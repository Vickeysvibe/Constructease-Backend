import { buildWorkbook, rupees, QTY_FMT, RUPEES_FMT, type SheetSpec } from "@/core/excel";
import { dayjs } from "@/core/units";
import type {
  LabourWagesReport,
  PaymentsReport,
  SiteSummaryReport,
  StockReport,
  VendorLedgerDetail,
  VendorLedgerSummary,
} from "./service";

export const REPORT_TYPES = ["labour-wages", "vendor-ledger", "payments", "stock", "site-summary"] as const;
export type ReportType = (typeof REPORT_TYPES)[number];

const TITLES: Record<ReportType, string> = {
  "labour-wages": "Labour wages",
  "vendor-ledger": "Vendor ledger",
  payments: "Payments",
  stock: "Stock",
  "site-summary": "Site summary",
};

const money = <T>(header: string, get: (r: T) => number | undefined, width = 16) => ({
  header,
  value: (r: T) => {
    const v = get(r);
    return v === undefined ? null : rupees(v);
  },
  numFmt: RUPEES_FMT,
  width,
});
const qty = <T>(header: string, get: (r: T) => number, width = 12) => ({ header, value: get, numFmt: QTY_FMT, width });
const fmtDate = (d: string) => dayjs(d, "YYYY-MM-DD").format("DD-MM-YYYY");

type Sheet = SheetSpec<unknown>;
const sheet = <T>(s: SheetSpec<T>) => s as unknown as Sheet;

function labourWagesSheets(r: LabourWagesReport, title: string): Sheet[] {
  type Row = LabourWagesReport["rows"][number];
  return [
    sheet<Row>({
      name: "Labour wages",
      title,
      columns: [
        { header: "Name", value: (x) => x.name, width: 24 },
        { header: "Category", value: (x) => x.category, width: 14 },
        { header: "Sub category", value: (x) => x.subCategory, width: 14 },
        ...r.days.map((d) => ({ header: dayjs(d, "YYYY-MM-DD").format("DD/MM/YY"), value: (x: Row) => x.shiftsByDate[d] ?? null, width: 9 })),
        { header: "Days", value: (x) => x.days, width: 8 },
        { header: "Shifts", value: (x) => x.shifts, numFmt: QTY_FMT, width: 8 },
        money("Wages", (x: Row) => x.wagesPaise),
        money("Paid", (x: Row) => x.paidPaise),
        money("Balance", (x: Row) => x.balancePaise),
      ],
      rows: r.rows,
      totals: {
        Shifts: r.totals.shifts,
        Wages: rupees(r.totals.wagesPaise),
        Paid: rupees(r.totals.paidPaise),
        Balance: rupees(r.totals.balancePaise),
      },
    }),
  ];
}

function vendorLedgerDetailSheets(r: VendorLedgerDetail, title: string): Sheet[] {
  type Row = { date?: string; type: string; reference: string; description: string; debitPaise?: number; creditPaise?: number; balancePaise: number };
  const TYPE: Record<string, string> = { goods_receipt: "Receipt", purchase_return: "Return", payment: "Payment", legacy: "Opening (migrated)" };
  const rows: Row[] = [
    { type: "Opening balance", reference: "", description: "", balancePaise: r.openingBalancePaise },
    ...r.entries.map((e) => ({ ...e, type: TYPE[e.sourceType] ?? e.sourceType })),
  ];
  return [
    sheet<Row>({
      name: "Ledger",
      title: `${title} — ${r.party.name}`,
      columns: [
        { header: "Date", value: (x) => (x.date ? fmtDate(x.date) : ""), width: 12 },
        { header: "Type", value: (x) => x.type, width: 16 },
        { header: "Reference", value: (x) => x.reference, width: 16 },
        { header: "Description", value: (x) => x.description, width: 32 },
        money("Debit", (x: Row) => x.debitPaise),
        money("Credit", (x: Row) => x.creditPaise),
        money("Balance", (x: Row) => x.balancePaise),
      ],
      rows,
      totals: {
        Debit: rupees(r.entries.reduce((s, e) => s + e.debitPaise, 0)),
        Credit: rupees(r.entries.reduce((s, e) => s + e.creditPaise, 0)),
        Balance: rupees(r.closingBalancePaise),
      },
    }),
  ];
}

function vendorLedgerSummarySheets(r: VendorLedgerSummary, title: string): Sheet[] {
  type Row = VendorLedgerSummary["rows"][number];
  return [
    sheet<Row>({
      name: "Vendors",
      title,
      columns: [
        { header: "Vendor", value: (x) => x.name, width: 28 },
        money("Opening", (x: Row) => x.openingBalancePaise),
        money("Received", (x: Row) => x.receivedPaise),
        money("Returned", (x: Row) => x.returnedPaise),
        money("Paid", (x: Row) => x.paidPaise),
        money("Closing", (x: Row) => x.closingBalancePaise),
      ],
      rows: r.rows,
      totals: {
        Opening: rupees(r.totals.openingBalancePaise),
        Received: rupees(r.totals.receivedPaise),
        Returned: rupees(r.totals.returnedPaise),
        Paid: rupees(r.totals.paidPaise),
        Closing: rupees(r.totals.closingBalancePaise),
      },
    }),
  ];
}

