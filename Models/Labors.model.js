import mongoose from "mongoose";

const LabourSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    phoneNo: { type: String, required: true },
    category: { type: String, required: true },
    subCategory: { type: String, required: true },
    wagesPerShift: { type: Number, required: true },
    isDel:{
      type: Boolean,
      default: false

    },
    siteId: {
      type: [
        {
          type: mongoose.Schema.Types.ObjectId,
          ref: "Sites",
        },
      ],
      default: [],
    },

  },
  { timestamps: true }
);

export default mongoose.model("Labours", LabourSchema);
