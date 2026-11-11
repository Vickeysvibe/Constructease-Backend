import bcrypt from "bcryptjs";
import mongoose, { Types, type Connection } from "mongoose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Counter } from "@/core/records";
import { todayIn } from "@/core/units";
import { Organization, User } from "@/modules/identity/models";
import { Membership, Site } from "@/modules/sites/models";
import { Party } from "@/modules/parties/models";
import { Product } from "@/modules/products/models";
import { PurchaseOrder } from "@/modules/purchasing/models";
import { AttendanceEntry, CheckinDay } from "@/modules/workforce/models";
import { Payment } from "@/modules/finance/models";
import { Tracker, TrackerRow } from "@/modules/worklog/models";
import { Note } from "@/modules/notes/models";
import { migrate } from "@/scripts/migrate-legacy/migrate";
import { classifyTaxId, cleanPhone, cleanShifts, pairCheckins } from "@/scripts/migrate-legacy/clean";
import { api, auth, login, sitePath, useDatabase } from "./helpers";

useDatabase();

const OWNER_A_PASSWORD = "OwnerPass123";
const SUP_PASSWORD = "SupPass1234";
const PLAIN_PASSWORD = "plain12345";

const id = () => new Types.ObjectId();
const ids = {
  engA: id(), engB: id(),
  siteA1: id(), siteA2: id(), siteB1: id(),
  supLocal: id(), supPlain: id(), supDeleted: id(), supGlobal: id(),
  vendorA1: id(), vendorA2: id(), vendorBad: id(), vendorB: id(),
  clientA: id(), clientJunk: id(),
  ravi: id(), muthu: id(), gone: id(),
  cementA1: id(), cementA2: id(), steelA1: id(), cementB1: id(),
  po1: id(), po2: id(), inward1: id(), matCement: id(), matSteel: id(), return1: id(),
};
const at = (iso: string) => new Date(iso);

/** bcrypt from the old `bcrypt` package is `$2b$`; bcryptjs writes `$2a$` with the same algorithm. */
const legacyHash = async (plain: string) => (await bcrypt.hash(plain, 4)).replace(/^\$2a\$/, "$2b$");

let source: Connection;

