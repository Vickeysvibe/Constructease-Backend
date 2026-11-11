import { z } from "zod";
import { paise } from "@/core/units";
import { phone } from "@/modules/identity/routes";

const optText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => (v === "" ? undefined : v));

export const gstIn = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/, "Enter a valid 15-character GSTIN");
export const pan = z.string().trim().toUpperCase().regex(/^[A-Z]{5}\d{4}[A-Z]$/, "Enter a valid PAN");

const base = {
  name: z.string().trim().min(1, "Name is required").max(120),
  phone,
  address: optText(500),
  contactName: optText(120),
  gstIn: gstIn.optional().or(z.literal("").transform(() => undefined)),
  pan: pan.optional().or(z.literal("").transform(() => undefined)),
  category: optText(60),
  subCategory: optText(60),
};

export const partyInput = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("vendor"), ...base, wageRatePaise: z.undefined().optional() }),
  z.object({ kind: z.literal("client"), ...base, wageRatePaise: z.undefined().optional() }),
  z.object({
    kind: z.literal("labour"),
    ...base,
    category: z.string().trim().min(1, "Trade is required").max(60),
    wageRatePaise: paise.refine((v) => v > 0, "Wage per shift is required"),
  }),
]);
export type PartyInput = z.infer<typeof partyInput>;

export const partyPatch = z
  .object({ ...base, wageRatePaise: paise.refine((v) => v > 0, "Must be greater than 0") })
  .partial()
  .strict();
export type PartyPatch = z.infer<typeof partyPatch>;
