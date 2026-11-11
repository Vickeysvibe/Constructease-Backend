import { Types, type ClientSession } from "mongoose";
import { withTransaction } from "@/core/db";
import { conflict, insufficientStock, invalidState, notFound, validationFailed, type FieldError } from "@/core/errors";
import { audit, nextNumber } from "@/core/records";
import { fromMilli, priceLine, toMilli } from "@/core/units";
import type { RequestContext, SiteContext } from "@/core/context";
import { Party, type PartyDoc } from "@/modules/parties/models";
import { Product, type ProductDoc } from "@/modules/products/models";
import { StockMovement, ensureStockLocks, lockStock, onHandMilli } from "@/modules/inventory/models";
import { postLedger } from "@/modules/finance/models";
import {
  GoodsReceipt,
  PurchaseOrder,
  PurchaseReturn,
  type GoodsReceiptDoc,
  type POLineDoc,
  type POStatus,
  type PurchaseOrderDoc,
  type PurchaseReturnDoc,
} from "./models";
import type { GRInput, POInput, POPatch, PRInput } from "./schemas";

type Ctx = Pick<RequestContext, "orgId" | "userId" | "userName">;
type Site = Pick<SiteContext, "id">;

// ---------- mappers ----------

const sumBy = <T>(xs: T[], f: (x: T) => number) => xs.reduce((s, x) => s + f(x), 0);
const pendingMilli = (l: Pick<POLineDoc, "qtyMilli" | "receivedMilli">) => Math.max(0, l.qtyMilli - (l.receivedMilli ?? 0));

export const publicPOLine = (l: POLineDoc) => ({
  id: l._id.toHexString(),
  productId: l.productId.toHexString(),
  productName: l.productName,
  unit: l.unit,
  qty: fromMilli(l.qtyMilli),
  unitPricePaise: l.unitPricePaise,
  taxRateBp: l.taxRateBp,
  amountPaise: l.amountPaise,
  taxPaise: l.taxPaise,
  totalPaise: l.totalPaise,
  receivedQty: fromMilli(l.receivedMilli ?? 0),
  returnedQty: fromMilli(l.returnedMilli ?? 0),
  pendingQty: fromMilli(pendingMilli(l)),
});

export const publicPOSummary = (po: PurchaseOrderDoc) => ({
  id: po._id.toHexString(),
  number: po.number,
  siteId: po.siteId.toHexString(),
  vendor: { id: po.vendorId.toHexString(), name: po.vendorName, gstIn: po.vendorGstIn ?? undefined },
  date: po.date,
  expectedDate: po.expectedDate ?? undefined,
  transport: po.transport ?? undefined,
  notes: po.notes ?? undefined,
  status: po.status as POStatus,
  cancelReason: po.cancelReason ?? undefined,
  subtotalPaise: po.subtotalPaise ?? 0,
  taxPaise: po.taxPaise ?? 0,
  totalPaise: po.totalPaise ?? 0,
  receivedValuePaise: po.receivedValuePaise ?? 0,
  lineCount: po.lines.length,
  createdAt: po.createdAt?.toISOString(),
  updatedAt: po.updatedAt?.toISOString(),
});

type DocSummary = { _id: Types.ObjectId; number: string; date: string; totalPaise: number };
const publicDocSummary = (d: DocSummary) => ({ id: d._id.toHexString(), number: d.number, date: d.date, totalPaise: d.totalPaise });

export function publicPO(po: PurchaseOrderDoc, receipts: DocSummary[], returns: DocSummary[]) {
  const { lineCount: _lineCount, ...rest } = publicPOSummary(po);
  return {
    ...rest,
    lines: po.lines.map(publicPOLine),
    receipts: receipts.map(publicDocSummary),
    returns: returns.map(publicDocSummary),
  };
}

function publicDocLines(lines: GoodsReceiptDoc["lines"]) {
  return lines.map((l) => ({
    id: l._id.toHexString(),
    poLineId: l.poLineId.toHexString(),
    productId: l.productId.toHexString(),
    productName: l.productName,
    unit: l.unit,
    qty: fromMilli(l.qtyMilli),
    unitPricePaise: l.unitPricePaise,
    taxRateBp: l.taxRateBp,
    amountPaise: l.amountPaise,
    taxPaise: l.taxPaise,
    totalPaise: l.totalPaise,
  }));
}

