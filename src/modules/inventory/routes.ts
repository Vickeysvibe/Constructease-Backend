import { z } from "zod";
import { Types } from "mongoose";
import { containsRegex, handler, listQuery, objectId, paginate } from "@/core/http";
import { requireSite } from "@/core/access";
import { insufficientStock, validationFailed, type FieldError } from "@/core/errors";
import { withTransaction } from "@/core/db";
import { audit, idempotent } from "@/core/records";
import { fromMilli, isoDate, positiveQty, qty, toMilli } from "@/core/units";
import { Product } from "@/modules/products/models";
import type { ModuleRoutes } from "@/modules/registry";
import {
  MOVEMENT_TYPES,
  StockMovement,
  averageCostPaise,
  ensureStockLocks,
  lockStock,
  onHandMilli,
} from "./models";
import { avgCostOf, publicMovements, stockTotals } from "./service";

const optText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => (v === "" ? undefined : v));

const consumptionInput = z
  .object({
    date: isoDate,
    notes: optText(500),
    lines: z
      .array(z.object({ productId: objectId, qty: positiveQty, usedFor: optText(200) }).strict())
      .min(1, "Add at least one line")
      .max(200),
  })
  .strict();

const adjustmentInput = z
  .object({
    date: isoDate,
    productId: objectId,
    qty: qty.refine((v) => v !== 0, "Quantity can't be 0"),
    reason: z.string().trim().min(1, "Reason is required").max(500),
  })
  .strict();

const movementsQuery = listQuery.extend({
  productId: objectId.optional(),
  type: z.enum(MOVEMENT_TYPES).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
});

/** Products of this org referenced by `ids`; unknown ids become per-line validation errors. */
async function loadProducts(orgId: Types.ObjectId, ids: string[], pathOf: (i: number) => string) {
  const found = await Product.find({ orgId, _id: { $in: [...new Set(ids)] } }).select("_id").lean();
  const known = new Set(found.map((p) => p._id.toHexString()));
  const errors: FieldError[] = [];
  ids.forEach((id, i) => {
    if (!known.has(id)) errors.push({ path: pathOf(i), message: "Product not found" });
  });
  if (errors.length) throw validationFailed(errors);
}

const fmtQty = (milli: number) => String(fromMilli(milli));

