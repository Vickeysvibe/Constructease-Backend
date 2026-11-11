import type { Types } from "mongoose";
import { siteCan, visibleSiteIds } from "@/core/access";
import { isOrgAdmin, type RequestContext, type SiteContext } from "@/core/context";
import { dayjs, todayIn } from "@/core/units";
import { Payment, partyBalances } from "@/modules/finance/models";
import { User } from "@/modules/identity/models";
import { avgCostOf, stockTotals } from "@/modules/inventory/service";
import { Party } from "@/modules/parties/models";
import { GoodsReceipt, PurchaseOrder, PurchaseReturn, type PurchaseOrderDoc } from "@/modules/purchasing/models";
import { monthlyTotals } from "@/modules/reports/service";
import { Membership, Site } from "@/modules/sites/models";
import { AttendanceEntry, CheckinDay, type CheckinDayDoc } from "@/modules/workforce/models";
import { checkinTotals } from "@/modules/workforce/service";

type Ctx = RequestContext;
const hex = (id: Types.ObjectId) => id.toHexString();
const OPEN_PO = ["sent", "partially_received"];

/** `YYYY-MM-01` .. `YYYY-MM-31` bounds of the month containing `date` (string compare, so 31 is safe). */
const monthBounds = (date: string) => ({ $gte: `${date.slice(0, 7)}-01`, $lte: `${date.slice(0, 7)}-31` });

type Count = { _id: Types.ObjectId; n: number };
const countMap = (rows: Count[]) => new Map(rows.map((r) => [hex(r._id), r.n]));

/**
 * Org dashboard: one card per visible site. A fixed number of aggregations grouped by site, whatever the
 * number of sites. `monthSpendPaise` (receipts − returns, this calendar month) only where the caller has
 * finance:read (owner/admin or engineer on that site).
 */
export async function orgDashboard(ctx: Ctx) {
  const siteIds = await visibleSiteIds(ctx);
  const today = todayIn(ctx.tz);
  const financeIds = isOrgAdmin(ctx)
    ? siteIds
    : (await Membership.find({ orgId: ctx.orgId, userId: ctx.userId, role: "engineer" }).select("siteId").lean()).map(
        (m) => m.siteId,
      );
  const orgId = ctx.orgId;
  const sumBySite = (model: typeof GoodsReceipt | typeof PurchaseReturn) =>
    financeIds.length
      ? model.aggregate<Count>([
          { $match: { orgId, siteId: { $in: financeIds }, date: monthBounds(today) } },
          { $group: { _id: "$siteId", n: { $sum: "$totalPaise" } } },
        ])
      : Promise.resolve([]);

  const [sites, present, checkedIn, openPOs, received, returned] = await Promise.all([
    Site.find({ orgId, _id: { $in: siteIds } }).select("name status").sort({ name: 1, _id: 1 }).lean(),
    AttendanceEntry.aggregate<Count>([
      { $match: { orgId, siteId: { $in: siteIds }, date: today, status: "present" } },
      { $group: { _id: "$siteId", n: { $sum: 1 } } },
    ]),
    CheckinDay.aggregate<Count>([
      { $match: { orgId, siteId: { $in: siteIds }, date: today, "events.type": "in" } },
      { $group: { _id: "$siteId", n: { $sum: 1 } } },
    ]),
    PurchaseOrder.aggregate<Count>([
      { $match: { orgId, siteId: { $in: siteIds }, status: { $in: OPEN_PO } } },
      { $group: { _id: "$siteId", n: { $sum: 1 } } },
    ]),
    sumBySite(GoodsReceipt),
    sumBySite(PurchaseReturn),
  ]);
  const [presentBy, checkedInBy, openBy, receivedBy, returnedBy] = [present, checkedIn, openPOs, received, returned].map(countMap);
  const finance = new Set(financeIds.map(hex));
  return {
    sites: sites.map((s) => {
      const id = hex(s._id);
      return {
        id,
        name: s.name,
        status: s.status,
        today: { labourPresent: presentBy!.get(id) ?? 0, checkedIn: checkedInBy!.get(id) ?? 0 },
        openPOs: openBy!.get(id) ?? 0,
        ...(finance.has(id) ? { monthSpendPaise: (receivedBy!.get(id) ?? 0) - (returnedBy!.get(id) ?? 0) } : {}),
      };
    }),
  };
}