export const publicReceiptSummary = (gr: GoodsReceiptDoc) => ({
  id: gr._id.toHexString(),
  number: gr.number,
  poId: gr.poId.toHexString(),
  poNumber: gr.poNumber,
  vendor: { id: gr.vendorId.toHexString(), name: gr.vendorName },
  date: gr.date,
  challanNo: gr.challanNo ?? undefined,
  vehicleNo: gr.vehicleNo ?? undefined,
  notes: gr.notes ?? undefined,
  subtotalPaise: gr.subtotalPaise,
  taxPaise: gr.taxPaise,
  totalPaise: gr.totalPaise,
  lineCount: gr.lines.length,
  createdBy: { id: gr.createdBy.toHexString(), name: gr.createdByName ?? "" },
  createdAt: gr.createdAt?.toISOString(),
});

export function publicReceipt(gr: GoodsReceiptDoc) {
  const { lineCount: _lineCount, ...rest } = publicReceiptSummary(gr);
  return { ...rest, lines: publicDocLines(gr.lines) };
}

export const publicReturnSummary = (pr: PurchaseReturnDoc) => ({
  id: pr._id.toHexString(),
  number: pr.number,
  poId: pr.poId.toHexString(),
  poNumber: pr.poNumber,
  vendor: { id: pr.vendorId.toHexString(), name: pr.vendorName },
  date: pr.date,
  reason: pr.reason ?? undefined,
  subtotalPaise: pr.subtotalPaise,
  taxPaise: pr.taxPaise,
  totalPaise: pr.totalPaise,
  lineCount: pr.lines.length,
  createdBy: { id: pr.createdBy.toHexString(), name: pr.createdByName ?? "" },
  createdAt: pr.createdAt?.toISOString(),
});

export function publicReturn(pr: PurchaseReturnDoc) {
  const { lineCount: _lineCount, ...rest } = publicReturnSummary(pr);
  return { ...rest, lines: publicDocLines(pr.lines) };
}

// ---------- lookups ----------

/** A PO of this site, or 404 (another org's or another site's PO is invisible). */
export async function findSitePO(orgId: Types.ObjectId, siteId: Types.ObjectId, poId: string, session?: ClientSession) {
  const po = await PurchaseOrder.findOne({ _id: poId, orgId, siteId })
    .session(session ?? null)
    .lean<PurchaseOrderDoc>();
  if (!po) throw notFound("Purchase order");
  return po;
}

export async function loadPO(orgId: Types.ObjectId, siteId: Types.ObjectId, poId: string) {
  const po = await findSitePO(orgId, siteId, poId);
  const [receipts, returns] = await Promise.all([
    GoodsReceipt.find({ orgId, poId: po._id }).select("number date totalPaise").sort({ createdAt: 1 }).lean<DocSummary[]>(),
    PurchaseReturn.find({ orgId, poId: po._id }).select("number date totalPaise").sort({ createdAt: 1 }).lean<DocSummary[]>(),
  ]);
  return publicPO(po, receipts, returns);
}

/** An active vendor attached to this site; anything else is a validation error on `vendorId`. */
async function resolveVendor(orgId: Types.ObjectId, siteId: Types.ObjectId, vendorId: string) {
  const v = await Party.findOne({ _id: vendorId, orgId, kind: "vendor", siteIds: siteId, status: "active" }).lean<PartyDoc>();
  if (!v) throw validationFailed([{ path: "vendorId", message: "Vendor not found on this site" }]);
  return v;
}

/** Prices PO input lines against the org's active products (snapshotting name/unit). */
async function buildPOLines(orgId: Types.ObjectId, lines: POInput["lines"]) {
  const ids = [...new Set(lines.map((l) => l.productId))];
  const products = await Product.find({ orgId, _id: { $in: ids }, status: "active" }).lean<ProductDoc[]>();
  const byId = new Map(products.map((p) => [p._id.toHexString(), p]));
  const errors: FieldError[] = [];
  const out = lines.map((l, i) => {
    const p = byId.get(l.productId);
    if (!p) {
      errors.push({ path: `lines.${i}.productId`, message: "Product not found or archived" });
      return null;
    }
    const qtyMilli = toMilli(l.qty);
    const unitPricePaise = l.unitPricePaise ?? 0;
    const taxRateBp = l.taxRateBp ?? p.defaultTaxRateBp ?? 1800;
    return {
      productId: p._id,
      productName: p.name,
      unit: p.unit,
      qtyMilli,
      unitPricePaise,
      taxRateBp,
      ...priceLine(qtyMilli, unitPricePaise, taxRateBp),
      receivedMilli: 0,
      returnedMilli: 0,
    };
  });
  if (errors.length) throw validationFailed(errors);
  const priced = out as NonNullable<(typeof out)[number]>[];
  return {
    lines: priced,
    subtotalPaise: sumBy(priced, (l) => l.amountPaise),
    taxPaise: sumBy(priced, (l) => l.taxPaise),
    totalPaise: sumBy(priced, (l) => l.totalPaise),
  };
}

