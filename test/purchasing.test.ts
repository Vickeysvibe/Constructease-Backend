import { describe, expect, it } from "vitest";
import { Types } from "mongoose";
import { config } from "@/core/config";
import { drainJobs } from "@/core/jobs";
import { LedgerEntry } from "@/modules/finance/models";
import { StockMovement } from "@/modules/inventory/models";
import { Organization } from "@/modules/identity/models";
import { formatINR, renderDocumentHtml } from "@/modules/purchasing/pdf";
import { api, auth, sitePath, useDatabase, world } from "./helpers";

useDatabase();

type World = Awaited<ReturnType<typeof world>>;

async function setup() {
  const w = await world();
  const t = w.tokens.ownerA;
  const vendor = await api()
    .post(sitePath(w.siteA1._id, "/parties"))
    .set(auth(t))
    .send({ kind: "vendor", name: "Sri Balaji Traders", phone: "9840123456", gstIn: "33AABCS1429B1Z5" });
  expect(vendor.status).toBe(201);
  const cement = await api().post("/api/v1/products").set(auth(t)).send({ name: "OPC 53 cement", unit: "bag", defaultTaxRateBp: 2800 });
  const steel = await api().post("/api/v1/products").set(auth(t)).send({ name: "TMT 12mm", unit: "kg" });
  expect(cement.status).toBe(201);
  return { w, t, vendorId: vendor.body.id as string, cementId: cement.body.id as string, steelId: steel.body.id as string };
}

type S = Awaited<ReturnType<typeof setup>>;

const poBody = (s: S, extra: Record<string, unknown> = {}) => ({
  vendorId: s.vendorId,
  date: "2026-11-10",
  lines: [
    { productId: s.cementId, qty: 12.5, unitPricePaise: 41250 },
    { productId: s.steelId, qty: 100, unitPricePaise: 6500, taxRateBp: 1800 },
  ],
  ...extra,
});

async function createPO(s: S, token = s.t, extra: Record<string, unknown> = {}) {
  return api().post(sitePath(s.w.siteA1._id, "/purchase-orders")).set(auth(token)).send(poBody(s, extra));
}

async function sentPO(s: S, extra: Record<string, unknown> = {}) {
  const po = await createPO(s, s.t, extra);
  expect(po.status).toBe(201);
  const sent = await api().post(sitePath(s.w.siteA1._id, `/purchase-orders/${po.body.id}/send`)).set(auth(s.t));
  expect(sent.status).toBe(200);
  return sent.body as { id: string; number: string; lines: { id: string; productId: string }[] };
}

const receive = (s: S, poId: string, lines: unknown[], token = s.t, date = "2026-11-11") =>
  api().post(sitePath(s.w.siteA1._id, "/goods-receipts")).set(auth(token)).send({ poId, date, challanNo: "CH-1", lines });

const ret = (s: S, poId: string, lines: unknown[], token = s.t) =>
  api().post(sitePath(s.w.siteA1._id, "/purchase-returns")).set(auth(token)).send({ poId, date: "2026-11-12", reason: "Damaged", lines });

const vendorBalance = async (w: World, vendorId: string) => {
  const rows = await LedgerEntry.find({ orgId: w.orgA._id, partyId: new Types.ObjectId(vendorId) }).lean();
  return rows.reduce((s, r) => s + (r.creditPaise ?? 0) - (r.debitPaise ?? 0), 0);
};

