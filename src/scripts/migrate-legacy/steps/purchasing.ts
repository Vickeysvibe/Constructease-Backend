/**
 * PurchaseOrders + MaterialInwards/Materials + PurchaseReturns → PurchaseOrder, GoodsReceipt, PurchaseReturn,
 * StockMovement (receipt / return / legacy usage) and vendor LedgerEntry rows. One old PO (with all its
 * inwards and returns) is migrated as one transaction.
 */
import type { Types } from "mongoose";
import { priceLine } from "@/core/units";
import { GoodsReceipt, PurchaseOrder, PurchaseReturn } from "@/modules/purchasing/models";
import { StockMovement } from "@/modules/inventory/models";
import { LedgerEntry } from "@/modules/finance/models";
import { Party } from "@/modules/parties/models";
import type { LMaterial, LMaterialInward, LPurchaseOrder, LPurchaseReturn } from "../legacy";
import { businessDate, percentToBp, str, toDate, toMilliSafe, toPaise } from "../clean";
import { newId, type Migration, type OrgState } from "../context";

interface Line {
  _id: Types.ObjectId;
  productId: Types.ObjectId;
  productName: string;
  unit: string;
  qtyMilli: number;
  unitPricePaise: number;
  taxRateBp: number;
  receivedMilli: number;
  returnedMilli: number;
  priced: boolean;
}
interface Alloc {
  line: Line;
  qtyMilli: number;
  returnedMilli: number;
}
interface DocLine {
  _id: Types.ObjectId;
  poLineId: Types.ObjectId;
  productId: Types.ObjectId;
  productName: string;
  unit: string;
  qtyMilli: number;
  unitPricePaise: number;
  taxRateBp: number;
  amountPaise: number;
  taxPaise: number;
  totalPaise: number;
}

const groupBy = <T>(items: T[], key: (t: T) => string | undefined) => {
  const out = new Map<string, T[]>();
  for (const it of items) {
    const k = key(it);
    if (!k) continue;
    const list = out.get(k) ?? [];
    list.push(it);
    out.set(k, list);
  }
  return out;
};
const time = (d: unknown) => toDate(d)?.getTime() ?? 0;
const pad = (n: number) => String(n).padStart(4, "0");
const totalsOf = (lines: { amountPaise: number; taxPaise: number; totalPaise: number }[]) => ({
  subtotalPaise: lines.reduce((s, l) => s + l.amountPaise, 0),
  taxPaise: lines.reduce((s, l) => s + l.taxPaise, 0),
  totalPaise: lines.reduce((s, l) => s + l.totalPaise, 0),
});

/**
 * Deterministic document numbers: rank of the old record (by date, then createdAt, then id) within
 * (org, prefix, year). The orgs are created by this migration, so nothing else uses these sequences and a
 * re-run produces exactly the same numbers.
 */
function assignNumbers<T extends { _id: Types.ObjectId }>(
  m: Migration,
  prefix: string,
  docs: { doc: T; org: OrgState; date: string; sortAt: number }[],
) {
  const out = new Map<string, { number: string; date: string }>();
  const sorted = [...docs].sort(
    (a, b) => a.date.localeCompare(b.date) || a.sortAt - b.sortAt || String(a.doc._id).localeCompare(String(b.doc._id)),
  );
  const seq = new Map<string, number>();
  for (const d of sorted) {
    const year = d.date.slice(0, 4);
    const k = `${d.org.orgId.toHexString()}|${year}`;
    const n = (seq.get(k) ?? 0) + 1;
    seq.set(k, n);
    m.useNumber(d.org.orgId, prefix, year, n);
    out.set(String(d.doc._id), { number: `${prefix}-${year}-${pad(n)}`, date: d.date });
  }
  return out;
}

