import mongoose from "mongoose";

const MaterialSchema = new mongoose.Schema(
  {
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Products",
      required: true,
    },
    suppliedQty: {
      type: Number,
      required: true,
    },
    tax: {
      type: Number,
      required: true,
      default: 18,
    },
    availableQty: {
      type: Number,
      required: true,
    },
    usedQty: {
      type: Number,
      required: true,
      default: 0,
    },
    unitPrice: {
      type: Number,
      required: true,
      default: 0,
    },
    siteId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Sites",
      required: true,
    },
    fromVendor: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Vendors",
      required: true,
    },
    POid: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "PurchaseOrders",
      required: true,
    },
  },
  { timestamps: true }
);

// Pre-save middleware to set `availableQty` to `suppliedQty` if not provided
MaterialSchema.pre("save", function (next) {
  if (!this.availableQty) {
    this.availableQty = this.suppliedQty;
  }
  next();
});

export default mongoose.model("Materials", MaterialSchema);