// ---------- purchase orders ----------

export async function createPO(ctx: Ctx, site: Site, body: POInput) {
  const vendor = await resolveVendor(ctx.orgId, site.id, body.vendorId);
  const priced = await buildPOLines(ctx.orgId, body.lines);
  const id = await withTransaction(async (session) => {
    const number = await nextNumber(ctx.orgId, "PO", body.date, session);
    const [po] = await PurchaseOrder.create(
      [
        {
          orgId: ctx.orgId,
          siteId: site.id,
          number,
          vendorId: vendor._id,
          vendorName: vendor.name,
          vendorGstIn: vendor.gstIn ?? undefined,
          date: body.date,
          expectedDate: body.expectedDate,
          transport: body.transport,
          notes: body.notes,
          status: "draft",
          ...priced,
          createdBy: ctx.userId,
        },
      ],
      { session },
    );
    await audit(ctx, { action: "po.create", entity: "PurchaseOrder", entityId: po!._id, siteId: site.id, data: { number } }, session);
    return po!._id;
  });
  return loadPO(ctx.orgId, site.id, id.toHexString());
}

export async function updatePO(ctx: Ctx, site: Site, poId: string, body: POPatch) {
  const po = await findSitePO(ctx.orgId, site.id, poId);
  if (po.status !== "draft") throw invalidState("Only a draft purchase order can be edited.");
  const date = body.date ?? po.date;
  const expectedDate = "expectedDate" in body ? body.expectedDate : po.expectedDate;
  if (expectedDate && expectedDate < date) {
    throw validationFailed([{ path: "expectedDate", message: "Expected date can't be before the PO date" }]);
  }
  const set: Record<string, unknown> = {};
  const unset: Record<string, 1> = {};
  for (const k of ["date", "expectedDate", "transport", "notes"] as const) {
    if (!(k in body)) continue;
    if (body[k] === undefined) unset[k] = 1;
    else set[k] = body[k];
  }
  if (body.vendorId) {
    const v = await resolveVendor(ctx.orgId, site.id, body.vendorId);
    Object.assign(set, { vendorId: v._id, vendorName: v.name });
    if (v.gstIn) set.vendorGstIn = v.gstIn;
    else unset.vendorGstIn = 1;
  }
  if (body.lines) Object.assign(set, await buildPOLines(ctx.orgId, body.lines));
  const updated = await PurchaseOrder.findOneAndUpdate(
    { _id: po._id, orgId: ctx.orgId, siteId: site.id, status: "draft" },
    { $set: set, ...(Object.keys(unset).length ? { $unset: unset } : {}) },
    { new: true, runValidators: true },
  ).lean();
  if (!updated) throw invalidState("Only a draft purchase order can be edited.");
  await audit(ctx, { action: "po.update", entity: "PurchaseOrder", entityId: po._id, siteId: site.id, data: { fields: Object.keys(body) } });
  return loadPO(ctx.orgId, site.id, poId);
}

export async function sendPO(ctx: Ctx, site: Site, poId: string) {
  const po = await findSitePO(ctx.orgId, site.id, poId);
  const res = await PurchaseOrder.updateOne(
    { _id: po._id, orgId: ctx.orgId, siteId: site.id, status: "draft" },
    { $set: { status: "sent" } },
  );
  if (!res.modifiedCount) throw invalidState(`A ${po.status.replace("_", " ")} purchase order can't be sent.`);
  await audit(ctx, { action: "po.send", entity: "PurchaseOrder", entityId: po._id, siteId: site.id });
  return loadPO(ctx.orgId, site.id, poId);
}

