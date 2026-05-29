import mongoose from "mongoose";

const PurchaseOrderSchema = new mongoose.Schema(
  {
    siteId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Sites",
      required: true,
    },
    vendorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Vendors",
      required: true,
    },
    date: { type: Date, default: Date.now },
    transport: { type: String },
    order: [
      {
        productId: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "Products",
          required: true,
        },
        requiredQty: { type: Number, required: true },
      },
    ],
  },
  { timestamps: true }
);

export default mongoose.model("PurchaseOrders", PurchaseOrderSchema);
