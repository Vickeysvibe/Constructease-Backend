import mongoose, { Schema, type Types } from "mongoose";
import { tenantGuard } from "@/core/db";
import { User } from "@/modules/identity/models";

export const TRACKER_KINDS = ["todo", "work", "custom"] as const;
export type TrackerKind = (typeof TRACKER_KINDS)[number];
export const COLUMN_TYPES = ["text", "number", "date", "status"] as const;
export type ColumnType = (typeof COLUMN_TYPES)[number];
export const MAX_COLUMNS = 30;

/** Column keys are generated server-side (`c_…`) and are safe to use in field paths (`values.<key>`). */
export const COLUMN_KEY = /^c_[a-z0-9]{1,24}$/;

const ColumnSchema = new Schema(
  {
    key: { type: String, required: true, match: COLUMN_KEY },
    label: { type: String, required: true, trim: true, maxlength: 60 },
    type: { type: String, enum: COLUMN_TYPES, required: true },
    required: { type: Boolean, default: false },
    options: { type: [String], default: [] },
  },
  { _id: false },
);

const TrackerSchema = new Schema(
  {
    orgId: { type: Schema.Types.ObjectId, required: true },
    siteId: { type: Schema.Types.ObjectId, required: true },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    kind: { type: String, enum: TRACKER_KINDS, required: true },
    columns: { type: [ColumnSchema], default: [] },
  },
  { timestamps: true },
);
TrackerSchema.index({ orgId: 1, siteId: 1, createdAt: 1 });
TrackerSchema.plugin(tenantGuard);
export const Tracker = mongoose.model("Tracker", TrackerSchema);

export type RowValue = string | number;
export type RowValues = Record<string, RowValue>;

const TrackerRowSchema = new Schema(
  {
    orgId: { type: Schema.Types.ObjectId, required: true },
    siteId: { type: Schema.Types.ObjectId, required: true },
    trackerId: { type: Schema.Types.ObjectId, required: true },
    /** plain object keyed by column key; validated in the route against the tracker's columns */
    values: { type: Schema.Types.Mixed, default: () => ({}) },
    done: { type: Boolean, default: false },
    createdBy: { type: Schema.Types.ObjectId, required: true },
  },
  { timestamps: true, minimize: false },
);
TrackerRowSchema.index({ orgId: 1, trackerId: 1, createdAt: 1 });
TrackerRowSchema.index({ orgId: 1, siteId: 1, trackerId: 1 });
TrackerRowSchema.plugin(tenantGuard);
export const TrackerRow = mongoose.model("TrackerRow", TrackerRowSchema);

export interface ColumnDoc {
  key: string;
  label: string;
  type: ColumnType;
  required: boolean;
  options: string[];
}
export interface TrackerDoc {
  _id: Types.ObjectId;
  orgId: Types.ObjectId;
  siteId: Types.ObjectId;
  name: string;
  kind: TrackerKind;
  columns: ColumnDoc[];
  createdAt: Date;
  updatedAt: Date;
}
export interface TrackerRowDoc {
  _id: Types.ObjectId;
  trackerId: Types.ObjectId;
  values?: RowValues | null;
  done: boolean;
  createdBy: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

export const publicColumn = (c: ColumnDoc) => ({
  key: c.key,
  label: c.label,
  type: c.type,
  required: Boolean(c.required),
  options: c.type === "status" ? [...(c.options ?? [])] : [],
});

export const publicTracker = (t: TrackerDoc, rowCount: number) => ({
  id: t._id.toHexString(),
  name: t.name,
  kind: t.kind,
  columns: t.columns.map(publicColumn),
  rowCount,
  createdAt: t.createdAt?.toISOString(),
  updatedAt: t.updatedAt?.toISOString(),
});

type UserRef = { id: string; name: string };

/** Resolves `createdBy` names for many records with one query. */
export async function userRefs(orgId: Types.ObjectId, ids: Types.ObjectId[]): Promise<Map<string, UserRef>> {
  const unique = [...new Set(ids.map((i) => i.toHexString()))];
  const users = unique.length
    ? await User.find({ orgId, _id: { $in: unique } }).select("name").lean()
    : [];
  return new Map(users.map((u) => [u._id.toHexString(), { id: u._id.toHexString(), name: u.name }]));
}

export const refOf = (refs: Map<string, UserRef>, id: Types.ObjectId): UserRef =>
  refs.get(id.toHexString()) ?? { id: id.toHexString(), name: "Unknown user" };

export const publicRow = (r: TrackerRowDoc, refs: Map<string, UserRef>) => ({
  id: r._id.toHexString(),
  values: { ...(r.values ?? {}) },
  done: Boolean(r.done),
  createdBy: refOf(refs, r.createdBy),
  createdAt: r.createdAt?.toISOString(),
  updatedAt: r.updatedAt?.toISOString(),
});
