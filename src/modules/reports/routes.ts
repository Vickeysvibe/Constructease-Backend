import { z, type ZodRawShape } from "zod";
import { requireSite } from "@/core/access";
import { AppError } from "@/core/errors";
import { handler, objectId } from "@/core/http";
import { enqueue, PermanentJobError, registerJobHandler, saveFile, XLSX_TYPE } from "@/core/jobs";
import { dateRange, DEFAULT_TZ } from "@/core/units";
import { PAYMENT_CATEGORIES, PAYMENT_DIRECTIONS } from "@/modules/finance/models";
import { Organization } from "@/modules/identity/models";
import { findSiteParty } from "@/modules/parties/routes";
import { Site } from "@/modules/sites/models";
import type { ModuleRoutes } from "@/modules/registry";
import { reportWorkbook, type ReportType } from "./excel";
import {
  labourWagesReport,
  paymentsReport,
  siteSummaryReport,
  stockReport,
  vendorLedgerDetail,
  vendorLedgerSummary,
  type ReportScope,
} from "./service";

export const REPORT_EXPORT_JOB = "reports.export";

/** `from`/`to` (inclusive, ≤ 366 days) + `format` + report-specific filters. */
const reportQuery = <S extends ZodRawShape>(extra: S) =>
  z.object({ format: z.enum(["json", "xlsx"]).default("json"), ...extra }).and(dateRange());

const queries = {
  "labour-wages": reportQuery({ category: z.string().trim().min(1).max(60).optional() }),
  "vendor-ledger": reportQuery({ vendorId: objectId.optional() }),
  payments: reportQuery({ category: z.enum(PAYMENT_CATEGORIES).optional(), direction: z.enum(PAYMENT_DIRECTIONS).optional() }),
  stock: reportQuery({ productId: objectId.optional() }),
  "site-summary": reportQuery({}),
} satisfies Record<ReportType, unknown>;

type Params = { [K in ReportType]: z.output<(typeof queries)[K]> };

/** Computes a report. Shared by the JSON route and the export job so both always agree. */
async function runReport(type: ReportType, scope: ReportScope, q: Params[ReportType]): Promise<unknown> {
  switch (type) {
    case "labour-wages":
      return labourWagesReport(scope, q as Params["labour-wages"]);
    case "vendor-ledger": {
      const p = q as Params["vendor-ledger"];
      return p.vendorId ? vendorLedgerDetail(scope, p.vendorId, p) : vendorLedgerSummary(scope, p);
    }
    case "payments":
      return paymentsReport(scope, q as Params["payments"]);
    case "stock":
      return stockReport(scope, q as Params["stock"]);
    default:
      return siteSummaryReport(scope, q as Params["site-summary"]);
  }
}

registerJobHandler(REPORT_EXPORT_JOB, async (job) => {
  const { type, siteId, params } = job.payload as { type: ReportType; siteId: string; params: Record<string, unknown> };
  const parsed = queries[type]?.safeParse(params);
  if (!parsed?.success) throw new PermanentJobError(`Invalid report export: ${type}`);
  const [site, org] = await Promise.all([
    Site.findOne({ _id: siteId, orgId: job.orgId }).select("name").lean(),
    Organization.findOne({ _id: job.orgId }).select("timezone").lean(),
  ]);
  if (!site) throw new PermanentJobError("Site not found");
  const scope: ReportScope = {
    orgId: job.orgId,
    siteId: site._id,
    userId: job.createdBy ?? job.orgId,
    tz: org?.timezone ?? DEFAULT_TZ,
  };
  let report: unknown;
  try {
    report = await runReport(type, scope, parsed.data);
  } catch (err) {
    // e.g. the vendor was detached since the export was requested — retrying won't help
    if (err instanceof AppError) throw new PermanentJobError(err.message);
    throw err;
  }
  const { from, to } = parsed.data;
  const { filename, buffer } = await reportWorkbook(type, report, { siteName: site.name, from, to });
  return { fileId: await saveFile(job.orgId, filename, XLSX_TYPE, buffer, job.createdBy) };
});

export const reportsModule: ModuleRoutes = {
  name: "reports",
  site(r) {
    for (const type of Object.keys(queries) as ReportType[]) {
      r.get(
        `/reports/${type}`,
        requireSite("reports:read"),
        handler({ query: queries[type] }, async ({ query, ctx, site, res }) => {
          const { format, ...params } = query;
          if (format === "xlsx") {
            // fail fast on a bad vendor rather than in the worker
            if ("vendorId" in params && params.vendorId) await findSiteParty(ctx.orgId, site.id, params.vendorId, "vendor");
            res.status(202).json(await enqueue(ctx, REPORT_EXPORT_JOB, { type, siteId: site.id.toHexString(), params }));
            return;
          }
          return runReport(type, { orgId: ctx.orgId, siteId: site.id, userId: ctx.userId, tz: ctx.tz }, query);
        }),
      );
    }
  },
};
