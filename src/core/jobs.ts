/**
 * Minimal MongoDB-backed job queue + GridFS file store. Slow work (PDFs, Excel exports, geocoding)
 * never runs inside a request: the API enqueues, `src/worker.ts` executes.
 */
import os from "node:os";
import { Readable } from "node:stream";
import mongoose, { Schema, type Types } from "mongoose";
import { tenantGuard } from "./db";
import { logger } from "./logger";
import type { RequestContext } from "./context";

const JobSchema = new Schema(
  {
    orgId: { type: Schema.Types.ObjectId, required: true },
    type: { type: String, required: true },
    payload: { type: Schema.Types.Mixed, default: {} },
    status: { type: String, enum: ["queued", "running", "done", "failed"], default: "queued" },
    attempts: { type: Number, default: 0 },
    maxAttempts: { type: Number, default: 3 },
    runAfter: { type: Date, default: Date.now },
    lockedAt: Date,
    lockedBy: String,
    error: String,
    fileId: { type: Schema.Types.ObjectId },
    createdBy: { type: Schema.Types.ObjectId },
  },
  { timestamps: true },
);
JobSchema.index({ status: 1, runAfter: 1 });
JobSchema.index({ updatedAt: 1 }, { expireAfterSeconds: 7 * 86_400 });
JobSchema.plugin(tenantGuard);
export const Job = mongoose.model("Job", JobSchema);

export interface JobContext {
  id: Types.ObjectId;
  orgId: Types.ObjectId;
  createdBy?: Types.ObjectId;
  payload: Record<string, unknown>;
}
export type JobResult = { fileId?: Types.ObjectId } | void;
type JobHandler = (job: JobContext) => Promise<JobResult>;

const handlers = new Map<string, JobHandler>();
export function registerJobHandler(type: string, fn: JobHandler) {
  handlers.set(type, fn);
}

export async function enqueue(
  ctx: Pick<RequestContext, "orgId" | "userId">,
  type: string,
  payload: Record<string, unknown>,
  opts: { maxAttempts?: number } = {},
) {
  const job = await Job.create({ orgId: ctx.orgId, createdBy: ctx.userId, type, payload, ...opts });
  return { jobId: job._id.toHexString() };
}

const WORKER_ID = `${os.hostname()}:${process.pid}`;
const LOCK_TIMEOUT_MS = 5 * 60_000;

/** Claims and runs one job. Returns false when the queue is empty. */
export async function runNextJob(): Promise<boolean> {
  const now = new Date();
  const job = await Job.findOneAndUpdate(
    {
      $or: [
        { status: "queued", runAfter: { $lte: now } },
        { status: "running", lockedAt: { $lt: new Date(now.getTime() - LOCK_TIMEOUT_MS) } },
      ],
    },
    { $set: { status: "running", lockedAt: now, lockedBy: WORKER_ID }, $inc: { attempts: 1 } },
    { sort: { runAfter: 1 }, new: true },
  )
    .setOptions({ skipTenantGuard: true })
    .lean();
  if (!job) return false;
  const fn = handlers.get(job.type);
  try {
    if (!fn) throw new Error(`No handler for job type "${job.type}"`);
    const result = await fn({
      id: job._id,
      orgId: job.orgId,
      createdBy: job.createdBy ?? undefined,
      payload: (job.payload ?? {}) as Record<string, unknown>,
    });
    await Job.updateOne(
      { _id: job._id, orgId: job.orgId },
      { $set: { status: "done", fileId: result?.fileId, error: undefined }, $unset: { lockedAt: 1, lockedBy: 1 } },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const retry = job.attempts < job.maxAttempts && !(err instanceof PermanentJobError);
    logger.warn({ jobId: job._id, type: job.type, err: message, retry }, "job failed");
    await Job.updateOne(
      { _id: job._id, orgId: job.orgId },
      {
        $set: {
          status: retry ? "queued" : "failed",
          error: message.slice(0, 500),
          runAfter: new Date(Date.now() + 2 ** job.attempts * 5_000),
        },
        $unset: { lockedAt: 1, lockedBy: 1 },
      },
    );
  }
  return true;
}

/** An error retrying won't fix (bad input, missing config). */
export class PermanentJobError extends Error {}

/** Test helper: drain the queue synchronously. */
export async function drainJobs(max = 50) {
  for (let i = 0; i < max; i++) if (!(await runNextJob())) return;
}

// ---------- Files (GridFS) ----------
const bucket = () => new mongoose.mongo.GridFSBucket(mongoose.connection.db!, { bucketName: "files" });

export async function saveFile(
  orgId: Types.ObjectId,
  filename: string,
  contentType: string,
  data: Buffer,
  createdBy?: Types.ObjectId,
): Promise<Types.ObjectId> {
  return new Promise((resolve, reject) => {
    const upload = bucket().openUploadStream(filename, { metadata: { orgId, contentType, createdBy } });
    Readable.from(data).pipe(upload).on("error", reject).on("finish", () => resolve(upload.id as Types.ObjectId));
  });
}

export async function findFile(orgId: Types.ObjectId, fileId: Types.ObjectId) {
  const [file] = await bucket().find({ _id: fileId, "metadata.orgId": orgId }).limit(1).toArray();
  if (!file) return null;
  return {
    id: file._id as Types.ObjectId,
    filename: file.filename,
    contentType: (file.metadata?.contentType as string) ?? "application/octet-stream",
    size: file.length,
    open: () => bucket().openDownloadStream(file._id),
  };
}

export const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
export const PDF_TYPE = "application/pdf";
