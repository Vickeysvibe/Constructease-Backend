import mongoose, { Schema, type InferSchemaType, type Types } from "mongoose";
import { tenantGuard } from "@/core/db";

export const PO_STATUSES = ["draft", "sent", "partially_received", "received", "cancelled"] as const;
export type POStatus = (typeof PO_STATUSES)[number];

/** Priced line, shared shape of PO / receipt / return lines (quantities in thousandths, money in paise). */
const pricedLine = {
  productId: { type: Schema.Types.ObjectId, ref: "Product", required: true },
  productName: { type: String, required: true },
  unit: { type: String, required: true },
  qtyMilli: { type: Number, required: true, min: 1 },
  unitPricePaise: { type: Number, required: true, min: 0 },
  taxRateBp: { type: Number, required: true, min: 0, max: 10_000 },
  amountPaise: { type: Number, required: true },
  taxPaise: { type: Number, required: true },
  totalPaise: { type: Number, required: true },
};

const POLineSchema = new Schema({
  ...pricedLine,
  /** running totals maintained by receipts / returns (inside their transactions) */
  receivedMilli: { type: Number, default: 0 },
  returnedMilli: { type: Number, default: 0 },
});

const PurchaseOrderSchema = new Schema(
  {
    orgId: { type: Schema.Types.ObjectId, required: true },
    siteId: { type: Schema.Types.ObjectId, ref: "Site", required: true },
    number: { type: String, required: true },
    vendorId: { type: Schema.Types.ObjectId, ref: "Party", required: true },
    /** snapshot for documents; refreshed on PATCH */
    vendorName: { type: String, required: true },
    vendorGstIn: { type: String },
    date: { type: String, required: true },
    expectedDate: { type: String },
    transport: { type: String, trim: true, maxlength: 200 },
    notes: { type: String, trim: true, maxlength: 1000 },
    status: { type: String, enum: PO_STATUSES, default: "draft" },
    lines: { type: [POLineSchema], default: [] },
    subtotalPaise: { type: Number, default: 0 },
    taxPaise: { type: Number, default: 0 },
    totalPaise: { type: Number, default: 0 },
    /** Σ totalPaise (incl. tax) of goods receipts against this PO */
    receivedValuePaise: { type: Number, default: 0 },
    cancelReason: { type: String, trim: true, maxlength: 500 },
    createdBy: { type: Schema.Types.ObjectId, required: true },
  },
  { timestamps: true },
);
PurchaseOrderSchema.index({ orgId: 1, number: 1 }, { unique: true });
PurchaseOrderSchema.index({ orgId: 1, siteId: 1, date: -1, number: -1 });
PurchaseOrderSchema.index({ orgId: 1, siteId: 1, vendorId: 1, status: 1 });
PurchaseOrderSchema.plugin(tenantGuard);
export const PurchaseOrder = mongoose.model("PurchaseOrder", PurchaseOrderSchema);

type LineDoc = InferSchemaType<typeof POLineSchema> & { _id: Types.ObjectId };
export type POLineDoc = LineDoc;
export type PurchaseOrderDoc = Omit<InferSchemaType<typeof PurchaseOrderSchema>, "lines"> & {
  _id: Types.ObjectId;
  __v: number;
  lines: LineDoc[];
  createdAt: Date;
  updatedAt: Date;
};

const ReceiptLineSchema = new Schema({ ...pricedLine, poLineId: { type: Schema.Types.ObjectId, required: true } });

const GoodsReceiptSchema = new Schema(
  {
    orgId: { type: Schema.Types.ObjectId, required: true },
    siteId: { type: Schema.Types.ObjectId, ref: "Site", required: true },
    number: { type: String, required: true },
    poId: { type: Schema.Types.ObjectId, ref: "PurchaseOrder", required: true },
    poNumber: { type: String, required: true },
    vendorId: { type: Schema.Types.ObjectId, ref: "Party", required: true },
    vendorName: { type: String, required: true },
    date: { type: String, required: true },
    challanNo: { type: String, trim: true, maxlength: 60 },
    vehicleNo: { type: String, trim: true, maxlength: 30 },
    notes: { type: String, trim: true, maxlength: 1000 },
    lines: { type: [ReceiptLineSchema], default: [] },
    subtotalPaise: { type: Number, required: true },
    taxPaise: { type: Number, required: true },
    totalPaise: { type: Number, required: true },
    createdBy: { type: Schema.Types.ObjectId, required: true },
    createdByName: { type: String, default: "" },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
GoodsReceiptSchema.index({ orgId: 1, number: 1 }, { unique: true });
GoodsReceiptSchema.index({ orgId: 1, siteId: 1, date: -1 });
GoodsReceiptSchema.index({ orgId: 1, poId: 1 });
GoodsReceiptSchema.plugin(tenantGuard);
export const GoodsReceipt = mongoose.model("GoodsReceipt", GoodsReceiptSchema);

const PurchaseReturnSchema = new Schema(
  {
    orgId: { type: Schema.Types.ObjectId, required: true },
    siteId: { type: Schema.Types.ObjectId, ref: "Site", required: true },
    number: { type: String, required: true },
    poId: { type: Schema.Types.ObjectId, ref: "PurchaseOrder", required: true },
    poNumber: { type: String, required: true },
    vendorId: { type: Schema.Types.ObjectId, ref: "Party", required: true },
    vendorName: { type: String, required: true },
    date: { type: String, required: true },
    reason: { type: String, trim: true, maxlength: 500 },
    lines: { type: [ReceiptLineSchema], default: [] },
    subtotalPaise: { type: Number, required: true },
    taxPaise: { type: Number, required: true },
    totalPaise: { type: Number, required: true },
    createdBy: { type: Schema.Types.ObjectId, required: true },
    createdByName: { type: String, default: "" },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
PurchaseReturnSchema.index({ orgId: 1, number: 1 }, { unique: true });
PurchaseReturnSchema.index({ orgId: 1, siteId: 1, date: -1 });
PurchaseReturnSchema.index({ orgId: 1, poId: 1 });
PurchaseReturnSchema.plugin(tenantGuard);
export const PurchaseReturn = mongoose.model("PurchaseReturn", PurchaseReturnSchema);

type DocLine = InferSchemaType<typeof ReceiptLineSchema> & { _id: Types.ObjectId };
export type GoodsReceiptDoc = Omit<InferSchemaType<typeof GoodsReceiptSchema>, "lines"> & {
  _id: Types.ObjectId;
  lines: DocLine[];
  createdAt: Date;
};
export type PurchaseReturnDoc = Omit<InferSchemaType<typeof PurchaseReturnSchema>, "lines"> & {
  _id: Types.ObjectId;
  lines: DocLine[];
  createdAt: Date;
};
