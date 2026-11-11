import crypto from "node:crypto";
import { z } from "zod";
import type { ClientSession, SortOrder, Types } from "mongoose";
import { handler, objectId, paginate, parseSort, containsRegex } from "@/core/http";
import { requireSite } from "@/core/access";
import { conflict, notFound, validationFailed, type FieldError } from "@/core/errors";
import { withTransaction } from "@/core/db";
import { onSiteCreated } from "@/core/hooks";
import { audit } from "@/core/records";
import type { RequestContext, SiteContext } from "@/core/context";
import type { ModuleRoutes } from "@/modules/registry";
import {
  Tracker,
  TrackerRow,
  publicRow,
  publicTracker,
  userRefs,
  type ColumnDoc,
  type TrackerDoc,
  type TrackerKind,
  type TrackerRowDoc,
} from "./models";
import { checkValue, rowInput, rowListQuery, rowPatch, trackerInput, trackerPatch, validateValues, type ColumnInput } from "./schemas";

// ---------- default trackers for every new site ----------
const TODO_STATUS = ["Not started", "In progress", "Done"];
export const DEFAULT_TRACKERS: { name: string; kind: TrackerKind; columns: ColumnDoc[] }[] = [
  {
    name: "To-do",
    kind: "todo",
    columns: [
      { key: "c_task", label: "Task", type: "text", required: true, options: [] },
      { key: "c_start", label: "Start date", type: "date", required: false, options: [] },
      { key: "c_end", label: "End date", type: "date", required: false, options: [] },
      { key: "c_status", label: "Status", type: "status", required: false, options: TODO_STATUS },
    ],
  },
  {
    name: "Work done",
    kind: "work",
    columns: [
      { key: "c_title", label: "Title", type: "text", required: true, options: [] },
      { key: "c_desc", label: "Description", type: "text", required: false, options: [] },
      { key: "c_date", label: "Date", type: "date", required: true, options: [] },
    ],
  },
];

onSiteCreated(async (ctx, siteId, session) => {
  await Tracker.create(
    DEFAULT_TRACKERS.map((t) => ({ ...t, columns: t.columns.map((c) => ({ ...c, options: [...c.options] })), orgId: ctx.orgId, siteId })),
    { session, ordered: true },
  );
});

// ---------- helpers ----------
const newKey = (taken: Set<string>) => {
  let k: string;
  do k = `c_${crypto.randomBytes(5).toString("hex")}`;
  while (taken.has(k));
  taken.add(k);
  return k;
};

const toColumn = (c: ColumnInput, key: string): ColumnDoc => ({
  key,
  label: c.label,
  type: c.type,
  required: c.required,
  options: c.options,
});

async function findSiteTracker(ctx: RequestContext, site: SiteContext, trackerId: string, session?: ClientSession) {
  const t = await Tracker.findOne({ _id: trackerId, orgId: ctx.orgId, siteId: site.id })
    .session(session ?? null)
    .lean<TrackerDoc>();
  if (!t) throw notFound("Tracker");
  return t;
}

const countRows = (ctx: RequestContext, trackerId: Types.ObjectId) =>
  TrackerRow.countDocuments({ orgId: ctx.orgId, trackerId });

/**
 * Checks that every stored value of `col.key` still fits `col` (after a type / options change).
 * Returns at most 20 field errors pointing at the column in the request.
 */
async function incompatibleValues(
  ctx: RequestContext,
  trackerId: Types.ObjectId,
  col: ColumnDoc,
  index: number,
  session: ClientSession,
): Promise<FieldError[]> {
  const path = `values.${col.key}`;
  const rows = await TrackerRow.find({ orgId: ctx.orgId, trackerId, [path]: { $exists: true, $ne: null } })
    .select(path)
    .session(session)
    .lean<TrackerRowDoc[]>();
  const errors: FieldError[] = [];
  for (const r of rows) {
    const res = checkValue(col, r.values?.[col.key]);
    if (!res.ok) {
      errors.push({ path: `columns.${index}`, message: `Row ${r._id.toHexString()}: "${String(r.values?.[col.key])}" — ${res.message}` });
      if (errors.length >= 20) break;
    }
  }
  return errors;
}

async function rowsOut(ctx: RequestContext, rows: TrackerRowDoc[]) {
  const refs = await userRefs(ctx.orgId, rows.map((r) => r.createdBy));
  return rows.map((r) => publicRow(r, refs));
}

const trackerParams = z.object({ trackerId: objectId });
const rowParams = z.object({ trackerId: objectId, rowId: objectId });

