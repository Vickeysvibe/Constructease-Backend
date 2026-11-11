import { z } from "zod";
import { listQuery, objectId } from "@/core/http";
import { isoDate, paise, positiveQty, taxRateBp } from "@/core/units";
import { PO_STATUSES } from "./models";

const optText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => (v === "" ? undefined : v));

export const poLineInput = z
  .object({
    productId: objectId,
    qty: positiveQty,
    unitPricePaise: paise.optional(),
    taxRateBp: taxRateBp.optional(),
  })
  .strict();

const poFields = {
  vendorId: objectId,
  date: isoDate,
  expectedDate: isoDate.optional(),
  transport: optText(200),
  notes: optText(1000),
  lines: z.array(poLineInput).min(1, "Add at least one line").max(200),
};

const expectedAfterDate = (v: { date?: string; expectedDate?: string }) =>
  !v.date || !v.expectedDate || v.expectedDate >= v.date;
const expectedMsg = { message: "Expected date can't be before the PO date", path: ["expectedDate"] };

export const poInput = z.object(poFields).strict().refine(expectedAfterDate, expectedMsg);
export type POInput = z.infer<typeof poInput>;

export const poPatch = z.object(poFields).partial().strict().refine(expectedAfterDate, expectedMsg);
export type POPatch = z.infer<typeof poPatch>;

const optDate = isoDate.optional();

export const poListQuery = listQuery.extend({
  status: z.enum(PO_STATUSES).optional(),
  vendorId: objectId.optional(),
  from: optDate,
  to: optDate,
});

export const cancelInput = z.object({ reason: optText(500) }).strict();

export const PO_TEMPLATES = ["classic", "compact", "detailed"] as const;
export const RETURN_TEMPLATES = ["classic"] as const;
export const poPdfInput = z.object({ template: z.enum(PO_TEMPLATES).default("classic") }).strict();
export const returnPdfInput = z.object({ template: z.enum(RETURN_TEMPLATES).default("classic") }).strict();

const noDuplicateLines = (lines: { poLineId: string }[]) => new Set(lines.map((l) => l.poLineId)).size === lines.length;
const dupMsg = { message: "Each PO line can appear only once" };

export const grInput = z
  .object({
    poId: objectId,
    date: isoDate,
    challanNo: optText(60),
    vehicleNo: optText(30),
    notes: optText(1000),
    lines: z
      .array(
        z
          .object({ poLineId: objectId, qty: positiveQty, unitPricePaise: paise.optional(), taxRateBp: taxRateBp.optional() })
          .strict(),
      )
      .min(1, "Add at least one line")
      .max(200)
      .refine(noDuplicateLines, dupMsg),
  })
  .strict();
export type GRInput = z.infer<typeof grInput>;

export const grListQuery = listQuery.extend({
  poId: objectId.optional(),
  vendorId: objectId.optional(),
  from: optDate,
  to: optDate,
});

export const prInput = z
  .object({
    poId: objectId,
    date: isoDate,
    reason: optText(500),
    lines: z
      .array(z.object({ poLineId: objectId, qty: positiveQty }).strict())
      .min(1, "Add at least one line")
      .max(200)
      .refine(noDuplicateLines, dupMsg),
  })
  .strict();
export type PRInput = z.infer<typeof prInput>;

export const prListQuery = listQuery.extend({ poId: objectId.optional(), from: optDate, to: optDate });
