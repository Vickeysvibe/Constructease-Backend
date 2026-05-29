import mongoose from "mongoose";

const WorkSchema = new mongoose.Schema(
  {
    title: { type: String, required: true },
    description: { type: String, required: true },
    date: { type: Date, required: true },
    additionalCols: {
      type: Map,
      of: String,
      default: {},
    },
    siteId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Sites",
      required: true,
    },
  },
  { timestamps: true }
);

export default mongoose.model("Works", WorkSchema);