async function seedLegacy(db: NonNullable<Connection["db"]>) {
  const ownerHash = await legacyHash(OWNER_A_PASSWORD);
  const supHash = await legacyHash(SUP_PASSWORD);
  const base = { createdAt: at("2025-01-01T05:00:00Z"), updatedAt: at("2025-01-01T05:00:00Z") };
  await db.collection("engineers").insertMany([
    { _id: ids.engA, name: "Priya R", companyName: "Acme Builders", companyLogo: "https://x.test/logo.png", companyDesc: "Builders", email: "priya@acme.test", phoneNo: "9840000001", address: "Chennai", password: ownerHash, ...base },
    { _id: ids.engB, name: "Arun K", companyName: "Other Corp", companyLogo: "https://x.test/o.png", companyDesc: "Other", email: "arun@other.test", phoneNo: "9840000002", address: "Madurai", password: await legacyHash("OtherPass123"), ...base },
  ]);
  await db.collection("sites").insertMany([
    { _id: ids.siteA1, siteName: "Anna Nagar Villa", siteAddress: "Anna Nagar", engineerId: ids.engA, supervisorsId: [ids.supLocal, ids.supDeleted], ...base },
    { _id: ids.siteA2, siteName: "Adyar Flats", siteAddress: "Adyar", engineerId: ids.engA, supervisorsId: [ids.supPlain], ...base },
    { _id: ids.siteB1, siteName: "Madurai Mall", siteAddress: "Madurai", engineerId: ids.engB, supervisorsId: [], ...base },
  ]);
  await db.collection("supervisors").insertMany([
    { _id: ids.supLocal, name: "Sam", email: "sam@acme.test", address: "x", phoneNo: "9840000011", password: supHash, role: "local", engineerId: ids.engA, isDel: false, ...base },
    { _id: ids.supPlain, name: "Plain Pete", email: "pete@acme.test", address: "x", phoneNo: "9840000012", password: PLAIN_PASSWORD, role: "local", engineerId: ids.engA, isDel: false, ...base },
    { _id: ids.supDeleted, name: "Gone Gopi", email: "gopi@acme.test", address: "x", phoneNo: "9840000013", password: supHash, role: "local", engineerId: ids.engA, isDel: true, ...base },
    { _id: ids.supGlobal, name: "Global Gita", email: "gita@acme.test", address: "x", phoneNo: "9840000014", password: supHash, role: "global", engineerId: ids.engA, isDel: false, ...base },
  ]);
  await db.collection("vendors").insertMany([
    { _id: ids.vendorA1, name: "Sri Balaji Traders", ownerName: "Balaji", address: "T Nagar", gstIn: "33AABCS1429B1Z5", phoneNo: "9840123456", siteId: ids.siteA1, ...base },
    { _id: ids.vendorA2, name: " sri balaji  traders", ownerName: "Balaji", address: "T Nagar", gstIn: "NA", phoneNo: "98401 23456", siteId: ids.siteA2, ...base },
    { _id: ids.vendorBad, name: "Bad Phone Vendor", ownerName: "X", address: "x", gstIn: "x", phoneNo: "12345", siteId: ids.siteA1, ...base },
    { _id: ids.vendorB, name: "Sri Balaji Traders", ownerName: "Balaji", address: "Madurai", gstIn: "33AABCS1429B1Z5", phoneNo: "9840123456", siteId: ids.siteB1, ...base },
  ]);
  await db.collection("clients").insertMany([
    { _id: ids.clientA, name: "Kumar Constructions", phoneNo: "9840200000", address: "Velachery", panGstNo: "abcde1234f", siteId: ids.siteA1, ...base },
    { _id: ids.clientJunk, name: "Junk Tax Client", phoneNo: "9840200001", address: "x", panGstNo: "N/A", siteId: ids.siteA1, ...base },
  ]);
  await db.collection("labours").insertMany([
    { _id: ids.ravi, name: "Ravi", phoneNo: "9789012345", category: "Mason", subCategory: "Senior", wagesPerShift: 950, isDel: false, siteId: [ids.siteA1, ids.siteA2], ...base },
    { _id: ids.muthu, name: "Muthu", phoneNo: "9789012346", category: "Helper", subCategory: "Helper", wagesPerShift: 800.5, isDel: false, siteId: [ids.siteA1], ...base },
    { _id: ids.gone, name: "Old Hand", phoneNo: "9789012347", category: "Helper", subCategory: "Helper", wagesPerShift: 700, isDel: true, siteId: [ids.siteA1], ...base },
  ]);
  await db.collection("products").insertMany([
    { _id: ids.cementA1, name: "Cement", description: "OPC 53", category: "Civil", unit: "bag", siteId: ids.siteA1, ...base },
    { _id: ids.cementA2, name: "cement ", description: "OPC", category: "Civil", unit: "bag", siteId: ids.siteA2, ...base },
    { _id: ids.steelA1, name: "Steel", description: "TMT", category: "Civil", unit: "kg", siteId: ids.siteA1, ...base },
    { _id: ids.cementB1, name: "Cement", description: "PPC", category: "Civil", unit: "bag", siteId: ids.siteB1, ...base },
  ]);
  // PO1: cement ordered on two lines (100 + 20) and steel 50. One inward: 110 cement (fills line 1, 10 on line 3) + 20 steel.
  await db.collection("purchaseorders").insertMany([
    {
      _id: ids.po1, siteId: ids.siteA1, vendorId: ids.vendorA1, date: at("2025-01-05T04:00:00Z"), transport: "Lorry",
      order: [{ productId: ids.cementA1, requiredQty: 100 }, { productId: ids.steelA1, requiredQty: 50 }, { productId: ids.cementA2, requiredQty: 20 }],
      createdAt: at("2025-01-05T04:00:00Z"), updatedAt: at("2025-01-05T04:00:00Z"),
    },
    {
      _id: ids.po2, siteId: ids.siteA1, vendorId: ids.vendorA2, date: at("2025-01-07T04:00:00Z"),
      order: [{ productId: ids.steelA1, requiredQty: 10 }],
      createdAt: at("2025-01-07T04:00:00Z"), updatedAt: at("2025-01-07T04:00:00Z"),
    },
  ]);
  await db.collection("materials").insertMany([
    // availableQty is corrupted (old hook bug): must be ignored and reported
    { _id: ids.matCement, productId: ids.cementA1, suppliedQty: 110, tax: 28, availableQty: 999, usedQty: 30, unitPrice: 400, siteId: ids.siteA1, fromVendor: ids.vendorA1, POid: ids.po1, createdAt: at("2025-01-06T05:00:00Z"), updatedAt: at("2025-01-08T05:00:00Z") },
    { _id: ids.matSteel, productId: ids.steelA1, suppliedQty: 20, tax: 18, availableQty: 20, usedQty: 0, unitPrice: 60, siteId: ids.siteA1, fromVendor: ids.vendorA1, POid: ids.po1, createdAt: at("2025-01-06T05:00:00Z"), updatedAt: at("2025-01-06T05:00:00Z") },
  ]);
  await db.collection("materialinwards").insertOne({
    _id: ids.inward1, POid: ids.po1, materials: [ids.matCement, ids.matSteel], subTotal: 45200, grandTotal: 57736, siteId: ids.siteA1,
    createdAt: at("2025-01-06T05:00:00Z"), updatedAt: at("2025-01-06T05:00:00Z"),
  });
  await db.collection("purchasereturns").insertOne({
    _id: ids.return1, POid: ids.po1, order: [{ materialId: ids.matCement, returnQty: 5, tax: 28, subTotal: 2000 }], grandTotal: 2560, siteId: ids.siteA1,
    createdAt: at("2025-01-09T05:00:00Z"), updatedAt: at("2025-01-09T05:00:00Z"),
  });
  // 2025-01-09T18:30Z = midnight 10 Jan in Kolkata. Ravi is also marked present on A2 that day (double booking).
  await db.collection("labourattendances").insertMany([
    { siteId: ids.siteA1, date: at("2025-01-09T18:30:00Z"), attendance: [{ labourId: ids.ravi, shift: 1, status: "present" }, { labourId: ids.muthu, shift: 1.5, status: "present" }], createdAt: at("2025-01-10T03:00:00Z") },
    { siteId: ids.siteA2, date: at("2025-01-09T18:30:00Z"), attendance: [{ labourId: ids.ravi, shift: 1, status: "present" }], createdAt: at("2025-01-10T04:00:00Z") },
    { siteId: ids.siteA1, date: at("2025-01-10T18:30:00Z"), attendance: [{ labourId: ids.ravi, shift: 1, status: "present" }, { labourId: ids.muthu, shift: 0, status: "absent" }], createdAt: at("2025-01-11T03:00:00Z") },
  ]);
  const t1 = at("2025-01-10T03:30:00Z");
  const t2 = at("2025-01-10T13:00:00Z");
  await db.collection("supervisorattendances").insertOne({
    siteId: ids.siteA1, date: at("2025-01-10T00:00:00Z"),
    attendance: [{
      supervisorId: ids.supLocal, location: { address: "Chennai, Tamil Nadu", latitude: 13.08, longitude: 80.27 },
      checkin: [t1, t2], checkout: [at("2025-01-10T11:30:00Z"), t2], // the second checkout is the bogus "= checkin" default
    }],
    createdAt: t1,
  });
  await db.collection("payments").insertMany([
    { siteId: ids.siteA1, type: "vendor", date: at("2025-01-08T06:00:00Z"), name: "SRI BALAJI TRADERS", description: "Advance", amount: 10000, createdAt: at("2025-01-08T06:00:00Z") },
    { siteId: ids.siteA1, type: "client", date: at("2025-01-08T06:00:00Z"), name: "kumar constructions", paymentReceived: 50000, paymentAs: "NEFT", paymentBy: "Kumar", createdAt: at("2025-01-08T06:00:00Z") },
    { siteId: ids.siteA1, type: "labour", date: at("2025-01-08T06:00:00Z"), name: "Ravi", description: "Weekly", amount: 2000, createdAt: at("2025-01-08T06:00:00Z") },
    { engineerId: ids.engA, type: "others", date: at("2025-01-08T06:00:00Z"), description: "Office rent", amount: 1500, createdAt: at("2025-01-08T06:00:00Z") },
    { siteId: ids.siteA1, type: "vendor", date: at("2025-01-08T06:00:00Z"), name: "Unknown Supplier", description: "Sand", amount: 700, createdAt: at("2025-01-08T06:00:00Z") },
  ]);
  await db.collection("todos").insertMany([
    { task: "Pour slab", start: at("2025-01-09T18:30:00Z"), end: at("2025-01-11T18:30:00Z"), additionalCols: { Owner: "Ravi", Priority: "High" }, siteId: ids.siteA1, createdAt: at("2025-01-02T00:00:00Z") },
    { task: "Order steel", start: at("2025-01-09T18:30:00Z"), end: at("2025-01-09T18:30:00Z"), additionalCols: { Owner: "", Priority: "" }, siteId: ids.siteA1, createdAt: at("2025-01-03T00:00:00Z") },
  ]);
  await db.collection("works").insertOne({
    title: "Plinth beam", description: "Done on east side", date: at("2025-01-09T18:30:00Z"), additionalCols: { Floor: "Ground" }, siteId: ids.siteA1, createdAt: at("2025-01-10T00:00:00Z"),
  });
  await db.collection("notes").insertMany([
    { title: "Drawings", context: "Rev 3 approved", sheetsLink: "https://docs.google.com/spreadsheets/d/abc", siteId: ids.siteA1, createdAt: at("2025-01-02T00:00:00Z") },
    { title: "Misc", context: "", sheetsLink: "drive folder 7", siteId: ids.siteA1, createdAt: at("2025-01-02T00:00:00Z") },
  ]);
}

