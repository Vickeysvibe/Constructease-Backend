import { Types } from "mongoose";
import { dayjs, eachDay, fromMilli, monthOf } from "@/core/units";
import type { SiteContext } from "@/core/context";
import { AttendanceEntry } from "@/modules/workforce/models";
import { LedgerEntry, Payment, PAYMENT_CATEGORIES, type PaymentDoc } from "@/modules/finance/models";
import { hydratePayments, partyLedger } from "@/modules/finance/service";
import { StockMovement } from "@/modules/inventory/models";
import { Party } from "@/modules/parties/models";
import { findSiteParty } from "@/modules/parties/routes";
import { Product } from "@/modules/products/models";
import { GoodsReceipt, PurchaseReturn } from "@/modules/purchasing/models";

/** Who/where a report is computed for. Reports run both in requests and in the export worker. */
export interface ReportScope {
  orgId: Types.ObjectId;
  siteId: Types.ObjectId;
  userId: Types.ObjectId;
  tz: string;
}
export interface Range {
  from: string;
  to: string;
}

const hex = (id: Types.ObjectId) => id.toHexString();
const inRange = (r: Range) => ({ $gte: r.from, $lte: r.to });
const UNCATEGORISED = "Uncategorised";

/** `YYYY-MM` keys from `from`'s month to `to`'s month inclusive (years never merge: keys carry the year). */
export function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  const last = monthOf(to);
  for (let m = dayjs(`${monthOf(from)}-01`, "YYYY-MM-DD"); m.format("YYYY-MM") <= last; m = m.add(1, "month")) {
    out.push(m.format("YYYY-MM"));
  }
  return out;
}

// ======================= Monthly totals (site summary + dashboard series) =======================

export interface MonthTotals {
  month: string;
  receivedPaise: number;
  returnedPaise: number;
  shifts: number;
  wagesPaise: number;
  paymentsInPaise: number;
  paymentsOutPaise: number;
}

const byMonth = { $substrBytes: ["$date", 0, 7] };

/**
 * Per-month material, labour and payment totals for a site over an inclusive range: four grouped
 * aggregations, every month of the range present (zeros when empty). Material values are receipt/return
 * totals incl. tax (what the vendor ledger carries); wages are the attendance snapshots; payments are posted only.
 */
export async function monthlyTotals(scope: Pick<ReportScope, "orgId" | "siteId">, range: Range): Promise<MonthTotals[]> {
  const match = { orgId: scope.orgId, siteId: scope.siteId, date: inRange(range) };
  type Sum = { _id: string; total: number };
  const [receipts, returns, labour, payments] = await Promise.all([
    GoodsReceipt.aggregate<Sum>([{ $match: match }, { $group: { _id: byMonth, total: { $sum: "$totalPaise" } } }]),
    PurchaseReturn.aggregate<Sum>([{ $match: match }, { $group: { _id: byMonth, total: { $sum: "$totalPaise" } } }]),
    AttendanceEntry.aggregate<Sum & { shifts: number }>([
      { $match: match },
      { $group: { _id: byMonth, total: { $sum: "$wagePaise" }, shifts: { $sum: "$shifts" } } },
    ]),
    Payment.aggregate<{ _id: { m: string; d: string }; total: number }>([
      { $match: { ...match, status: "posted" } },
      { $group: { _id: { m: byMonth, d: "$direction" }, total: { $sum: "$amountPaise" } } },
    ]),
  ]);
  const months = new Map<string, MonthTotals>(
    monthsBetween(range.from, range.to).map((month) => [
      month,
      { month, receivedPaise: 0, returnedPaise: 0, shifts: 0, wagesPaise: 0, paymentsInPaise: 0, paymentsOutPaise: 0 },
    ]),
  );
  for (const r of receipts) months.get(r._id)!.receivedPaise += r.total;
  for (const r of returns) months.get(r._id)!.returnedPaise += r.total;
  for (const r of labour) {
    months.get(r._id)!.wagesPaise += r.total;
    months.get(r._id)!.shifts += r.shifts;
  }
  for (const r of payments) {
    const m = months.get(r._id.m)!;
    if (r._id.d === "in") m.paymentsInPaise += r.total;
    else m.paymentsOutPaise += r.total;
  }
  return [...months.values()];
}

