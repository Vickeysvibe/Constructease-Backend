import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import type { Types } from "mongoose";
import { drainJobs } from "@/core/jobs";
import { monthsBetween } from "@/modules/reports/service";
import { api, auth, sitePath, useDatabase, world } from "./helpers";

useDatabase();

type World = Awaited<ReturnType<typeof world>>;
type Site = Types.ObjectId;
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

async function setup() {
  const w = await world();
  const t = w.tokens.ownerA;
  const mkParty = async (siteId: Site, body: object) => {
    const res = await api().post(sitePath(siteId, "/parties")).set(auth(t)).send(body);
    expect(res.status).toBe(201);
    return res.body.id as string;
  };
  const vendorA = await mkParty(w.siteA1._id, { kind: "vendor", name: "Sri Balaji Traders", phone: "9840123456" });
  const vendorB = await mkParty(w.siteA1._id, { kind: "vendor", name: "Murugan Steels", phone: "9840654321" });
  await mkParty(w.siteA2._id, { existingPartyId: vendorA });
  const client = await mkParty(w.siteA1._id, { kind: "client", name: "Mr. Raman", phone: "9840111111" });
  const ravi = await mkParty(w.siteA1._id, { kind: "labour", name: "Ravi K", phone: "9789012345", category: "Mason", wageRatePaise: 95000 });
  const mani = await mkParty(w.siteA1._id, { kind: "labour", name: "Mani S", phone: "9789012346", category: "Helper", wageRatePaise: 60000 });
  const cement = await api().post("/api/v1/products").set(auth(t)).send({ name: "OPC 53 cement", unit: "bag", defaultTaxRateBp: 0 });
  expect(cement.status).toBe(201);
  return { w, t, vendorA, vendorB, client, ravi, mani, cementId: cement.body.id as string };
}
type S = Awaited<ReturnType<typeof setup>>;

/** PO → send → receipt; returns the PO (with line ids). Prices excl. tax, tax 0 for round numbers. */
async function buy(s: S, siteId: Site, vendorId: string, date: string, qty: number, unitPricePaise: number) {
  const po = await api()
    .post(sitePath(siteId, "/purchase-orders"))
    .set(auth(s.t))
    .send({ vendorId, date, lines: [{ productId: s.cementId, qty, unitPricePaise, taxRateBp: 0 }] });
  expect(po.status).toBe(201);
  expect((await api().post(sitePath(siteId, `/purchase-orders/${po.body.id}/send`)).set(auth(s.t))).status).toBe(200);
  const gr = await api()
    .post(sitePath(siteId, "/goods-receipts"))
    .set(auth(s.t))
    .send({ poId: po.body.id, date, lines: [{ poLineId: po.body.lines[0].id, qty }] });
  expect(gr.status).toBe(201);
  return po.body as { id: string; lines: { id: string }[] };
}
async function giveBack(s: S, siteId: Site, po: { id: string; lines: { id: string }[] }, date: string, qty: number) {
  const res = await api()
    .post(sitePath(siteId, "/purchase-returns"))
    .set(auth(s.t))
    .send({ poId: po.id, date, reason: "Damaged", lines: [{ poLineId: po.lines[0]!.id, qty }] });
  expect(res.status).toBe(201);
}
async function pay(s: S, body: object, siteId: Site = s.w.siteA1._id) {
  const res = await api().post(sitePath(siteId, "/payments")).set(auth(s.t)).send(body);
  expect(res.status).toBe(201);
  return res.body.id as string;
}
const attendance = async (s: S, date: string, entries: object[]) =>
  expect((await api().put(sitePath(s.w.siteA1._id, "/attendance")).set(auth(s.t)).send({ date, entries })).status).toBe(200);

const report = (token: string, siteId: Site, name: string, qs: string) =>
  api().get(sitePath(siteId, `/reports/${name}?${qs}`)).set(auth(token));
const OCT = "from=2026-10-01&to=2026-10-31";

/**
 * Vendor A on site A1: ₹4,000 received before the range (opening), ₹1,600 received in range, ₹800 returned
 * ON the last day of the range, ₹1,000 paid, ₹500 paid then voided, ₹300 paid after the range.
 * Vendor B on A1 and vendor A on A2 also have history that must not leak into A's A1 opening.
 */
