import mongoose from "mongoose";

const TodoSchema = new mongoose.Schema(
  {
    task: { type: String, required: true },
    start: { type: Date, required: true },
    end: { type: Date, required: true },
    additionalCols: {
      type: Map,
      of: String, // Allows key-value pairs with values as strings
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

export default mongoose.model("Todos", TodoSchema);
