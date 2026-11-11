import { describe, expect, it } from "vitest";
import type { Types } from "mongoose";
import { dayjs, todayIn } from "@/core/units";
import { AttendanceEntry } from "@/modules/workforce/models";
import { api, auth, sitePath, useDatabase, world } from "./helpers";

useDatabase();

const today = () => todayIn("Asia/Kolkata");
const monthsAgo = (n: number) => dayjs(`${today().slice(0, 7)}-01`, "YYYY-MM-DD").subtract(n, "month");

/**
 * Site A1 today: Ravi present (1.5 shifts @ ₹950), Mani absent, the supervisor checked in, one PO partly
 * received (₹4,000 of 2 lines), one PO sent, ₹1,000 paid to the vendor, ₹5,000 received from the client.
 */
async function seed() {
  const w = await world();
  const t = w.tokens.ownerA;
  const A1 = w.siteA1._id;
  const party = async (siteId: Types.ObjectId, body: object) => {
    const res = await api().post(sitePath(siteId, "/parties")).set(auth(t)).send(body);
    expect(res.status).toBe(201);
    return res.body.id as string;
  };
  const vendor = await party(A1, { kind: "vendor", name: "Sri Balaji Traders", phone: "9840123456" });
  const client = await party(A1, { kind: "client", name: "Mr. Raman", phone: "9840111111" });
  const ravi = await party(A1, { kind: "labour", name: "Ravi K", phone: "9789012345", category: "Mason", wageRatePaise: 95000 });
  const mani = await party(A1, { kind: "labour", name: "Mani S", phone: "9789012346", category: "Helper", wageRatePaise: 60000 });
  const cement = (await api().post("/api/v1/products").set(auth(t)).send({ name: "Cement", unit: "bag", defaultTaxRateBp: 0 })).body.id;
  const sand = (await api().post("/api/v1/products").set(auth(t)).send({ name: "Sand", unit: "cu.m", defaultTaxRateBp: 0 })).body.id;

  const po = async () => {
    const res = await api()
      .post(sitePath(A1, "/purchase-orders"))
      .set(auth(t))
      .send({
        vendorId: vendor,
        date: today(),
        lines: [
          { productId: cement, qty: 10, unitPricePaise: 40000 },
          { productId: sand, qty: 2, unitPricePaise: 300000 },
        ],
      });
    expect((await api().post(sitePath(A1, `/purchase-orders/${res.body.id}/send`)).set(auth(t))).status).toBe(200);
    return res.body as { id: string; number: string; lines: { id: string }[] };
  };
  const partial = await po();
  const gr = await api()
    .post(sitePath(A1, "/goods-receipts"))
    .set(auth(t))
    .send({ poId: partial.id, date: today(), lines: [{ poLineId: partial.lines[0]!.id, qty: 10 }] });
  expect(gr.status).toBe(201);
  await po();

  const att = await api()
    .put(sitePath(A1, "/attendance"))
    .set(auth(w.tokens.supervisorA))
    .send({ date: today(), entries: [{ labourId: ravi, status: "present", shifts: 1.5 }, { labourId: mani, status: "absent" }] });
  expect(att.status).toBe(200);
  const ci = await api().post(sitePath(A1, "/checkins")).set(auth(w.tokens.supervisorA)).send({ type: "in", lat: 13.08, lng: 80.27 });
  expect(ci.status).toBe(201);
  const pay = (body: object) => api().post(sitePath(A1, "/payments")).set(auth(t)).send(body).expect(201);
  await pay({ date: today(), direction: "out", category: "vendor", partyId: vendor, amountPaise: 100000 });
  await pay({ date: today(), direction: "in", category: "client", partyId: client, amountPaise: 500000 });
  return { w, partial };
}

describe("org dashboard", () => {
  it("lists visible sites with today's figures; month spend only where the caller has finance rights", async () => {
    const { w } = await seed();
    const owner = await api().get("/api/v1/dashboard").set(auth(w.tokens.ownerA));
    expect(owner.status).toBe(200);
    expect(owner.body.sites).toEqual([
      {
        id: w.siteA1.id,
        name: "Site A1",
        status: "active",
        today: { labourPresent: 1, checkedIn: 1 },
        openPOs: 2,
        monthSpendPaise: 400000,
      },
      { id: w.siteA2.id, name: "Site A2", status: "active", today: { labourPresent: 0, checkedIn: 0 }, openPOs: 0, monthSpendPaise: 0 },
    ]);

    const engineer = await api().get("/api/v1/dashboard").set(auth(w.tokens.engineerA));
    expect(engineer.body.sites).toHaveLength(1);
    expect(engineer.body.sites[0]).toMatchObject({ id: w.siteA1.id, monthSpendPaise: 400000 });

    const supervisor = await api().get("/api/v1/dashboard").set(auth(w.tokens.supervisorA));
    expect(supervisor.body.sites).toEqual([
      { id: w.siteA1.id, name: "Site A1", status: "active", today: { labourPresent: 1, checkedIn: 1 }, openPOs: 2 },
    ]);

    const other = await api().get("/api/v1/dashboard").set(auth(w.tokens.ownerB));
    expect(other.body.sites.map((s: { id: string }) => s.id)).toEqual([w.siteB1.id]);
  });
});

