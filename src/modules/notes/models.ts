import mongoose, { Schema, type Types } from "mongoose";
import { tenantGuard } from "@/core/db";
import { refOf, type userRefs } from "@/modules/worklog/models";

const NoteSchema = new Schema(
  {
    orgId: { type: Schema.Types.ObjectId, required: true },
    siteId: { type: Schema.Types.ObjectId, required: true },
    title: { type: String, required: true, trim: true, maxlength: 200 },
    body: { type: String, trim: true, maxlength: 20_000, default: "" },
    link: { type: String, trim: true, maxlength: 2000 },
    createdBy: { type: Schema.Types.ObjectId, required: true },
  },
  { timestamps: true },
);
NoteSchema.index({ orgId: 1, siteId: 1, createdAt: -1 });
NoteSchema.plugin(tenantGuard);
export const Note = mongoose.model("Note", NoteSchema);

export interface NoteDoc {
  _id: Types.ObjectId;
  title: string;
  body?: string | null;
  link?: string | null;
  createdBy: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

export const publicNote = (n: NoteDoc, refs: Awaited<ReturnType<typeof userRefs>>) => ({
  id: n._id.toHexString(),
  title: n.title,
  body: n.body ?? "",
  link: n.link ?? undefined,
  createdBy: refOf(refs, n.createdBy),
  createdAt: n.createdAt?.toISOString(),
  updatedAt: n.updatedAt?.toISOString(),
});
