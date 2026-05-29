import mongoose from "mongoose";

const MaterialInwardSchema = new mongoose.Schema(
  {
    POid: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "PurchaseOrders",
      required: true,
    },
    materials: {
      type: [
        {
          type: mongoose.Schema.Types.ObjectId,
          ref: "Materials",
        },
      ],
      default: [],
    },
    subTotal: { type: Number, required: true },
    grandTotal: { type: Number, required: true },
    siteId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Sites",
      required: true,
    },
  },
  { timestamps: true }
);

const MaterialInwards =
  mongoose.models.MaterialInwards ||
  mongoose.model("MaterialInwards", MaterialInwardSchema);

export default MaterialInwards;