describe("purchase orders", () => {
  it("creates a draft with a number, per-line tax and paise totals", async () => {
    const s = await setup();
    const res = await createPO(s);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ number: "PO-2026-0001", status: "draft", vendor: { id: s.vendorId, name: "Sri Balaji Traders" } });
    // 12.5 × ₹412.50 = ₹5,156.25; 28% GST = ₹1,443.75 → ₹6,600.00 ; 100 × ₹65 = ₹6,500 + 18% = ₹7,670
    expect(res.body.lines[0]).toMatchObject({ qty: 12.5, unit: "bag", taxRateBp: 2800, amountPaise: 515625, taxPaise: 144375, totalPaise: 660000, receivedQty: 0, pendingQty: 12.5 });
    expect(res.body.lines[1]).toMatchObject({ amountPaise: 650000, taxPaise: 117000, totalPaise: 767000 });
    expect(res.body).toMatchObject({ subtotalPaise: 1165625, taxPaise: 261375, totalPaise: 1427000, receipts: [], returns: [] });
    expect(res.body.orgId).toBeUndefined();
    expect(res.body._id).toBeUndefined();
  });

  it("numbers POs sequentially per org per year", async () => {
    const s = await setup();
    const a = await createPO(s);
    const b = await createPO(s);
    const c = await createPO(s, s.t, { date: "2027-01-02" });
    expect([a.body.number, b.body.number, c.body.number]).toEqual(["PO-2026-0001", "PO-2026-0002", "PO-2027-0001"]);
    // another org starts at 1
    const vB = await api().post(sitePath(s.w.siteB1._id, "/parties")).set(auth(s.w.tokens.ownerB)).send({ kind: "vendor", name: "B Vendor", phone: "9840000001" });
    const pB = await api().post("/api/v1/products").set(auth(s.w.tokens.ownerB)).send({ name: "Sand", unit: "cu.m" });
    const poB = await api()
      .post(sitePath(s.w.siteB1._id, "/purchase-orders"))
      .set(auth(s.w.tokens.ownerB))
      .send({ vendorId: vB.body.id, date: "2026-11-10", lines: [{ productId: pB.body.id, qty: 1 }] });
    expect(poB.body.number).toBe("PO-2026-0001");
  });

  it("validates input: vendor on this site, active products, unknown fields", async () => {
    const s = await setup();
    // vendor not attached to site A2
    const other = await api()
      .post(sitePath(s.w.siteA2._id, "/purchase-orders"))
      .set(auth(s.t))
      .send(poBody(s));
    expect(other.status).toBe(422);
    expect(other.body.errors[0].path).toBe("vendorId");
    // archived product
    await api().post(`/api/v1/products/${s.steelId}/archive`).set(auth(s.t));
    const archived = await createPO(s);
    expect(archived.status).toBe(422);
    expect(archived.body.errors).toEqual([{ path: "lines.1.productId", message: expect.any(String) }]);
    // unknown fields / empty lines
    const bad = await api()
      .post(sitePath(s.w.siteA1._id, "/purchase-orders"))
      .set(auth(s.t))
      .send({ ...poBody(s), status: "received" });
    expect(bad.status).toBe(422);
    expect((await createPO(s, s.t, { lines: [] })).status).toBe(422);
    expect((await createPO(s, s.t, { lines: [{ productId: s.cementId, qty: 1.2345 }] })).status).toBe(422);
  });

  it("patches only drafts; send and cancel follow the state machine", async () => {
    const s = await setup();
    const po = await createPO(s);
    const path = sitePath(s.w.siteA1._id, `/purchase-orders/${po.body.id}`);
    const patched = await api().patch(path).set(auth(s.t)).send({ notes: "Deliver before 10am", lines: [{ productId: s.cementId, qty: 10, unitPricePaise: 40000 }] });
    expect(patched.status).toBe(200);
    expect(patched.body).toMatchObject({ notes: "Deliver before 10am", totalPaise: 512000, number: "PO-2026-0001" });
    expect((await api().patch(path).set(auth(s.t)).send({ siteId: "x" })).status).toBe(422);

    expect((await api().post(`${path}/send`).set(auth(s.t))).body.status).toBe("sent");
    const late = await api().patch(path).set(auth(s.t)).send({ notes: "x" });
    expect(late.status).toBe(409);
    expect(late.body.code).toBe("INVALID_STATE");
    expect((await api().post(`${path}/send`).set(auth(s.t))).status).toBe(409);

    const cancelled = await api().post(`${path}/cancel`).set(auth(s.t)).send({ reason: "Vendor out of stock" });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body).toMatchObject({ status: "cancelled", cancelReason: "Vendor out of stock" });
    const rec = await receive(s, po.body.id, [{ poLineId: patched.body.lines[0].id, qty: 1 }]);
    expect(rec.status).toBe(409);
    expect(rec.body.code).toBe("INVALID_STATE");
  });

  it("can't cancel once goods are received", async () => {
    const s = await setup();
    const po = await sentPO(s);
    expect((await receive(s, po.id, [{ poLineId: po.lines[0]!.id, qty: 1 }])).status).toBe(201);
    const res = await api().post(sitePath(s.w.siteA1._id, `/purchase-orders/${po.id}/cancel`)).set(auth(s.t)).send({});
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("INVALID_STATE");
  });

  it("lists with filters and summaries", async () => {
    const s = await setup();
    await createPO(s);
    const sent = await sentPO(s, { date: "2026-11-01" });
    const list = await api().get(sitePath(s.w.siteA1._id, "/purchase-orders?status=sent")).set(auth(s.w.tokens.supervisorA));
    expect(list.status).toBe(200);
    expect(list.body).toMatchObject({ total: 1, page: 1, pageSize: 25 });
    expect(list.body.items[0]).toMatchObject({ id: sent.id, lineCount: 2 });
    expect(list.body.items[0].lines).toBeUndefined();
    const byDate = await api().get(sitePath(s.w.siteA1._id, "/purchase-orders?from=2026-11-05&to=2026-11-30")).set(auth(s.t));
    expect(byDate.body.total).toBe(1);
    const byQ = await api().get(sitePath(s.w.siteA1._id, "/purchase-orders?q=balaji")).set(auth(s.t));
    expect(byQ.body.total).toBe(2);
    const empty = await api().get(sitePath(s.w.siteA2._id, "/purchase-orders")).set(auth(s.t));
    expect(empty.body).toMatchObject({ items: [], total: 0 });
  });

  it("permissions: supervisors read and receive but can't create POs or returns", async () => {
    const s = await setup();
    const sup = s.w.tokens.supervisorA;
    expect((await createPO(s, sup)).status).toBe(403);
    expect((await createPO(s, s.w.tokens.engineerA)).status).toBe(201);
    const po = await sentPO(s);
    expect((await api().get(sitePath(s.w.siteA1._id, `/purchase-orders/${po.id}`)).set(auth(sup))).status).toBe(200);
    expect((await receive(s, po.id, [{ poLineId: po.lines[0]!.id, qty: 2 }], sup)).status).toBe(201);
    expect((await ret(s, po.id, [{ poLineId: po.lines[0]!.id, qty: 1 }], sup)).status).toBe(403);
    expect((await api().post(sitePath(s.w.siteA1._id, `/purchase-orders/${po.id}/cancel`)).set(auth(sup))).status).toBe(403);
  });

  it("other org's or other site's ids are 404", async () => {
    const s = await setup();
    const po = await sentPO(s);
    expect((await api().get(sitePath(s.w.siteA2._id, `/purchase-orders/${po.id}`)).set(auth(s.t))).status).toBe(404);
    expect((await api().get(sitePath(s.w.siteB1._id, `/purchase-orders/${po.id}`)).set(auth(s.w.tokens.ownerB))).status).toBe(404);
    expect((await api().get(sitePath(s.w.siteA1._id, `/purchase-orders/${po.id}`)).set(auth(s.w.tokens.ownerB))).status).toBe(404);
    // receipt against a PO of another site
    const rec = await api()
      .post(sitePath(s.w.siteA2._id, "/goods-receipts"))
      .set(auth(s.t))
      .send({ poId: po.id, date: "2026-11-11", lines: [{ poLineId: po.lines[0]!.id, qty: 1 }] });
    expect(rec.status).toBe(404);
    const gr = await receive(s, po.id, [{ poLineId: po.lines[0]!.id, qty: 1 }]);
    expect((await api().get(sitePath(s.w.siteA2._id, `/goods-receipts/${gr.body.id}`)).set(auth(s.t))).status).toBe(404);
    expect((await api().get(sitePath(s.w.siteB1._id, `/goods-receipts/${gr.body.id}`)).set(auth(s.w.tokens.ownerB))).status).toBe(404);
  });

  it("is idempotent: the same key twice creates one PO", async () => {
    const s = await setup();
    const send = () =>
      api().post(sitePath(s.w.siteA1._id, "/purchase-orders")).set(auth(s.t)).set("Idempotency-Key", "po-key-1").send(poBody(s));
    const a = await send();
    await new Promise((r) => setTimeout(r, 50)); // response bookkeeping is written just after the reply
    const b = await send();
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(b.body.id).toBe(a.body.id);
    const list = await api().get(sitePath(s.w.siteA1._id, "/purchase-orders")).set(auth(s.t));
    expect(list.body.total).toBe(1);
  });
});