async function seedVendors(s: S) {
  const A1 = s.w.siteA1._id;
  await buy(s, A1, s.vendorA, "2026-09-25", 10, 40000);
  await buy(s, A1, s.vendorB, "2026-09-26", 5, 10000);
  await buy(s, s.w.siteA2._id, s.vendorA, "2026-09-27", 1, 99900);
  const po = await buy(s, A1, s.vendorA, "2026-10-10", 4, 40000);
  await giveBack(s, A1, po, "2026-10-31", 2);
  await pay(s, { date: "2026-10-15", direction: "out", category: "vendor", partyId: s.vendorA, amountPaise: 100000 });
  const voided = await pay(s, { date: "2026-10-20", direction: "out", category: "vendor", partyId: s.vendorA, amountPaise: 50000 });
  expect((await api().post(sitePath(A1, `/payments/${voided}/void`)).set(auth(s.t)).send({ reason: "Duplicate" })).status).toBe(200);
  await pay(s, { date: "2026-11-01", direction: "out", category: "vendor", partyId: s.vendorA, amountPaise: 30000 });
}

describe("vendor ledger report", () => {
  it("summarises every vendor with opening by vendor+site, inclusive end date and voids netted out", async () => {
    const s = await setup();
    await seedVendors(s);
    const res = await report(s.w.tokens.engineerA, s.w.siteA1._id, "vendor-ledger", OCT);
    expect(res.status).toBe(200);
    expect(res.body.rows).toEqual([
      { vendorId: s.vendorB, name: "Murugan Steels", openingBalancePaise: 50000, receivedPaise: 0, returnedPaise: 0, paidPaise: 0, closingBalancePaise: 50000 },
      {
        vendorId: s.vendorA,
        name: "Sri Balaji Traders",
        openingBalancePaise: 400000,
        receivedPaise: 160000,
        returnedPaise: 80000, // dated 2026-10-31 = `to`
        paidPaise: 100000, // the voided ₹500 nets to 0, the November ₹300 is outside
        closingBalancePaise: 380000,
      },
    ]);
    expect(res.body.totals).toEqual({
      openingBalancePaise: 450000,
      receivedPaise: 160000,
      returnedPaise: 80000,
      paidPaise: 100000,
      closingBalancePaise: 430000,
    });
  });

  it("with vendorId returns the party ledger for the range", async () => {
    const s = await setup();
    await seedVendors(s);
    const res = await report(s.t, s.w.siteA1._id, "vendor-ledger", `${OCT}&vendorId=${s.vendorA}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ party: { id: s.vendorA }, from: "2026-10-01", to: "2026-10-31", openingBalancePaise: 400000, closingBalancePaise: 380000 });
    expect(res.body.entries.at(-1)).toMatchObject({ date: "2026-10-31", sourceType: "purchase_return", debitPaise: 80000 });
    const ledger = await api().get(sitePath(s.w.siteA1._id, `/parties/${s.vendorA}/ledger?${OCT}`)).set(auth(s.t));
    expect(res.body).toEqual(ledger.body);
    // a client id or a vendor of another site is not a vendor of this site
    expect((await report(s.t, s.w.siteA1._id, "vendor-ledger", `${OCT}&vendorId=${s.client}`)).status).toBe(404);
  });
});

describe("labour wages report", () => {
  it("uses wage snapshots, includes detached labour, the last day, and labour payments", async () => {
    const s = await setup();
    await attendance(s, "2026-10-05", [
      { labourId: s.ravi, status: "present" },
      { labourId: s.mani, status: "present", shifts: 1.5 },
    ]);
    // rate change after the 5th: history keeps ₹950, the 31st uses ₹1,200
    expect((await api().patch(sitePath(s.w.siteA1._id, `/parties/${s.ravi}`)).set(auth(s.t)).send({ wageRatePaise: 120000 })).status).toBe(200);
    await attendance(s, "2026-10-31", [
      { labourId: s.ravi, status: "present" },
      { labourId: s.mani, status: "absent" },
    ]);
    await attendance(s, "2026-11-01", [{ labourId: s.ravi, status: "present" }]);
    await pay(s, { date: "2026-10-31", direction: "out", category: "labour", partyId: s.ravi, amountPaise: 50000 });
    await pay(s, { date: "2026-11-02", direction: "out", category: "labour", partyId: s.ravi, amountPaise: 70000 });
    // Mani leaves the site — his October wages still count
    expect((await api().delete(sitePath(s.w.siteA1._id, `/parties/${s.mani}`)).set(auth(s.t))).status).toBe(204);

    const res = await report(s.t, s.w.siteA1._id, "labour-wages", OCT);
    expect(res.status).toBe(200);
    expect(res.body.days).toHaveLength(31);
    expect(res.body.days.at(-1)).toBe("2026-10-31");
    expect(res.body.rows).toEqual([
      {
        labourId: s.mani,
        name: "Mani S",
        category: "Helper",
        shiftsByDate: { "2026-10-05": 1.5, "2026-10-31": 0 },
        days: 1,
        shifts: 1.5,
        wagesPaise: 90000,
        paidPaise: 0,
        balancePaise: 90000,
      },
      {
        labourId: s.ravi,
        name: "Ravi K",
        category: "Mason",
        shiftsByDate: { "2026-10-05": 1, "2026-10-31": 1 },
        days: 2,
        shifts: 2,
        wagesPaise: 215000,
        paidPaise: 50000,
        balancePaise: 165000,
      },
    ]);
    expect(res.body.totals).toEqual({ shifts: 3.5, wagesPaise: 305000, paidPaise: 50000, balancePaise: 255000 });

    const helpers = await report(s.t, s.w.siteA1._id, "labour-wages", `${OCT}&category=Helper`);
    expect(helpers.body.rows.map((r: { name: string }) => r.name)).toEqual(["Mani S"]);
    expect(helpers.body.totals.wagesPaise).toBe(90000);
  });
});

describe("payments report", () => {
  it("lists posted payments in range with totals by direction and category", async () => {
    const s = await setup();
    await seedVendors(s);
    await pay(s, { date: "2026-10-31", direction: "in", category: "client", partyId: s.client, amountPaise: 1000000 });
    await pay(s, { date: "2026-10-02", direction: "out", category: "other", amountPaise: 2500, description: "Tea" });
    await pay(s, { date: "2026-10-02", direction: "out", category: "other", amountPaise: 9999 }, s.w.siteA2._id);

    const res = await report(s.t, s.w.siteA1._id, "payments", OCT);
    expect(res.status).toBe(200);
    expect(res.body.rows.map((r: { date: string; amountPaise: number }) => [r.date, r.amountPaise])).toEqual([
      ["2026-10-02", 2500],
      ["2026-10-15", 100000],
      ["2026-10-31", 1000000],
    ]);
    expect(res.body.rows[2]).toMatchObject({ status: "posted", party: { id: s.client, name: "Mr. Raman", kind: "client" } });
    expect(res.body.rows[0]).not.toHaveProperty("orgId");
    expect(res.body.totals).toEqual({
      inPaise: 1000000,
      outPaise: 102500,
      byCategory: [
        { category: "vendor", inPaise: 0, outPaise: 100000 },
        { category: "client", inPaise: 1000000, outPaise: 0 },
        { category: "other", inPaise: 0, outPaise: 2500 },
      ],
    });
    const outOnly = await report(s.t, s.w.siteA1._id, "payments", `${OCT}&direction=out&category=vendor`);
    expect(outOnly.body.rows).toHaveLength(1);
    expect(outOnly.body.totals).toMatchObject({ inPaise: 0, outPaise: 100000 });
  });
});

describe("stock report", () => {
  it("computes opening, in-range movements, closing and value at average cost", async () => {
    const s = await setup();
    const A1 = s.w.siteA1._id;
    await buy(s, A1, s.vendorA, "2026-09-25", 10, 40000);
    const po = await buy(s, A1, s.vendorA, "2026-10-10", 4, 46000);
    await giveBack(s, A1, po, "2026-10-31", 2);
    const used = await api()
      .post(sitePath(A1, "/consumptions"))
      .set(auth(s.t))
      .send({ date: "2026-10-15", lines: [{ productId: s.cementId, qty: 3 }] });
    expect(used.status).toBe(201);
    const adj = await api()
      .post(sitePath(A1, "/stock-adjustments"))
      .set(auth(s.t))
      .send({ date: "2026-10-20", productId: s.cementId, qty: -0.5, reason: "Spilt" });
    expect(adj.status).toBe(201);
    await buy(s, A1, s.vendorA, "2026-11-02", 100, 10000); // after the range

    const res = await report(s.t, A1, "stock", OCT);
    expect(res.status).toBe(200);
    // avg cost as of the 31st: (10×400 + 4×460 − 2×460) / 12 = ₹410
    expect(res.body.rows).toEqual([
      {
        productId: s.cementId,
        productName: "OPC 53 cement",
        unit: "bag",
        openingQty: 10,
        receivedQty: 4,
        returnedQty: 2,
        consumedQty: 3,
        adjustedQty: -0.5,
        closingQty: 8.5,
        avgCostPaise: 41000,
        closingValuePaise: 348500,
      },
    ]);
    const other = await report(s.t, A1, "stock", `${OCT}&productId=${s.vendorA}`);
    expect(other.body.rows).toEqual([]);
  });
});

describe("site summary report", () => {
  it("totals materials, labour and payments, with every month present and years kept apart", async () => {
    const s = await setup();
    const A1 = s.w.siteA1._id;
    const po = await buy(s, A1, s.vendorA, "2026-01-10", 10, 40000);
    await giveBack(s, A1, po, "2026-01-20", 1);
    await attendance(s, "2026-03-02", [{ labourId: s.ravi, status: "present", shifts: 2 }]);
    await pay(s, { date: "2025-11-20", direction: "in", category: "client", partyId: s.client, amountPaise: 700000 });
    await pay(s, { date: "2026-11-05", direction: "in", category: "client", partyId: s.client, amountPaise: 300000 });
    await pay(s, { date: "2026-11-10", direction: "out", category: "labour", partyId: s.ravi, amountPaise: 190000 });

    const res = await report(s.t, A1, "site-summary", "from=2025-11-15&to=2026-11-10");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      materials: { receivedPaise: 400000, returnedPaise: 40000, netPaise: 360000 },
      labour: { shifts: 2, wagesPaise: 190000 },
      payments: { inPaise: 1000000, outPaise: 190000 },
    });
    expect(res.body.byMonth).toHaveLength(13);
    const month = (m: string) => res.body.byMonth.find((x: { month: string }) => x.month === m);
    expect(month("2025-11")).toEqual({ month: "2025-11", materialsPaise: 0, wagesPaise: 0, paymentsOutPaise: 0, paymentsInPaise: 700000 });
    expect(month("2026-11")).toEqual({ month: "2026-11", materialsPaise: 0, wagesPaise: 0, paymentsOutPaise: 190000, paymentsInPaise: 300000 });
    expect(month("2026-01")).toMatchObject({ materialsPaise: 360000 });
    expect(month("2026-03")).toMatchObject({ wagesPaise: 190000 });
    expect(month("2026-06")).toEqual({ month: "2026-06", materialsPaise: 0, wagesPaise: 0, paymentsOutPaise: 0, paymentsInPaise: 0 });
  });

  it("monthsBetween keys by year and month", () => {
    expect(monthsBetween("2025-11-15", "2026-02-01")).toEqual(["2025-11", "2025-12", "2026-01", "2026-02"]);
    expect(monthsBetween("2026-02-28", "2026-02-28")).toEqual(["2026-02"]);
  });
});

describe("reports: access and validation", () => {
  const NAMES = ["labour-wages", "vendor-ledger", "payments", "stock", "site-summary"];

  it("engineer+ only; other orgs' sites are 404", async () => {
    const w: World = await world();
    for (const name of NAMES) {
      expect((await report(w.tokens.supervisorA, w.siteA1._id, name, OCT)).status).toBe(403);
      expect((await report(w.tokens.engineerA, w.siteA1._id, name, OCT)).status).toBe(200);
      expect((await report(w.tokens.engineerA, w.siteA2._id, name, OCT)).status).toBe(404);
      expect((await report(w.tokens.ownerA, w.siteB1._id, name, OCT)).status).toBe(404);
    }
  });

  it("validates the range: inclusive ≤ 366 days, from ≤ to, both required", async () => {
    const w = await world();
    const go = (qs: string) => report(w.tokens.ownerA, w.siteA1._id, "site-summary", qs);
    expect((await go("from=2025-01-01&to=2025-12-31")).status).toBe(200); // 365 days
    expect((await go("from=2024-01-01&to=2024-12-31")).status).toBe(200); // 366 days (leap year)
    const tooLong = await go("from=2025-01-01&to=2026-01-02");
    expect(tooLong.status).toBe(422);
    expect(tooLong.body.code).toBe("VALIDATION_FAILED");
    expect((await go("from=2026-10-31&to=2026-10-01")).status).toBe(422);
    expect((await go("to=2026-10-01")).status).toBe(422);
    expect((await go(`${OCT}&format=pdf`)).status).toBe(422);
    expect((await report(w.tokens.ownerA, w.siteA1._id, "stock", `${OCT}&productId=nope`)).status).toBe(422);
  });
});

describe("report exports", () => {
  it("queues an xlsx export that completes with a downloadable, formatted workbook", async () => {
    const s = await setup();
    await attendance(s, "2026-10-05", [{ labourId: s.ravi, status: "present" }]);
    const res = await report(s.w.tokens.engineerA, s.w.siteA1._id, "labour-wages", `${OCT}&format=xlsx`);
    expect(res.status).toBe(202);
    expect(res.body.jobId).toMatch(/^[a-f0-9]{24}$/);
    await drainJobs();
    const job = await api().get(`/api/v1/jobs/${res.body.jobId}`).set(auth(s.w.tokens.engineerA));
    expect(job.body).toMatchObject({ status: "done", file: { filename: "labour-wages_2026-10-01_2026-10-31.xlsx", contentType: XLSX } });

    const file = await api()
      .get(`/api/v1/files/${job.body.file.id}`)
      .set(auth(s.w.tokens.engineerA))
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on("data", (c: Buffer) => chunks.push(c));
        r.on("end", () => cb(null, Buffer.concat(chunks)));
      });
    expect(file.status).toBe(200);
    expect(file.headers["content-type"]).toBe(XLSX);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(file.body as ArrayBuffer);
    const ws = wb.worksheets[0]!;
    expect(String(ws.getCell("A1").value)).toContain("Site A1");
    expect(String(ws.getCell("A1").value)).toContain("01-10-2026 to 31-10-2026");
    const header = ws.getRow(3).values as unknown[];
    const wagesCol = header.indexOf("Wages");
    expect(ws.getRow(4).getCell(wagesCol).value).toBe(950); // rupees, not paise
    expect(ws.getRow(5).getCell(1).value).toBe("Total");
    expect(ws.getRow(5).getCell(wagesCol).value).toBe(950);
  });

  it("every report exports; a bad vendor fails before queueing; supervisors can't export", async () => {
    const s = await setup();
    await seedVendors(s);
    const queries: [string, string][] = [
      ["vendor-ledger", OCT],
      ["vendor-ledger", `${OCT}&vendorId=${s.vendorA}`],
      ["payments", OCT],
      ["stock", OCT],
      ["site-summary", OCT],
    ];
    const jobs: string[] = [];
    for (const [name, qs] of queries) {
      const res = await report(s.t, s.w.siteA1._id, name, `${qs}&format=xlsx`);
      expect(res.status).toBe(202);
      jobs.push(res.body.jobId);
    }
    await drainJobs();
    for (const [i, id] of jobs.entries()) {
      const job = await api().get(`/api/v1/jobs/${id}`).set(auth(s.t));
      expect(job.body.status, queries[i]![0]).toBe("done");
      expect(job.body.file.filename).toBe(`${queries[i]![0]}_2026-10-01_2026-10-31.xlsx`);
    }
    expect((await report(s.t, s.w.siteA1._id, "vendor-ledger", `${OCT}&vendorId=${s.client}&format=xlsx`)).status).toBe(404);
    expect((await report(s.w.tokens.supervisorA, s.w.siteA1._id, "stock", `${OCT}&format=xlsx`)).status).toBe(403);
  });
});