// ======================= Labour wages =======================

export async function labourWagesReport(scope: ReportScope, q: Range & { category?: string }) {
  const { orgId, siteId } = scope;
  const [attendance, paid] = await Promise.all([
    AttendanceEntry.aggregate<{
      _id: Types.ObjectId;
      marks: { date: string; shifts: number }[];
      days: number;
      shifts: number;
      wages: number;
    }>([
      { $match: { orgId, siteId, date: inRange(q) } },
      {
        $group: {
          _id: "$labourId",
          marks: { $push: { date: "$date", shifts: "$shifts" } },
          days: { $sum: { $cond: [{ $eq: ["$status", "present"] }, 1, 0] } },
          shifts: { $sum: "$shifts" },
          wages: { $sum: "$wagePaise" },
        },
      },
    ]),
    // Labour payments on this site in the range (refunds — direction "in" — net off).
    Payment.aggregate<{ _id: Types.ObjectId; paid: number }>([
      { $match: { orgId, siteId, category: "labour", status: "posted", partyId: { $ne: null }, date: inRange(q) } },
      {
        $group: {
          _id: "$partyId",
          paid: { $sum: { $cond: [{ $eq: ["$direction", "out"] }, "$amountPaise", { $multiply: ["$amountPaise", -1] }] } },
        },
      },
    ]),
  ]);
  // Anyone with an entry or a payment in range — even if since detached from the site or archived.
  const ids = [...new Set([...attendance, ...paid].map((r) => hex(r._id)))];
  const partyFilter: Record<string, unknown> = { orgId, kind: "labour", _id: { $in: ids } };
  if (q.category) {
    partyFilter.category =
      q.category.toLowerCase() === UNCATEGORISED.toLowerCase() ? { $in: [null, ""] } : q.category;
  }
  const labour = ids.length
    ? await Party.find(partyFilter).select("name category subCategory").sort({ name: 1, _id: 1 }).lean()
    : [];
  const att = new Map(attendance.map((a) => [hex(a._id), a]));
  const paidBy = new Map(paid.map((p) => [hex(p._id), p.paid]));

  const totals = { shifts: 0, wagesPaise: 0, paidPaise: 0, balancePaise: 0 };
  const rows = labour.map((p) => {
    const a = att.get(hex(p._id));
    const shiftsByDate: Record<string, number> = {};
    for (const m of [...(a?.marks ?? [])].sort((x, y) => x.date.localeCompare(y.date))) shiftsByDate[m.date] = m.shifts;
    const wagesPaise = a?.wages ?? 0;
    const paidPaise = paidBy.get(hex(p._id)) ?? 0;
    const row = {
      labourId: hex(p._id),
      name: p.name,
      category: p.category || UNCATEGORISED,
      subCategory: p.subCategory ?? undefined,
      shiftsByDate,
      days: a?.days ?? 0,
      shifts: a?.shifts ?? 0,
      wagesPaise,
      paidPaise,
      balancePaise: wagesPaise - paidPaise,
    };
    totals.shifts += row.shifts;
    totals.wagesPaise += wagesPaise;
    totals.paidPaise += paidPaise;
    totals.balancePaise += row.balancePaise;
    return row;
  });
  return { from: q.from, to: q.to, days: eachDay(q.from, q.to), rows, totals };
}
export type LabourWagesReport = Awaited<ReturnType<typeof labourWagesReport>>;

// ======================= Vendor ledger =======================

/** Single-vendor ledger: exactly the party ledger (`GET …/parties/:id/ledger`) for the range. */
export async function vendorLedgerDetail(scope: ReportScope, vendorId: string, range: Range) {
  await findSiteParty(scope.orgId, scope.siteId, vendorId, "vendor");
  return partyLedger(scope, { id: scope.siteId } as SiteContext, vendorId, range);
}
export type VendorLedgerDetail = Awaited<ReturnType<typeof vendorLedgerDetail>>;

const sumIf = (cond: unknown, value: unknown) => ({ $sum: { $cond: [cond, value, 0] } });
const net = { $subtract: ["$creditPaise", "$debitPaise"] };
const negNet = { $subtract: ["$debitPaise", "$creditPaise"] };

