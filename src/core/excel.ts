import ExcelJS from "exceljs";
import { badRequest } from "./errors";

export interface SheetColumn<T> {
  header: string;
  /** value for a row; numbers stay numbers so Excel can sum them */
  value: (row: T) => string | number | null | undefined;
  width?: number;
  /** Excel number format, e.g. '#,##0.00' */
  numFmt?: string;
}

export interface SheetSpec<T> {
  name: string;
  title?: string;
  columns: SheetColumn<T>[];
  rows: T[];
  /** optional totals row: header label → value */
  totals?: Record<string, number>;
}

export const RUPEES_FMT = '"₹"#,##0.00';
export const QTY_FMT = "#,##0.###";

/** Builds an .xlsx workbook. Money passed to sheets should already be in rupees (paise / 100). */
export async function buildWorkbook(sheets: SheetSpec<unknown>[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "ConstructEase";
  for (const spec of sheets) {
    const ws = wb.addWorksheet(spec.name.slice(0, 31));
    let headerRow = 1;
    if (spec.title) {
      ws.addRow([spec.title]).font = { bold: true, size: 13 };
      ws.addRow([]);
      headerRow = 3;
    }
    ws.addRow(spec.columns.map((c) => c.header)).font = { bold: true };
    spec.columns.forEach((c, i) => {
      const col = ws.getColumn(i + 1);
      col.width = c.width ?? Math.max(12, c.header.length + 2);
      if (c.numFmt) col.numFmt = c.numFmt;
    });
    for (const r of spec.rows) ws.addRow(spec.columns.map((c) => c.value(r) ?? null));
    if (spec.totals) {
      const row = ws.addRow(spec.columns.map((c, i) => (i === 0 ? "Total" : (spec.totals![c.header] ?? null))));
      row.font = { bold: true };
    }
    ws.views = [{ state: "frozen", ySplit: headerRow }];
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** Reads the first sheet into objects keyed by normalised header ("Wages Per Shift" → "wagesPerShift"). */
export async function readSheet(data: Buffer): Promise<{ row: number; values: Record<string, string> }[]> {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(data as unknown as ArrayBuffer);
  } catch {
    throw badRequest("The file is not a valid .xlsx workbook.");
  }
  const ws = wb.worksheets[0];
  if (!ws) throw badRequest("The workbook has no sheets.");
  const headers: string[] = [];
  ws.getRow(1).eachCell({ includeEmpty: true }, (cell, col) => {
    headers[col] = normaliseHeader(cellText(cell.value));
  });
  if (!headers.some(Boolean)) throw badRequest("The first row must contain column headers.");
  const out: { row: number; values: Record<string, string> }[] = [];
  ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return;
    const values: Record<string, string> = {};
    row.eachCell({ includeEmpty: false }, (cell, col) => {
      const h = headers[col];
      if (h) values[h] = cellText(cell.value).trim();
    });
    if (Object.values(values).some((v) => v !== "")) out.push({ row: rowNumber, values });
  });
  if (out.length > 5000) throw badRequest("Imports are limited to 5,000 rows per file.");
  return out;
}

export const normaliseHeader = (h: string) =>
  h
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+(.)?/g, (_m, c: string | undefined) => (c ? c.toUpperCase() : ""));

function cellText(v: ExcelJS.CellValue): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") {
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    if ("text" in v && typeof v.text === "string") return v.text;
    if ("result" in v) return String(v.result ?? "");
    if ("richText" in v) return v.richText.map((t) => t.text).join("");
  }
  return String(v);
}

export const rupees = (p: number) => Math.round(p) / 100;