/** document counts of every target collection */
async function snapshot() {
  const db = mongoose.connection.db!;
  const out: Record<string, number> = {};
  for (const c of await db.collections()) out[c.collectionName] = await c.countDocuments();
  return out;
}

beforeAll(async () => {
  source = await mongoose.createConnection(process.env.TEST_MONGODB_URI!, { dbName: "constructease_legacy_src" }).asPromise();
  await source.db!.dropDatabase();
  await seedLegacy(source.db!);
});
afterAll(async () => {
  await source.db?.dropDatabase();
  await source.close();
});

const orgA = async () => (await Organization.findOne({ name: "Acme Builders" }).lean())!;
const siteNamed = async (orgId: Types.ObjectId, name: string) => (await Site.findOne({ orgId, name }).lean())!;

describe("legacy migration", () => {
  it("dry run maps and validates everything but writes nothing", async () => {
    const before = await snapshot();
    const report = await migrate({ source, dryRun: true });
    expect(report.dryRun).toBe(true);
    expect(report.issues.errors).toEqual([]);
    expect(report.counts.engineers.created).toBe(2);
    expect(report.counts.purchaseOrders.created).toBe(2);
    expect(report.counts.labourAttendance.created).toBe(4);
    expect(report.issues.doubleBookings).toHaveLength(1);
    expect(report.issues.unmatchedPayments).toHaveLength(1);
    const after = await snapshot();
    expect(Object.values(after).reduce((s, n) => s + n, 0)).toBe(Object.values(before).reduce((s, n) => s + n, 0));
    expect(await Organization.countDocuments()).toBe(0);
  });

  it("migrates orgs, users, masters, purchasing, stock, ledgers, attendance, payments and worklog", async () => {
    const report = await migrate({ source, dryRun: false });
    expect(report.issues.errors).toEqual([]);
    expect(report.format()).toMatch(/purchaseOrders\s+2\s+2/);

    // ---- orgs, owners, supervisors, memberships ----
    expect(await Organization.countDocuments()).toBe(2);
    const org = await orgA();
    expect(org).toMatchObject({ description: "Builders", logoUrl: "https://x.test/logo.png", phone: "9840000001", timezone: "Asia/Kolkata" });
    const token = await login("priya@acme.test", OWNER_A_PASSWORD); // $2b$ legacy hash verifies
    expect(token).toBeTruthy();
    const users = await User.find({ orgId: org._id }).lean();
    expect(users.map((u) => u.orgRole).sort()).toEqual(["member", "member", "member", "member", "owner"]);
    expect(report.issues.mustResetPassword).toEqual([expect.objectContaining({ email: "pete@acme.test", kind: "supervisor" })]);
    expect((await api().post("/api/v1/auth/login").send({ email: "pete@acme.test", password: PLAIN_PASSWORD })).status).toBe(401);
    expect(users.find((u) => u.email === "gopi@acme.test")!.status).toBe("disabled");
    expect((await api().post("/api/v1/auth/login").send({ email: "gopi@acme.test", password: SUP_PASSWORD })).status).toBe(401);
    await login("sam@acme.test", SUP_PASSWORD);
    const a1 = await siteNamed(org._id, "Anna Nagar Villa");
    const a2 = await siteNamed(org._id, "Adyar Flats");
    const gita = users.find((u) => u.email === "gita@acme.test")!;
    const sam = users.find((u) => u.email === "sam@acme.test")!;
    expect(await Membership.countDocuments({ orgId: org._id, userId: gita._id, role: "supervisor" })).toBe(2); // global → every site
    expect((await Membership.find({ orgId: org._id, userId: sam._id }).lean()).map((x) => String(x.siteId))).toEqual([String(a1._id)]);
    expect(await Tracker.countDocuments({ orgId: org._id, siteId: a1._id })).toBe(2);

    // ---- parties ----
    const vendors = await Party.find({ orgId: org._id, kind: "vendor" }).lean();
    expect(vendors).toHaveLength(1); // duplicate across A1/A2 merged; bad phone vendor skipped
    const vendor = vendors[0]!;
    expect(vendor).toMatchObject({ name: "Sri Balaji Traders", phone: "9840123456", gstIn: "33AABCS1429B1Z5", contactName: "Balaji" });
    expect(vendor.siteIds.map(String).sort()).toEqual([String(a1._id), String(a2._id)].sort());
    expect(report.issues.partyMerges).toHaveLength(1);
    expect(report.issues.invalidPhones).toEqual([expect.objectContaining({ name: "Bad Phone Vendor" })]);
    expect(await Party.countDocuments({ kind: "vendor" }).setOptions({ skipTenantGuard: true })).toBe(2); // org B keeps its own vendor
    const client = (await Party.findOne({ orgId: org._id, kind: "client", nameKey: "kumar constructions" }).lean())!;
    expect(client.pan).toBe("ABCDE1234F");
    expect(report.issues.droppedTaxIds.map((d) => d.value).sort()).toEqual(["N/A", "NA"]);
    const ravi = (await Party.findOne({ orgId: org._id, kind: "labour", nameKey: "ravi" }).lean())!;
    expect(ravi).toMatchObject({ wageRatePaise: 95000, category: "Mason", subCategory: "Senior" });
    expect((await Party.findOne({ orgId: org._id, nameKey: "old hand" }).lean())!.status).toBe("archived");
    expect(await Product.countDocuments({ orgId: org._id })).toBe(2); // cement merged

    // ---- purchase order: partially received, duplicate cement lines filled in order ----
    const ownerAuth = auth(token);
    const po1 = (await PurchaseOrder.findOne({ orgId: org._id, number: "PO-2025-0001" }).lean())!;
    const res = await api().get(sitePath(a1._id, `/purchase-orders/${po1._id.toHexString()}`)).set(ownerAuth);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("partially_received");
    expect(res.body.lines.map((l: { qty: number; receivedQty: number; returnedQty: number; unitPricePaise: number; taxRateBp: number }) => [l.qty, l.receivedQty, l.returnedQty, l.unitPricePaise, l.taxRateBp])).toEqual([
      [100, 100, 5, 40000, 2800],
      [50, 20, 0, 6000, 1800],
      [20, 10, 0, 40000, 2800],
    ]);
    expect(res.body.receipts).toEqual([expect.objectContaining({ number: "GR-2025-0001", totalPaise: 5773600 })]);
    expect(res.body.returns).toEqual([expect.objectContaining({ number: "PR-2025-0001", totalPaise: 256000 })]);
    expect((await PurchaseOrder.findOne({ orgId: org._id, number: "PO-2025-0002" }).lean())!.status).toBe("sent");
    expect((await Counter.findOne({ orgId: org._id, key: "PO-2025" }).lean())!.seq).toBe(2);
    expect(report.issues.availableQtyMismatch).toEqual([expect.objectContaining({ materialId: String(ids.matCement), oldAvailableQty: 999, computedQty: 75 })]);

    // ---- stock: supplied − used − returned ----
    const stock = await api().get(sitePath(a1._id, "/stock")).set(ownerAuth);
    expect(stock.status).toBe(200);
    const cement = stock.body.items.find((i: { productName: string }) => i.productName === "Cement");
    expect(cement).toMatchObject({ receivedQty: 110, consumedQty: 30, returnedQty: 5, onHandQty: 75 });
    expect(stock.body.items.find((i: { productName: string }) => i.productName === "Steel")).toMatchObject({ onHandQty: 20 });

    // ---- vendor ledger: receipt 57,736 − return 2,560 − payment 10,000 ----
    const ledger = await api()
      .get(sitePath(a1._id, `/parties/${vendor._id.toHexString()}/ledger`))
      .query({ from: "2024-04-01", to: todayIn() })
      .set(ownerAuth);
    expect(ledger.status).toBe(200);
    expect(ledger.body.closingBalancePaise).toBe(5773600 - 256000 - 1000000);

    // ---- attendance (IST days), double booking ----
    const entries = await AttendanceEntry.find({ orgId: org._id }).lean();
    expect(entries).toHaveLength(4);
    expect(entries.filter((e) => e.date === "2025-01-10").map((e) => [String(e.siteId), e.shifts, e.wageRatePaise]).sort()).toEqual(
      [[String(a1._id), 1, 95000], [String(a1._id), 1.5, 80050]].sort(),
    );
    expect(entries.filter((e) => e.date === "2025-01-11")).toHaveLength(2);
    expect(report.issues.doubleBookings).toEqual([expect.objectContaining({ labour: "Ravi", date: "2025-01-10", site: "Adyar Flats" })]);
    const sheet = await api().get(sitePath(a1._id, "/attendance")).query({ date: "2025-01-10" }).set(ownerAuth);
    expect(sheet.body.summary.present).toBe(2);

    // ---- supervisor check-ins ----
    const day = (await CheckinDay.findOne({ orgId: org._id, userId: sam._id }).lean())!;
    expect(day.date).toBe("2025-01-10");
    expect(day.events.map((e) => e.type)).toEqual(["in", "out", "in"]);
    expect(day.events[0]).toMatchObject({ lat: 13.08, lng: 80.27, address: "Chennai, Tamil Nadu" });

    // ---- payments ----
    const payments = await Payment.find({ orgId: org._id }).lean();
    expect(payments).toHaveLength(5);
    expect(payments.every((p) => p.createdAt.toISOString() === "2025-01-08T06:00:00.000Z")).toBe(true); // old timestamps kept
    const unmatched = payments.find((p) => p.description?.startsWith("[unmatched: Unknown Supplier]"))!;
    expect(unmatched).toMatchObject({ category: "other", amountPaise: 70000 });
    expect(unmatched.partyId).toBeUndefined();
    expect(report.issues.unmatchedPayments).toEqual([expect.objectContaining({ name: "Unknown Supplier" })]);
    expect(payments.find((p) => p.category === "client")).toMatchObject({ direction: "in", amountPaise: 5000000, method: "bank", partyId: client._id });
    expect(payments.find((p) => p.category === "labour")).toMatchObject({ partyId: ravi._id, amountPaise: 200000 });
    expect(payments.find((p) => p.description === "Office rent")).toMatchObject({ siteId: null, category: "other" });

    // ---- worklog & notes ----
    const todo = (await Tracker.findOne({ orgId: org._id, siteId: a1._id, kind: "todo" }).lean())!;
    const owner = todo.columns.find((c) => c.label === "Owner")!;
    const priority = todo.columns.find((c) => c.label === "Priority")!;
    expect(owner).toMatchObject({ type: "text" });
    const rows = await api().get(sitePath(a1._id, `/trackers/${todo._id.toHexString()}/rows`)).set(ownerAuth);
    expect(rows.status).toBe(200);
    expect(rows.body.items.map((r: { values: Record<string, unknown> }) => r.values)).toEqual([
      { c_task: "Pour slab", c_start: "2025-01-10", c_end: "2025-01-12", [owner.key]: "Ravi", [priority.key]: "High" },
      { c_task: "Order steel", c_start: "2025-01-10", c_end: "2025-01-10" },
    ]);
    const work = (await Tracker.findOne({ orgId: org._id, siteId: a1._id, kind: "work" }).lean())!;
    const floor = work.columns.find((c) => c.label === "Floor")!;
    expect((await TrackerRow.findOne({ orgId: org._id, trackerId: work._id }).lean())!.values).toEqual({
      c_title: "Plinth beam", c_desc: "Done on east side", c_date: "2025-01-10", [floor.key]: "Ground",
    });
    const notes = await Note.find({ orgId: org._id }).sort({ title: 1 }).lean();
    expect(notes.map((n) => [n.title, n.link ?? null, n.body])).toEqual([
      ["Drawings", "https://docs.google.com/spreadsheets/d/abc", "Rev 3 approved"],
      ["Misc", null, "Link: drive folder 7"],
    ]);
  });

  it("is idempotent: a re-run creates nothing new", async () => {
    await migrate({ source, dryRun: false });
    const first = await snapshot();
    const again = await migrate({ source, dryRun: false });
    expect(again.issues.errors).toEqual([]);
    for (const [entity, c] of Object.entries(again.counts)) {
      expect({ entity, created: c.created }).toEqual({ entity, created: 0 });
    }
    expect(again.counts.purchaseOrders.alreadyMigrated).toBe(2);
    expect(again.counts.vendors.alreadyMigrated).toBe(3);
    expect(await snapshot()).toEqual(first);
  });
});

