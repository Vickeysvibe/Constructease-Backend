import { z } from "zod";
import { handler, listQuery, objectId, paginate, parseSort, containsRegex } from "@/core/http";
import { requireEngineerAnywhere } from "@/core/access";
import { conflict, notFound } from "@/core/errors";
import { audit } from "@/core/records";
import { taxRateBp } from "@/core/units";
import { nameKeyOf } from "@/modules/parties/models";
import type { ModuleRoutes } from "@/modules/registry";
import { Product, publicProduct, type ProductDoc } from "./models";

export const productInput = z.object({
  name: z.string().trim().min(1, "Name is required").max(120),
  unit: z.string().trim().min(1, "Unit is required").max(20),
  category: z.string().trim().max(60).optional(),
  description: z.string().trim().max(500).optional(),
  defaultTaxRateBp: taxRateBp.optional(),
});
const params = z.object({ productId: objectId });

export const productsModule: ModuleRoutes = {
  name: "products",
  org(r) {
    r.get(
      "/products",
      handler(
        {
          query: listQuery.extend({
            category: z.string().trim().max(60).optional(),
            status: z.enum(["active", "archived"]).optional(),
          }),
        },
        async ({ query, ctx }) => {
          const filter: Record<string, unknown> = { orgId: ctx.orgId, status: query.status ?? "active" };
          if (query.category) filter.category = query.category;
          if (query.q) filter.$or = [{ name: containsRegex(query.q) }, { category: containsRegex(query.q) }];
          return paginate(Product, filter, query, parseSort(query.sort, ["name", "category", "createdAt"], { name: 1 }), (d) =>
            publicProduct(d as unknown as ProductDoc),
          );
        },
      ),
    );
    r.post(
      "/products",
      requireEngineerAnywhere,
      handler(
        { body: productInput },
        async ({ body, ctx }) => {
          const nameKey = nameKeyOf(body.name);
          if (await Product.exists({ orgId: ctx.orgId, nameKey })) {
            throw conflict(`A product named "${body.name}" already exists.`, [{ path: "name", message: "Name is already used" }]);
          }
          const p = await Product.create({ ...body, nameKey, orgId: ctx.orgId });
          await audit(ctx, { action: "product.create", entity: "Product", entityId: p._id });
          return publicProduct(p.toObject() as ProductDoc);
        },
        { status: 201 },
      ),
    );
    r.get(
      "/products/:productId",
      handler({ params }, async ({ params, ctx }) => {
        const p = await Product.findOne({ _id: params.productId, orgId: ctx.orgId }).lean<ProductDoc>();
        if (!p) throw notFound("Product");
        return publicProduct(p);
      }),
    );
    r.patch(
      "/products/:productId",
      requireEngineerAnywhere,
      handler({ params, body: productInput.partial().strict() }, async ({ params, body, ctx }) => {
        const set: Record<string, unknown> = { ...body };
        if (body.name) {
          set.nameKey = nameKeyOf(body.name);
          const clash = await Product.exists({ orgId: ctx.orgId, nameKey: set.nameKey, _id: { $ne: params.productId } });
          if (clash) throw conflict(`A product named "${body.name}" already exists.`);
        }
        const p = await Product.findOneAndUpdate(
          { _id: params.productId, orgId: ctx.orgId },
          { $set: set },
          { new: true, runValidators: true },
        ).lean<ProductDoc>();
        if (!p) throw notFound("Product");
        await audit(ctx, { action: "product.update", entity: "Product", entityId: p._id, data: body });
        return publicProduct(p);
      }),
    );
    for (const [path, status] of [
      ["/products/:productId/archive", "archived"],
      ["/products/:productId/restore", "active"],
    ] as const) {
      r.post(
        path,
        requireEngineerAnywhere,
        handler({ params }, async ({ params, ctx }) => {
          const p = await Product.findOneAndUpdate(
            { _id: params.productId, orgId: ctx.orgId },
            { $set: { status } },
            { new: true },
          ).lean<ProductDoc>();
          if (!p) throw notFound("Product");
          await audit(ctx, { action: `product.${status}`, entity: "Product", entityId: p._id });
          return publicProduct(p);
        }),
      );
    }
  },
};