describe("goods receipts", () => {
  it("partial then full receipt moves status, stock, ledger and received value", async () => {
    const s = await setup();
    const po = await sentPO(s);
    const cement = po.lines[0]!;
    const steel = po.lines[1]!;
    const first = await receive(s, po.id, [{ poLineId: cement.id, qty: 5 }]);
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({
      number: "GR-2026-0001",
      poNumber: po.number,
      vendor: { id: s.vendorId },
      challanNo: "CH-1",
      // 5 × 412.50 = 2062.50 + 28% (577.50) = 2640.00
      subtotalPaise: 206250,
      taxPaise: 57750,
      totalPaise: 264000,
      createdBy: { id: s.w.ownerA._id.toHexString() },
    });
    let detail = await api().get(sitePath(s.w.siteA1._id, `/purchase-orders/${po.id}`)).set(auth(s.t));
    expect(detail.body.status).toBe("partially_received");
    expect(detail.body.lines[0]).toMatchObject({ receivedQty: 5, pendingQty: 7.5 });
    expect(detail.body.receivedValuePaise).toBe(264000);
    expect(detail.body.receipts).toEqual([{ id: first.body.id, number: "GR-2026-0001", date: "2026-11-11", totalPaise: 264000 }]);

    const second = await receive(s, po.id, [
      { poLineId: cement.id, qty: 7.5 },
      { poLineId: steel.id, qty: 100, unitPricePaise: 6000 }, // vendor billed lower
    ]);
    expect(second.status).toBe(201);
    expect(second.body.number).toBe("GR-2026-0002");
    expect(second.body.lines[1]).toMatchObject({ unitPricePaise: 6000, taxRateBp: 1800, amountPaise: 600000, taxPaise: 108000, totalPaise: 708000 });
    detail = await api().get(sitePath(s.w.siteA1._id, `/purchase-orders/${po.id}`)).set(auth(s.t));
    expect(detail.body.status).toBe("received");
    expect(detail.body.lines.map((l: { pendingQty: number }) => l.pendingQty)).toEqual([0, 0]);

    // 7.5 × 412.50 = 3093.75 + 28% 866.25 = 3960.00 ; + 7080.00
    expect(await vendorBalance(s.w, s.vendorId)).toBe(264000 + 396000 + 708000);
    const moves = await StockMovement.find({ orgId: s.w.orgA._id, sourceType: "goods_receipt" }).lean();
    expect(moves).toHaveLength(3);
    expect(moves.find((m) => m.unitCostPaise === 6000)?.qtyMilli).toBe(100_000);

    // no more receipts against a received PO
    const more = await receive(s, po.id, [{ poLineId: cement.id, qty: 1 }]);
    expect(more.status).toBe(409);
  });

  it("rejects over-receipt with per-line errors, drafts, and foreign lines", async () => {
    const s = await setup();
    const draft = await createPO(s);
    const onDraft = await receive(s, draft.body.id, [{ poLineId: draft.body.lines[0].id, qty: 1 }]);
    expect(onDraft.status).toBe(409);
    expect(onDraft.body.code).toBe("INVALID_STATE");

    const po = await sentPO(s);
    const over = await receive(s, po.id, [
      { poLineId: po.lines[0]!.id, qty: 5 },
      { poLineId: po.lines[1]!.id, qty: 100.001 },
    ]);
    expect(over.status).toBe(409);
    expect(over.body.code).toBe("INVALID_STATE");
    expect(over.body.errors).toEqual([{ path: "lines.1.qty", message: expect.stringContaining("100") }]);
    // nothing was written
    expect(await StockMovement.countDocuments({ orgId: s.w.orgA._id })).toBe(0);
    expect(await vendorBalance(s.w, s.vendorId)).toBe(0);

    const foreign = await receive(s, po.id, [{ poLineId: draft.body.lines[0].id, qty: 1 }]);
    expect(foreign.status).toBe(422);
    expect(foreign.body.errors[0].path).toBe("lines.0.poLineId");
    const dup = await receive(s, po.id, [
      { poLineId: po.lines[0]!.id, qty: 1 },
      { poLineId: po.lines[0]!.id, qty: 1 },
    ]);
    expect(dup.status).toBe(422);
  });

  it("two concurrent receipts can't exceed the ordered quantity", async () => {
    const s = await setup();
    const po = await sentPO(s);
    const line = po.lines[0]!.id;
    const results = await Promise.all([
      receive(s, po.id, [{ poLineId: line, qty: 10 }]),
      receive(s, po.id, [{ poLineId: line, qty: 10 }]),
    ]);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([201, 409]);
    const detail = await api().get(sitePath(s.w.siteA1._id, `/purchase-orders/${po.id}`)).set(auth(s.t));
    expect(detail.body.lines[0]).toMatchObject({ receivedQty: 10, pendingQty: 2.5 });
    const moves = await StockMovement.find({ orgId: s.w.orgA._id }).lean();
    expect(moves.reduce((a, m) => a + m.qtyMilli, 0)).toBe(10_000);
  });

  it("lists receipts by PO", async () => {
    const s = await setup();
    const po = await sentPO(s);
    await receive(s, po.id, [{ poLineId: po.lines[0]!.id, qty: 1 }]);
    const res = await api().get(sitePath(s.w.siteA1._id, `/goods-receipts?poId=${po.id}`)).set(auth(s.w.tokens.supervisorA));
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.items[0]).toMatchObject({ poNumber: po.number, lineCount: 1 });
  });
});