describe("legacy value cleaning", () => {
  it("normalises phones, tax ids, shifts and check-in pairs", () => {
    expect(cleanPhone("+91 98401-23456")).toEqual({ digits: "9840123456", valid: true });
    expect(cleanPhone("098401 23456")).toEqual({ digits: "9840123456", valid: true });
    expect(cleanPhone("12345").valid).toBe(false);
    expect(classifyTaxId("33aabcs1429b1z5")).toEqual({ gstIn: "33AABCS1429B1Z5" });
    expect(classifyTaxId("abcde1234f")).toEqual({ pan: "ABCDE1234F" });
    expect(classifyTaxId("N/A")).toEqual({ dropped: "N/A" });
    expect(cleanShifts(1.3)).toEqual({ shifts: 1.5, changed: true });
    expect(cleanShifts(undefined)).toEqual({ shifts: 1, changed: false });
    const a = at("2025-01-10T03:00:00Z");
    const b = at("2025-01-10T05:00:00Z");
    const c = at("2025-01-10T09:00:00Z");
    // a never closed (checkout = checkin), then b → c
    const r = pairCheckins([a, b], [a, c]);
    expect(r.events.map((e) => [e.type, e.at.toISOString()])).toEqual([["in", b.toISOString()], ["out", c.toISOString()]]);
    expect(r.dropped).toBe(1);
  });
});
