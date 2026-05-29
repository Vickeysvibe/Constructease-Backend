import mongoose from "mongoose";

const LabourAttendanceSchema = new mongoose.Schema(
  {
    siteId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Sites",
      required: true,
    },
    date: { type: Date, default: Date.now, required: true },
    attendance: [
      {
        labourId: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "Labours",
          required: true,
        },
        shift: { type: Number, default: 1 },
        status: {
          type: String,
          enum: ["present", "absent"],
          required: true,
        },
      },
    ],
  },
  { timestamps: true }
);

export default mongoose.model("LabourAttendances", LabourAttendanceSchema);