function paymentsSheets(r: PaymentsReport, title: string): Sheet[] {
  type Row = PaymentsReport["rows"][number];
  type Cat = PaymentsReport["totals"]["byCategory"][number];
  return [
    sheet<Row>({
      name: "Payments",
      title,
      columns: [
        { header: "Date", value: (x) => fmtDate(x.date), width: 12 },
        { header: "Category", value: (x) => x.category, width: 10 },
        { header: "Party", value: (x) => x.party?.name, width: 24 },
        { header: "Method", value: (x) => x.method, width: 9 },
        { header: "Reference", value: (x) => x.reference, width: 16 },
        { header: "Description", value: (x) => x.description, width: 30 },
        money("In", (x: Row) => (x.direction === "in" ? x.amountPaise : undefined)),
        money("Out", (x: Row) => (x.direction === "out" ? x.amountPaise : undefined)),
      ],
      rows: r.rows,
      totals: { In: rupees(r.totals.inPaise), Out: rupees(r.totals.outPaise) },
    }),
    sheet<Cat>({
      name: "By category",
      title,
      columns: [
        { header: "Category", value: (x) => x.category, width: 14 },
        money("In", (x: Cat) => x.inPaise),
        money("Out", (x: Cat) => x.outPaise),
      ],
      rows: r.totals.byCategory,
      totals: { In: rupees(r.totals.inPaise), Out: rupees(r.totals.outPaise) },
    }),
  ];
}

function stockSheets(r: StockReport, title: string): Sheet[] {
  type Row = StockReport["rows"][number];
  return [
    sheet<Row>({
      name: "Stock",
      title,
      columns: [
        { header: "Product", value: (x) => x.productName, width: 28 },
        { header: "Unit", value: (x) => x.unit, width: 8 },
        qty("Opening", (x: Row) => x.openingQty),
        qty("Received", (x: Row) => x.receivedQty),
        qty("Returned", (x: Row) => x.returnedQty),
        qty("Consumed", (x: Row) => x.consumedQty),
        qty("Adjusted", (x: Row) => x.adjustedQty),
        qty("Closing", (x: Row) => x.closingQty),
        money("Avg cost", (x: Row) => x.avgCostPaise),
        money("Closing value", (x: Row) => x.closingValuePaise),
      ],
      rows: r.rows,
      totals: { "Closing value": rupees(r.totals.closingValuePaise) },
    }),
  ];
}

function siteSummarySheets(r: SiteSummaryReport, title: string): Sheet[] {
  type Line = { label: string; paise?: number; value?: number };
  type Month = SiteSummaryReport["byMonth"][number];
  const lines: Line[] = [
    { label: "Materials received", paise: r.materials.receivedPaise },
    { label: "Materials returned", paise: r.materials.returnedPaise },
    { label: "Materials (net)", paise: r.materials.netPaise },
    { label: "Labour shifts", value: r.labour.shifts },
    { label: "Labour wages", paise: r.labour.wagesPaise },
    { label: "Payments in", paise: r.payments.inPaise },
    { label: "Payments out", paise: r.payments.outPaise },
  ];
  return [
    sheet<Line>({
      name: "Summary",
      title,
      columns: [
        { header: "Item", value: (x) => x.label, width: 24 },
        { header: "Amount (₹)", value: (x) => (x.paise === undefined ? null : rupees(x.paise)), numFmt: RUPEES_FMT, width: 18 },
        { header: "Quantity", value: (x) => x.value, numFmt: QTY_FMT, width: 12 },
      ],
      rows: lines,
    }),
    sheet<Month>({
      name: "By month",
      title,
      columns: [
        { header: "Month", value: (x) => dayjs(`${x.month}-01`, "YYYY-MM-DD").format("MMM YYYY"), width: 12 },
        money("Materials", (x: Month) => x.materialsPaise),
        money("Wages", (x: Month) => x.wagesPaise),
        money("Payments out", (x: Month) => x.paymentsOutPaise),
        money("Payments in", (x: Month) => x.paymentsInPaise),
      ],
      rows: r.byMonth,
      totals: {
        Materials: rupees(r.materials.netPaise),
        Wages: rupees(r.labour.wagesPaise),
        "Payments out": rupees(r.payments.outPaise),
        "Payments in": rupees(r.payments.inPaise),
      },
    }),
  ];
}

/** Builds the workbook for a computed report: title row (report — site — period), rupees, totals row. */
export async function reportWorkbook(
  type: ReportType,
  report: unknown,
  meta: { siteName: string; from: string; to: string },
): Promise<{ filename: string; buffer: Buffer }> {
  const title = `${TITLES[type]} — ${meta.siteName} — ${fmtDate(meta.from)} to ${fmtDate(meta.to)}`;
  let sheets: Sheet[];
  switch (type) {
    case "labour-wages":
      sheets = labourWagesSheets(report as LabourWagesReport, title);
      break;
    case "vendor-ledger":
      sheets =
        "entries" in (report as object)
          ? vendorLedgerDetailSheets(report as VendorLedgerDetail, title)
          : vendorLedgerSummarySheets(report as VendorLedgerSummary, title);
      break;
    case "payments":
      sheets = paymentsSheets(report as PaymentsReport, title);
      break;
    case "stock":
      sheets = stockSheets(report as StockReport, title);
      break;
    case "site-summary":
      sheets = siteSummarySheets(report as SiteSummaryReport, title);
      break;
  }
  return { filename: `${type}_${meta.from}_${meta.to}.xlsx`, buffer: await buildWorkbook(sheets) };
}
