import mongoose, { Schema, type InferSchemaType, type Types } from "mongoose";
import { tenantGuard } from "@/core/db";

export const ATTENDANCE_STATUSES = ["present", "absent"] as const;
export type AttendanceStatus = (typeof ATTENDANCE_STATUSES)[number];

/**
 * One labourer on one site on one day. The wage rate is a snapshot taken when the entry is
 * first created, so later edits to the labourer's rate don't rewrite history.
 */
const AttendanceEntrySchema = new Schema(
  {
    orgId: { type: Schema.Types.ObjectId, required: true },
    siteId: { type: Schema.Types.ObjectId, ref: "Site", required: true },
    labourId: { type: Schema.Types.ObjectId, ref: "Party", required: true },
    date: { type: String, required: true }, // YYYY-MM-DD
    status: { type: String, enum: ATTENDANCE_STATUSES, required: true },
    /** 0–3 in 0.5 steps; 0 when absent */
    shifts: { type: Number, required: true, min: 0, max: 3 },
    wageRatePaise: { type: Number, required: true, min: 0 },
    /** round(shifts × wageRatePaise) */
    wagePaise: { type: Number, required: true, min: 0 },
    markedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true },
);
// One entry per labourer per site per day (the upsert key)…
AttendanceEntrySchema.index({ orgId: 1, siteId: 1, labourId: 1, date: 1 }, { unique: true });
// …and a labourer can be *present* on only one site per day across the org.
AttendanceEntrySchema.index(
  { orgId: 1, labourId: 1, date: 1 },
  { unique: true, partialFilterExpression: { status: "present" }, name: "present_once_per_day" },
);
AttendanceEntrySchema.index({ orgId: 1, siteId: 1, date: 1 });
AttendanceEntrySchema.plugin(tenantGuard);
export const AttendanceEntry = mongoose.model("AttendanceEntry", AttendanceEntrySchema);
export type AttendanceEntryDoc = InferSchemaType<typeof AttendanceEntrySchema> & { _id: Types.ObjectId };

export const CHECKIN_TYPES = ["in", "out"] as const;
export type CheckinType = (typeof CHECKIN_TYPES)[number];

const CheckinEventSchema = new Schema({
  type: { type: String, enum: CHECKIN_TYPES, required: true },
  at: { type: Date, required: true },
  lat: { type: Number, required: true, min: -90, max: 90 },
  lng: { type: Number, required: true, min: -180, max: 180 },
  accuracyM: { type: Number, min: 0 },
  /** filled in later by the "workforce.geocode" job */
  address: { type: String },
});

/** A site member's own check-ins on one site for one business day. */
const CheckinDaySchema = new Schema(
  {
    orgId: { type: Schema.Types.ObjectId, required: true },
    siteId: { type: Schema.Types.ObjectId, ref: "Site", required: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    date: { type: String, required: true }, // YYYY-MM-DD
    events: { type: [CheckinEventSchema], default: [] },
  },
  { timestamps: true },
);
CheckinDaySchema.index({ orgId: 1, siteId: 1, userId: 1, date: 1 }, { unique: true });
CheckinDaySchema.index({ orgId: 1, siteId: 1, date: 1 });
CheckinDaySchema.plugin(tenantGuard);
export const CheckinDay = mongoose.model("CheckinDay", CheckinDaySchema);
export type CheckinEventDoc = InferSchemaType<typeof CheckinEventSchema> & { _id: Types.ObjectId };
export type CheckinDayDoc = Omit<InferSchemaType<typeof CheckinDaySchema>, "events"> & {
  _id: Types.ObjectId;
  events: CheckinEventDoc[];
};