describe("purchase returns", () => {
  it("prices at the weighted average receipt price and debits the vendor", async () => {
    const s = await setup();
    const po = await sentPO(s);
    const steel = po.lines[1]!.id;
    await receive(s, po.id, [{ poLineId: steel, qty: 40, unitPricePaise: 6000 }]);
    await receive(s, po.id, [{ poLineId: steel, qty: 60, unitPricePaise: 7000 }]);
    // avg = (40×60 + 60×70) / 100 = ₹66.00
    const before = await vendorBalance(s.w, s.vendorId);
    const res = await ret(s, po.id, [{ poLineId: steel, qty: 10 }]);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ number: "PR-2026-0001", reason: "Damaged", poNumber: po.number });
    expect(res.body.lines[0]).toMatchObject({ qty: 10, unitPricePaise: 6600, taxRateBp: 1800, amountPaise: 66000, taxPaise: 11880, totalPaise: 77880 });
    expect(await vendorBalance(s.w, s.vendorId)).toBe(before - 77880);
    const detail = await api().get(sitePath(s.w.siteA1._id, `/purchase-orders/${po.id}`)).set(auth(s.t));
    expect(detail.body.lines[1]).toMatchObject({ receivedQty: 100, returnedQty: 10, pendingQty: 0 });
    expect(detail.body.status).toBe("partially_received"); // cement still pending
    expect(detail.body.returns).toHaveLength(1);
    const stock = await api().get(sitePath(s.w.siteA1._id, "/stock")).set(auth(s.t));
    expect(stock.body.items.find((i: { productId: string }) => i.productId === s.steelId)).toMatchObject({ receivedQty: 100, returnedQty: 10, onHandQty: 90 });
  });

  it("never re-opens a received PO", async () => {
    const s = await setup();
    const po = await sentPO(s);
    await receive(s, po.id, [
      { poLineId: po.lines[0]!.id, qty: 12.5 },
      { poLineId: po.lines[1]!.id, qty: 100 },
    ]);
    expect((await ret(s, po.id, [{ poLineId: po.lines[0]!.id, qty: 2.5 }])).status).toBe(201);
    const detail = await api().get(sitePath(s.w.siteA1._id, `/purchase-orders/${po.id}`)).set(auth(s.t));
    expect(detail.body.status).toBe("received");
    expect(detail.body.lines[0]).toMatchObject({ receivedQty: 12.5, returnedQty: 2.5, pendingQty: 0 });
  });

  it("rejects returning more than received or more than on hand", async () => {
    const s = await setup();
    const po = await sentPO(s);
    const cement = po.lines[0]!.id;
    await receive(s, po.id, [{ poLineId: cement, qty: 10 }]);
    const tooMany = await ret(s, po.id, [{ poLineId: cement, qty: 10.5 }]);
    expect(tooMany.status).toBe(409);
    expect(tooMany.body.code).toBe("INSUFFICIENT_STOCK");
    expect(tooMany.body.errors[0].path).toBe("lines.0.qty");

    // consume 8 → only 2 on hand although 10 were received on this PO
    const used = await api()
      .post(sitePath(s.w.siteA1._id, "/consumptions"))
      .set(auth(s.t))
      .send({ date: "2026-11-11", lines: [{ productId: s.cementId, qty: 8, usedFor: "Footing" }] });
    expect(used.status).toBe(201);
    const noStock = await ret(s, po.id, [{ poLineId: cement, qty: 3 }]);
    expect(noStock.status).toBe(409);
    expect(noStock.body.code).toBe("INSUFFICIENT_STOCK");
    expect(noStock.body.errors[0]).toMatchObject({ path: "lines.0.qty", message: expect.stringContaining("in stock") });
    expect((await ret(s, po.id, [{ poLineId: cement, qty: 2 }])).status).toBe(201);
    expect((await ret(s, po.id, [{ poLineId: cement, qty: 0.001 }])).status).toBe(409);
  });
});

