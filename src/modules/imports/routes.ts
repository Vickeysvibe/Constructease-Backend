import type { RequestHandler } from "express";
import multer from "multer";
import { Types } from "mongoose";
import { z } from "zod";
import { handler } from "@/core/http";
import { requireEngineerAnywhere, requireSite } from "@/core/access";
import { AppError, badRequest, type FieldError, zodToFieldErrors } from "@/core/errors";
import { withTransaction } from "@/core/db";
import { audit } from "@/core/records";
import { buildWorkbook, readSheet, rupees, RUPEES_FMT, type SheetSpec } from "@/core/excel";
import { enqueue, registerJobHandler, saveFile, XLSX_TYPE, PermanentJobError } from "@/core/jobs";
import { contentDisposition } from "@/modules/files/routes";
import { Party, PARTY_KINDS, nameKeyOf, type PartyDoc, type PartyKind } from "@/modules/parties/models";
import { partyInput } from "@/modules/parties/schemas";
import { assertCanWriteKind } from "@/modules/parties/routes";
import { Product, type ProductDoc } from "@/modules/products/models";
import { productInput } from "@/modules/products/routes";
import { Membership } from "@/modules/sites/models";
import { User } from "@/modules/identity/models";
import type { ModuleRoutes } from "@/modules/registry";

const upload: RequestHandler = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 10 },
  fileFilter: (_req, file, cb) => {
    if (/\.xlsx$/i.test(file.originalname)) cb(null, true);
    else cb(badRequest("Upload an .xlsx file."));
  },
}).single("file");

const importQuery = z.object({
  dryRun: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
});

type RowStatus = "create" | "update" | "skip" | "error";
interface ImportRow {
  row: number;
  status: RowStatus;
  data: Record<string, unknown>;
  errors: FieldError[];
}

/** Header aliases accepted in uploaded sheets (old exports used different names). */
const PARTY_ALIASES: Record<string, string[]> = {
  name: ["name", "vendorName", "clientName", "labourName"],
  phone: ["phone", "phoneNo", "mobile", "mobileNo", "phoneNumber"],
  address: ["address"],
  contactName: ["contactName", "ownerName", "contact"],
  gstIn: ["gstIn", "gstin", "gst", "gstNo", "gstNumber"],
  pan: ["pan", "panNo"],
  category: ["category", "trade"],
  subCategory: ["subCategory", "subcategory"],
  wageRate: ["wageRate", "wagesPerShift", "wagePerShift", "wages", "wage"],
};
const PRODUCT_ALIASES: Record<string, string[]> = {
  name: ["name", "productName", "product"],
  unit: ["unit", "uom"],
  category: ["category"],
  description: ["description", "desc"],
  gstRate: ["gstRate", "gst", "tax", "taxRate", "gstPercent"],
};

function pick(values: Record<string, string>, aliases: Record<string, string[]>) {
  const out: Record<string, string> = {};
  for (const [field, names] of Object.entries(aliases)) {
    const hit = names.find((n) => values[n] !== undefined && values[n] !== "");
    if (hit) out[field] = values[hit]!;
  }
  return out;
}

const toPaise = (rupeesText: string | undefined) => {
  if (rupeesText === undefined) return undefined;
  const n = Number(rupeesText.replace(/[₹,\s]/g, ""));
  return Number.isFinite(n) ? Math.round(n * 100) : NaN;
};

function summarise(dryRun: boolean, rows: ImportRow[]) {
  const count = (s: RowStatus) => rows.filter((r) => r.status === s).length;
  return {
    dryRun,
    total: rows.length,
    valid: rows.length - count("error"),
    created: dryRun ? 0 : count("create"),
    updated: dryRun ? 0 : count("update"),
    skipped: count("skip"),
    rows,
  };
}

function rejectIfErrors(result: ReturnType<typeof summarise>) {
  if (result.rows.some((r) => r.status === "error")) {
    throw new AppError(422, "VALIDATION_FAILED", "Import has errors", "Fix the rows marked as errors and upload again. Nothing was imported.", undefined, { result });
  }
}

async function partyRows(file: Buffer, kind: PartyKind, orgId: Types.ObjectId): Promise<ImportRow[]> {
  const sheet = await readSheet(file);
  const seen = new Set<string>();
  const rows: ImportRow[] = [];
  for (const { row, values } of sheet) {
    const v = pick(values, PARTY_ALIASES);
    const candidate = {
      kind,
      name: v.name ?? "",
      phone: v.phone ?? "",
      address: v.address,
      contactName: v.contactName,
      gstIn: v.gstIn,
      pan: v.pan,
      category: v.category,
      subCategory: v.subCategory,
      ...(kind === "labour" ? { wageRatePaise: toPaise(v.wageRate) } : {}),
    };
    const parsed = partyInput.safeParse(candidate);
    if (!parsed.success) {
      rows.push({ row, status: "error", data: candidate, errors: zodToFieldErrors(parsed.error) });
      continue;
    }
    const key = `${nameKeyOf(parsed.data.name)}|${parsed.data.phone}`;
    if (seen.has(key)) {
      rows.push({ row, status: "skip", data: parsed.data, errors: [{ path: "name", message: "Duplicate of an earlier row" }] });
      continue;
    }
    seen.add(key);
    const exists = await Party.exists({ orgId, kind, nameKey: nameKeyOf(parsed.data.name), phone: parsed.data.phone });
    rows.push({ row, status: exists ? "update" : "create", data: parsed.data, errors: [] });
  }
  return rows;
}

