import mongoose, { Schema, type ClientSession, type Types } from "mongoose";
import { tenantGuard } from "@/core/db";

export const MOVEMENT_TYPES = ["receipt", "return", "consumption", "adjustment"] as const;
export type MovementType = (typeof MOVEMENT_TYPES)[number];

/**
 * Append-only stock ledger. On-hand stock for (site, product) = Σ qtyMilli. Never update or delete rows;
 * corrections are new rows (returns, adjustments).
 */
const StockMovementSchema = new Schema(
  {
    orgId: { type: Schema.Types.ObjectId, required: true },
    siteId: { type: Schema.Types.ObjectId, required: true },
    productId: { type: Schema.Types.ObjectId, ref: "Product", required: true },
    date: { type: String, required: true }, // YYYY-MM-DD, org timezone
    type: { type: String, enum: MOVEMENT_TYPES, required: true },
    /** signed quantity in thousandths: + receipt / positive adjustment, − return / consumption */
    qtyMilli: { type: Number, required: true },
    /** unit cost in paise (receipt/return price; weighted average for consumption) */
    unitCostPaise: { type: Number, required: true, default: 0 },
    sourceType: { type: String, enum: ["goods_receipt", "purchase_return", "consumption", "adjustment", "legacy"], required: true },
    sourceId: { type: Schema.Types.ObjectId },
    reference: { type: String, default: "" }, // e.g. GR-2026-0004
    notes: { type: String, maxlength: 500 },
    createdBy: { type: Schema.Types.ObjectId, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
StockMovementSchema.index({ orgId: 1, siteId: 1, productId: 1, date: 1 });
StockMovementSchema.index({ orgId: 1, siteId: 1, date: -1 });
StockMovementSchema.index({ orgId: 1, sourceType: 1, sourceId: 1 });
StockMovementSchema.plugin(tenantGuard);
StockMovementSchema.pre(["updateOne", "updateMany", "findOneAndUpdate", "deleteOne", "deleteMany", "findOneAndDelete"], function () {
  const opts = this.getOptions() as { allowLedgerMutation?: boolean };
  if (!opts.allowLedgerMutation) throw new Error("StockMovement is append-only");
});
export const StockMovement = mongoose.model("StockMovement", StockMovementSchema);

/** On-hand quantity (thousandths) per product for a site, optionally restricted to products and/or up to a date. */
export async function onHandMilli(
  orgId: Types.ObjectId,
  siteId: Types.ObjectId,
  opts: { productIds?: Types.ObjectId[]; upTo?: string; session?: ClientSession } = {},
): Promise<Map<string, number>> {
  const match: Record<string, unknown> = { orgId, siteId };
  if (opts.productIds) match.productId = { $in: opts.productIds };
  if (opts.upTo) match.date = { $lte: opts.upTo };
  const rows = await StockMovement.aggregate<{ _id: Types.ObjectId; qty: number }>([
    { $match: match },
    { $group: { _id: "$productId", qty: { $sum: "$qtyMilli" } } },
  ]).session(opts.session ?? null);
  return new Map(rows.map((r) => [r._id.toHexString(), r.qty]));
}

/** Quantity-weighted average receipt cost (paise) per product on a site, net of returns. */
export async function averageCostPaise(
  orgId: Types.ObjectId,
  siteId: Types.ObjectId,
  productIds: Types.ObjectId[],
  session?: ClientSession,
): Promise<Map<string, number>> {
  const rows = await StockMovement.aggregate<{ _id: Types.ObjectId; qty: number; value: number }>([
    { $match: { orgId, siteId, productId: { $in: productIds }, type: { $in: ["receipt", "return"] } } },
    { $group: { _id: "$productId", qty: { $sum: "$qtyMilli" }, value: { $sum: { $multiply: ["$qtyMilli", "$unitCostPaise"] } } } },
  ]).session(session ?? null);
  return new Map(rows.map((r) => [r._id.toHexString(), r.qty > 0 ? Math.round(r.value / r.qty) : 0]));
}

/**
 * One row per (site, product) used only to serialise stock-decreasing transactions. Every transaction
 * that checks on-hand before writing a negative movement first bumps these rows with its session, so two
 * concurrent transactions on the same product hit a write conflict and the driver retries the later one
 * (which then re-reads on-hand and sees the earlier commit).
 */
const StockLockSchema = new Schema(
  {
    orgId: { type: Schema.Types.ObjectId, required: true },
    siteId: { type: Schema.Types.ObjectId, required: true },
    productId: { type: Schema.Types.ObjectId, required: true },
    seq: { type: Number, default: 0 },
  },
  { versionKey: false },
);
StockLockSchema.index({ orgId: 1, siteId: 1, productId: 1 }, { unique: true });
StockLockSchema.plugin(tenantGuard);
export const StockLock = mongoose.model("StockLock", StockLockSchema);

/** Makes sure the lock rows exist. Call OUTSIDE the transaction (an upsert inside one could race into E11000). */
export async function ensureStockLocks(orgId: Types.ObjectId, siteId: Types.ObjectId, productIds: Types.ObjectId[]) {
  await Promise.all(
    productIds.map((productId) =>
      StockLock.updateOne({ orgId, siteId, productId }, { $setOnInsert: { seq: 0 } }, { upsert: true }).catch((err: unknown) => {
        if ((err as { code?: number }).code !== 11000) throw err;
      }),
    ),
  );
}

/** Takes the stock locks for these products inside `session` (see StockLock). */
export async function lockStock(
  orgId: Types.ObjectId,
  siteId: Types.ObjectId,
  productIds: Types.ObjectId[],
  session: ClientSession,
) {
  await StockLock.updateMany({ orgId, siteId, productId: { $in: productIds } }, { $inc: { seq: 1 } }, { session });
}
