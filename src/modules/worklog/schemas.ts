import { z } from "zod";
import { listQuery } from "@/core/http";
import { isoDate } from "@/core/units";
import { COLUMN_KEY, COLUMN_TYPES, MAX_COLUMNS, TRACKER_KINDS, type ColumnDoc, type RowValue } from "./models";

export const MAX_TEXT = 2000;

const columnInput = z
  .object({
    key: z.string().regex(COLUMN_KEY, "Not a valid column key").optional(),
    label: z.string().trim().min(1, "Label is required").max(60),
    type: z.enum(COLUMN_TYPES),
    required: z.boolean().default(false),
    options: z.array(z.string().trim().min(1, "Option can't be empty").max(60)).max(50).optional(),
  })
  .strict()
  .superRefine((c, ctx) => {
    if (c.type === "status") {
      if (!c.options?.length) ctx.addIssue({ code: "custom", path: ["options"], message: "A status column needs at least one option" });
      const seen = new Set<string>();
      c.options?.forEach((o, i) => {
        const k = o.toLowerCase();
        if (seen.has(k)) ctx.addIssue({ code: "custom", path: ["options", i], message: "Options must be unique" });
        seen.add(k);
      });
    } else if (c.options?.length) {
      ctx.addIssue({ code: "custom", path: ["options"], message: "Only status columns have options" });
    }
  })
  .transform((c) => ({ ...c, options: c.type === "status" ? c.options! : [] }));
export type ColumnInput = z.output<typeof columnInput>;

const columnList = z
  .array(columnInput)
  .min(1, "Add at least one column")
  .max(MAX_COLUMNS, `A tracker can have at most ${MAX_COLUMNS} columns`)
  .superRefine((cols, ctx) => {
    const labels = new Set<string>();
    const keys = new Set<string>();
    cols.forEach((c, i) => {
      const l = c.label.toLowerCase();
      if (labels.has(l)) ctx.addIssue({ code: "custom", path: [i, "label"], message: "Column labels must be unique" });
      labels.add(l);
      if (c.key) {
        if (keys.has(c.key)) ctx.addIssue({ code: "custom", path: [i, "key"], message: "Column appears twice" });
        keys.add(c.key);
      }
    });
  });

const trackerName = z.string().trim().min(1, "Name is required").max(80);

export const trackerInput = z
  .object({
    name: trackerName,
    kind: z.enum(TRACKER_KINDS).default("custom"),
    // keys are generated server-side on create
    columns: columnList.refine((cols) => cols.every((c) => !c.key), "Don't send keys when creating a tracker"),
  })
  .strict();

export const trackerPatch = z.object({ name: trackerName.optional(), columns: columnList.optional() }).strict();

const valuesInput = z.record(z.string(), z.unknown());
export const rowInput = z.object({ values: valuesInput.default({}), done: z.boolean().default(false) }).strict();
export const rowPatch = z.object({ values: valuesInput.optional(), done: z.boolean().optional() }).strict();

export const rowListQuery = listQuery.extend({
  done: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .optional(),
});

/** Validates one non-empty value against a column. Returns the normalised value or an error message. */
export function checkValue(col: Pick<ColumnDoc, "type" | "options">, v: unknown): { ok: true; value: RowValue } | { ok: false; message: string } {
  switch (col.type) {
    case "text":
      if (typeof v !== "string") return { ok: false, message: "Must be text" };
      if (v.trim().length > MAX_TEXT) return { ok: false, message: `At most ${MAX_TEXT} characters` };
      return { ok: true, value: v.trim() };
    case "number":
      if (typeof v !== "number" || !Number.isFinite(v)) return { ok: false, message: "Must be a number" };
      return { ok: true, value: v };
    case "date": {
      const r = isoDate.safeParse(v);
      return r.success ? { ok: true, value: r.data } : { ok: false, message: r.error.issues[0]?.message ?? "Not a valid date" };
    }
    case "status":
      if (typeof v !== "string" || !col.options.includes(v)) {
        return { ok: false, message: `Must be one of: ${col.options.join(", ")}` };
      }
      return { ok: true, value: v };
  }
}

const isEmpty = (v: unknown) => v === null || v === undefined || (typeof v === "string" && v.trim() === "");

/**
 * Validates submitted row values against the tracker's columns.
 * Empty values (null / "") clear the cell. On create, every required column must have a value;
 * on patch, only the submitted keys are checked (so rows that predate a new required column stay editable).
 */
export function validateValues(columns: ColumnDoc[], input: Record<string, unknown>, mode: "create" | "patch") {
  const byKey = new Map(columns.map((c) => [c.key, c]));
  const set: Record<string, RowValue> = {};
  const unset: string[] = [];
  const errors: { path: string; message: string }[] = [];
  for (const [key, raw] of Object.entries(input)) {
    const col = byKey.get(key);
    if (!col) {
      errors.push({ path: `values.${key}`, message: "Unknown column" });
      continue;
    }
    if (isEmpty(raw)) {
      if (col.required) errors.push({ path: `values.${key}`, message: `${col.label} is required` });
      else unset.push(key);
      continue;
    }
    const r = checkValue(col, raw);
    if (r.ok) set[key] = r.value;
    else errors.push({ path: `values.${key}`, message: r.message });
  }
  if (mode === "create") {
    for (const c of columns) {
      if (c.required && !(c.key in set) && !errors.some((e) => e.path === `values.${c.key}`)) {
        errors.push({ path: `values.${c.key}`, message: `${c.label} is required` });
      }
    }
  }
  return { set, unset, errors };
}