async function productRows(file: Buffer, orgId: Types.ObjectId): Promise<ImportRow[]> {
  const sheet = await readSheet(file);
  const seen = new Set<string>();
  const rows: ImportRow[] = [];
  for (const { row, values } of sheet) {
    const v = pick(values, PRODUCT_ALIASES);
    const rate = v.gstRate === undefined ? undefined : Number(v.gstRate.replace("%", ""));
    const candidate = {
      name: v.name ?? "",
      unit: v.unit ?? "",
      category: v.category,
      description: v.description,
      defaultTaxRateBp: rate === undefined ? undefined : Math.round(rate * 100),
    };
    const parsed = productInput.safeParse(candidate);
    if (!parsed.success) {
      rows.push({ row, status: "error", data: candidate, errors: zodToFieldErrors(parsed.error) });
      continue;
    }
    const key = nameKeyOf(parsed.data.name);
    if (seen.has(key)) {
      rows.push({ row, status: "skip", data: parsed.data, errors: [{ path: "name", message: "Duplicate of an earlier row" }] });
      continue;
    }
    seen.add(key);
    const exists = await Product.exists({ orgId, nameKey: key });
    rows.push({ row, status: exists ? "update" : "create", data: parsed.data, errors: [] });
  }
  return rows;
}

const requireFile = (file: Express.Multer.File | undefined) => {
  if (!file) throw badRequest("Attach the spreadsheet in the 'file' field.");
  return file.buffer;
};

// ---------- templates ----------
const TEMPLATES: Record<string, { headers: string[]; example: (string | number)[] }> = {
  vendor: {
    headers: ["Name", "Phone", "Contact name", "GSTIN", "PAN", "Address", "Category"],
    example: ["Sri Balaji Traders", "9840123456", "R. Balaji", "33AABCS1429B1Z5", "AABCS1429B", "12 GST Road, Chennai", "Cement"],
  },
  client: {
    headers: ["Name", "Phone", "Contact name", "GSTIN", "PAN", "Address"],
    example: ["Lakshmi Residency", "9884012345", "S. Lakshmi", "", "ABCPL1234K", "Plot 4, Anna Nagar, Chennai"],
  },
  labour: {
    headers: ["Name", "Phone", "Category", "Sub category", "Wage rate"],
    example: ["Ravi K", "9789012345", "Mason", "Brickwork", 950],
  },
  product: {
    headers: ["Name", "Unit", "Category", "Description", "GST rate"],
    example: ["OPC 53 cement", "bag", "Cement", "50 kg bag", 28],
  },
};

// ---------- exports (job) ----------
const exportBody = z.object({ entity: z.enum(["vendor", "client", "labour", "product", "team"]) });

registerJobHandler("export.masters", async (job) => {
  const { siteId, entity } = job.payload as { siteId: string; entity: string };
  const orgId = job.orgId;
  let sheet: SheetSpec<never>;
  if ((PARTY_KINDS as readonly string[]).includes(entity)) {
    const rows = await Party.find({ orgId, siteIds: new Types.ObjectId(siteId), kind: entity, status: "active" })
      .sort({ name: 1 })
      .lean<PartyDoc[]>();
    sheet = {
      name: entity,
      columns: [
        { header: "Name", value: (p: PartyDoc) => p.name, width: 28 },
        { header: "Phone", value: (p: PartyDoc) => p.phone, width: 14 },
        ...(entity === "labour"
          ? [
              { header: "Category", value: (p: PartyDoc) => p.category, width: 16 },
              { header: "Sub category", value: (p: PartyDoc) => p.subCategory, width: 16 },
              { header: "Wage rate", value: (p: PartyDoc) => rupees(p.wageRatePaise ?? 0), numFmt: RUPEES_FMT },
            ]
          : [
              { header: "Contact name", value: (p: PartyDoc) => p.contactName, width: 20 },
              { header: "GSTIN", value: (p: PartyDoc) => p.gstIn, width: 18 },
              { header: "PAN", value: (p: PartyDoc) => p.pan, width: 12 },
              { header: "Address", value: (p: PartyDoc) => p.address, width: 40 },
            ]),
      ],
      rows,
    } as unknown as SheetSpec<never>;
  } else if (entity === "product") {
    const rows = await Product.find({ orgId, status: "active" }).sort({ name: 1 }).lean<ProductDoc[]>();
    sheet = {
      name: "products",
      columns: [
        { header: "Name", value: (p: ProductDoc) => p.name, width: 28 },
        { header: "Unit", value: (p: ProductDoc) => p.unit },
        { header: "Category", value: (p: ProductDoc) => p.category, width: 16 },
        { header: "Description", value: (p: ProductDoc) => p.description, width: 30 },
        { header: "GST rate", value: (p: ProductDoc) => (p.defaultTaxRateBp ?? 0) / 100 },
      ],
      rows,
    } as unknown as SheetSpec<never>;
  } else if (entity === "team") {
    const ms = await Membership.find({ orgId, siteId: new Types.ObjectId(siteId) }).lean();
    const users = await User.find({ orgId, _id: { $in: ms.map((m) => m.userId) } }).sort({ name: 1 }).lean();
    const role = new Map(ms.map((m) => [m.userId.toHexString(), m.role]));
    type U = (typeof users)[number];
    sheet = {
      name: "team",
      columns: [
        { header: "Name", value: (u: U) => u.name, width: 24 },
        { header: "Email", value: (u: U) => u.email, width: 28 },
        { header: "Phone", value: (u: U) => u.phone, width: 14 },
        { header: "Role", value: (u: U) => role.get(u._id.toHexString()) },
        { header: "Status", value: (u: U) => u.status },
      ],
      rows: users,
    } as unknown as SheetSpec<never>;
  } else {
    throw new PermanentJobError(`Unknown export entity ${entity}`);
  }
  const buffer = await buildWorkbook([sheet as unknown as SheetSpec<unknown>]);
  const fileId = await saveFile(orgId, `${entity}-${new Date().toISOString().slice(0, 10)}.xlsx`, XLSX_TYPE, buffer, job.createdBy);
  return { fileId };
});

