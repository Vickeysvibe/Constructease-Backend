import { Types } from "mongoose";
import { withTransaction } from "@/core/db";
import { invalidState, notFound, validationFailed } from "@/core/errors";
import { containsRegex, paginate, parseSort } from "@/core/http";
import type { RequestContext, SiteContext } from "@/core/context";
import { audit } from "@/core/records";
import { fromMilli, toMilli, todayIn } from "@/core/units";
import { User } from "@/modules/identity/models";
import { Party, publicParty, type PartyDoc } from "@/modules/parties/models";
import { findSiteParty } from "@/modules/parties/routes";
import {
  LedgerEntry,
  Payment,
  partyBalances,
  postLedger,
  reverseLedgerFor,
  type PaymentCategory,
  type PaymentDoc,
  type PostEntry,
} from "./models";
import { partyRuleErrors, type PaymentInput, type PaymentListQuery, type PaymentPatch } from "./schemas";

type Ctx = Pick<RequestContext, "orgId" | "userId" | "tz">;
/** null = org-level payments (no site) */
type SiteId = Types.ObjectId | null;

const hex = (id: Types.ObjectId) => id.toHexString();
const blankToUndef = <T>(v: T | null | undefined) => (v === null || v === "" ? undefined : v);

// ---------- mapping ----------
type Ref = { id: string; name: string };
type PartyRef = Ref & { kind: string };