export const worklogModule: ModuleRoutes = {
  name: "worklog",
  site(r) {
    // ---- trackers ----
    r.get(
      "/trackers",
      requireSite("site:read"),
      handler({}, async ({ ctx, site }) => {
        const [trackers, counts] = await Promise.all([
          Tracker.find({ orgId: ctx.orgId, siteId: site.id }).sort({ createdAt: 1, _id: 1 }).lean<TrackerDoc[]>(),
          TrackerRow.aggregate<{ _id: Types.ObjectId; n: number }>([
            { $match: { orgId: ctx.orgId, siteId: site.id } },
            { $group: { _id: "$trackerId", n: { $sum: 1 } } },
          ]),
        ]);
        const countOf = new Map(counts.map((c) => [c._id.toHexString(), c.n]));
        return { items: trackers.map((t) => publicTracker(t, countOf.get(t._id.toHexString()) ?? 0)) };
      }),
    );

    r.post(
      "/trackers",
      requireSite("worklog:write"),
      handler(
        { body: trackerInput },
        async ({ body, ctx, site }) => {
          const taken = new Set<string>();
          const created = await Tracker.create({
            orgId: ctx.orgId,
            siteId: site.id,
            name: body.name,
            kind: body.kind,
            columns: body.columns.map((c) => toColumn(c, newKey(taken))),
          });
          await audit(ctx, { action: "tracker.create", entity: "Tracker", entityId: created._id, siteId: site.id });
          return publicTracker(created.toObject() as unknown as TrackerDoc, 0);
        },
        { status: 201 },
      ),
    );

    r.patch(
      "/trackers/:trackerId",
      requireSite("worklog:write"),
      handler({ params: trackerParams, body: trackerPatch }, async ({ params, body, ctx, site }) => {
        const updated = await withTransaction(async (session) => {
          const current = await findSiteTracker(ctx, site, params.trackerId, session);
          const set: Record<string, unknown> = {};
          if (body.name !== undefined) set.name = body.name;
          let removed: string[] = [];
          if (body.columns) {
            const existing = new Map(current.columns.map((c) => [c.key, c]));
            const unknown: FieldError[] = body.columns.flatMap((c, i) =>
              c.key && !existing.has(c.key) ? [{ path: `columns.${i}.key`, message: "Unknown column key" }] : [],
            );
            if (unknown.length) throw validationFailed(unknown);
            const taken = new Set(existing.keys());
            const next = body.columns.map((c) => toColumn(c, c.key ?? newKey(taken)));
            const incompatible: FieldError[] = [];
            for (const [i, col] of next.entries()) {
              const before = existing.get(col.key);
              if (!before) continue;
              const optionsChanged =
                col.type === "status" && (before.options ?? []).some((o) => !col.options.includes(o));
              if (before.type !== col.type || optionsChanged) {
                incompatible.push(...(await incompatibleValues(ctx, current._id, col, i, session)));
              }
            }
            if (incompatible.length) {
              throw conflict("Some existing values don't fit the new column settings. Change or clear them first.", incompatible);
            }
            const kept = new Set(next.map((c) => c.key));
            removed = current.columns.map((c) => c.key).filter((k) => !kept.has(k));
            set.columns = next;
          }
          const t = await Tracker.findOneAndUpdate(
            { _id: current._id, orgId: ctx.orgId, siteId: site.id },
            { $set: set },
            { new: true, runValidators: true, session },
          ).lean<TrackerDoc>();
          if (removed.length) {
            await TrackerRow.updateMany(
              { orgId: ctx.orgId, trackerId: current._id },
              { $unset: Object.fromEntries(removed.map((k) => [`values.${k}`, ""])) },
              { session },
            );
          }
          await audit(
            ctx,
            { action: "tracker.update", entity: "Tracker", entityId: current._id, siteId: site.id, data: { removedColumns: removed } },
            session,
          );
          return t!;
        });
        return publicTracker(updated, await countRows(ctx, updated._id));
      }),
    );

    r.delete(
      "/trackers/:trackerId",
      requireSite("worklog:write"),
      handler(
        { params: trackerParams, query: z.object({ force: z.enum(["true", "false"]).optional() }) },
        async ({ params, query, ctx, site }) => {
          const t = await findSiteTracker(ctx, site, params.trackerId);
          const force = query.force === "true";
          if (!force && (await TrackerRow.exists({ orgId: ctx.orgId, trackerId: t._id }))) {
            throw conflict("This tracker has rows. Delete them first, or delete with force=true to remove everything.");
          }
          await withTransaction(async (session) => {
            const { deletedCount } = await TrackerRow.deleteMany({ orgId: ctx.orgId, trackerId: t._id }, { session });
            await Tracker.deleteOne({ _id: t._id, orgId: ctx.orgId, siteId: site.id }, { session });
            await audit(
              ctx,
              { action: "tracker.delete", entity: "Tracker", entityId: t._id, siteId: site.id, data: { name: t.name, rowsDeleted: deletedCount } },
              session,
            );
          });
          return null;
        },
      ),
    );

    // ---- rows ----
    r.get(
      "/trackers/:trackerId/rows",
      requireSite("site:read"),
      handler({ params: trackerParams, query: rowListQuery }, async ({ params, query, ctx, site }) => {
        const t = await findSiteTracker(ctx, site, params.trackerId);
        const filter: Record<string, unknown> = { orgId: ctx.orgId, siteId: site.id, trackerId: t._id };
        if (query.done !== undefined) filter.done = query.done;
        if (query.q) {
          const rx = containsRegex(query.q);
          const searchable = t.columns.filter((c) => c.type === "text" || c.type === "status");
          filter.$or = searchable.length ? searchable.map((c) => ({ [`values.${c.key}`]: rx })) : [{ _id: null }];
        }
        let sort: Record<string, SortOrder> = parseSort(query.sort, ["createdAt", "updatedAt"], { createdAt: 1, _id: 1 });
        if (query.sort) {
          const desc = query.sort.startsWith("-");
          const field = desc ? query.sort.slice(1) : query.sort;
          // only a key that is a column of this tracker may reach the sort spec
          if (t.columns.some((c) => c.key === field)) sort = { [`values.${field}`]: desc ? -1 : 1, _id: 1 };
        }
        const list = await paginate(TrackerRow, filter, query, sort, (d) => d as unknown as TrackerRowDoc);
        return { ...list, items: await rowsOut(ctx, list.items) };
      }),
    );

    r.post(
      "/trackers/:trackerId/rows",
      requireSite("worklog:write"),
      handler(
        { params: trackerParams, body: rowInput },
        async ({ params, body, ctx, site }) => {
          const t = await findSiteTracker(ctx, site, params.trackerId);
          const { set, errors } = validateValues(t.columns, body.values, "create");
          if (errors.length) throw validationFailed(errors);
          const created = await TrackerRow.create({
            orgId: ctx.orgId,
            siteId: site.id,
            trackerId: t._id,
            values: set,
            done: body.done,
            createdBy: ctx.userId,
          });
          const [out] = await rowsOut(ctx, [created.toObject() as unknown as TrackerRowDoc]);
          return out;
        },
        { status: 201 },
      ),
    );

    r.patch(
      "/trackers/:trackerId/rows/:rowId",
      requireSite("worklog:write"),
      handler({ params: rowParams, body: rowPatch }, async ({ params, body, ctx, site }) => {
        const t = await findSiteTracker(ctx, site, params.trackerId);
        const update: { $set: Record<string, unknown>; $unset?: Record<string, ""> } = { $set: {} };
        if (body.values) {
          const { set, unset, errors } = validateValues(t.columns, body.values, "patch");
          if (errors.length) throw validationFailed(errors);
          for (const [k, v] of Object.entries(set)) update.$set[`values.${k}`] = v;
          if (unset.length) update.$unset = Object.fromEntries(unset.map((k) => [`values.${k}`, ""] as const));
        }
        if (body.done !== undefined) update.$set.done = body.done;
        const row = await TrackerRow.findOneAndUpdate(
          { _id: params.rowId, orgId: ctx.orgId, siteId: site.id, trackerId: t._id },
          update,
          { new: true },
        ).lean<TrackerRowDoc>();
        if (!row) throw notFound("Row");
        const [out] = await rowsOut(ctx, [row]);
        return out;
      }),
    );

    r.delete(
      "/trackers/:trackerId/rows/:rowId",
      requireSite("worklog:write"),
      handler({ params: rowParams }, async ({ params, ctx, site }) => {
        const t = await findSiteTracker(ctx, site, params.trackerId);
        const res = await TrackerRow.deleteOne({ _id: params.rowId, orgId: ctx.orgId, siteId: site.id, trackerId: t._id });
        if (res.deletedCount === 0) throw notFound("Row");
        return null;
      }),
    );
  },
};