export async function cancelPO(ctx: Ctx, site: Site, poId: string, reason?: string) {
  const po = await findSitePO(ctx.orgId, site.id, poId);
  // draft/sent POs have no receipts (the first receipt moves a PO to partially_received in the same transaction)
  const res = await PurchaseOrder.updateOne(
    { _id: po._id, orgId: ctx.orgId, siteId: site.id, status: { $in: ["draft", "sent"] }, "lines.receivedMilli": { $not: { $gt: 0 } } },
    { $set: { status: "cancelled", ...(reason ? { cancelReason: reason } : {}) } },
  );
  if (!res.modifiedCount) {
    throw invalidState(
      po.status === "cancelled" ? "This purchase order is already cancelled." : "A purchase order with received goods can't be cancelled.",
    );
  }
  await audit(ctx, { action: "po.cancel", entity: "PurchaseOrder", entityId: po._id, siteId: site.id, data: { reason } });
  return loadPO(ctx.orgId, site.id, poId);
}

/**
 * Writes the new running totals back to the PO, conditional on the version read inside this transaction.
 * A concurrent commit to the same PO makes this a write conflict (the driver retries the whole callback,
 * which re-reads the PO); the version filter is a belt-and-braces guard on top of that.
 */
async function savePOProgress(po: PurchaseOrderDoc, set: Record<string, unknown>, session: ClientSession) {
  const res = await PurchaseOrder.updateOne(
    { _id: po._id, orgId: po.orgId, __v: po.__v },
    { $set: set, $inc: { __v: 1 } },
    { session },
  );
  if (!res.modifiedCount) throw conflict("The purchase order changed while saving. Please try again.");
}

// ---------- goods receipts ----------

export async function createReceipt(ctx: Ctx, site: Site, body: GRInput) {
  const id = await withTransaction(async (session) => {
    const po = await findSitePO(ctx.orgId, site.id, body.poId, session);
    if (po.status !== "sent" && po.status !== "partially_received") {
      throw invalidState(
        po.status === "draft"
          ? "Send the purchase order before receiving goods."
          : `Goods can't be received against a ${po.status.replace("_", " ")} purchase order.`,
      );
    }
    const lineById = new Map(po.lines.map((l) => [l._id.toHexString(), l]));
    const missing: FieldError[] = [];
    const over: FieldError[] = [];
    body.lines.forEach((l, i) => {
      const pl = lineById.get(l.poLineId);
      if (!pl) return missing.push({ path: `lines.${i}.poLineId`, message: "Not a line of this purchase order" });
      const pending = pendingMilli(pl);
      if (toMilli(l.qty) > pending) over.push({ path: `lines.${i}.qty`, message: `Only ${fromMilli(pending)} ${pl.unit} pending` });
    });
    if (missing.length) throw validationFailed(missing);
    if (over.length) throw invalidState("Received quantity is more than pending on the purchase order.", over);

    const lines = body.lines.map((l) => {
      const pl = lineById.get(l.poLineId)!;
      const qtyMilli = toMilli(l.qty);
      const unitPricePaise = l.unitPricePaise ?? pl.unitPricePaise;
      const taxRateBp = l.taxRateBp ?? pl.taxRateBp;
      return {
        _id: new Types.ObjectId(),
        poLineId: pl._id,
        productId: pl.productId,
        productName: pl.productName,
        unit: pl.unit,
        qtyMilli,
        unitPricePaise,
        taxRateBp,
        ...priceLine(qtyMilli, unitPricePaise, taxRateBp),
      };
    });
    const totals = {
      subtotalPaise: sumBy(lines, (l) => l.amountPaise),
      taxPaise: sumBy(lines, (l) => l.taxPaise),
      totalPaise: sumBy(lines, (l) => l.totalPaise),
    };
    const number = await nextNumber(ctx.orgId, "GR", body.date, session);
    const grId = new Types.ObjectId();
    await GoodsReceipt.create(
      [
        {
          _id: grId,
          orgId: ctx.orgId,
          siteId: site.id,
          number,
          poId: po._id,
          poNumber: po.number,
          vendorId: po.vendorId,
          vendorName: po.vendorName,
          date: body.date,
          challanNo: body.challanNo,
          vehicleNo: body.vehicleNo,
          notes: body.notes,
          lines,
          ...totals,
          createdBy: ctx.userId,
          createdByName: ctx.userName,
        },
      ],
      { session },
    );
    await StockMovement.create(
      lines.map((l) => ({
        orgId: ctx.orgId,
        siteId: site.id,
        productId: l.productId,
        date: body.date,
        type: "receipt",
        qtyMilli: l.qtyMilli,
        unitCostPaise: l.unitPricePaise,
        sourceType: "goods_receipt",
        sourceId: grId,
        reference: number,
        notes: body.notes,
        createdBy: ctx.userId,
      })),
      { session, ordered: true },
    );
    if (totals.totalPaise > 0) {
      await postLedger(
        [
          {
            orgId: ctx.orgId,
            siteId: site.id,
            partyId: po.vendorId,
            date: body.date,
            sourceType: "goods_receipt",
            sourceId: grId,
            reference: number,
            description: `Goods received against ${po.number}`,
            creditPaise: totals.totalPaise,
            createdBy: ctx.userId,
          },
        ],
        session,
      );
    }
    const received = new Map<string, number>();
    for (const l of lines) received.set(l.poLineId.toHexString(), (received.get(l.poLineId.toHexString()) ?? 0) + l.qtyMilli);
    const newLines = po.lines.map((l) => ({ ...l, receivedMilli: (l.receivedMilli ?? 0) + (received.get(l._id.toHexString()) ?? 0) }));
    const status: POStatus = newLines.every((l) => pendingMilli(l) === 0) ? "received" : "partially_received";
    await savePOProgress(po, { lines: newLines, status, receivedValuePaise: (po.receivedValuePaise ?? 0) + totals.totalPaise }, session);
    await audit(
      ctx,
      { action: "receipt.create", entity: "GoodsReceipt", entityId: grId, siteId: site.id, data: { number, poNumber: po.number, totalPaise: totals.totalPaise } },
      session,
    );
    return grId;
  });
  return findReceipt(ctx.orgId, site.id, id.toHexString());
}