describe("PDFs", () => {
  it("renders escaped, numbered HTML with Indian money formatting", async () => {
    const s = await setup();
    await Organization.updateOne({ _id: s.w.orgA._id }, { $set: { gstIn: "33AAACA1234A1Z5", logoUrl: "javascript:alert(1)" } });
    const po = await createPO(s, s.t, { notes: "<script>alert(1)</script>", lines: [{ productId: s.cementId, qty: 1000, unitPricePaise: 12345678 }] });
    for (const template of ["classic", "compact", "detailed"]) {
      const out = await renderDocumentHtml(s.w.orgA._id, "po", po.body.id, template);
      expect(out!.filename).toBe("PO-2026-0001.pdf");
      expect(out!.html).toContain("Acme Builders");
      expect(out!.html).toContain("Sri Balaji Traders");
      expect(out!.html).toContain("₹12,34,56,780.00"); // 1000 × ₹1,23,456.78
      expect(out!.html).not.toContain("<script>alert(1)</script>");
      expect(out!.html).not.toContain("javascript:");
      expect(out!.html).toMatch(/<td>1<\/td>/);
    }
    const classic = await renderDocumentHtml(s.w.orgA._id, "po", po.body.id, "classic");
    expect(classic!.html).toContain("&lt;script&gt;");
    expect(classic!.html).toContain("33AAACA1234A1Z5");
    expect(await renderDocumentHtml(s.w.orgB._id, "po", po.body.id)).toBeNull();
  });

  it("formats rupees with Indian grouping", () => {
    expect(formatINR(0)).toBe("₹0.00");
    expect(formatINR(41250)).toBe("₹412.50");
    expect(formatINR(12345678901)).toBe("₹12,34,56,789.01");
    expect(formatINR(-100000)).toBe("-₹1,000.00");
  });

  it("enqueues a job that fails cleanly when no browser is configured", async () => {
    const s = await setup();
    const saved = { ws: config.PDF_BROWSER_WS_ENDPOINT, chrome: config.CHROME_PATH };
    config.PDF_BROWSER_WS_ENDPOINT = "";
    config.CHROME_PATH = "";
    try {
      const po = await sentPO(s);
      const res = await api().post(sitePath(s.w.siteA1._id, `/purchase-orders/${po.id}/pdf`)).set(auth(s.w.tokens.supervisorA)).send({ template: "compact" });
      expect(res.status).toBe(202);
      expect(res.body.jobId).toBeTruthy();
      expect((await api().post(sitePath(s.w.siteA1._id, `/purchase-orders/${po.id}/pdf`)).set(auth(s.t)).send({ template: "fancy" })).status).toBe(422);
      expect((await api().post(sitePath(s.w.siteA2._id, `/purchase-orders/${po.id}/pdf`)).set(auth(s.t)).send({})).status).toBe(404);
      await drainJobs();
      const job = await api().get(`/api/v1/jobs/${res.body.jobId}`).set(auth(s.t));
      expect(job.body.status).toBe("failed");
      expect(job.body.error).toMatch(/not configured/);

      await receive(s, po.id, [{ poLineId: po.lines[0]!.id, qty: 2 }]);
      const pr = await ret(s, po.id, [{ poLineId: po.lines[0]!.id, qty: 1 }]);
      const html = await renderDocumentHtml(s.w.orgA._id, "return", pr.body.id, "classic");
      expect(html!.filename).toBe("PR-2026-0001.pdf");
      expect(html!.html).toContain(po.number);
      expect((await api().post(sitePath(s.w.siteA1._id, `/purchase-returns/${pr.body.id}/pdf`)).set(auth(s.t)).send({})).status).toBe(202);
    } finally {
      config.PDF_BROWSER_WS_ENDPOINT = saved.ws;
      config.CHROME_PATH = saved.chrome;
    }
  });
});
