import { describe, expect, it } from "vitest";
import { StockMovement } from "@/modules/inventory/models";
import { api, auth, sitePath, useDatabase, world } from "./helpers";

useDatabase();

/** Org A with cement received on site A1: 10 bags @ ₹400 and 10 bags @ ₹420 (avg ₹410). */
async function stocked() {
  const w = await world();
  const t = w.tokens.ownerA;
  const vendor = await api().post(sitePath(w.siteA1._id, "/parties")).set(auth(t)).send({ kind: "vendor", name: "Ganesh Hardware", phone: "9840123457" });
  const cement = await api().post("/api/v1/products").set(auth(t)).send({ name: "PPC cement", unit: "bag", category: "Cement", defaultTaxRateBp: 2800 });
  const sand = await api().post("/api/v1/products").set(auth(t)).send({ name: "M-sand", unit: "cu.m", category: "Aggregates" });
  const po = await api()
    .post(sitePath(w.siteA1._id, "/purchase-orders"))
    .set(auth(t))
    .send({ vendorId: vendor.body.id, date: "2026-11-01", lines: [{ productId: cement.body.id, qty: 20, unitPricePaise: 40000 }] });
  await api().post(sitePath(w.siteA1._id, `/purchase-orders/${po.body.id}/send`)).set(auth(t));
  const line = po.body.lines[0].id;
  for (const price of [40000, 42000]) {
    const gr = await api()
      .post(sitePath(w.siteA1._id, "/goods-receipts"))
      .set(auth(t))
      .send({ poId: po.body.id, date: "2026-11-02", lines: [{ poLineId: line, qty: 10, unitPricePaise: price }] });
    expect(gr.status).toBe(201);
  }
  return { w, t, cementId: cement.body.id as string, sandId: sand.body.id as string };
}

type S = Awaited<ReturnType<typeof stocked>>;
const consume = (s: S, lines: unknown[], token = s.t) =>
  api().post(sitePath(s.w.siteA1._id, "/consumptions")).set(auth(token)).send({ date: "2026-11-05", lines });
const adjust = (s: S, body: Record<string, unknown>, token = s.t) =>
  api().post(sitePath(s.w.siteA1._id, "/stock-adjustments")).set(auth(token)).send({ date: "2026-11-06", ...body });
const stockOf = async (s: S, productId: string) => {
  const res = await api().get(sitePath(s.w.siteA1._id, "/stock")).set(auth(s.t));
  return res.body.items.find((i: { productId: string }) => i.productId === productId);
};

