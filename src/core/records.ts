/**
 * Cross-cutting persistence helpers: document numbering, audit log, idempotency keys.
 */
import type { RequestHandler } from "express";
import mongoose, { Schema, type ClientSession, type Types } from "mongoose";
import { tenantGuard } from "./db";
import { conflict, badRequest } from "./errors";
import type { RequestContext } from "./context";

// ---------- Counters: PO-2026-0001 ----------
const CounterSchema = new Schema({
  orgId: { type: Schema.Types.ObjectId, required: true },
  key: { type: String, required: true },
  seq: { type: Number, default: 0 },
});
CounterSchema.index({ orgId: 1, key: 1 }, { unique: true });
CounterSchema.plugin(tenantGuard);
export const Counter = mongoose.model("Counter", CounterSchema);

/** Next document number, e.g. nextNumber(org, "PO", "2026-11-11") → "PO-2026-0007". Gap-free inside a transaction. */
export async function nextNumber(orgId: Types.ObjectId, prefix: string, date: string, session?: ClientSession) {
  const year = date.slice(0, 4);
  const key = `${prefix}-${year}`;
  const doc = await Counter.findOneAndUpdate(
    { orgId, key },
    { $inc: { seq: 1 } },
    { upsert: true, new: true, session },
  ).lean();
  return `${key}-${String(doc!.seq).padStart(4, "0")}`;
}

// ---------- Audit log (money & stock changes, user admin) ----------
const AuditSchema = new Schema(
  {
    orgId: { type: Schema.Types.ObjectId, required: true },
    siteId: { type: Schema.Types.ObjectId },
    userId: { type: Schema.Types.ObjectId, required: true },
    action: { type: String, required: true }, // e.g. "payment.void"
    entity: { type: String, required: true },
    entityId: { type: Schema.Types.ObjectId, required: true },
    data: { type: Schema.Types.Mixed },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
AuditSchema.index({ orgId: 1, entity: 1, entityId: 1, createdAt: -1 });
AuditSchema.plugin(tenantGuard);
export const AuditEntry = mongoose.model("AuditEntry", AuditSchema);

export async function audit(
  ctx: Pick<RequestContext, "orgId" | "userId">,
  e: { action: string; entity: string; entityId: Types.ObjectId; siteId?: Types.ObjectId; data?: unknown },
  session?: ClientSession,
) {
  await AuditEntry.create([{ orgId: ctx.orgId, userId: ctx.userId, ...e }], { session });
}

// ---------- Idempotency keys ----------
const IdempotencySchema = new Schema(
  {
    orgId: { type: Schema.Types.ObjectId, required: true },
    userId: { type: Schema.Types.ObjectId, required: true },
    key: { type: String, required: true },
    route: { type: String, required: true },
    state: { type: String, enum: ["processing", "done"], default: "processing" },
    status: Number,
    body: Schema.Types.Mixed,
    createdAt: { type: Date, default: Date.now, expires: 86_400 },
  },
  { versionKey: false },
);
IdempotencySchema.index({ orgId: 1, userId: 1, key: 1 }, { unique: true });
IdempotencySchema.plugin(tenantGuard);
export const IdempotencyRecord = mongoose.model("IdempotencyRecord", IdempotencySchema);

/**
 * Honours the `Idempotency-Key` header on create endpoints. A repeat returns the stored response;
 * a concurrent repeat gets 409. Failed requests (≥ 400) release the key so the client can retry.
 */
export const idempotent: RequestHandler = async (req, res, next) => {
  const key = req.get("Idempotency-Key");
  if (!key || !req.ctx) return next();
  if (key.length > 64) throw badRequest("Idempotency-Key must be at most 64 characters.");
  const scope = { orgId: req.ctx.orgId, userId: req.ctx.userId, key };
  const route = `${req.method} ${req.baseUrl}${req.path}`;
  try {
    await IdempotencyRecord.create({ ...scope, route });
  } catch (err) {
    if ((err as { code?: number }).code !== 11000) throw err;
    const existing = await IdempotencyRecord.findOne(scope).lean();
    if (existing?.route !== route) throw conflict("This Idempotency-Key was already used for a different request.");
    if (existing.state === "done") {
      res.status(existing.status ?? 200).json(existing.body);
      return;
    }
    throw conflict("A request with this Idempotency-Key is still being processed.");
  }
  const json = res.json.bind(res);
  res.json = (body: unknown) => {
    const status = res.statusCode;
    const write =
      status < 400
        ? IdempotencyRecord.updateOne(scope, { $set: { state: "done", status, body } })
        : IdempotencyRecord.deleteOne(scope);
    // Response must not wait on bookkeeping; failures only lose replay protection for this key.
    write.catch(() => undefined);
    return json(body);
  };
  res.on("close", () => {
    if (res.statusCode >= 400) IdempotencyRecord.deleteOne({ ...scope, state: "processing" }).catch(() => undefined);
  });
  next();
};