describe("site dashboard", () => {
  it("shows today, purchasing, finance, stock and a 6-month series to engineers", async () => {
    const { w, partial } = await seed();
    // two months ago: wages only — older months stay zero
    await AttendanceEntry.create({
      orgId: w.orgA._id,
      siteId: w.siteA1._id,
      labourId: w.ownerA._id,
      date: monthsAgo(2).add(4, "day").format("YYYY-MM-DD"),
      status: "present",
      shifts: 1,
      wageRatePaise: 80000,
      wagePaise: 80000,
      markedBy: w.ownerA._id,
    });
    const res = await api().get(sitePath(w.siteA1._id, "/dashboard")).set(auth(w.tokens.engineerA));
    expect(res.status).toBe(200);
    expect(res.body.today).toMatchObject({ date: today(), labourPresent: 1, labourAbsent: 1, shifts: 1.5, wagesPaise: 142500 });
    expect(res.body.today.checkedIn).toEqual([{ userId: w.supervisorA.id, name: w.supervisorA.name, at: expect.any(String) }]);
    expect(res.body.purchasing.openPOs).toBe(2);
    expect(res.body.purchasing.partiallyReceived).toBe(1);
    expect(res.body.purchasing.awaitingDelivery).toHaveLength(2);
    expect(res.body.purchasing.awaitingDelivery).toContainEqual({
      id: partial.id,
      number: partial.number,
      vendorName: "Sri Balaji Traders",
      pendingLines: 1,
    });
    expect(res.body.finance).toEqual({ vendorPayablePaise: 300000, clientReceivedPaise: 500000, monthPaymentsOutPaise: 100000 });
    expect(res.body.stock).toEqual({ items: 1, valuePaise: 400000 });

    const months = [5, 4, 3, 2, 1, 0].map((n) => monthsAgo(n).format("YYYY-MM"));
    expect(res.body.series.map((m: { month: string }) => m.month)).toEqual(months);
    expect(res.body.series[5]).toEqual({
      month: months[5],
      materialSpendPaise: 400000,
      wagesPaise: 142500,
      paymentsOutPaise: 100000,
      paymentsInPaise: 500000,
    });
    expect(res.body.series[3]).toEqual({ month: months[3], materialSpendPaise: 0, wagesPaise: 80000, paymentsOutPaise: 0, paymentsInPaise: 0 });
    expect(res.body.series[0]).toEqual({ month: months[0], materialSpendPaise: 0, wagesPaise: 0, paymentsOutPaise: 0, paymentsInPaise: 0 });
  });

  it("omits money for supervisors and hides other orgs' sites", async () => {
    const { w } = await seed();
    const res = await api().get(sitePath(w.siteA1._id, "/dashboard")).set(auth(w.tokens.supervisorA));
    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty("finance");
    expect(res.body).not.toHaveProperty("series");
    expect(res.body.today).not.toHaveProperty("wagesPaise");
    expect(res.body.today).toMatchObject({ labourPresent: 1, shifts: 1.5 });
    expect(res.body.stock).toEqual({ items: 1 });
    expect(res.body.purchasing.openPOs).toBe(2);

    expect((await api().get(sitePath(w.siteA1._id, "/dashboard")).set(auth(w.tokens.ownerB))).status).toBe(404);
    expect((await api().get(sitePath(w.siteA2._id, "/dashboard")).set(auth(w.tokens.engineerA))).status).toBe(404);
  });

  it("an empty site has zeros, not errors", async () => {
    const w = await world();
    const res = await api().get(sitePath(w.siteA2._id, "/dashboard")).set(auth(w.tokens.ownerA));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      today: { labourPresent: 0, labourAbsent: 0, shifts: 0, wagesPaise: 0, checkedIn: [] },
      purchasing: { openPOs: 0, partiallyReceived: 0, awaitingDelivery: [] },
      finance: { vendorPayablePaise: 0, clientReceivedPaise: 0, monthPaymentsOutPaise: 0 },
      stock: { items: 0, valuePaise: 0 },
    });
    expect(res.body.series).toHaveLength(6);
  });
});
