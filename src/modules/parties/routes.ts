import { z } from "zod";
import { Types } from "mongoose";
import { handler, listQuery, objectId, paginate, parseSort, containsRegex } from "@/core/http";
import { requireEngineerAnywhere, requireOrgAdmin, requireSite, siteCan } from "@/core/access";
import { conflict, forbidden, notFound, invalidState } from "@/core/errors";
import { audit } from "@/core/records";
import type { SiteContext } from "@/core/context";
import type { ModuleRoutes } from "@/modules/registry";
import { Party, PARTY_KINDS, nameKeyOf, publicParty, type PartyDoc, type PartyKind } from "./models";
import { partyInput, partyPatch } from "./schemas";

const kindParam = z.enum(PARTY_KINDS);
const partyParams = z.object({ partyId: objectId });

/** Labour can be managed by supervisors; vendors and clients need engineer rights. */
export function assertCanWriteKind(site: SiteContext, kind: PartyKind) {
  if (site.status === "archived") throw invalidState("This site is archived. Restore it to make changes.");
  if (!siteCan(site, kind === "labour" ? "labour:write" : "masters:write")) throw forbidden();
}

const SORTABLE = ["name", "category", "createdAt", "wageRatePaise"];

/** A party attached to this site, or 404. */
export async function findSiteParty(orgId: Types.ObjectId, siteId: Types.ObjectId, partyId: string, kind?: PartyKind) {
  const p = await Party.findOne({ _id: partyId, orgId, siteIds: siteId, ...(kind ? { kind } : {}) }).lean<PartyDoc>();
  if (!p) throw notFound(kind ? kind[0]!.toUpperCase() + kind.slice(1) : "Party");
  return p;
}

export const partiesModule: ModuleRoutes = {
  name: "parties",
  site(r) {
    r.get(
      "/parties",
      requireSite("site:read"),
      handler(
        { query: listQuery.extend({ kind: kindParam, status: z.enum(["active", "archived"]).optional() }) },
        async ({ query, ctx, site }) => {
          const filter: Record<string, unknown> = {
            orgId: ctx.orgId,
            siteIds: site.id,
            kind: query.kind,
            status: query.status ?? "active",
          };
          if (query.q) {
            const rx = containsRegex(query.q);
            filter.$or = [{ name: rx }, { phone: rx }, { category: rx }, { gstIn: rx }];
          }
          return paginate(Party, filter, query, parseSort(query.sort, SORTABLE, { name: 1 }), (d) =>
            publicParty(d as unknown as PartyDoc),
          );
        },
      ),
    );

    r.post(
      "/parties",
      requireSite("site:read"),
      handler(
        { body: z.union([z.object({ existingPartyId: objectId }).strict(), partyInput]) },
        async ({ body, ctx, site }) => {
          if ("existingPartyId" in body) {
            const existing = await Party.findOne({ _id: body.existingPartyId, orgId: ctx.orgId }).lean<PartyDoc>();
            if (!existing || existing.status === "archived") throw notFound("Party");
            assertCanWriteKind(site, existing.kind as PartyKind);
            const updated = await Party.findOneAndUpdate(
              { _id: existing._id, orgId: ctx.orgId },
              { $addToSet: { siteIds: site.id } },
              { new: true },
            ).lean<PartyDoc>();
            return publicParty(updated!);
          }
          assertCanWriteKind(site, body.kind);
          const nameKey = nameKeyOf(body.name);
          const dup = await Party.findOne({ orgId: ctx.orgId, kind: body.kind, nameKey, phone: body.phone }).lean<PartyDoc>();
          if (dup) {
            throw conflict(`A ${body.kind} named "${dup.name}" with this phone already exists. Add the existing one instead.`, [
              { path: "existingPartyId", message: dup._id.toHexString() },
            ]);
          }
          const created = await Party.create({ ...body, nameKey, orgId: ctx.orgId, siteIds: [site.id] });
          await audit(ctx, { action: "party.create", entity: "Party", entityId: created._id, siteId: site.id });
          return publicParty(created.toObject() as PartyDoc);
        },
        { status: 201 },
      ),
    );

    r.get(
      "/parties/:partyId",
      requireSite("site:read"),
      handler({ params: partyParams }, async ({ params, ctx, site }) =>
        publicParty(await findSiteParty(ctx.orgId, site.id, params.partyId)),
      ),
    );

    r.patch(
      "/parties/:partyId",
      requireSite("site:read"),
      handler({ params: partyParams, body: partyPatch }, async ({ params, body, ctx, site }) => {
        const current = await findSiteParty(ctx.orgId, site.id, params.partyId);
        assertCanWriteKind(site, current.kind as PartyKind);
        if (current.kind !== "labour" && body.wageRatePaise !== undefined) {
          throw invalidState("Only labour has a wage rate.");
        }
        const set: Record<string, unknown> = { ...body };
        if (body.name) set.nameKey = nameKeyOf(body.name);
        const updated = await Party.findOneAndUpdate(
          { _id: current._id, orgId: ctx.orgId },
          { $set: set },
          { new: true, runValidators: true },
        ).lean<PartyDoc>();
        await audit(ctx, { action: "party.update", entity: "Party", entityId: current._id, siteId: site.id, data: body });
        return publicParty(updated!);
      }),
    );

    r.delete(
      "/parties/:partyId",
      requireSite("site:read"),
      handler({ params: partyParams }, async ({ params, ctx, site }) => {
        const current = await findSiteParty(ctx.orgId, site.id, params.partyId);
        assertCanWriteKind(site, current.kind as PartyKind);
        await Party.updateOne({ _id: current._id, orgId: ctx.orgId }, { $pull: { siteIds: site.id } });
        await audit(ctx, { action: "party.detach", entity: "Party", entityId: current._id, siteId: site.id });
        return null;
      }),
    );
  },

  org(r) {
    r.get(
      "/parties",
      requireEngineerAnywhere,
      handler(
        { query: listQuery.extend({ kind: kindParam.optional(), status: z.enum(["active", "archived"]).optional() }) },
        async ({ query, ctx }) => {
          const filter: Record<string, unknown> = { orgId: ctx.orgId, status: query.status ?? "active" };
          if (query.kind) filter.kind = query.kind;
          if (query.q) filter.$or = [{ name: containsRegex(query.q) }, { phone: containsRegex(query.q) }];
          return paginate(Party, filter, query, parseSort(query.sort, SORTABLE, { name: 1 }), (d) =>
            publicParty(d as unknown as PartyDoc),
          );
        },
      ),
    );
    for (const [path, status] of [
      ["/parties/:partyId/archive", "archived"],
      ["/parties/:partyId/restore", "active"],
    ] as const) {
      r.post(
        path,
        requireOrgAdmin,
        handler({ params: partyParams }, async ({ params, ctx }) => {
          const p = await Party.findOneAndUpdate(
            { _id: params.partyId, orgId: ctx.orgId },
            { $set: { status } },
            { new: true },
          ).lean<PartyDoc>();
          if (!p) throw notFound("Party");
          await audit(ctx, { action: `party.${status}`, entity: "Party", entityId: p._id });
          return publicParty(p);
        }),
      );
    }
  },
};