/** Site dashboard. Money (wages, stock value, finance block, monthly series) only with finance:read. */
export async function siteDashboard(ctx: Ctx, site: SiteContext) {
  const orgId = ctx.orgId;
  const siteId = site.id;
  const showMoney = siteCan(site, "finance:read");
  const today = todayIn(ctx.tz);
  const seriesFrom = dayjs(`${today.slice(0, 7)}-01`, "YYYY-MM-DD").subtract(5, "month").format("YYYY-MM-DD");

  const [attendance, checkins, poCounts, awaiting, stock, balances, monthOut, series] = await Promise.all([
    AttendanceEntry.aggregate<{ _id: string; n: number; shifts: number; wages: number }>([
      { $match: { orgId, siteId, date: today } },
      { $group: { _id: "$status", n: { $sum: 1 }, shifts: { $sum: "$shifts" }, wages: { $sum: "$wagePaise" } } },
    ]),
    CheckinDay.find({ orgId, siteId, date: today, "events.type": "in" }).lean<CheckinDayDoc[]>(),
    PurchaseOrder.aggregate<{ _id: string; n: number }>([
      { $match: { orgId, siteId, status: { $in: OPEN_PO } } },
      { $group: { _id: "$status", n: { $sum: 1 } } },
    ]),
    PurchaseOrder.find({ orgId, siteId, status: { $in: OPEN_PO } })
      .select("number vendorName lines.qtyMilli lines.receivedMilli")
      .sort({ date: 1, _id: 1 })
      .limit(5)
      .lean<Pick<PurchaseOrderDoc, "_id" | "number" | "vendorName" | "lines">[]>(),
    stockTotals(orgId, siteId),
    showMoney ? partyBalances(orgId, { siteId }) : null,
    showMoney
      ? Payment.aggregate<{ n: number }>([
          { $match: { orgId, siteId, status: "posted", direction: "out", date: monthBounds(today) } },
          { $group: { _id: null, n: { $sum: "$amountPaise" } } },
        ])
      : null,
    showMoney ? monthlyTotals({ orgId, siteId }, { from: seriesFrom, to: `${today.slice(0, 7)}-31` }) : null,
  ]);

  // today
  const present = attendance.find((a) => a._id === "present");
  const users = await User.find({ orgId, _id: { $in: checkins.map((c) => c.userId) } }).select("name").lean();
  const userName = new Map(users.map((u) => [hex(u._id), u.name]));
  const checkedIn = checkins
    .map((c) => ({ userId: hex(c.userId), name: userName.get(hex(c.userId)) ?? "", at: checkinTotals(c.events).firstIn! }))
    .sort((a, b) => a.at.getTime() - b.at.getTime())
    .map((c) => ({ ...c, at: c.at.toISOString() }));

  // purchasing
  const poCount = (s: string) => poCounts.find((p) => p._id === s)?.n ?? 0;

  // stock
  let valuePaise = 0;
  for (const t of stock.values()) valuePaise += Math.round((Math.max(t.onHandMilli, 0) * avgCostOf(t)) / 1000);

  // finance: balances per party on this site, split by party kind
  let finance: { vendorPayablePaise: number; clientReceivedPaise: number; monthPaymentsOutPaise: number } | undefined;
  if (balances) {
    const parties = balances.size
      ? await Party.find({ orgId, _id: { $in: [...balances.keys()] } }).select("kind").lean()
      : [];
    finance = { vendorPayablePaise: 0, clientReceivedPaise: 0, monthPaymentsOutPaise: monthOut?.[0]?.n ?? 0 };
    for (const p of parties) {
      const b = balances.get(hex(p._id))!.balancePaise;
      if (p.kind === "vendor") finance.vendorPayablePaise += b;
      else if (p.kind === "client") finance.clientReceivedPaise += b;
    }
  }

  return {
    today: {
      date: today,
      labourPresent: present?.n ?? 0,
      labourAbsent: attendance.find((a) => a._id === "absent")?.n ?? 0,
      shifts: present?.shifts ?? 0,
      ...(showMoney ? { wagesPaise: present?.wages ?? 0 } : {}),
      checkedIn,
    },
    purchasing: {
      openPOs: poCount("sent") + poCount("partially_received"),
      partiallyReceived: poCount("partially_received"),
      awaitingDelivery: awaiting.map((po) => ({
        id: hex(po._id),
        number: po.number,
        vendorName: po.vendorName,
        pendingLines: po.lines.filter((l) => l.qtyMilli - (l.receivedMilli ?? 0) > 0).length,
      })),
    },
    ...(finance ? { finance } : {}),
    stock: { items: stock.size, ...(showMoney ? { valuePaise } : {}) },
    ...(series
      ? {
          series: series.map((m) => ({
            month: m.month,
            materialSpendPaise: m.receivedPaise - m.returnedPaise,
            wagesPaise: m.wagesPaise,
            paymentsOutPaise: m.paymentsOutPaise,
            paymentsInPaise: m.paymentsInPaise,
          })),
        }
      : {}),
  };
}
