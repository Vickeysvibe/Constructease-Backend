import mongoose, { Schema, type InferSchemaType, type Types } from "mongoose";
import { tenantGuard } from "@/core/db";
import { DEFAULT_TZ } from "@/core/units";

const OrganizationSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    logoUrl: { type: String, trim: true },
    description: { type: String, trim: true, maxlength: 1000 },
    address: { type: String, trim: true, maxlength: 500 },
    phone: { type: String, trim: true },
    gstIn: { type: String, trim: true, uppercase: true },
    timezone: { type: String, default: DEFAULT_TZ },
  },
  { timestamps: true },
);
export const Organization = mongoose.model("Organization", OrganizationSchema);
export type OrganizationDoc = InferSchemaType<typeof OrganizationSchema> & { _id: Types.ObjectId };

const UserSchema = new Schema(
  {
    orgId: { type: Schema.Types.ObjectId, ref: "Organization", required: true },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    email: { type: String, required: true, trim: true, lowercase: true },
    phone: { type: String, trim: true, default: "" },
    passwordHash: { type: String, required: true, select: false },
    orgRole: { type: String, enum: ["owner", "admin", "member"], required: true, default: "member" },
    status: { type: String, enum: ["active", "disabled"], default: "active" },
    lastLoginAt: Date,
  },
  { timestamps: true },
);
// Email is the login identifier, so it is unique across all orgs.
UserSchema.index({ email: 1 }, { unique: true });
UserSchema.index({ orgId: 1, status: 1 });
UserSchema.plugin(tenantGuard);
export const User = mongoose.model("User", UserSchema);
export type UserDoc = InferSchemaType<typeof UserSchema> & { _id: Types.ObjectId };

/** One refresh-token session. The token rotates on every refresh; presenting a previous token revokes the session (reuse detection). */
const SessionSchema = new Schema(
  {
    orgId: { type: Schema.Types.ObjectId, required: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    tokenHash: { type: String, required: true },
    prevTokenHash: { type: String },
    expiresAt: { type: Date, required: true },
    revokedAt: { type: Date },
    revokedReason: { type: String },
    userAgent: String,
    ip: String,
  },
  { timestamps: true },
);
SessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
SessionSchema.index({ orgId: 1, userId: 1 });
SessionSchema.plugin(tenantGuard);
export const Session = mongoose.model("Session", SessionSchema);

export const publicUser = (u: {
  _id: Types.ObjectId;
  name: string;
  email: string;
  phone?: string | null;
  orgRole: string;
  status: string;
  createdAt?: Date;
  updatedAt?: Date;
}) => ({
  id: u._id.toHexString(),
  name: u.name,
  email: u.email,
  phone: u.phone ?? "",
  orgRole: u.orgRole,
  status: u.status,
  createdAt: u.createdAt?.toISOString(),
  updatedAt: u.updatedAt?.toISOString(),
});

export const publicOrg = (o: OrganizationDoc & { createdAt?: Date; updatedAt?: Date }) => ({
  id: o._id.toHexString(),
  name: o.name,
  logoUrl: o.logoUrl ?? undefined,
  description: o.description ?? undefined,
  address: o.address ?? undefined,
  phone: o.phone ?? undefined,
  gstIn: o.gstIn ?? undefined,
  timezone: o.timezone ?? DEFAULT_TZ,
  createdAt: o.createdAt?.toISOString(),
  updatedAt: o.updatedAt?.toISOString(),
});
