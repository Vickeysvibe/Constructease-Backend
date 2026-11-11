import { z } from "zod";
import { listQuery, objectId } from "@/core/http";
import type { FieldError } from "@/core/errors";
import { isoDate, paise, positivePaise, positiveQty } from "@/core/units";
import { PAYMENT_CATEGORIES, PAYMENT_DIRECTIONS, PAYMENT_METHODS, type PaymentCategory } from "./models";

const text = (max: number) => z.string().trim().max(max);

const fields = {
  date: isoDate,
  direction: z.enum(PAYMENT_DIRECTIONS),
  category: z.enum(PAYMENT_CATEGORIES),
  partyId: objectId,
  amountPaise: positivePaise,
  method: z.enum(PAYMENT_METHODS),
  reference: text(120),
  description: text(1000),
  quantity: positiveQty,
  unit: text(30),
  unitCostPaise: paise,
};

/** vendor/client/labour payments name a party of that kind; `other` payments must not. */
export function partyRuleErrors(category: PaymentCategory, partyId: string | null | undefined): FieldError[] {
  if (category === "other") {
    return partyId ? [{ path: "partyId", message: "Payments in category 'other' don't have a party" }] : [];
  }
  return partyId ? [] : [{ path: "partyId", message: `Choose the ${category} this payment is for` }];
}

export const paymentInput = z
  .object({
    date: fields.date,
    direction: fields.direction,
    category: fields.category,
    partyId: fields.partyId.optional(),
    amountPaise: fields.amountPaise,
    method: fields.method.optional(),
    reference: fields.reference.optional(),
    description: fields.description.optional(),
    quantity: fields.quantity.optional(),
    unit: fields.unit.optional(),
    unitCostPaise: fields.unitCostPaise.optional(),
  })
  .strict()
  .superRefine((p, ctx) => {
    for (const e of partyRuleErrors(p.category, p.partyId)) ctx.addIssue({ code: "custom", path: [e.path], message: e.message });
  });
export type PaymentInput = z.infer<typeof paymentInput>;

/** Partial update; optional fields can be cleared with `null`. The merged result is re-validated by the service. */
export const paymentPatch = z
  .object({
    date: fields.date,
    direction: fields.direction,
    category: fields.category,
    partyId: fields.partyId.nullable(),
    amountPaise: fields.amountPaise,
    method: fields.method.nullable(),
    reference: fields.reference.nullable(),
    description: fields.description.nullable(),
    quantity: fields.quantity.nullable(),
    unit: fields.unit.nullable(),
    unitCostPaise: fields.unitCostPaise.nullable(),
  })
  .partial()
  .strict();
export type PaymentPatch = z.infer<typeof paymentPatch>;

export const voidInput = z.object({ reason: z.string().trim().min(1, "Give a reason").max(500) }).strict();

const fromTo = { from: isoDate.optional(), to: isoDate.optional() };
const fromBeforeTo = (r: { from?: string; to?: string }) => !r.from || !r.to || r.from <= r.to;
const fromBeforeToMsg = { message: "'from' must be on or before 'to'", path: ["to"] };

export const paymentListQuery = listQuery
  .extend({
    category: z.enum(PAYMENT_CATEGORIES).optional(),
    direction: z.enum(PAYMENT_DIRECTIONS).optional(),
    partyId: objectId.optional(),
    status: z.enum(["posted", "void"]).optional(),
    ...fromTo,
  })
  .refine(fromBeforeTo, fromBeforeToMsg);
export type PaymentListQuery = z.infer<typeof paymentListQuery>;

export const ledgerQuery = z.object(fromTo).refine(fromBeforeTo, fromBeforeToMsg);

export const paymentParams = z.object({ paymentId: objectId });
export const partyParams = z.object({ partyId: objectId });
