import mongoose, { Schema, type InferSchemaType, type Types } from "mongoose";
import { tenantGuard } from "@/core/db";

const ProductSchema = new Schema(
  {
    orgId: { type: Schema.Types.ObjectId, required: true },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    nameKey: { type: String, required: true },
    unit: { type: String, required: true, trim: true, maxlength: 20 },
    category: { type: String, trim: true, maxlength: 60 },
    description: { type: String, trim: true, maxlength: 500 },
    defaultTaxRateBp: { type: Number, min: 0, max: 10_000, default: 1800 },
    status: { type: String, enum: ["active", "archived"], default: "active" },
  },
  { timestamps: true },
);
ProductSchema.index({ orgId: 1, nameKey: 1 }, { unique: true });
ProductSchema.index({ orgId: 1, status: 1, category: 1, name: 1 });
ProductSchema.plugin(tenantGuard);
export const Product = mongoose.model("Product", ProductSchema);
export type ProductDoc = InferSchemaType<typeof ProductSchema> & { _id: Types.ObjectId; createdAt: Date; updatedAt: Date };

export const publicProduct = (p: ProductDoc) => ({
  id: p._id.toHexString(),
  name: p.name,
  unit: p.unit,
  category: p.category ?? undefined,
  description: p.description ?? undefined,
  defaultTaxRateBp: p.defaultTaxRateBp ?? 1800,
  status: p.status,
  createdAt: p.createdAt?.toISOString(),
  updatedAt: p.updatedAt?.toISOString(),
});