describe("stock", () => {
  it("summarises received stock with average cost and value", async () => {
    const s = await stocked();
    const res = await api().get(sitePath(s.w.siteA1._id, "/stock")).set(auth(s.w.tokens.supervisorA));
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([
      {
        productId: s.cementId,
        productName: "PPC cement",
        unit: "bag",
        category: "Cement",
        receivedQty: 20,
        returnedQty: 0,
        consumedQty: 0,
        adjustedQty: 0,
        onHandQty: 20,
        avgCostPaise: 41000,
        valuePaise: 820000,
      },
    ]);
    expect((await api().get(sitePath(s.w.siteA1._id, "/stock?category=Aggregates")).set(auth(s.t))).body.items).toEqual([]);
    expect((await api().get(sitePath(s.w.siteA1._id, "/stock?q=ppc")).set(auth(s.t))).body.items).toHaveLength(1);
    expect((await api().get(sitePath(s.w.siteA2._id, "/stock")).set(auth(s.t))).body).toEqual({ items: [] });
  });

  it("consumption reduces on-hand at the current average cost", async () => {
    const s = await stocked();
    const res = await consume(s, [{ productId: s.cementId, qty: 7.5, usedFor: "Column C3" }], s.w.tokens.supervisorA);
    expect(res.status).toBe(201);
    expect(res.body.movements).toHaveLength(1);
    expect(res.body.movements[0]).toMatchObject({
      productId: s.cementId,
      productName: "PPC cement",
      unit: "bag",
      type: "consumption",
      qty: -7.5,
      unitCostPaise: 41000,
      sourceType: "consumption",
      notes: "Column C3",
      createdBy: { id: s.w.supervisorA._id.toHexString(), name: s.w.supervisorA.name },
    });
    expect(await stockOf(s, s.cementId)).toMatchObject({ consumedQty: 7.5, onHandQty: 12.5, valuePaise: 512500 });
  });

  it("rejects consumption beyond stock with per-line errors and writes nothing", async () => {
    const s = await stocked();
    const res = await consume(s, [
      { productId: s.cementId, qty: 15 },
      { productId: s.cementId, qty: 6 },
      { productId: s.sandId, qty: 1 },
    ]);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("INSUFFICIENT_STOCK");
    expect(res.body.errors.map((e: { path: string }) => e.path)).toEqual(["lines.0.qty", "lines.1.qty", "lines.2.qty"]);
    expect(await StockMovement.countDocuments({ orgId: s.w.orgA._id, type: "consumption" })).toBe(0);
    expect((await consume(s, [{ productId: s.w.siteA1._id.toHexString(), qty: 1 }])).status).toBe(422);
    expect((await consume(s, [])).status).toBe(422);
    expect((await consume(s, [{ productId: s.cementId, qty: -1 }])).status).toBe(422);
  });

  it("concurrent consumptions can't take stock below zero", async () => {
    const s = await stocked();
    const results = await Promise.all([consume(s, [{ productId: s.cementId, qty: 15 }]), consume(s, [{ productId: s.cementId, qty: 15 }])]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await stockOf(s, s.cementId)).toMatchObject({ onHandQty: 5 });
  });

  it("adjustments are signed, need a reason and engineer rights, and can't go below zero", async () => {
    const s = await stocked();
    expect((await adjust(s, { productId: s.cementId, qty: -2 })).status).toBe(422); // reason missing
    expect((await adjust(s, { productId: s.cementId, qty: 0, reason: "x" })).status).toBe(422);
    expect((await adjust(s, { productId: s.cementId, qty: -1, reason: "Wet bag" }, s.w.tokens.supervisorA)).status).toBe(403);
    const down = await adjust(s, { productId: s.cementId, qty: -2, reason: "Wet bags" }, s.w.tokens.engineerA);
    expect(down.status).toBe(201);
    expect(down.body).toMatchObject({ type: "adjustment", qty: -2, notes: "Wet bags", sourceType: "adjustment", unitCostPaise: 41000 });
    const tooFar = await adjust(s, { productId: s.cementId, qty: -18.001, reason: "Count" });
    expect(tooFar.status).toBe(409);
    expect(tooFar.body.code).toBe("INSUFFICIENT_STOCK");
    expect((await adjust(s, { productId: s.sandId, qty: 3, reason: "Opening stock" })).status).toBe(201);
    expect(await stockOf(s, s.cementId)).toMatchObject({ adjustedQty: -2, onHandQty: 18 });
    expect(await stockOf(s, s.sandId)).toMatchObject({ adjustedQty: 3, onHandQty: 3, avgCostPaise: 0 });
  });

  it("lists movements newest first with filters and pagination", async () => {
    const s = await stocked();
    await consume(s, [{ productId: s.cementId, qty: 1 }]);
    await adjust(s, { productId: s.sandId, qty: 3, reason: "Opening stock" });
    const all = await api().get(sitePath(s.w.siteA1._id, "/stock/movements?pageSize=2")).set(auth(s.w.tokens.supervisorA));
    expect(all.status).toBe(200);
    expect(all.body).toMatchObject({ page: 1, pageSize: 2, total: 4 });
    expect(all.body.items[0]).toMatchObject({ type: "adjustment", date: "2026-11-06", productName: "M-sand" });
    const receipts = await api().get(sitePath(s.w.siteA1._id, `/stock/movements?type=receipt&productId=${s.cementId}`)).set(auth(s.t));
    expect(receipts.body.total).toBe(2);
    expect(receipts.body.items[0].reference).toMatch(/^GR-2026-000[12]$/);
    const ranged = await api().get(sitePath(s.w.siteA1._id, "/stock/movements?from=2026-11-05&to=2026-11-05")).set(auth(s.t));
    expect(ranged.body.total).toBe(1);
    expect((await api().get(sitePath(s.w.siteA1._id, "/stock/movements?type=theft")).set(auth(s.t))).status).toBe(422);
  });

  it("is idempotent and hides other orgs' sites", async () => {
    const s = await stocked();
    const send = () =>
      api()
        .post(sitePath(s.w.siteA1._id, "/consumptions"))
        .set(auth(s.t))
        .set("Idempotency-Key", "use-1")
        .send({ date: "2026-11-05", lines: [{ productId: s.cementId, qty: 1 }] });
    const a = await send();
    await new Promise((r) => setTimeout(r, 50));
    const b = await send();
    expect(b.status).toBe(201);
    expect(b.body.movements[0].id).toBe(a.body.movements[0].id);
    expect(await stockOf(s, s.cementId)).toMatchObject({ onHandQty: 19 });

    expect((await api().get(sitePath(s.w.siteA1._id, "/stock")).set(auth(s.w.tokens.ownerB))).status).toBe(404);
    const foreign = await api()
      .post(sitePath(s.w.siteB1._id, "/consumptions"))
      .set(auth(s.w.tokens.ownerB))
      .send({ date: "2026-11-05", lines: [{ productId: s.cementId, qty: 1 }] });
    expect(foreign.status).toBe(422); // product of another org is unknown
  });
});