/**
 * One row per vendor attached to the site or with ledger entries on it, from ONE aggregation over the
 * site's ledger. Amounts are netted per source type, so a reversal (void/edit of a payment, which posts the
 * mirror entry) cancels its original: a voided payment contributes 0 to `paidPaise`.
 */
export async function vendorLedgerSummary(scope: ReportScope, range: Range) {
  const { orgId, siteId } = scope;
  const inR = { $gte: ["$date", range.from] };
  const rows = await LedgerEntry.aggregate<{
    _id: Types.ObjectId;
    opening: number;
    received: number;
    returned: number;
    paid: number;
    other: number;
  }>([
    { $match: { orgId, siteId, date: { $lte: range.to } } },
    {
      $group: {
        _id: "$partyId",
        opening: sumIf({ $lt: ["$date", range.from] }, net),
        received: sumIf({ $and: [inR, { $eq: ["$sourceType", "goods_receipt"] }] }, net),
        returned: sumIf({ $and: [inR, { $eq: ["$sourceType", "purchase_return"] }] }, negNet),
        paid: sumIf({ $and: [inR, { $eq: ["$sourceType", "payment"] }] }, negNet),
        // migrated (legacy) entries in range: folded into `received` as a net credit
        other: sumIf({ $and: [inR, { $eq: ["$sourceType", "legacy"] }] }, net),
      },
    },
  ]);
  const vendors = await Party.find({ orgId, kind: "vendor", $or: [{ siteIds: siteId }, { _id: { $in: rows.map((r) => r._id) } }] })
    .select("name")
    .sort({ name: 1, _id: 1 })
    .lean();
  const byId = new Map(rows.map((r) => [hex(r._id), r]));
  const totals = { openingBalancePaise: 0, receivedPaise: 0, returnedPaise: 0, paidPaise: 0, closingBalancePaise: 0 };
  const out = vendors.map((v) => {
    const r = byId.get(hex(v._id));
    const row = {
      vendorId: hex(v._id),
      name: v.name,
      openingBalancePaise: r?.opening ?? 0,
      receivedPaise: (r?.received ?? 0) + (r?.other ?? 0),
      returnedPaise: r?.returned ?? 0,
      paidPaise: r?.paid ?? 0,
      closingBalancePaise: 0,
    };
    row.closingBalancePaise = row.openingBalancePaise + row.receivedPaise - row.returnedPaise - row.paidPaise;
    for (const k of Object.keys(totals) as (keyof typeof totals)[]) totals[k] += row[k];
    return row;
  });
  return { from: range.from, to: range.to, rows: out, totals };
}
export type VendorLedgerSummary = Awaited<ReturnType<typeof vendorLedgerSummary>>;

// ======================= Payments =======================

export async function paymentsReport(
  scope: ReportScope,
  q: Range & { category?: (typeof PAYMENT_CATEGORIES)[number]; direction?: "in" | "out" },
) {
  const filter: Record<string, unknown> = { orgId: scope.orgId, siteId: scope.siteId, status: "posted", date: inRange(q) };
  if (q.category) filter.category = q.category;
  if (q.direction) filter.direction = q.direction;
  const docs = await Payment.find(filter).sort({ date: 1, createdAt: 1, _id: 1 }).lean<PaymentDoc[]>();
  const byCategory = new Map<string, { category: string; inPaise: number; outPaise: number }>();
  const totals = { inPaise: 0, outPaise: 0 };
  for (const d of docs) {
    const c = byCategory.get(d.category) ?? { category: d.category, inPaise: 0, outPaise: 0 };
    byCategory.set(d.category, c);
    const key = d.direction === "in" ? "inPaise" : "outPaise";
    c[key] += d.amountPaise;
    totals[key] += d.amountPaise;
  }
  return {
    from: q.from,
    to: q.to,
    rows: await hydratePayments(scope.orgId, docs),
    totals: {
      ...totals,
      byCategory: PAYMENT_CATEGORIES.flatMap((c) => (byCategory.has(c) ? [byCategory.get(c)!] : [])),
    },
  };
}
export type PaymentsReport = Awaited<ReturnType<typeof paymentsReport>>;

