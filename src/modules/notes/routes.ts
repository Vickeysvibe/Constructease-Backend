import { z } from "zod";
import { handler, listQuery, objectId, paginate, parseSort, containsRegex } from "@/core/http";
import { requireSite } from "@/core/access";
import { notFound } from "@/core/errors";
import type { RequestContext } from "@/core/context";
import type { ModuleRoutes } from "@/modules/registry";
import { userRefs } from "@/modules/worklog/models";
import { Note, publicNote, type NoteDoc } from "./models";

/** http(s) URL only — no javascript:, data:, file: … */
const link = z
  .string()
  .trim()
  .max(2000)
  .url("Enter a valid link")
  .refine((v) => /^https?:\/\//i.test(v), "Link must start with http:// or https://");

const noteFields = {
  title: z.string().trim().min(1, "Title is required").max(200),
  body: z.string().trim().max(20_000),
};
const noteInput = z
  .object({
    ...noteFields,
    body: noteFields.body.default(""),
    link: link.optional().or(z.literal("").transform(() => undefined)),
  })
  .strict();
/** `link: null` or `""` removes the link */
const notePatch = z
  .object({ ...noteFields, link: link.nullable().or(z.literal("").transform(() => null)) })
  .partial()
  .strict();

const noteParams = z.object({ noteId: objectId });

async function notesOut(ctx: RequestContext, notes: NoteDoc[]) {
  const refs = await userRefs(ctx.orgId, notes.map((n) => n.createdBy));
  return notes.map((n) => publicNote(n, refs));
}

export const notesModule: ModuleRoutes = {
  name: "notes",
  site(r) {
    r.get(
      "/notes",
      requireSite("site:read"),
      handler({ query: listQuery }, async ({ query, ctx, site }) => {
        const filter: Record<string, unknown> = { orgId: ctx.orgId, siteId: site.id };
        if (query.q) {
          const rx = containsRegex(query.q);
          filter.$or = [{ title: rx }, { body: rx }];
        }
        const sort = parseSort(query.sort, ["title", "createdAt", "updatedAt"], { createdAt: -1, _id: -1 });
        const list = await paginate(Note, filter, query, sort, (d) => d as unknown as NoteDoc);
        return { ...list, items: await notesOut(ctx, list.items) };
      }),
    );

    r.post(
      "/notes",
      requireSite("notes:write"),
      handler(
        { body: noteInput },
        async ({ body, ctx, site }) => {
          const created = await Note.create({ ...body, orgId: ctx.orgId, siteId: site.id, createdBy: ctx.userId });
          const [out] = await notesOut(ctx, [created.toObject() as unknown as NoteDoc]);
          return out;
        },
        { status: 201 },
      ),
    );

    r.patch(
      "/notes/:noteId",
      requireSite("notes:write"),
      handler({ params: noteParams, body: notePatch }, async ({ params, body, ctx, site }) => {
        const { link: newLink, ...rest } = body;
        const update: Record<string, unknown> = { $set: { ...rest } };
        if (newLink === null) update.$unset = { link: "" };
        else if (newLink !== undefined) (update.$set as Record<string, unknown>).link = newLink;
        const n = await Note.findOneAndUpdate({ _id: params.noteId, orgId: ctx.orgId, siteId: site.id }, update, {
          new: true,
          runValidators: true,
        }).lean<NoteDoc>();
        if (!n) throw notFound("Note");
        const [out] = await notesOut(ctx, [n]);
        return out;
      }),
    );

    r.delete(
      "/notes/:noteId",
      requireSite("notes:write"),
      handler({ params: noteParams }, async ({ params, ctx, site }) => {
        const res = await Note.deleteOne({ _id: params.noteId, orgId: ctx.orgId, siteId: site.id });
        if (res.deletedCount === 0) throw notFound("Note");
        return null;
      }),
    );
  },
};