export const inventoryModule: ModuleRoutes = {
  name: "inventory",
  site(r) {
    r.get(
      "/stock",
      requireSite("site:read"),
      handler(
        { query: z.object({ q: z.string().trim().max(100).optional(), category: z.string().trim().max(60).optional() }) },
        async ({ query, ctx, site }) => {
          const totals = await stockTotals(ctx.orgId, site.id);
          if (!totals.size) return { items: [] };
          const filter: Record<string, unknown> = { orgId: ctx.orgId, _id: { $in: [...totals.keys()] } };
          if (query.category) filter.category = query.category;
          if (query.q) filter.$or = [{ name: containsRegex(query.q) }, { category: containsRegex(query.q) }];
          const products = await Product.find(filter).sort({ name: 1 }).lean();
          return {
            items: products.map((p) => {
              const t = totals.get(p._id.toHexString())!;
              const avg = avgCostOf(t);
              return {
                productId: p._id.toHexString(),
                productName: p.name,
                unit: p.unit,
                category: p.category ?? undefined,
                receivedQty: fromMilli(t.receivedMilli),
                returnedQty: fromMilli(t.returnedMilli),
                consumedQty: fromMilli(t.consumedMilli),
                adjustedQty: fromMilli(t.adjustedMilli),
                onHandQty: fromMilli(t.onHandMilli),
                avgCostPaise: avg,
                valuePaise: Math.round((Math.max(t.onHandMilli, 0) * avg) / 1000),
              };
            }),
          };
        },
      ),
    );

    r.get(
      "/stock/movements",
      requireSite("site:read"),
      handler({ query: movementsQuery }, async ({ query, ctx, site }) => {
        const filter: Record<string, unknown> = { orgId: ctx.orgId, siteId: site.id };
        if (query.productId) filter.productId = new Types.ObjectId(query.productId);
        if (query.type) filter.type = query.type;
        if (query.from || query.to) {
          filter.date = { ...(query.from ? { $gte: query.from } : {}), ...(query.to ? { $lte: query.to } : {}) };
        }
        const page = await paginate(StockMovement, filter, query, { date: -1, createdAt: -1, _id: -1 }, (d) => d);
        return { ...page, items: await publicMovements(ctx.orgId, page.items as never[]) };
      }),
    );

    r.post(
      "/consumptions",
      requireSite("receiving:write"),
      idempotent,
      handler(
        { body: consumptionInput },
        async ({ body, ctx, site }) => {
          await loadProducts(ctx.orgId, body.lines.map((l) => l.productId), (i) => `lines.${i}.productId`);
          const need = new Map<string, number>();
          for (const l of body.lines) need.set(l.productId, (need.get(l.productId) ?? 0) + toMilli(l.qty));
          const productIds = [...need.keys()].map((id) => new Types.ObjectId(id));
          await ensureStockLocks(ctx.orgId, site.id, productIds);
          const sourceId = new Types.ObjectId();
          const docs = await withTransaction(async (session) => {
            await lockStock(ctx.orgId, site.id, productIds, session);
            const onHand = await onHandMilli(ctx.orgId, site.id, { productIds, session });
            const errors: FieldError[] = [];
            body.lines.forEach((l, i) => {
              const have = onHand.get(l.productId) ?? 0;
              const want = need.get(l.productId)!;
              if (want > have) errors.push({ path: `lines.${i}.qty`, message: `Only ${fmtQty(have)} in stock` });
            });
            if (errors.length) throw insufficientStock("Not enough stock for some lines.", errors);
            const avg = await averageCostPaise(ctx.orgId, site.id, productIds, session);
            const created = await StockMovement.create(
              body.lines.map((l) => ({
                orgId: ctx.orgId,
                siteId: site.id,
                productId: new Types.ObjectId(l.productId),
                date: body.date,
                type: "consumption",
                qtyMilli: -toMilli(l.qty),
                unitCostPaise: avg.get(l.productId) ?? 0,
                sourceType: "consumption",
                sourceId,
                reference: "Consumption",
                notes: l.usedFor ?? body.notes,
                createdBy: ctx.userId,
              })),
              { session, ordered: true },
            );
            await audit(
              ctx,
              { action: "stock.consume", entity: "StockMovement", entityId: sourceId, siteId: site.id, data: { lines: body.lines.length } },
              session,
            );
            return created.map((c) => c.toObject());
          });
          return { movements: await publicMovements(ctx.orgId, docs) };
        },
        { status: 201 },
      ),
    );

    r.post(
      "/stock-adjustments",
      requireSite("stock:adjust"),
      idempotent,
      handler(
        { body: adjustmentInput },
        async ({ body, ctx, site }) => {
          await loadProducts(ctx.orgId, [body.productId], () => "productId");
          const productId = new Types.ObjectId(body.productId);
          const delta = toMilli(body.qty);
          await ensureStockLocks(ctx.orgId, site.id, [productId]);
          const doc = await withTransaction(async (session) => {
            await lockStock(ctx.orgId, site.id, [productId], session);
            if (delta < 0) {
              const have = (await onHandMilli(ctx.orgId, site.id, { productIds: [productId], session })).get(body.productId) ?? 0;
              if (have + delta < 0) {
                throw insufficientStock("Stock can't go below zero.", [{ path: "qty", message: `Only ${fmtQty(have)} in stock` }]);
              }
            }
            const avg = (await averageCostPaise(ctx.orgId, site.id, [productId], session)).get(body.productId) ?? 0;
            const id = new Types.ObjectId();
            const [created] = await StockMovement.create(
              [
                {
                  _id: id,
                  orgId: ctx.orgId,
                  siteId: site.id,
                  productId,
                  date: body.date,
                  type: "adjustment",
                  qtyMilli: delta,
                  unitCostPaise: avg,
                  sourceType: "adjustment",
                  sourceId: id,
                  reference: "Adjustment",
                  notes: body.reason,
                  createdBy: ctx.userId,
                },
              ],
              { session },
            );
            await audit(
              ctx,
              { action: "stock.adjust", entity: "StockMovement", entityId: id, siteId: site.id, data: { qty: body.qty, reason: body.reason } },
              session,
            );
            return created!.toObject();
          });
          const [out] = await publicMovements(ctx.orgId, [doc]);
          return out;
        },
        { status: 201 },
      ),
    );
  },
};
