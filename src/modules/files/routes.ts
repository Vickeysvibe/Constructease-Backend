import { z } from "zod";
import { Types } from "mongoose";
import { handler, objectId } from "@/core/http";
import { Job, findFile } from "@/core/jobs";
import { notFound } from "@/core/errors";
import type { ModuleRoutes } from "@/modules/registry";

/** RFC 5987 Content-Disposition so non-ASCII names (e.g. Tamil product names) don't break headers. */
export function contentDisposition(filename: string) {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export const filesModule: ModuleRoutes = {
  name: "files",
  org(r) {
    r.get(
      "/jobs/:jobId",
      handler({ params: z.object({ jobId: objectId }) }, async ({ params, ctx }) => {
        const job = await Job.findOne({ _id: params.jobId, orgId: ctx.orgId }).lean();
        if (!job) throw notFound("Job");
        const file = job.fileId ? await findFile(ctx.orgId, job.fileId) : null;
        return {
          id: job._id.toHexString(),
          type: job.type,
          status: job.status,
          attempts: job.attempts ?? 0,
          ...(job.status === "failed" ? { error: job.error ?? "Failed" } : {}),
          ...(file
            ? { file: { id: file.id.toHexString(), filename: file.filename, contentType: file.contentType, size: file.size } }
            : {}),
        };
      }),
    );
    r.get(
      "/files/:fileId",
      handler({ params: z.object({ fileId: objectId }) }, async ({ params, ctx, res }) => {
        const file = await findFile(ctx.orgId, new Types.ObjectId(params.fileId));
        if (!file) throw notFound("File");
        res.setHeader("Content-Type", file.contentType);
        res.setHeader("Content-Length", String(file.size));
        res.setHeader("Content-Disposition", contentDisposition(file.filename));
        res.setHeader("Cache-Control", "private, no-store");
        await new Promise<void>((resolve, reject) => {
          file.open().on("error", reject).pipe(res).on("finish", resolve).on("error", reject);
        });
      }),
    );
  },
};
