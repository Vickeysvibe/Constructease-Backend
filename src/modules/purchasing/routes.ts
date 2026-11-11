import { z } from "zod";
import { Types } from "mongoose";
import { containsRegex, handler, objectId, paginate, parseSort } from "@/core/http";
import { requireSite } from "@/core/access";
import { enqueue } from "@/core/jobs";
import { idempotent } from "@/core/records";
import type { ModuleRoutes } from "@/modules/registry";
import { GoodsReceipt, PurchaseOrder, PurchaseReturn, type GoodsReceiptDoc, type PurchaseOrderDoc, type PurchaseReturnDoc } from "./models";
import {
  cancelInput,
  grInput,
  grListQuery,
  poInput,
  poListQuery,
  poPatch,
  poPdfInput,
  prInput,
  prListQuery,
  returnPdfInput,
} from "./schemas";
import {
  cancelPO,
  createPO,
  createReceipt,
  createReturn,
  findReceipt,
  findReturn,
  findSitePO,
  loadPO,
  publicPOSummary,
  publicReceiptSummary,
  publicReturnSummary,
  sendPO,
  updatePO,
} from "./service";
import { PDF_JOB } from "./pdf";

const poParams = z.object({ poId: objectId });
const dateFilter = (from?: string, to?: string) =>
  from || to ? { date: { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) } } : {};

export const purchasingModule: ModuleRoutes = {
  name: "purchasing",
  site(r) {
    // ---------- purchase orders ----------
    r.get(
      "/purchase-orders",
      requireSite("site:read"),
      handler({ query: poListQuery }, async ({ query, ctx, site }) => {
        const filter: Record<string, unknown> = { orgId: ctx.orgId, siteId: site.id, ...dateFilter(query.from, query.to) };
        if (query.status) filter.status = query.status;
        if (query.vendorId) filter.vendorId = new Types.ObjectId(query.vendorId);
        if (query.q) filter.$or = [{ number: containsRegex(query.q) }, { vendorName: containsRegex(query.q) }];
        const sort = parseSort(query.sort, ["date", "number", "totalPaise", "createdAt", "status"], { date: -1, number: -1 });
        return paginate(PurchaseOrder, filter, query, sort, (d) => publicPOSummary(d as unknown as PurchaseOrderDoc));
      }),
    );
    r.post(
      "/purchase-orders",
      requireSite("purchasing:write"),
      idempotent,
      handler({ body: poInput }, async ({ body, ctx, site }) => createPO(ctx, site, body), { status: 201 }),
    );
    r.get(
      "/purchase-orders/:poId",
      requireSite("site:read"),
      handler({ params: poParams }, async ({ params, ctx, site }) => loadPO(ctx.orgId, site.id, params.poId)),
    );
    r.patch(
      "/purchase-orders/:poId",
      requireSite("purchasing:write"),
      handler({ params: poParams, body: poPatch }, async ({ params, body, ctx, site }) => updatePO(ctx, site, params.poId, body)),
    );
    r.post(
      "/purchase-orders/:poId/send",
      requireSite("purchasing:write"),
      handler({ params: poParams }, async ({ params, ctx, site }) => sendPO(ctx, site, params.poId)),
    );
    r.post(
      "/purchase-orders/:poId/cancel",
      requireSite("purchasing:write"),
      handler({ params: poParams, body: cancelInput }, async ({ params, body, ctx, site }) =>
        cancelPO(ctx, site, params.poId, body.reason),
      ),
    );
    r.post(
      "/purchase-orders/:poId/pdf",
      requireSite("site:read"),
      handler(
        { params: poParams, body: poPdfInput },
        async ({ params, body, ctx, site }) => {
          const po = await findSitePO(ctx.orgId, site.id, params.poId);
          return enqueue(ctx, PDF_JOB, { kind: "po", id: po._id.toHexString(), template: body.template });
        },
        { status: 202 },
      ),
    );

    // ---------- goods receipts ----------
    r.get(
      "/goods-receipts",
      requireSite("site:read"),
      handler({ query: grListQuery }, async ({ query, ctx, site }) => {
        const filter: Record<string, unknown> = { orgId: ctx.orgId, siteId: site.id, ...dateFilter(query.from, query.to) };
        if (query.poId) filter.poId = new Types.ObjectId(query.poId);
        if (query.vendorId) filter.vendorId = new Types.ObjectId(query.vendorId);
        if (query.q) {
          const rx = containsRegex(query.q);
          filter.$or = [{ number: rx }, { poNumber: rx }, { vendorName: rx }, { challanNo: rx }];
        }
        const sort = parseSort(query.sort, ["date", "number", "totalPaise", "createdAt"], { date: -1, number: -1 });
        return paginate(GoodsReceipt, filter, query, sort, (d) => publicReceiptSummary(d as unknown as GoodsReceiptDoc));
      }),
    );
    r.post(
      "/goods-receipts",
      requireSite("receiving:write"),
      idempotent,
      handler({ body: grInput }, async ({ body, ctx, site }) => createReceipt(ctx, site, body), { status: 201 }),
    );
    r.get(
      "/goods-receipts/:receiptId",
      requireSite("site:read"),
      handler({ params: z.object({ receiptId: objectId }) }, async ({ params, ctx, site }) =>
        findReceipt(ctx.orgId, site.id, params.receiptId),
      ),
    );

    // ---------- purchase returns ----------
    r.get(
      "/purchase-returns",
      requireSite("site:read"),
      handler({ query: prListQuery }, async ({ query, ctx, site }) => {
        const filter: Record<string, unknown> = { orgId: ctx.orgId, siteId: site.id, ...dateFilter(query.from, query.to) };
        if (query.poId) filter.poId = new Types.ObjectId(query.poId);
        if (query.q) {
          const rx = containsRegex(query.q);
          filter.$or = [{ number: rx }, { poNumber: rx }, { vendorName: rx }];
        }
        const sort = parseSort(query.sort, ["date", "number", "totalPaise", "createdAt"], { date: -1, number: -1 });
        return paginate(PurchaseReturn, filter, query, sort, (d) => publicReturnSummary(d as unknown as PurchaseReturnDoc));
      }),
    );
    r.post(
      "/purchase-returns",
      requireSite("purchasing:write"),
      idempotent,
      handler({ body: prInput }, async ({ body, ctx, site }) => createReturn(ctx, site, body), { status: 201 }),
    );
    const returnParams = z.object({ returnId: objectId });
    r.get(
      "/purchase-returns/:returnId",
      requireSite("site:read"),
      handler({ params: returnParams }, async ({ params, ctx, site }) => findReturn(ctx.orgId, site.id, params.returnId)),
    );
    r.post(
      "/purchase-returns/:returnId/pdf",
      requireSite("site:read"),
      handler(
        { params: returnParams, body: returnPdfInput },
        async ({ params, body, ctx, site }) => {
          const pr = await findReturn(ctx.orgId, site.id, params.returnId);
          return enqueue(ctx, PDF_JOB, { kind: "return", id: pr.id, template: body.template });
        },
        { status: 202 },
      ),
    );
  },
};
