/** Todos → "To-do" tracker rows, Works → "Work done" tracker rows (additionalCols → custom text columns), Notes → Note. */
import crypto from "node:crypto";
import type { Types } from "mongoose";
import { DEFAULT_TRACKERS } from "@/modules/worklog/routes";
import { MAX_COLUMNS, Tracker, TrackerRow, type ColumnDoc } from "@/modules/worklog/models";
import { Note } from "@/modules/notes/models";
import type { LTodo, LWork } from "../legacy";
import { businessDate, clip, isHttpUrl, str } from "../clean";
import { newId, type Migration, type SiteState } from "../context";

const MAX_TEXT = 2000;
const DEFAULT_KEYS = new Set(DEFAULT_TRACKERS.flatMap((t) => t.columns.map((c) => c.key)));

type Kind = "todo" | "work";

async function trackerFor(m: Migration, site: SiteState, kind: Kind) {
  const k = `${site.siteId.toHexString()}|${kind}`;
  const cached = m.trackers.get(k);
  if (cached) return cached;
  const found = await Tracker.findOne({ orgId: site.org.orgId, siteId: site.siteId, kind }).sort({ createdAt: 1 }).lean();
  let t: { id: Types.ObjectId; columns: ColumnDoc[] } | undefined = found
    ? { id: found._id, columns: found.columns.map((c) => ({ ...c, options: [...(c.options ?? [])] }) as ColumnDoc) }
    : undefined;
  if (!t) {
    // Site migrated before its trackers existed (or they were deleted): recreate the default one.
    const def = DEFAULT_TRACKERS.find((d) => d.kind === kind)!;
    const created = { id: newId(), columns: def.columns.map((c) => ({ ...c, options: [...c.options] })) };
    const res = await m.unit(kind === "todo" ? "todos" : "works", site.oldId, async (tx) => {
      await tx.create(Tracker, { _id: created.id, orgId: site.org.orgId, siteId: site.siteId, name: def.name, kind, columns: created.columns });
    });
    if (!res.ok) return undefined;
    t = created;
  }
  m.trackers.set(k, t);
  return t;
}

/** Adds one text column per legacy additionalCols key (label = the old key). Returns old key → column key. */
async function ensureColumns(m: Migration, site: SiteState, kind: Kind, oldKeys: string[]) {
  const entity = kind === "todo" ? "todos" : "works";
  const tracker = await trackerFor(m, site, kind);
  if (!tracker) return undefined;
  const columns = [...tracker.columns];
  const out = new Map<string, string>();
  const added: string[] = [];
  const dropped: string[] = [];
  for (const oldKey of oldKeys) {
    let label = clip(oldKey, 60).value;
    if (!label) continue;
    const find = (l: string) => columns.find((c) => c.label.toLowerCase() === l.toLowerCase());
    let col = find(label);
    if (col && DEFAULT_KEYS.has(col.key)) {
      label = `${clip(oldKey, 51).value} (legacy)`;
      col = find(label);
    }
    if (!col) {
      if (columns.length >= MAX_COLUMNS) {
        dropped.push(oldKey);
        continue;
      }
      const taken = new Set(columns.map((c) => c.key));
      let key: string;
      do key = `c_${crypto.randomBytes(5).toString("hex")}`;
      while (taken.has(key));
      col = { key, label, type: "text", required: false, options: [] };
      columns.push(col);
      added.push(label);
    }
    out.set(oldKey, col.key);
  }
  if (added.length) {
    const res = await m.unit(entity, `${site.oldId}:columns`, async (tx) => {
      await tx.update(Tracker, { _id: tracker.id, orgId: site.org.orgId }, { $set: { columns } });
      tx.issue("trackerColumns", { site: site.name, tracker: kind === "todo" ? "To-do" : "Work done", added });
    });
    if (!res.ok) return undefined;
    tracker.columns = columns;
  }
  if (dropped.length) {
    m.report.add("trackerColumns", { site: site.name, tracker: kind, dropped, message: `more than ${MAX_COLUMNS} columns; values of these keys were not imported` });
  }
  return { tracker, keys: out };
}

const colsOf = (v: unknown): [string, string][] => {
  const obj = v instanceof Map ? Object.fromEntries(v) : v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  return Object.entries(obj).map(([k, val]) => [k, str(val)] as [string, string]);
};

