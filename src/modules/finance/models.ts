import mongoose, { Schema, type ClientSession, type InferSchemaType, type Types } from "mongoose";
import { tenantGuard } from "@/core/db";

export const LEDGER_SOURCES = ["goods_receipt", "purchase_return", "payment", "legacy"] as const;
export type LedgerSource = (typeof LEDGER_SOURCES)[number];

/**
 * Party ledger (vendors and clients). balance = Σcredit − Σdebit.
 *  vendor: goods receipt = credit (we owe more); purchase return = debit; payment out = debit.
 *  client: payment in = credit (total received); a refund (payment out) = debit.
 * Append-only: a voided/edited payment posts a reversing entry instead of mutating history.
 */
const LedgerEntrySchema = new Schema(
  {
    orgId: { type: Schema.Types.ObjectId, required: true },
    siteId: { type: Schema.Types.ObjectId }, // null for org-level payments
    partyId: { type: Schema.Types.ObjectId, ref: "Party", required: true },
    date: { type: String, required: true }, // YYYY-MM-DD
    sourceType: { type: String, enum: LEDGER_SOURCES, required: true },
    sourceId: { type: Schema.Types.ObjectId, required: true },
    reference: { type: String, default: "" },
    description: { type: String, default: "" },
    debitPaise: { type: Number, default: 0, min: 0 },
    creditPaise: { type: Number, default: 0, min: 0 },
    /** set on the entry that reverses another (void / edit) */
    reversesId: { type: Schema.Types.ObjectId },
    createdBy: { type: Schema.Types.ObjectId, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
LedgerEntrySchema.index({ orgId: 1, partyId: 1, siteId: 1, date: 1 });
LedgerEntrySchema.index({ orgId: 1, sourceType: 1, sourceId: 1 });
LedgerEntrySchema.plugin(tenantGuard);
LedgerEntrySchema.pre(["updateOne", "updateMany", "findOneAndUpdate", "deleteOne", "deleteMany", "findOneAndDelete"], function () {
  const opts = this.getOptions() as { allowLedgerMutation?: boolean };
  if (!opts.allowLedgerMutation) throw new Error("LedgerEntry is append-only");
});
export const LedgerEntry = mongoose.model("LedgerEntry", LedgerEntrySchema);

export interface PostEntry {
  orgId: Types.ObjectId;
  siteId?: Types.ObjectId | null;
  partyId: Types.ObjectId;
  date: string;
  sourceType: LedgerSource;
  sourceId: Types.ObjectId;
  reference?: string;
  description?: string;
  debitPaise?: number;
  creditPaise?: number;
  createdBy: Types.ObjectId;
}

export async function postLedger(entries: PostEntry[], session?: ClientSession) {
  if (!entries.length) return [];
  return LedgerEntry.create(entries, { session, ordered: true });
}

/** Posts the exact opposite of every live entry for a source (used when a payment is voided or edited). */
export async function reverseLedgerFor(
  orgId: Types.ObjectId,
  sourceType: LedgerSource,
  sourceId: Types.ObjectId,
  createdBy: Types.ObjectId,
  session?: ClientSession,
) {
  const existing = await LedgerEntry.find({ orgId, sourceType, sourceId }).session(session ?? null).lean();
  const reversed = new Set(existing.filter((e) => e.reversesId).map((e) => e.reversesId!.toHexString()));
  const live = existing.filter((e) => !e.reversesId && !reversed.has(e._id.toHexString()));
  return postLedger(
    live.map((e) => ({
      orgId,
      siteId: e.siteId ?? null,
      partyId: e.partyId,
      date: e.date,
      sourceType,
      sourceId,
      reference: e.reference,
      description: `Reversal: ${e.description}`,
      debitPaise: e.creditPaise ?? 0,
      creditPaise: e.debitPaise ?? 0,
      createdBy,
      reversesId: e._id,
    })) as PostEntry[],
    session,
  );
}

/** Balance (Σcredit − Σdebit) per party, optionally per site and/or before a date (exclusive). */
export async function partyBalances(
  orgId: Types.ObjectId,
  opts: { partyIds?: Types.ObjectId[]; siteId?: Types.ObjectId; before?: string; from?: string; to?: string } = {},
) {
  const match: Record<string, unknown> = { orgId };
  if (opts.partyIds) match.partyId = { $in: opts.partyIds };
  if (opts.siteId) match.siteId = opts.siteId;
  const date: Record<string, string> = {};
  if (opts.before) date.$lt = opts.before;
  if (opts.from) date.$gte = opts.from;
  if (opts.to) date.$lte = opts.to;
  if (Object.keys(date).length) match.date = date;
  const rows = await LedgerEntry.aggregate<{ _id: Types.ObjectId; debit: number; credit: number }>([
    { $match: match },
    { $group: { _id: "$partyId", debit: { $sum: "$debitPaise" }, credit: { $sum: "$creditPaise" } } },
  ]);
  return new Map(rows.map((r) => [r._id.toHexString(), { debitPaise: r.debit, creditPaise: r.credit, balancePaise: r.credit - r.debit }]));
}

// ---------- Payments ----------
export const PAYMENT_DIRECTIONS = ["out", "in"] as const;
export const PAYMENT_CATEGORIES = ["vendor", "client", "labour", "other"] as const;
export const PAYMENT_METHODS = ["cash", "bank", "upi", "cheque", "other"] as const;
export type PaymentCategory = (typeof PAYMENT_CATEGORIES)[number];
export type PaymentDirection = (typeof PAYMENT_DIRECTIONS)[number];

/**
 * Money in or out. Vendor/client payments also post a LedgerEntry (in = credit, out = debit);
 * labour and other payments don't (labour balances come from attendance). Never deleted: voided.
 */
const PaymentSchema = new Schema(
  {
    orgId: { type: Schema.Types.ObjectId, required: true },
    /** null for org-level payments (general expenses) */
    siteId: { type: Schema.Types.ObjectId, ref: "Site", default: null },
    date: { type: String, required: true }, // YYYY-MM-DD
    direction: { type: String, enum: PAYMENT_DIRECTIONS, required: true },
    category: { type: String, enum: PAYMENT_CATEGORIES, required: true },
    partyId: { type: Schema.Types.ObjectId, ref: "Party" },
    amountPaise: { type: Number, required: true, min: 1 },
    method: { type: String, enum: PAYMENT_METHODS },
    reference: { type: String, trim: true, maxlength: 120 },
    description: { type: String, trim: true, maxlength: 1000 },
    quantityMilli: { type: Number },
    unit: { type: String, trim: true, maxlength: 30 },
    unitCostPaise: { type: Number, min: 0 },
    status: { type: String, enum: ["posted", "void"], default: "posted" },
    voidReason: { type: String, trim: true, maxlength: 500 },
    voidedAt: { type: Date },
    voidedBy: { type: Schema.Types.ObjectId, ref: "User" },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true },
);
PaymentSchema.index({ orgId: 1, siteId: 1, date: -1 });
PaymentSchema.index({ orgId: 1, partyId: 1, date: 1 });
PaymentSchema.plugin(tenantGuard);
export const Payment = mongoose.model("Payment", PaymentSchema);
export type PaymentDoc = InferSchemaType<typeof PaymentSchema> & { _id: Types.ObjectId; createdAt: Date; updatedAt: Date };
