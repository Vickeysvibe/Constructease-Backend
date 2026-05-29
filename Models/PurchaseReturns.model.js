import mongoose from "mongoose";

const PurchaseReturnSchema = new mongoose.Schema(
  {
    POid: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "PurchaseOrders",
      required: true,
    },
    order: [
      {
        materialId: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "Materials",
          required: true,
        },
        returnQty: { type: Number, required: true },
        tax: { type: Number, required: true },
        subTotal: { type: Number, required: true },
      },
    ],
    grandTotal: { type: Number, required: true },
    siteId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Sites",
      required: true,
    },
  },
  { timestamps: true }
);

export default mongoose.model("PurchaseReturns", PurchaseReturnSchema);