export async function findReceipt(orgId: Types.ObjectId, siteId: Types.ObjectId, id: string) {
  const gr = await GoodsReceipt.findOne({ _id: id, orgId, siteId }).lean<GoodsReceiptDoc>();
  if (!gr) throw notFound("Goods receipt");
  return publicReceipt(gr);
}

// ---------- purchase returns ----------

/** Quantity-weighted average receipt price (paise) per PO line, over every receipt against the PO. */
async function receiptPriceByLine(orgId: Types.ObjectId, poId: Types.ObjectId, session: ClientSession) {
  const receipts = await GoodsReceipt.find({ orgId, poId }).select("lines").session(session).lean<GoodsReceiptDoc[]>();
  const acc = new Map<string, { qty: number; value: number }>();
  for (const gr of receipts) {
    for (const l of gr.lines) {
      const k = l.poLineId.toHexString();
      const a = acc.get(k) ?? { qty: 0, value: 0 };
      a.qty += l.qtyMilli;
      a.value += l.qtyMilli * l.unitPricePaise;
      acc.set(k, a);
    }
  }
  return new Map([...acc].map(([k, a]) => [k, a.qty > 0 ? Math.round(a.value / a.qty) : 0]));
}

export async function createReturn(ctx: Ctx, site: Site, body: PRInput) {
  // Validate ids and collect products before the transaction so the stock lock rows exist.
  const pre = await findSitePO(ctx.orgId, site.id, body.poId);
  const preLines = new Map(pre.lines.map((l) => [l._id.toHexString(), l]));
  const missing: FieldError[] = [];
  body.lines.forEach((l, i) => {
    if (!preLines.has(l.poLineId)) missing.push({ path: `lines.${i}.poLineId`, message: "Not a line of this purchase order" });
  });
  if (missing.length) throw validationFailed(missing);
  if (pre.status === "draft" || pre.status === "cancelled") {
    throw invalidState(`Nothing can be returned against a ${pre.status} purchase order.`);
  }
  const productIds = [...new Set(body.lines.map((l) => preLines.get(l.poLineId)!.productId.toHexString()))].map(
    (id) => new Types.ObjectId(id),
  );
  await ensureStockLocks(ctx.orgId, site.id, productIds);

  const id = await withTransaction(async (session) => {
    const po = await findSitePO(ctx.orgId, site.id, body.poId, session);
    await lockStock(ctx.orgId, site.id, productIds, session);
    const lineById = new Map(po.lines.map((l) => [l._id.toHexString(), l]));
    const onHand = await onHandMilli(ctx.orgId, site.id, { productIds, session });
    const wantByProduct = new Map<string, number>();
    for (const l of body.lines) {
      const pid = lineById.get(l.poLineId)!.productId.toHexString();
      wantByProduct.set(pid, (wantByProduct.get(pid) ?? 0) + toMilli(l.qty));
    }
    const errors: FieldError[] = [];
    body.lines.forEach((l, i) => {
      const pl = lineById.get(l.poLineId)!;
      const returnable = (pl.receivedMilli ?? 0) - (pl.returnedMilli ?? 0);
      const pid = pl.productId.toHexString();
      const stock = onHand.get(pid) ?? 0;
      if (toMilli(l.qty) > returnable) {
        errors.push({ path: `lines.${i}.qty`, message: `Only ${fromMilli(returnable)} ${pl.unit} received and not yet returned` });
      } else if (wantByProduct.get(pid)! > stock) {
        errors.push({ path: `lines.${i}.qty`, message: `Only ${fromMilli(stock)} ${pl.unit} in stock` });
      }
    });
    if (errors.length) throw insufficientStock("Some lines can't be returned.", errors);

    const avgPrice = await receiptPriceByLine(ctx.orgId, po._id, session);
    const lines = body.lines.map((l) => {
      const pl = lineById.get(l.poLineId)!;
      const qtyMilli = toMilli(l.qty);
      const unitPricePaise = avgPrice.get(l.poLineId) ?? pl.unitPricePaise;
      return {
        _id: new Types.ObjectId(),
        poLineId: pl._id,
        productId: pl.productId,
        productName: pl.productName,
        unit: pl.unit,
        qtyMilli,
        unitPricePaise,
        taxRateBp: pl.taxRateBp,
        ...priceLine(qtyMilli, unitPricePaise, pl.taxRateBp),
      };
    });
    const totals = {
      subtotalPaise: sumBy(lines, (l) => l.amountPaise),
      taxPaise: sumBy(lines, (l) => l.taxPaise),
      totalPaise: sumBy(lines, (l) => l.totalPaise),
    };
    const number = await nextNumber(ctx.orgId, "PR", body.date, session);
    const prId = new Types.ObjectId();
    await PurchaseReturn.create(
      [
        {
          _id: prId,
          orgId: ctx.orgId,
          siteId: site.id,
          number,
          poId: po._id,
          poNumber: po.number,
          vendorId: po.vendorId,
          vendorName: po.vendorName,
          date: body.date,
          reason: body.reason,
          lines,
          ...totals,
          createdBy: ctx.userId,
          createdByName: ctx.userName,
        },
      ],
      { session },
    );
    await StockMovement.create(
      lines.map((l) => ({
        orgId: ctx.orgId,
        siteId: site.id,
        productId: l.productId,
        date: body.date,
        type: "return",
        qtyMilli: -l.qtyMilli,
        unitCostPaise: l.unitPricePaise,
        sourceType: "purchase_return",
        sourceId: prId,
        reference: number,
        notes: body.reason,
        createdBy: ctx.userId,
      })),
      { session, ordered: true },
    );
    if (totals.totalPaise > 0) {
      await postLedger(
        [
          {
            orgId: ctx.orgId,
            siteId: site.id,
            partyId: po.vendorId,
            date: body.date,
            sourceType: "purchase_return",
            sourceId: prId,
            reference: number,
            description: `Goods returned against ${po.number}`,
            debitPaise: totals.totalPaise,
            createdBy: ctx.userId,
          },
        ],
        session,
      );
    }
    const returned = new Map<string, number>();
    for (const l of lines) returned.set(l.poLineId.toHexString(), (returned.get(l.poLineId.toHexString()) ?? 0) + l.qtyMilli);
    // Returns never re-open a PO: status and pendingQty (qty − received) are unchanged.
    const newLines = po.lines.map((l) => ({ ...l, returnedMilli: (l.returnedMilli ?? 0) + (returned.get(l._id.toHexString()) ?? 0) }));
    await savePOProgress(po, { lines: newLines }, session);
    await audit(
      ctx,
      { action: "return.create", entity: "PurchaseReturn", entityId: prId, siteId: site.id, data: { number, poNumber: po.number, totalPaise: totals.totalPaise } },
      session,
    );
    return prId;
  });
  return findReturn(ctx.orgId, site.id, id.toHexString());
}

export async function findReturn(orgId: Types.ObjectId, siteId: Types.ObjectId, id: string) {
  const pr = await PurchaseReturn.findOne({ _id: id, orgId, siteId }).lean<PurchaseReturnDoc>();
  if (!pr) throw notFound("Purchase return");
  return publicReturn(pr);
}