// ======================= Stock =======================

/**
 * Per product: opening (movements before `from`), in-range movements by type, closing, and closing value at
 * the quantity-weighted average receipt cost net of returns as of `to` (same rule as GET /stock).
 */
export async function stockReport(scope: ReportScope, q: Range & { productId?: string }) {
  const match: Record<string, unknown> = { orgId: scope.orgId, siteId: scope.siteId, date: { $lte: q.to } };
  if (q.productId) match.productId = new Types.ObjectId(q.productId);
  const inR = { $gte: ["$date", q.from] };
  const isType = (t: string) => ({ $and: [inR, { $eq: ["$type", t] }] });
  const costed = { $in: ["$type", ["receipt", "return"]] };
  const rows = await StockMovement.aggregate<{
    _id: Types.ObjectId;
    opening: number;
    received: number;
    returned: number;
    consumed: number;
    adjusted: number;
    costQty: number;
    costValue: number;
  }>([
    { $match: match },
    {
      $group: {
        _id: "$productId",
        opening: sumIf({ $lt: ["$date", q.from] }, "$qtyMilli"),
        received: sumIf(isType("receipt"), "$qtyMilli"),
        returned: sumIf(isType("return"), { $multiply: ["$qtyMilli", -1] }),
        consumed: sumIf(isType("consumption"), { $multiply: ["$qtyMilli", -1] }),
        adjusted: sumIf(isType("adjustment"), "$qtyMilli"),
        costQty: sumIf(costed, "$qtyMilli"),
        costValue: sumIf(costed, { $multiply: ["$qtyMilli", "$unitCostPaise"] }),
      },
    },
  ]);
  const products = rows.length
    ? await Product.find({ orgId: scope.orgId, _id: { $in: rows.map((r) => r._id) } }).select("name unit").lean()
    : [];
  const productById = new Map(products.map((p) => [hex(p._id), p]));
  let closingValuePaise = 0;
  const out = rows
    .map((r) => {
      const p = productById.get(hex(r._id));
      const closing = r.opening + r.received - r.returned - r.consumed + r.adjusted;
      const avg = r.costQty > 0 ? Math.round(r.costValue / r.costQty) : 0;
      const value = Math.round((Math.max(closing, 0) * avg) / 1000);
      closingValuePaise += value;
      return {
        productId: hex(r._id),
        productName: p?.name ?? "",
        unit: p?.unit ?? "",
        openingQty: fromMilli(r.opening),
        receivedQty: fromMilli(r.received),
        returnedQty: fromMilli(r.returned),
        consumedQty: fromMilli(r.consumed),
        adjustedQty: fromMilli(r.adjusted),
        closingQty: fromMilli(closing),
        avgCostPaise: avg,
        closingValuePaise: value,
      };
    })
    .sort((a, b) => a.productName.localeCompare(b.productName, "en", { sensitivity: "base" }));
  return { from: q.from, to: q.to, rows: out, totals: { closingValuePaise } };
}
export type StockReport = Awaited<ReturnType<typeof stockReport>>;

// ======================= Site summary =======================

export async function siteSummaryReport(scope: ReportScope, q: Range) {
  const months = await monthlyTotals(scope, q);
  const sum = (k: keyof Omit<MonthTotals, "month">) => months.reduce((s, m) => s + m[k], 0);
  const receivedPaise = sum("receivedPaise");
  const returnedPaise = sum("returnedPaise");
  return {
    from: q.from,
    to: q.to,
    materials: { receivedPaise, returnedPaise, netPaise: receivedPaise - returnedPaise },
    labour: { shifts: sum("shifts"), wagesPaise: sum("wagesPaise") },
    payments: { inPaise: sum("paymentsInPaise"), outPaise: sum("paymentsOutPaise") },
    byMonth: months.map((m) => ({
      month: m.month,
      materialsPaise: m.receivedPaise - m.returnedPaise,
      wagesPaise: m.wagesPaise,
      paymentsOutPaise: m.paymentsOutPaise,
      paymentsInPaise: m.paymentsInPaise,
    })),
  };
}
export type SiteSummaryReport = Awaited<ReturnType<typeof siteSummaryReport>>;