async function migrateRows(m: Migration, kind: Kind, docs: (LTodo | LWork)[]) {
  const { report, tz } = m;
  const entity = kind === "todo" ? "todos" : "works";
  const bySite = new Map<string, (LTodo | LWork)[]>();
  for (const d of docs) {
    report.count(entity, "read");
    const site = m.siteOf(d.siteId);
    if (!site) {
      report.error(entity, d._id, `site ${String(d.siteId)} was not migrated`);
      continue;
    }
    const list = bySite.get(site.oldId) ?? [];
    list.push(d);
    bySite.set(site.oldId, list);
  }
  for (const [siteOld, list] of bySite) {
    const site = m.sites.get(siteOld)!;
    const pending = list.filter((d) => !m.mapped(kind, d._id));
    report.count(entity, "alreadyMigrated", list.length - pending.length);
    if (!pending.length) continue;
    const oldKeys = [...new Set(pending.flatMap((d) => colsOf(d.additionalCols).map(([k]) => k)))];
    const cols = await ensureColumns(m, site, kind, oldKeys);
    if (!cols) {
      for (const d of pending) report.error(entity, d._id, "tracker could not be prepared");
      continue;
    }
    for (const d of pending) {
      const oldId = String(d._id);
      const text = (field: string, v: unknown) => {
        const c = clip(v, MAX_TEXT);
        if (c.cut) report.add("truncated", { entity, oldId, field, max: MAX_TEXT });
        return c.value;
      };
      const values: Record<string, string> = {};
      if (kind === "todo") {
        const t = d as LTodo;
        values.c_task = text("task", t.task) || "(untitled)";
        const start = businessDate(t.start, tz);
        const end = businessDate(t.end, tz);
        if (start) values.c_start = start;
        if (end) values.c_end = end;
      } else {
        const w = d as LWork;
        values.c_title = text("title", w.title) || "(untitled)";
        const desc = text("description", w.description);
        if (desc) values.c_desc = desc;
        values.c_date = businessDate(w.date, tz, w.createdAt) ?? "1970-01-01";
      }
      for (const [k, v] of colsOf(d.additionalCols)) {
        const key = cols.keys.get(k);
        if (key && v) values[key] = text(`additionalCols.${k}`, v);
      }
      const id = newId();
      await m.unit(entity, oldId, async (tx) => {
        await tx.create(TrackerRow, {
          _id: id,
          orgId: site.org.orgId,
          siteId: site.siteId,
          trackerId: cols.tracker.id,
          values,
          done: false,
          createdBy: site.org.ownerId,
          createdAt: d.createdAt,
        });
        tx.map(kind, oldId, id, site.org.orgId);
        tx.count(entity, "created");
      });
    }
  }
}

export async function migrateWorklog(m: Migration) {
  await migrateRows(m, "todo", m.legacy.todos);
  await migrateRows(m, "work", m.legacy.works);
}

export async function migrateNotes(m: Migration) {
  const { legacy, report } = m;
  for (const n of legacy.notes) {
    report.count("notes", "read");
    const oldId = String(n._id);
    const site = m.siteOf(n.siteId);
    if (!site) {
      report.error("notes", oldId, `site ${String(n.siteId)} was not migrated`);
      continue;
    }
    if (m.mapped("note", oldId)) {
      report.count("notes", "alreadyMigrated");
      continue;
    }
    const linkRaw = str(n.sheetsLink);
    let body = str(n.context);
    let link: string | undefined;
    if (linkRaw && isHttpUrl(linkRaw) && linkRaw.length <= 2000) link = linkRaw;
    else if (linkRaw) {
      body = [body, `Link: ${linkRaw}`].filter(Boolean).join("\n\n");
      report.add("notes", { entity: "notes", oldId, message: "sheetsLink is not an http(s) URL; moved into the body" });
    }
    const b = clip(body, 20_000);
    if (b.cut) report.add("truncated", { entity: "notes", oldId, field: "context", max: 20_000 });
    const id = newId();
    await m.unit("notes", oldId, async (tx) => {
      await tx.create(Note, {
        _id: id,
        orgId: site.org.orgId,
        siteId: site.siteId,
        title: clip(n.title, 200).value || "Untitled note",
        body: b.value,
        link,
        createdBy: site.org.ownerId,
        createdAt: n.createdAt,
      });
      tx.map("note", oldId, id, site.org.orgId);
      tx.count("notes", "created");
    });
  }
}
