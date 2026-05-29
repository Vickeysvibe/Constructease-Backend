import mongoose from "mongoose";

const PaymentSchema = new mongoose.Schema(
  {
    siteId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Sites",
    },
    engineerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Engineers",
    },
    type: {
      type: String,
      enum: ["vendor", "client", "labour", "others"],
      required: true,
    },
    date: { type: Date, default: Date.now, required: true },
    description: { type: String, default: "" },
    name: { type: String, default: "" },
    amount: { type: Number, default: 0 },
    quantity: { type: Number, default: 0 },
    unit: { type: String, default: "" },
    costPerUnit: { type: Number, default: 0 },
    paymentReceived: { type: Number, default: 0 },
    paymentAs: { type: String, default: "" },
    paymentBy: { type: String, default: "" },
  },
  { timestamps: true }
);

export default mongoose.model("Payments", PaymentSchema);
