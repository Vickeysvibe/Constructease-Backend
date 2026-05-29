import mongoose from "mongoose";

const SiteSchema = new mongoose.Schema(
  {
    siteName: {
      type: String,
      required: [true, "Site name is required"],
      trim: true,
    },
    engineerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Engineers", // Reference to the Engineers model
      required: [true, "Engineer ID is required"],
    },
    siteAddress: {
      type: String,
      required: [true, "Site address is required"],
      trim: true,
    },
    supervisorsId: {
      type: [
        {
          type: mongoose.Schema.Types.ObjectId,
          ref: "Supervisors", 
        },
      ],
      default: [],
    },
  },
  {
    timestamps: true, 
  }
);

export default mongoose.model("Sites", SiteSchema);