export function publicPayment(p: PaymentDoc, party?: PartyRef, createdBy?: Ref) {
  return {
    id: hex(p._id),
    siteId: p.siteId ? hex(p.siteId) : null,
    date: p.date,
    direction: p.direction,
    category: p.category,
    partyId: p.partyId ? hex(p.partyId) : undefined,
    party,
    amountPaise: p.amountPaise,
    method: p.method ?? undefined,
    reference: p.reference ?? undefined,
    description: p.description ?? undefined,
    quantity: p.quantityMilli === null || p.quantityMilli === undefined ? undefined : fromMilli(p.quantityMilli),
    unit: p.unit ?? undefined,
    unitCostPaise: p.unitCostPaise ?? undefined,
    status: p.status,
    voidReason: p.voidReason ?? undefined,
    createdBy: createdBy ?? { id: hex(p.createdBy), name: "" },
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}
export type PublicPayment = ReturnType<typeof publicPayment>;

/** Maps payments to API shape with party and creator names, in two queries. */
export async function hydratePayments(orgId: Types.ObjectId, docs: PaymentDoc[]): Promise<PublicPayment[]> {
  const partyIds = docs.flatMap((d) => (d.partyId ? [d.partyId] : []));
  const [parties, users] = await Promise.all([
    partyIds.length ? Party.find({ orgId, _id: { $in: partyIds } }).select("name kind").lean() : [],
    User.find({ orgId, _id: { $in: docs.map((d) => d.createdBy) } }).select("name").lean(),
  ]);
  const partyById = new Map(parties.map((p) => [hex(p._id), { id: hex(p._id), name: p.name, kind: p.kind }]));
  const userById = new Map(users.map((u) => [hex(u._id), { id: hex(u._id), name: u.name }]));
  return docs.map((d) =>
    publicPayment(d, d.partyId ? partyById.get(hex(d.partyId)) : undefined, userById.get(hex(d.createdBy))),
  );
}

// ---------- rules ----------
async function resolveParty(orgId: Types.ObjectId, siteId: SiteId, category: PaymentCategory, partyId?: string | null) {
  const errors = partyRuleErrors(category, partyId);
  if (errors.length) throw validationFailed(errors);
  if (category === "other" || !partyId) return undefined;
  const party = await Party.findOne({ _id: partyId, orgId, kind: category, ...(siteId ? { siteIds: siteId } : {}) })
    .select("_id")
    .lean();
  if (!party) {
    throw validationFailed([
      { path: "partyId", message: siteId ? `Not a ${category} on this site` : `Not a ${category} in your organisation` },
    ]);
  }
  return party._id;
}

type LedgerFields = Pick<
  PaymentDoc,
  "_id" | "orgId" | "siteId" | "partyId" | "category" | "direction" | "date" | "amountPaise" | "reference" | "description"
>;

/** Vendor and client payments post to the party ledger: money in = credit, money out = debit. */
function ledgerEntryFor(p: LedgerFields, createdBy: Types.ObjectId): PostEntry | null {
  if ((p.category !== "vendor" && p.category !== "client") || !p.partyId) return null;
  return {
    orgId: p.orgId,
    siteId: p.siteId ?? null,
    partyId: p.partyId,
    date: p.date,
    sourceType: "payment",
    sourceId: p._id,
    reference: p.reference ?? "",
    description: p.description || (p.direction === "in" ? "Payment received" : "Payment made"),
    debitPaise: p.direction === "out" ? p.amountPaise : 0,
    creditPaise: p.direction === "in" ? p.amountPaise : 0,
    createdBy,
  };
}

const ledgerKey = (p: LedgerFields) => {
  const e = ledgerEntryFor(p, p.orgId);
  return e ? JSON.stringify({ ...e, createdBy: undefined }) : null;
};

async function findPayment(orgId: Types.ObjectId, siteId: SiteId, paymentId: string) {
  const p = await Payment.findOne({ _id: paymentId, orgId, siteId }).lean<PaymentDoc>();
  if (!p) throw notFound("Payment");
  return p;
}

// ---------- operations ----------
export async function listPayments(ctx: Ctx, siteId: SiteId, q: PaymentListQuery) {
  const filter: Record<string, unknown> = { orgId: ctx.orgId, siteId };
  if (q.category) filter.category = q.category;
  if (q.direction) filter.direction = q.direction;
  if (q.partyId) filter.partyId = new Types.ObjectId(q.partyId);
  if (q.status) filter.status = q.status;
  if (q.from || q.to) filter.date = { ...(q.from ? { $gte: q.from } : {}), ...(q.to ? { $lte: q.to } : {}) };
  if (q.q) filter.$or = [{ reference: containsRegex(q.q) }, { description: containsRegex(q.q) }];
  const page = await paginate(
    Payment,
    filter,
    q,
    parseSort(q.sort, ["date", "amountPaise", "createdAt"], { date: -1, createdAt: -1, _id: -1 }),
    (d) => d as unknown as PaymentDoc,
  );
  return { ...page, items: await hydratePayments(ctx.orgId, page.items) };
}

export async function getPayment(ctx: Ctx, siteId: SiteId, paymentId: string) {
  const [p] = await hydratePayments(ctx.orgId, [await findPayment(ctx.orgId, siteId, paymentId)]);
  return p!;
}

export async function createPayment(ctx: Ctx, siteId: SiteId, input: PaymentInput) {
  const partyId = await resolveParty(ctx.orgId, siteId, input.category, input.partyId);
  const created = await withTransaction(async (session) => {
    const [doc] = await Payment.create(
      [
        {
          orgId: ctx.orgId,
          siteId,
          date: input.date,
          direction: input.direction,
          category: input.category,
          partyId,
          amountPaise: input.amountPaise,
          method: input.method,
          reference: blankToUndef(input.reference),
          description: blankToUndef(input.description),
          quantityMilli: input.quantity === undefined ? undefined : toMilli(input.quantity),
          unit: blankToUndef(input.unit),
          unitCostPaise: input.unitCostPaise,
          createdBy: ctx.userId,
        },
      ],
      { session },
    );
    const payment = doc!.toObject() as PaymentDoc;
    const entry = ledgerEntryFor(payment, ctx.userId);
    if (entry) await postLedger([entry], session);
    await audit(
      ctx,
      {
        action: "payment.create",
        entity: "Payment",
        entityId: payment._id,
        siteId: siteId ?? undefined,
        data: { category: input.category, direction: input.direction, amountPaise: input.amountPaise },
      },
      session,
    );
    return payment;
  });
  return (await hydratePayments(ctx.orgId, [created]))[0]!;
}

const OPTIONAL_FIELDS = ["method", "reference", "description", "unit", "unitCostPaise"] as const;

export async function updatePayment(ctx: Ctx, siteId: SiteId, paymentId: string, patch: PaymentPatch) {
  const current = await findPayment(ctx.orgId, siteId, paymentId);
  if (current.status === "void") throw invalidState("A void payment can't be edited.");

  const set: Record<string, unknown> = {};
  const unset: Record<string, 1> = {};
  for (const k of ["date", "direction", "category", "amountPaise"] as const) if (patch[k] !== undefined) set[k] = patch[k];
  for (const k of OPTIONAL_FIELDS) {
    if (patch[k] === undefined) continue;
    const v = blankToUndef(patch[k]);
    if (v === undefined) unset[k] = 1;
    else set[k] = v;
  }
  if (patch.quantity !== undefined) {
    if (patch.quantity === null) unset.quantityMilli = 1;
    else set.quantityMilli = toMilli(patch.quantity);
  }

  // Re-check the party whenever the category or party changes (merged view of old + new).
  const category = (patch.category ?? current.category) as PaymentCategory;
  const partyId = patch.partyId === undefined ? (current.partyId ? hex(current.partyId) : undefined) : patch.partyId;
  if (patch.category !== undefined || patch.partyId !== undefined) {
    const resolved = await resolveParty(ctx.orgId, siteId, category, partyId);
    if (resolved) set.partyId = resolved;
    else unset.partyId = 1;
  }

  const updated = await withTransaction(async (session) => {
    const next = await Payment.findOneAndUpdate(
      { _id: current._id, orgId: ctx.orgId, siteId, status: "posted" },
      { $set: set, ...(Object.keys(unset).length ? { $unset: unset } : {}) },
      { new: true, session, runValidators: true },
    ).lean<PaymentDoc>();
    if (!next) throw invalidState("A void payment can't be edited.");
    // Append-only ledger: reverse the old posting and post the new one, only if the posting changed.
    if (ledgerKey(current) !== ledgerKey(next)) {
      await reverseLedgerFor(ctx.orgId, "payment", current._id, ctx.userId, session);
      const entry = ledgerEntryFor(next, ctx.userId);
      if (entry) await postLedger([entry], session);
    }
    await audit(
      ctx,
      {
        action: "payment.update",
        entity: "Payment",
        entityId: current._id,
        siteId: siteId ?? undefined,
        data: { patch, before: { ...current, _id: undefined, orgId: undefined } },
      },
      session,
    );
    return next;
  });
  return (await hydratePayments(ctx.orgId, [updated]))[0]!;
}

export async function voidPayment(ctx: Ctx, siteId: SiteId, paymentId: string, reason: string) {
  const current = await findPayment(ctx.orgId, siteId, paymentId);
  const voided = await withTransaction(async (session) => {
    const next = await Payment.findOneAndUpdate(
      { _id: current._id, orgId: ctx.orgId, siteId, status: "posted" },
      { $set: { status: "void", voidReason: reason, voidedAt: new Date(), voidedBy: ctx.userId } },
      { new: true, session },
    ).lean<PaymentDoc>();
    if (!next) throw invalidState("This payment is already void.");
    await reverseLedgerFor(ctx.orgId, "payment", current._id, ctx.userId, session);
    await audit(
      ctx,
      { action: "payment.void", entity: "Payment", entityId: current._id, siteId: siteId ?? undefined, data: { reason } },
      session,
    );
    return next;
  });
  return (await hydratePayments(ctx.orgId, [voided]))[0]!;
}

// ---------- party ledger ----------
/** Start of the Indian financial year (1 April) that contains `date`. */
export const financialYearStart = (date: string) => {
  const year = Number(date.slice(0, 4));
  return `${Number(date.slice(5, 7)) >= 4 ? year : year - 1}-04-01`;
};

export async function partyLedger(ctx: Ctx, site: SiteContext, partyId: string, q: { from?: string; to?: string }) {
  const party = await findSiteParty(ctx.orgId, site.id, partyId);
  if (party.kind !== "vendor" && party.kind !== "client") {
    throw invalidState("Ledgers are kept only for vendors and clients.");
  }
  const to = q.to ?? todayIn(ctx.tz);
  const from = q.from ?? financialYearStart(to);
  if (from > to) throw validationFailed([{ path: "query.to", message: "'from' must be on or before 'to'" }]);

  const [opening, rows] = await Promise.all([
    partyBalances(ctx.orgId, { partyIds: [party._id], siteId: site.id, before: from }),
    LedgerEntry.find({ orgId: ctx.orgId, partyId: party._id, siteId: site.id, date: { $gte: from, $lte: to } })
      .sort({ date: 1, createdAt: 1, _id: 1 })
      .lean(),
  ]);
  const openingBalancePaise = opening.get(hex(party._id))?.balancePaise ?? 0;
  let balance = openingBalancePaise;
  const entries = rows.map((e) => {
    balance += (e.creditPaise ?? 0) - (e.debitPaise ?? 0);
    return {
      id: hex(e._id),
      date: e.date,
      sourceType: e.sourceType,
      sourceId: hex(e.sourceId),
      reference: e.reference ?? "",
      description: e.description ?? "",
      debitPaise: e.debitPaise ?? 0,
      creditPaise: e.creditPaise ?? 0,
      balancePaise: balance,
    };
  });
  return { party: publicParty(party as PartyDoc), from, to, openingBalancePaise, entries, closingBalancePaise: balance };
}
