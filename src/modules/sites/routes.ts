import { Types } from "mongoose";
import { z } from "zod";
import { handler, listQuery, objectId, paginate, parseSort, containsRegex } from "@/core/http";
import { requireOrgAdmin, requireSite, visibleSiteIds } from "@/core/access";
import { conflict, notFound } from "@/core/errors";
import { withTransaction } from "@/core/db";
import { runSiteCreated } from "@/core/hooks";
import { audit } from "@/core/records";
import { hashPassword } from "@/core/auth";
import { isOrgAdmin } from "@/core/context";
import { email, password, phone } from "@/modules/identity/routes";
import { User } from "@/modules/identity/models";
import { Membership, Site } from "./models";
import type { ModuleRoutes } from "@/modules/registry";

const siteInput = z.object({
  name: z.string().trim().min(1, "Name is required").max(120),
  address: z.string().trim().min(1, "Address is required").max(500),
});

type SiteLean = { _id: { toHexString(): string }; name: string; address: string; status: string; createdAt?: Date; updatedAt?: Date };
export const publicSite = (s: SiteLean) => ({
  id: s._id.toHexString(),
  name: s.name,
  address: s.address,
  status: s.status,
  createdAt: s.createdAt?.toISOString(),
  updatedAt: s.updatedAt?.toISOString(),
});

const memberOut = (
  u: { _id: { toHexString(): string }; name: string; email: string; phone?: string | null; status: string },
  role: string,
) => ({ userId: u._id.toHexString(), name: u.name, email: u.email, phone: u.phone ?? "", role, status: u.status });

const roleSchema = z.enum(["engineer", "supervisor"]);

export const sitesModule: ModuleRoutes = {
  name: "sites",
  org(r) {
    r.get(
      "/sites",
      handler(
        { query: listQuery.extend({ status: z.enum(["active", "archived"]).optional() }) },
        async ({ query, ctx }) => {
          const filter: Record<string, unknown> = { orgId: ctx.orgId };
          if (!isOrgAdmin(ctx)) filter._id = { $in: await visibleSiteIds(ctx) };
          if (query.status) filter.status = query.status;
          if (query.q) filter.name = containsRegex(query.q);
          return paginate(Site, filter, query, parseSort(query.sort, ["name", "createdAt"], { name: 1 }), (s) =>
            publicSite(s as never),
          );
        },
      ),
    );
    r.post(
      "/sites",
      requireOrgAdmin,
      handler(
        { body: siteInput },
        async ({ body, ctx }) => {
          const site = await withTransaction(async (session) => {
            const [created] = await Site.create([{ ...body, orgId: ctx.orgId }], { session });
            await runSiteCreated(ctx, created!._id, session);
            return created!;
          });
          await audit(ctx, { action: "site.create", entity: "Site", entityId: site._id, siteId: site._id });
          return publicSite(site.toObject());
        },
        { status: 201 },
      ),
    );
  },
  site(r) {
    r.get(
      "/",
      requireSite("site:read"),
      handler({}, async ({ ctx, site }) => {
        const s = await Site.findOne({ _id: site.id, orgId: ctx.orgId }).lean();
        if (!s) throw notFound("Site");
        return publicSite(s);
      }),
    );
    r.patch(
      "/",
      requireSite("site:manage"),
      handler({ body: siteInput.partial() }, async ({ body, ctx, site }) => {
        const s = await Site.findOneAndUpdate({ _id: site.id, orgId: ctx.orgId }, { $set: body }, { new: true, runValidators: true }).lean();
        if (!s) throw notFound("Site");
        return publicSite(s);
      }),
    );
    for (const [path, status] of [
      ["/archive", "archived"],
      ["/restore", "active"],
    ] as const) {
      r.post(
        path,
        requireOrgAdmin,
        handler({}, async ({ ctx, site }) => {
          const s = await Site.findOneAndUpdate({ _id: site.id, orgId: ctx.orgId }, { $set: { status } }, { new: true }).lean();
          if (!s) throw notFound("Site");
          await audit(ctx, { action: `site.${status}`, entity: "Site", entityId: s._id, siteId: s._id });
          return publicSite(s);
        }),
      );
    }

    // ---- members ----
    r.get(
      "/members",
      requireSite("site:read"),
      handler({}, async ({ ctx, site }) => {
        const ms = await Membership.find({ orgId: ctx.orgId, siteId: site.id }).lean();
        const users = await User.find({ orgId: ctx.orgId, _id: { $in: ms.map((m) => m.userId) } })
          .sort({ name: 1 })
          .lean();
        const roleOf = new Map(ms.map((m) => [m.userId.toHexString(), m.role]));
        const items = users.map((u) => memberOut(u, roleOf.get(u._id.toHexString())!));
        return { items, page: 1, pageSize: items.length, total: items.length };
      }),
    );
    r.post(
      "/members",
      requireSite("site:manage"),
      handler(
        {
          body: z.object({
            name: z.string().trim().min(1).max(120),
            email,
            phone,
            password,
            role: roleSchema,
          }),
        },
        async ({ body, ctx, site }) => {
          if (await User.exists({ email: body.email }).setOptions({ skipTenantGuard: true })) {
            throw conflict("A user with this email already exists. Add them by role instead.", [
              { path: "email", message: "Email is already in use" },
            ]);
          }
          const user = await withTransaction(async (session) => {
            const [u] = await User.create(
              [
                {
                  orgId: ctx.orgId,
                  name: body.name,
                  email: body.email,
                  phone: body.phone,
                  orgRole: "member",
                  passwordHash: await hashPassword(body.password),
                },
              ],
              { session },
            );
            await Membership.create([{ orgId: ctx.orgId, siteId: site.id, userId: u!._id, role: body.role }], { session });
            return u!;
          });
          await audit(ctx, { action: "member.add", entity: "User", entityId: user._id, siteId: site.id, data: { role: body.role } });
          return memberOut(user, body.role);
        },
        { status: 201 },
      ),
    );
    r.put(
      "/members/:userId",
      requireSite("site:manage"),
      handler(
        { params: z.object({ userId: objectId }), body: z.object({ role: roleSchema }) },
        async ({ params, body, ctx, site }) => {
          const user = await User.findOne({ _id: params.userId, orgId: ctx.orgId }).lean();
          if (!user) throw notFound("User");
          await Membership.findOneAndUpdate(
            { orgId: ctx.orgId, siteId: site.id, userId: user._id },
            { $set: { role: body.role } },
            { upsert: true },
          );
          await audit(ctx, { action: "member.role", entity: "User", entityId: user._id, siteId: site.id, data: body });
          return memberOut(user, body.role);
        },
      ),
    );
    r.delete(
      "/members/:userId",
      requireSite("site:manage"),
      handler({ params: z.object({ userId: objectId }) }, async ({ params, ctx, site }) => {
        const res = await Membership.deleteOne({ orgId: ctx.orgId, siteId: site.id, userId: params.userId });
        if (res.deletedCount === 0) throw notFound("Member");
        await audit(ctx, { action: "member.remove", entity: "User", entityId: oidOf(params.userId), siteId: site.id });
        return null;
      }),
    );
  },
};

const oidOf = (s: string) => new Types.ObjectId(s);
