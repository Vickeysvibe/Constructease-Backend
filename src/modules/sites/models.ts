import mongoose, { Schema } from "mongoose";
import { tenantGuard } from "@/core/db";

const SiteSchema = new Schema(
  {
    orgId: { type: Schema.Types.ObjectId, ref: "Organization", required: true },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    address: { type: String, required: true, trim: true, maxlength: 500 },
    status: { type: String, enum: ["active", "archived"], default: "active" },
  },
  { timestamps: true },
);
SiteSchema.index({ orgId: 1, status: 1, name: 1 });
SiteSchema.plugin(tenantGuard);
export const Site = mongoose.model("Site", SiteSchema);

/** A non-admin user's access to one site. Owners/admins don't need memberships. */
const MembershipSchema = new Schema(
  {
    orgId: { type: Schema.Types.ObjectId, required: true },
    siteId: { type: Schema.Types.ObjectId, ref: "Site", required: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    role: { type: String, enum: ["engineer", "supervisor"], required: true },
  },
  { timestamps: true },
);
MembershipSchema.index({ orgId: 1, siteId: 1, userId: 1 }, { unique: true });
MembershipSchema.index({ orgId: 1, userId: 1 });
MembershipSchema.plugin(tenantGuard);
export const Membership = mongoose.model("Membership", MembershipSchema);
