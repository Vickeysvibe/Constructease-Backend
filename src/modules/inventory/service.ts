import type { Types } from "mongoose";
import { fromMilli } from "@/core/units";
import { Product } from "@/modules/products/models";
import { User } from "@/modules/identity/models";
import { StockMovement } from "./models";

type MovementDoc = {
  _id: Types.ObjectId;
  productId: Types.ObjectId;
  date: string;
  type: string;
  qtyMilli: number;
  unitCostPaise: number;
  sourceType: string;
  sourceId?: Types.ObjectId | null;
  reference?: string | null;
  notes?: string | null;
  createdBy: Types.ObjectId;
  createdAt?: Date;
};

/** API shape of stock movements, with product names/units and creator names resolved in two batch queries. */
export async function publicMovements(orgId: Types.ObjectId, docs: MovementDoc[]) {
  const productIds = [...new Set(docs.map((d) => d.productId.toHexString()))];
  const userIds = [...new Set(docs.map((d) => d.createdBy.toHexString()))];
  const [products, users] = await Promise.all([
    productIds.length ? Product.find({ orgId, _id: { $in: productIds } }).select("name unit").lean() : [],
    userIds.length ? User.find({ orgId, _id: { $in: userIds } }).select("name").lean() : [],
  ]);
  const p = new Map(products.map((x) => [x._id.toHexString(), x]));
  const u = new Map(users.map((x) => [x._id.toHexString(), x.name]));
  return docs.map((d) => {
    const product = p.get(d.productId.toHexString());
    return {
      id: d._id.toHexString(),
      productId: d.productId.toHexString(),
      productName: product?.name ?? "",
      unit: product?.unit ?? "",
      date: d.date,
      type: d.type,
      qty: fromMilli(d.qtyMilli),
      unitCostPaise: d.unitCostPaise,
      sourceType: d.sourceType,
      sourceId: d.sourceId ? d.sourceId.toHexString() : null,
      reference: d.reference ?? "",
      notes: d.notes ?? undefined,
      createdBy: { id: d.createdBy.toHexString(), name: u.get(d.createdBy.toHexString()) ?? "" },
      createdAt: d.createdAt?.toISOString(),
    };
  });
}

export interface StockTotals {
  receivedMilli: number;
  returnedMilli: number;
  consumedMilli: number;
  adjustedMilli: number;
  onHandMilli: number;
  /** Σ qty × unitCost over receipts and returns (thousandths × paise) */
  costValue: number;
}

/** Per-product movement totals for a site. Received/returned/consumed are positive; adjusted is signed. */
export async function stockTotals(orgId: Types.ObjectId, siteId: Types.ObjectId): Promise<Map<string, StockTotals>> {
  const rows = await StockMovement.aggregate<{ _id: { p: Types.ObjectId; t: string }; qty: number; value: number }>([
    { $match: { orgId, siteId } },
    {
      $group: {
        _id: { p: "$productId", t: "$type" },
        qty: { $sum: "$qtyMilli" },
        value: { $sum: { $multiply: ["$qtyMilli", "$unitCostPaise"] } },
      },
    },
  ]);
  const out = new Map<string, StockTotals>();
  for (const r of rows) {
    const key = r._id.p.toHexString();
    const t = out.get(key) ?? { receivedMilli: 0, returnedMilli: 0, consumedMilli: 0, adjustedMilli: 0, onHandMilli: 0, costValue: 0 };
    t.onHandMilli += r.qty;
    if (r._id.t === "receipt") t.receivedMilli += r.qty;
    else if (r._id.t === "return") t.returnedMilli -= r.qty;
    else if (r._id.t === "consumption") t.consumedMilli -= r.qty;
    else t.adjustedMilli += r.qty;
    if (r._id.t === "receipt" || r._id.t === "return") t.costValue += r.value;
    out.set(key, t);
  }
  return out;
}

/** Same rule as averageCostPaise(): quantity-weighted receipt cost net of returns. */
export const avgCostOf = (t: StockTotals) => {
  const netQty = t.receivedMilli - t.returnedMilli;
  return netQty > 0 ? Math.round(t.costValue / netQty) : 0;
};