export async function migratePurchasing(m: Migration) {
  const { legacy, report, tz } = m;
  const materials = new Map(legacy.materials.map((x) => [String(x._id), x]));
  const inwardsByPo = groupBy(legacy.materialInwards, (i) => (i.POid ? String(i.POid) : undefined));
  const returnsByPo = groupBy(legacy.purchaseReturns, (r) => (r.POid ? String(r.POid) : undefined));
  const poById = new Map(legacy.purchaseOrders.map((p) => [String(p._id), p]));
  report.count("purchaseOrders", "read", legacy.purchaseOrders.length);
  report.count("materialInwards", "read", legacy.materialInwards.length);
  report.count("materials", "read", legacy.materials.length);
  report.count("purchaseReturns", "read", legacy.purchaseReturns.length);

  // Materials not listed by any inward (the old controller saved them without awaiting) carry no receipt.
  const listed = new Set(legacy.materialInwards.flatMap((i) => (i.materials ?? []).map(String)));
  for (const mat of legacy.materials) {
    if (listed.has(String(mat._id))) continue;
    report.count("materials", "skipped");
    report.add("orphanMaterials", {
      materialId: String(mat._id),
      poId: mat.POid ? String(mat.POid) : null,
      suppliedQty: mat.suppliedQty,
      usedQty: mat.usedQty,
      message: "material is not referenced by any material inward; not imported",
    });
  }
  for (const i of legacy.materialInwards) {
    if (!i.POid || !poById.has(String(i.POid))) report.error("materialInwards", i._id, `purchase order ${String(i.POid)} does not exist`);
  }
  for (const r of legacy.purchaseReturns) {
    if (!r.POid || !poById.has(String(r.POid))) report.error("purchaseReturns", r._id, `purchase order ${String(r.POid)} does not exist`);
  }

  // ---- numbering (per org, in date order) ----
  const poOrg = (po: LPurchaseOrder) => m.siteOf(po.siteId)?.org;
  const poDocs: { doc: LPurchaseOrder; org: OrgState; date: string; sortAt: number }[] = [];
  const grDocs: { doc: LMaterialInward; org: OrgState; date: string; sortAt: number }[] = [];
  const prDocs: { doc: LPurchaseReturn; org: OrgState; date: string; sortAt: number }[] = [];
  for (const po of legacy.purchaseOrders) {
    const org = poOrg(po);
    if (!org) continue;
    poDocs.push({ doc: po, org, date: businessDate(po.date, tz, po.createdAt) ?? "1970-01-01", sortAt: time(po.createdAt) });
    for (const i of inwardsByPo.get(String(po._id)) ?? []) {
      grDocs.push({ doc: i, org, date: businessDate(i.createdAt, tz, po.date) ?? "1970-01-01", sortAt: time(i.createdAt) });
    }
    for (const r of returnsByPo.get(String(po._id)) ?? []) {
      prDocs.push({ doc: r, org, date: businessDate(r.createdAt, tz, po.date) ?? "1970-01-01", sortAt: time(r.createdAt) });
    }
  }
  const poNo = assignNumbers(m, "PO", poDocs);
  const grNo = assignNumbers(m, "GR", grDocs);
  const prNo = assignNumbers(m, "PR", prDocs);

  for (const { doc: po } of [...poDocs].sort((a, b) => poNo.get(String(a.doc._id))!.number.localeCompare(poNo.get(String(b.doc._id))!.number))) {
    await migrateOne(m, po, inwardsByPo.get(String(po._id)) ?? [], returnsByPo.get(String(po._id)) ?? [], materials, poNo, grNo, prNo);
  }
  for (const po of legacy.purchaseOrders) {
    if (!poOrg(po)) {
      report.error("purchaseOrders", po._id, `site ${String(po.siteId)} was not migrated`);
      for (const i of inwardsByPo.get(String(po._id)) ?? []) report.error("materialInwards", i._id, "its purchase order was not migrated");
      for (const r of returnsByPo.get(String(po._id)) ?? []) report.error("purchaseReturns", r._id, "its purchase order was not migrated");
    }
  }
}

