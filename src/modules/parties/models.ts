import mongoose, { Schema, type InferSchemaType, type Types } from "mongoose";
import { tenantGuard } from "@/core/db";

export const PARTY_KINDS = ["vendor", "client", "labour"] as const;
export type PartyKind = (typeof PARTY_KINDS)[number];

const PartySchema = new Schema(
  {
    orgId: { type: Schema.Types.ObjectId, required: true },
    kind: { type: String, enum: PARTY_KINDS, required: true },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    /** lower-cased, whitespace-collapsed name used for duplicate detection */
    nameKey: { type: String, required: true },
    phone: { type: String, required: true },
    address: { type: String, trim: true, maxlength: 500 },
    contactName: { type: String, trim: true, maxlength: 120 },
    gstIn: { type: String, trim: true, uppercase: true },
    pan: { type: String, trim: true, uppercase: true },
    category: { type: String, trim: true, maxlength: 60 },
    subCategory: { type: String, trim: true, maxlength: 60 },
    wageRatePaise: { type: Number, min: 0 },
    siteIds: { type: [Schema.Types.ObjectId], default: [] },
    status: { type: String, enum: ["active", "archived"], default: "active" },
  },
  { timestamps: true },
);
PartySchema.index({ orgId: 1, kind: 1, nameKey: 1, phone: 1 }, { unique: true });
PartySchema.index({ orgId: 1, siteIds: 1, kind: 1, status: 1, name: 1 });
PartySchema.plugin(tenantGuard);
export const Party = mongoose.model("Party", PartySchema);
export type PartyDoc = InferSchemaType<typeof PartySchema> & { _id: Types.ObjectId; createdAt: Date; updatedAt: Date };

export const nameKeyOf = (name: string) => name.trim().replace(/\s+/g, " ").toLowerCase();

export const publicParty = (p: PartyDoc) => ({
  id: p._id.toHexString(),
  kind: p.kind,
  name: p.name,
  phone: p.phone,
  address: p.address ?? undefined,
  contactName: p.contactName ?? undefined,
  gstIn: p.gstIn ?? undefined,
  pan: p.pan ?? undefined,
  category: p.category ?? undefined,
  subCategory: p.subCategory ?? undefined,
  wageRatePaise: p.wageRatePaise ?? undefined,
  siteIds: (p.siteIds ?? []).map((s) => s.toHexString()),
  status: p.status,
  createdAt: p.createdAt?.toISOString(),
  updatedAt: p.updatedAt?.toISOString(),
});
export type PublicParty = ReturnType<typeof publicParty>;