export const importsModule: ModuleRoutes = {
  name: "imports",
  site(r) {
    r.post(
      "/imports/parties",
      requireSite("site:read"),
      upload,
      handler({ query: importQuery.extend({ kind: z.enum(PARTY_KINDS) }) }, async ({ query, ctx, site, req }) => {
        assertCanWriteKind(site, query.kind);
        const rows = await partyRows(requireFile(req.file), query.kind, ctx.orgId);
        const result = summarise(query.dryRun, rows);
        if (query.dryRun) return result;
        rejectIfErrors(result);
        await withTransaction(async (session) => {
          for (const r of rows) {
            if (r.status !== "create" && r.status !== "update") continue;
            const d = r.data as Record<string, unknown> & { name: string; phone: string };
            await Party.updateOne(
              { orgId: ctx.orgId, kind: query.kind, nameKey: nameKeyOf(d.name), phone: d.phone },
              { $set: { ...d, nameKey: nameKeyOf(d.name) }, $addToSet: { siteIds: site.id }, $setOnInsert: { orgId: ctx.orgId, status: "active" } },
              { upsert: true, session, runValidators: true },
            );
          }
        });
        await audit(ctx, {
          action: "party.import",
          entity: "Party",
          entityId: site.id,
          siteId: site.id,
          data: { kind: query.kind, created: result.created, updated: result.updated },
        });
        return result;
      }),
    );
    r.post(
      "/exports",
      requireSite("site:read"),
      handler(
        { body: exportBody },
        async ({ body, ctx, site }) => enqueue(ctx, "export.masters", { siteId: site.id.toHexString(), entity: body.entity }),
        { status: 202 },
      ),
    );
  },
  org(r) {
    r.post(
      "/imports/products",
      requireEngineerAnywhere,
      upload,
      handler({ query: importQuery }, async ({ query, ctx, req }) => {
        const rows = await productRows(requireFile(req.file), ctx.orgId);
        const result = summarise(query.dryRun, rows);
        if (query.dryRun) return result;
        rejectIfErrors(result);
        await withTransaction(async (session) => {
          for (const r of rows) {
            if (r.status !== "create" && r.status !== "update") continue;
            const d = r.data as Record<string, unknown> & { name: string };
            await Product.updateOne(
              { orgId: ctx.orgId, nameKey: nameKeyOf(d.name) },
              { $set: { ...d, nameKey: nameKeyOf(d.name) }, $setOnInsert: { orgId: ctx.orgId, status: "active" } },
              { upsert: true, session, runValidators: true },
            );
          }
        });
        return result;
      }),
    );
    r.get(
      "/imports/templates/:entity",
      handler({ params: z.object({ entity: z.enum(["vendor", "client", "labour", "product"]) }) }, async ({ params, res }) => {
        const t = TEMPLATES[params.entity]!;
        const buffer = await buildWorkbook([
          { name: params.entity, columns: t.headers.map((h, i) => ({ header: h, value: (row: unknown[]) => row[i] as string, width: 20 })), rows: [t.example] } as SheetSpec<unknown>,
        ]);
        res.setHeader("Content-Type", XLSX_TYPE);
        res.setHeader("Content-Disposition", contentDisposition(`${params.entity}-import-template.xlsx`));
        res.end(buffer);
      }),
    );
  },
};
