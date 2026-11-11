/**
 * Purchase order / purchase return PDFs: Handlebars HTML → PDF via puppeteer-core, run as a job.
 * All user text goes through `{{ }}` (HTML-escaped); templates never use triple-stash.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Handlebars from "handlebars";
import type { Types } from "mongoose";
import { config, resolveChromePath } from "@/core/config";
import { PermanentJobError, PDF_TYPE, registerJobHandler, saveFile } from "@/core/jobs";
import { dayjs, fromMilli } from "@/core/units";
import { Organization } from "@/modules/identity/models";
import { Site } from "@/modules/sites/models";
import { Party, type PartyDoc } from "@/modules/parties/models";
import { PurchaseOrder, PurchaseReturn, type PurchaseOrderDoc, type PurchaseReturnDoc } from "./models";
import { PO_TEMPLATES, RETURN_TEMPLATES } from "./schemas";

export type PdfKind = "po" | "return";
export type POTemplate = (typeof PO_TEMPLATES)[number];
export type ReturnTemplate = (typeof RETURN_TEMPLATES)[number];

// ---------- formatting ----------

/** Indian digit grouping: 1234567.5 → "12,34,567.50" */
export function formatINR(paiseAmount: number): string {
  const neg = paiseAmount < 0;
  const abs = Math.abs(Math.round(paiseAmount));
  const rupees = String(Math.floor(abs / 100));
  const p = String(abs % 100).padStart(2, "0");
  const last3 = rupees.slice(-3);
  const rest = rupees.slice(0, -3);
  const grouped = rest ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${last3}` : last3;
  return `${neg ? "-" : ""}₹${grouped}.${p}`;
}

const formatQty = (milli: number) => {
  const q = fromMilli(milli);
  return q.toLocaleString("en-IN", { maximumFractionDigits: 3 });
};
const formatRate = (bp: number) => `${(bp / 100).toFixed(bp % 100 === 0 ? 0 : 2)}%`;
const formatDate = (d?: string | null) => (d ? dayjs(d, "YYYY-MM-DD").format("DD MMM YYYY") : "");
/** Only https and inline images are rendered, so a logo URL can't point the renderer at internal hosts or scripts. */
const safeImageUrl = (u?: string | null) => (u && /^(https:\/\/|data:image\/(png|jpe?g|gif|webp|svg\+xml);base64,)/i.test(u) ? u : undefined);

// ---------- templates ----------

let templateDir: string | undefined;
function resolveTemplateDir(): string {
  if (templateDir) return templateDir;
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, "../../templates"), // tsx / vitest: src/modules/purchasing → src/templates
    here, // tsup bundle: publicDir copies src/templates into dist/
    path.resolve(here, "templates"),
    path.resolve(process.cwd(), "src/templates"),
    path.resolve(process.cwd(), "dist"),
  ];
  const found = candidates.find((d) => fs.existsSync(path.join(d, "po-classic.hbs")));
  if (!found) throw new PermanentJobError("PDF templates are missing from the deployment.");
  templateDir = found;
  return found;
}

const hbs = Handlebars.create();
const compiled = new Map<string, Handlebars.TemplateDelegate>();
function template(name: string) {
  let t = compiled.get(name);
  if (!t) {
    const src = fs.readFileSync(path.join(resolveTemplateDir(), `${name}.hbs`), "utf8");
    t = hbs.compile(src, { strict: false });
    compiled.set(name, t);
  }
  return t;
}

// ---------- view model ----------

type PricedDoc = Pick<PurchaseOrderDoc, "subtotalPaise" | "taxPaise" | "totalPaise"> & {
  lines: {
    productName: string;
    unit: string;
    qtyMilli: number;
    unitPricePaise: number;
    taxRateBp: number;
    amountPaise: number;
    taxPaise: number;
    totalPaise: number;
  }[];
};

function linesView(doc: PricedDoc) {
  return doc.lines.map((l, i) => ({
    sn: i + 1,
    productName: l.productName,
    unit: l.unit,
    qty: formatQty(l.qtyMilli),
    unitPrice: formatINR(l.unitPricePaise),
    taxRate: formatRate(l.taxRateBp),
    amount: formatINR(l.amountPaise),
    tax: formatINR(l.taxPaise),
    total: formatINR(l.totalPaise),
  }));
}

async function partiesView(orgId: Types.ObjectId, siteId: Types.ObjectId, vendorId: Types.ObjectId, vendorName: string, gstIn?: string | null) {
  const [org, site, vendor] = await Promise.all([
    Organization.findOne({ _id: orgId }).lean(),
    Site.findOne({ _id: siteId, orgId }).lean(),
    Party.findOne({ _id: vendorId, orgId }).lean<PartyDoc>(),
  ]);
  return {
    org: {
      name: org?.name ?? "",
      logoUrl: safeImageUrl(org?.logoUrl),
      address: org?.address ?? "",
      phone: org?.phone ?? "",
      gstIn: org?.gstIn ?? "",
    },
    site: { name: site?.name ?? "", address: site?.address ?? "" },
    vendor: {
      name: vendorName,
      gstIn: gstIn ?? vendor?.gstIn ?? "",
      address: vendor?.address ?? "",
      phone: vendor?.phone ?? "",
      contactName: vendor?.contactName ?? "",
    },
  };
}

/** Renders the HTML for a PO or return of this org. Returns null when the document doesn't exist. */
export async function renderDocumentHtml(
  orgId: Types.ObjectId,
  kind: PdfKind,
  id: string,
  templateName: string = "classic",
): Promise<{ html: string; filename: string } | null> {
  if (kind === "po") {
    if (!(PO_TEMPLATES as readonly string[]).includes(templateName)) throw new PermanentJobError(`Unknown template ${templateName}`);
    const po = await PurchaseOrder.findOne({ _id: id, orgId }).lean<PurchaseOrderDoc>();
    if (!po) return null;
    const view = {
      title: "Purchase Order",
      ...(await partiesView(orgId, po.siteId, po.vendorId, po.vendorName, po.vendorGstIn)),
      doc: {
        number: po.number,
        date: formatDate(po.date),
        expectedDate: formatDate(po.expectedDate),
        transport: po.transport ?? "",
        notes: po.notes ?? "",
        status: PO_STATUS_LABEL[po.status] ?? po.status,
      },
      lines: linesView(po),
      totals: { subtotal: formatINR(po.subtotalPaise ?? 0), tax: formatINR(po.taxPaise ?? 0), total: formatINR(po.totalPaise ?? 0) },
    };
    return { html: template(`po-${templateName}`)(view), filename: `${po.number}.pdf` };
  }
  if (!(RETURN_TEMPLATES as readonly string[]).includes(templateName)) throw new PermanentJobError(`Unknown template ${templateName}`);
  const pr = await PurchaseReturn.findOne({ _id: id, orgId }).lean<PurchaseReturnDoc>();
  if (!pr) return null;
  const view = {
    title: "Purchase Return",
    ...(await partiesView(orgId, pr.siteId, pr.vendorId, pr.vendorName)),
    doc: { number: pr.number, date: formatDate(pr.date), poNumber: pr.poNumber, reason: pr.reason ?? "" },
    lines: linesView(pr),
    totals: { subtotal: formatINR(pr.subtotalPaise), tax: formatINR(pr.taxPaise), total: formatINR(pr.totalPaise) },
  };
  return { html: template(`return-${templateName}`)(view), filename: `${pr.number}.pdf` };
}

// ---------- HTML → PDF ----------

export async function htmlToPdf(html: string): Promise<Buffer> {
  const chromePath = resolveChromePath();
  if (!config.PDF_BROWSER_WS_ENDPOINT && !chromePath) {
    throw new PermanentJobError(
      "PDF rendering is not configured: no Chrome found on the server. Install Google Chrome, or set CHROME_PATH or PDF_BROWSER_WS_ENDPOINT.",
    );
  }
  const { default: puppeteer } = await import("puppeteer-core");
  const remote = Boolean(config.PDF_BROWSER_WS_ENDPOINT);
  const browser = remote
    ? await puppeteer.connect({ browserWSEndpoint: config.PDF_BROWSER_WS_ENDPOINT })
    : await puppeteer.launch({ executablePath: chromePath, args: ["--disable-dev-shm-usage"] });
  let page: Awaited<ReturnType<typeof browser.newPage>> | undefined;
  try {
    page = await browser.newPage();
    await page.setJavaScriptEnabled(false);
    await page.setContent(html, { waitUntil: "load", timeout: 30_000 });
    const pdf = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: "12mm", bottom: "12mm", left: "10mm", right: "10mm" },
    });
    return Buffer.from(pdf);
  } finally {
    await page?.close().catch(() => undefined);
    // a shared remote browser is only disconnected; a browser we launched is closed
    if (remote) await browser.disconnect().catch(() => undefined);
    else await browser.close().catch(() => undefined);
  }
}

/** Wording printed on documents (a "sent" PO is issued, not emailed). */
const PO_STATUS_LABEL: Record<string, string> = {
  draft: "Draft",
  sent: "Issued",
  partially_received: "Partially received",
  received: "Received",
  cancelled: "Cancelled",
};

export const PDF_JOB = "purchasing.pdf";

registerJobHandler(PDF_JOB, async (job) => {
  const { kind, id, template: tpl } = job.payload as { kind: PdfKind; id: string; template?: string };
  const rendered = await renderDocumentHtml(job.orgId, kind, id, tpl ?? "classic");
  if (!rendered) throw new PermanentJobError("The document no longer exists.");
  const pdf = await htmlToPdf(rendered.html);
  const fileId = await saveFile(job.orgId, rendered.filename, PDF_TYPE, pdf, job.createdBy);
  return { fileId };
});