async function migrateOne(
  m: Migration,
  po: LPurchaseOrder,
  inwards: LMaterialInward[],
  returns: LPurchaseReturn[],
  materials: Map<string, LMaterial>,
  poNo: Map<string, { number: string; date: string }>,
  grNo: Map<string, { number: string; date: string }>,
  prNo: Map<string, { number: string; date: string }>,
) {
  const { report, tz } = m;
  const oldId = String(po._id);
  const site = m.siteOf(po.siteId)!;
  const org = site.org;
  const matCount = inwards.reduce((s, i) => s + (i.materials?.length ?? 0), 0);
  const failChildren = (message: string) => {
    for (const i of inwards) report.error("materialInwards", i._id, message);
    for (const r of returns) report.error("purchaseReturns", r._id, message);
    report.count("materials", "errors", matCount);
  };
  if (m.mapped("purchase_order", oldId)) {
    report.count("purchaseOrders", "alreadyMigrated");
    report.count("materialInwards", "alreadyMigrated", inwards.length);
    report.count("purchaseReturns", "alreadyMigrated", returns.length);
    report.count("materials", "alreadyMigrated", matCount);
    return;
  }
  const vendor = m.parties.get(`vendor:${String(po.vendorId)}`);
  if (!vendor || vendor.org !== org) {
    report.error("purchaseOrders", oldId, `vendor ${String(po.vendorId)} was not migrated (or belongs to another engineer)`);
    failChildren("its purchase order was not migrated");
    return;
  }
  const { number, date } = poNo.get(oldId)!;
  const adjust = (message: string, extra: Record<string, unknown> = {}) =>
    report.add("purchaseOrderAdjustments", { poId: oldId, number, message, ...extra });

  // ---- PO lines from order[] ----
  const lines: Line[] = [];
  for (const [i, o] of (po.order ?? []).entries()) {
    const product = m.products.get(String(o.productId));
    if (!product || !product.orgId.equals(org.orgId)) {
      adjust(`order line ${i + 1}: product ${String(o.productId)} was not migrated; line dropped`);
      continue;
    }
    const qtyMilli = toMilliSafe(o.requiredQty);
    if (qtyMilli < 1) {
      adjust(`order line ${i + 1}: requiredQty ${String(o.requiredQty)} is not positive; line dropped`);
      continue;
    }
    lines.push({
      _id: newId(),
      productId: product.id,
      productName: product.name,
      unit: product.unit,
      qtyMilli,
      unitPricePaise: 0,
      taxRateBp: product.defaultTaxRateBp,
      receivedMilli: 0,
      returnedMilli: 0,
      priced: false,
    });
  }
  const priceFrom = (line: Line, mat: LMaterial) => {
    if (line.priced) return;
    line.unitPricePaise = Math.max(0, toPaise(mat.unitPrice));
    line.taxRateBp = percentToBp(mat.tax) ?? line.taxRateBp;
    line.priced = true;
  };

  // ---- inwards → receipts, materials allocated to PO lines by product in line order ----
  const matAllocs = new Map<string, { mat: LMaterial; allocs: Alloc[]; grDate: string; productId: Types.ObjectId }>();
  const receipts: { oldId: string; id: Types.ObjectId; number: string; date: string; lines: DocLine[]; oldTotal: number }[] = [];
  const sortedInwards = [...inwards].sort((a, b) => time(a.createdAt) - time(b.createdAt));
  for (const inward of sortedInwards) {
    const gr = grNo.get(String(inward._id))!;
    const grLines: DocLine[] = [];
    for (const matId of inward.materials ?? []) {
      const mat = materials.get(String(matId));
      if (!mat) {
        report.add("orphanMaterials", { inwardId: String(inward._id), materialId: String(matId), message: "inward lists a material that does not exist" });
        continue;
      }
      if (matAllocs.has(String(mat._id))) continue; // listed twice
      const product = m.products.get(String(mat.productId));
      let remaining = toMilliSafe(mat.suppliedQty);
      if (!product || !product.orgId.equals(org.orgId) || remaining < 1) {
        report.count("materials", "skipped");
        adjust(`material ${String(mat._id)}: ${!product ? "product not migrated" : "supplied quantity is not positive"}; not received`);
        continue;
      }
      let candidates = lines.filter((l) => l.productId.equals(product.id));
      if (!candidates.length) {
        const extra: Line = {
          _id: newId(),
          productId: product.id,
          productName: product.name,
          unit: product.unit,
          qtyMilli: remaining,
          unitPricePaise: 0,
          taxRateBp: product.defaultTaxRateBp,
          receivedMilli: 0,
          returnedMilli: 0,
          priced: false,
        };
        lines.push(extra);
        candidates = [extra];
        adjust(`material ${String(mat._id)}: product "${product.name}" was received but not ordered; added a PO line`);
      }
      const allocs: Alloc[] = [];
      for (const line of candidates) {
        const take = Math.min(remaining, line.qtyMilli - line.receivedMilli);
        if (take <= 0) continue;
        allocs.push({ line, qtyMilli: take, returnedMilli: 0 });
        line.receivedMilli += take;
        remaining -= take;
        if (!remaining) break;
      }
      if (remaining > 0) {
        const last = candidates[candidates.length - 1]!;
        const a = allocs.find((x) => x.line === last);
        if (a) a.qtyMilli += remaining;
        else allocs.push({ line: last, qtyMilli: remaining, returnedMilli: 0 });
        last.receivedMilli += remaining;
        adjust(`material ${String(mat._id)}: received ${remaining / 1000} more "${product.name}" than ordered (over-receipt kept)`);
      }
      const unitPricePaise = Math.max(0, toPaise(mat.unitPrice));
      for (const a of allocs) {
        priceFrom(a.line, mat);
        const taxRateBp = percentToBp(mat.tax) ?? a.line.taxRateBp;
        grLines.push({
          _id: newId(),
          poLineId: a.line._id,
          productId: product.id,
          productName: product.name,
          unit: product.unit,
          qtyMilli: a.qtyMilli,
          unitPricePaise,
          taxRateBp,
          ...priceLine(a.qtyMilli, unitPricePaise, taxRateBp),
        });
      }
      matAllocs.set(String(mat._id), { mat, allocs, grDate: gr.date, productId: product.id });
    }
    if (!grLines.length) {
      report.error("materialInwards", inward._id, "no importable materials; receipt not created");
      continue;
    }
    receipts.push({ oldId: String(inward._id), id: newId(), number: gr.number, date: gr.date, lines: grLines, oldTotal: toPaise(inward.grandTotal) });
  }

  // ---- returns: materialId → the PO line(s) that material was received on ----
  const matReturned = new Map<string, number>();
  const returnDocs: { oldId: string; id: Types.ObjectId; number: string; date: string; lines: DocLine[] }[] = [];
  for (const ret of [...returns].sort((a, b) => time(a.createdAt) - time(b.createdAt))) {
    const pr = prNo.get(String(ret._id))!;
    const prLines: DocLine[] = [];
    for (const [i, item] of (ret.order ?? []).entries()) {
      const got = item.materialId ? matAllocs.get(String(item.materialId)) : undefined;
      let remaining = toMilliSafe(item.returnQty);
      if (!got || remaining < 1) {
        adjust(`return ${String(ret._id)} line ${i + 1}: ${!got ? "material was not received/imported" : "return quantity is not positive"}; line dropped`);
        continue;
      }
      const unitPricePaise = Math.max(0, toPaise(got.mat.unitPrice));
      for (const a of got.allocs) {
        const take = Math.min(remaining, a.qtyMilli - a.returnedMilli);
        if (take <= 0) continue;
        a.returnedMilli += take;
        a.line.returnedMilli += take;
        remaining -= take;
        matReturned.set(String(got.mat._id), (matReturned.get(String(got.mat._id)) ?? 0) + take);
        const taxRateBp = percentToBp(item.tax) ?? percentToBp(got.mat.tax) ?? a.line.taxRateBp;
        prLines.push({
          _id: newId(),
          poLineId: a.line._id,
          productId: got.productId,
          productName: a.line.productName,
          unit: a.line.unit,
          qtyMilli: take,
          unitPricePaise,
          taxRateBp,
          ...priceLine(take, unitPricePaise, taxRateBp),
        });
        if (!remaining) break;
      }
      if (remaining > 0) {
        adjust(`return ${String(ret._id)} line ${i + 1}: returned ${remaining / 1000} more than was received; excess ignored`);
      }
    }
    if (!prLines.length) {
      report.error("purchaseReturns", ret._id, "no importable lines; return not created");
      continue;
    }
    returnDocs.push({ oldId: String(ret._id), id: newId(), number: pr.number, date: pr.date, lines: prLines });
  }

  // ---- legacy usage → one consumption movement per material; check the old availableQty ----
  const consumptions: { productId: Types.ObjectId; qtyMilli: number; unitCostPaise: number; date: string; materialId: string }[] = [];
  for (const [matId, { mat, allocs, grDate, productId }] of matAllocs) {
    const supplied = allocs.reduce((s, a) => s + a.qtyMilli, 0);
    const returned = matReturned.get(matId) ?? 0;
    const usedOld = Math.max(0, toMilliSafe(mat.usedQty));
    if (mat.availableQty != null && toMilliSafe(mat.availableQty) !== supplied - usedOld - returned) {
      report.add("availableQtyMismatch", {
        materialId: matId,
        poNumber: number,
        suppliedQty: supplied / 1000,
        usedQty: usedOld / 1000,
        returnedQty: returned / 1000,
        oldAvailableQty: mat.availableQty,
        computedQty: (supplied - usedOld - returned) / 1000,
      });
    }
    let used = usedOld;
    if (used > supplied - returned) {
      used = Math.max(0, supplied - returned);
      report.add("usageClamped", { materialId: matId, poNumber: number, usedQty: usedOld / 1000, keptQty: used / 1000, reason: "used more than supplied − returned" });
    }
    if (used < 1) continue;
    const usedOn = businessDate(mat.updatedAt, tz) ?? grDate;
    consumptions.push({
      productId,
      qtyMilli: used,
      unitCostPaise: Math.max(0, toPaise(mat.unitPrice)),
      date: usedOn < grDate ? grDate : usedOn,
      materialId: matId,
    });
  }

  if (!lines.length) {
    report.error("purchaseOrders", oldId, "purchase order has no importable lines");
    failChildren("its purchase order has no importable lines");
    return;
  }
  for (const r of receipts) {
    const t = totalsOf(r.lines).totalPaise;
    if (r.oldTotal && Math.abs(t - r.oldTotal) > 100) {
      report.add("receiptTotalMismatch", { inwardId: r.oldId, number: r.number, oldGrandTotalPaise: r.oldTotal, recomputedTotalPaise: t });
    }
  }

  const poLines = lines.map((l) => ({
    _id: l._id,
    productId: l.productId,
    productName: l.productName,
    unit: l.unit,
    qtyMilli: l.qtyMilli,
    unitPricePaise: l.unitPricePaise,
    taxRateBp: l.taxRateBp,
    ...priceLine(l.qtyMilli, l.unitPricePaise, l.taxRateBp),
    receivedMilli: l.receivedMilli,
    returnedMilli: l.returnedMilli,
  }));
  const anyReceived = lines.some((l) => l.receivedMilli > 0);
  const status = !anyReceived ? "sent" : lines.every((l) => l.receivedMilli >= l.qtyMilli) ? "received" : "partially_received";
  const poId = newId();
  const receiptTotals = receipts.map((r) => ({ ...r, ...totalsOf(r.lines) }));
  const returnTotals = returnDocs.map((r) => ({ ...r, ...totalsOf(r.lines) }));
  const base = { orgId: org.orgId, siteId: site.siteId, createdBy: org.ownerId };
  const attach = !vendor.siteIds.has(site.siteId.toHexString());

  const res = await m.unit("purchaseOrders", oldId, async (tx) => {
    await tx.create(PurchaseOrder, {
      _id: poId,
      ...base,
      number,
      vendorId: vendor.id,
      vendorName: vendor.name,
      vendorGstIn: vendor.gstIn,
      date,
      transport: str(po.transport).slice(0, 200) || undefined,
      status,
      lines: poLines,
      ...totalsOf(poLines),
      receivedValuePaise: receiptTotals.reduce((s, r) => s + r.totalPaise, 0),
      createdAt: po.createdAt,
    });
    if (attach) {
      await tx.update(Party, { _id: vendor.id, orgId: org.orgId }, { $addToSet: { siteIds: site.siteId } });
      tx.issue("notes", { entity: "vendors", partyId: vendor.id.toHexString(), message: `attached to site "${site.name}" because PO ${number} uses it` });
    }
    for (const r of receiptTotals) {
      await tx.create(GoodsReceipt, {
        _id: r.id,
        ...base,
        number: r.number,
        poId,
        poNumber: number,
        vendorId: vendor.id,
        vendorName: vendor.name,
        date: r.date,
        notes: "Migrated from the legacy material inward",
        lines: r.lines,
        subtotalPaise: r.subtotalPaise,
        taxPaise: r.taxPaise,
        totalPaise: r.totalPaise,
        createdByName: org.ownerName,
      });
      await tx.create(
        StockMovement,
        r.lines.map((l) => ({
          ...base,
          productId: l.productId,
          date: r.date,
          type: "receipt",
          qtyMilli: l.qtyMilli,
          unitCostPaise: l.unitPricePaise,
          sourceType: "goods_receipt",
          sourceId: r.id,
          reference: r.number,
        })),
      );
      if (r.totalPaise > 0) {
        await tx.create(LedgerEntry, {
          ...base,
          partyId: vendor.id,
          date: r.date,
          sourceType: "goods_receipt",
          sourceId: r.id,
          reference: r.number,
          description: `Goods received against ${number}`,
          creditPaise: r.totalPaise,
        });
      }
      tx.map("material_inward", r.oldId, r.id, org.orgId);
      tx.count("materialInwards", "created");
    }
    for (const r of returnTotals) {
      await tx.create(PurchaseReturn, {
        _id: r.id,
        ...base,
        number: r.number,
        poId,
        poNumber: number,
        vendorId: vendor.id,
        vendorName: vendor.name,
        date: r.date,
        reason: "Migrated from the legacy purchase return",
        lines: r.lines,
        subtotalPaise: r.subtotalPaise,
        taxPaise: r.taxPaise,
        totalPaise: r.totalPaise,
        createdByName: org.ownerName,
      });
      await tx.create(
        StockMovement,
        r.lines.map((l) => ({
          ...base,
          productId: l.productId,
          date: r.date,
          type: "return",
          qtyMilli: -l.qtyMilli,
          unitCostPaise: l.unitPricePaise,
          sourceType: "purchase_return",
          sourceId: r.id,
          reference: r.number,
        })),
      );
      if (r.totalPaise > 0) {
        await tx.create(LedgerEntry, {
          ...base,
          partyId: vendor.id,
          date: r.date,
          sourceType: "purchase_return",
          sourceId: r.id,
          reference: r.number,
          description: `Goods returned against ${number}`,
          debitPaise: r.totalPaise,
        });
      }
      tx.map("purchase_return", r.oldId, r.id, org.orgId);
      tx.count("purchaseReturns", "created");
    }
    await tx.create(
      StockMovement,
      consumptions.map((c) => ({
        ...base,
        productId: c.productId,
        date: c.date,
        type: "consumption",
        qtyMilli: -c.qtyMilli,
        unitCostPaise: c.unitCostPaise,
        sourceType: "legacy",
        reference: "Opening usage (migrated)",
        notes: `Legacy material ${c.materialId} (${number})`,
      })),
    );
    tx.map("purchase_order", oldId, poId, org.orgId);
    tx.count("purchaseOrders", "created");
    tx.count("materials", "created", matAllocs.size);
  });
  if (res.ok) {
    if (attach) vendor.siteIds.add(site.siteId.toHexString());
  } else {
    failChildren("its purchase order failed to migrate");
  }
}
