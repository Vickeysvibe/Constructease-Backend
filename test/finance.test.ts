import { describe, expect, it } from "vitest";
import { Types } from "mongoose";
import { AuditEntry } from "@/core/records";
import { LedgerEntry, Payment, postLedger } from "@/modules/finance/models";
import { Party, nameKeyOf } from "@/modules/parties/models";
import { api, auth, sitePath, useDatabase, world } from "./helpers";

useDatabase();

type World = Awaited<ReturnType<typeof world>>;

async function party(orgId: Types.ObjectId, siteIds: Types.ObjectId[], kind: "vendor" | "client" | "labour", name: string) {
  return Party.create({
    orgId,
    kind,
    name,
    nameKey: nameKeyOf(name),
    phone: `98${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`,
    ...(kind === "labour" ? { category: "Mason", wageRatePaise: 95000 } : {}),
    siteIds,
  });
}

/** Simulates a goods receipt (vendor credit) the purchasing module would post. */
const receipt = (w: World, siteId: Types.ObjectId, partyId: Types.ObjectId, date: string, creditPaise: number) =>
  postLedger([
    {
      orgId: w.orgA._id,
      siteId,
      partyId,
      date,
      sourceType: "goods_receipt",
      sourceId: new Types.ObjectId(),
      reference: "GR-2026-0001",
      description: "Cement",
      creditPaise,
      createdBy: w.ownerA._id,
    },
  ]);

const pay = (token: string, siteId: Types.ObjectId, body: object, key?: string) => {
  const req = api().post(sitePath(siteId, "/payments")).set(auth(token));
  if (key) req.set("Idempotency-Key", key);
  return req.send(body);
};
const ledger = (token: string, siteId: Types.ObjectId, partyId: Types.ObjectId | string, qs = "") =>
  api().get(sitePath(siteId, `/parties/${String(partyId)}/ledger${qs}`)).set(auth(token));

describe("payments", () => {
  it("creates a vendor payment that debits the vendor ledger", async () => {
    const w = await world();
    const v = await party(w.orgA._id, [w.siteA1._id], "vendor", "Sri Balaji Traders");
    const res = await pay(w.tokens.engineerA, w.siteA1._id, {
      date: "2026-11-05",
      direction: "out",
      category: "vendor",
      partyId: v.id,
      amountPaise: 2500000,
      method: "bank",
      reference: "UTR123",
      quantity: 12.5,
      unit: "bag",
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      siteId: w.siteA1.id,
      party: { id: v.id, name: "Sri Balaji Traders", kind: "vendor" },
      amountPaise: 2500000,
      quantity: 12.5,
      status: "posted",
      createdBy: { id: w.engineerA.id, name: w.engineerA.name },
    });
    expect(res.body).not.toHaveProperty("orgId");
    const entries = await LedgerEntry.find({ orgId: w.orgA._id }).lean();
    expect(entries).toEqual([expect.objectContaining({ debitPaise: 2500000, creditPaise: 0, sourceType: "payment", reference: "UTR123" })]);
    expect(await AuditEntry.countDocuments({ orgId: w.orgA._id, action: "payment.create" })).toBe(1);

    const one = await api().get(sitePath(w.siteA1._id, `/payments/${res.body.id}`)).set(auth(w.tokens.engineerA));
    expect(one.body.id).toBe(res.body.id);
  });

  it("client receipts credit the ledger; labour and other payments post nothing", async () => {
    const w = await world();
    const c = await party(w.orgA._id, [w.siteA1._id], "client", "Lakshmi Residency");
    const l = await party(w.orgA._id, [w.siteA1._id], "labour", "Ravi K");
    await pay(w.tokens.ownerA, w.siteA1._id, { date: "2026-11-01", direction: "in", category: "client", partyId: c.id, amountPaise: 1000000 }).expect(201);
    await pay(w.tokens.ownerA, w.siteA1._id, { date: "2026-11-01", direction: "out", category: "labour", partyId: l.id, amountPaise: 95000 }).expect(201);
    await pay(w.tokens.ownerA, w.siteA1._id, { date: "2026-11-01", direction: "out", category: "other", amountPaise: 5000, description: "Tea" }).expect(201);
    const entries = await LedgerEntry.find({ orgId: w.orgA._id }).lean();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ partyId: c._id, creditPaise: 1000000, debitPaise: 0 });
  });

  it("validates the party per category and the amount", async () => {
    const w = await world();
    const v = await party(w.orgA._id, [w.siteA1._id], "vendor", "Vendor One");
    const c = await party(w.orgA._id, [w.siteA1._id], "client", "Client One");
    const v2 = await party(w.orgA._id, [w.siteA2._id], "vendor", "Vendor Two");
    const foreign = await party(w.orgB._id, [w.siteB1._id], "vendor", "Foreign");
    const base = { date: "2026-11-01", direction: "out", amountPaise: 1000 };
    const cases: [object, string][] = [
      [{ category: "vendor" }, "partyId"],
      [{ category: "client" }, "partyId"],
      [{ category: "labour" }, "partyId"],
      [{ category: "vendor", partyId: c.id }, "partyId"], // wrong kind
      [{ category: "vendor", partyId: v2.id }, "partyId"], // not on this site
      [{ category: "vendor", partyId: foreign.id }, "partyId"], // other org
      [{ category: "other", partyId: v.id }, "partyId"],
      [{ category: "vendor", partyId: v.id, amountPaise: 0 }, "amountPaise"],
      [{ category: "vendor", partyId: v.id, amountPaise: -5 }, "amountPaise"],
      [{ category: "vendor", partyId: v.id, amountPaise: 10.5 }, "amountPaise"],
      [{ category: "vendor", partyId: v.id, date: "2026-02-30" }, "date"],
      [{ category: "vendor", partyId: v.id, status: "void" }, ""],
    ];
    for (const [extra, path] of cases) {
      const res = await pay(w.tokens.ownerA, w.siteA1._id, { ...base, ...extra });
      expect(res.status, JSON.stringify(extra)).toBe(422);
      expect(res.body.errors.map((e: { path: string }) => e.path), JSON.stringify(extra)).toContain(path);
    }
    expect(await Payment.countDocuments({ orgId: w.orgA._id })).toBe(0);
  });

  it("filters the list", async () => {
    const w = await world();
    const v = await party(w.orgA._id, [w.siteA1._id], "vendor", "Vendor One");
    const c = await party(w.orgA._id, [w.siteA1._id], "client", "Client One");
    await pay(w.tokens.ownerA, w.siteA1._id, { date: "2026-10-01", direction: "out", category: "vendor", partyId: v.id, amountPaise: 100 });
    await pay(w.tokens.ownerA, w.siteA1._id, { date: "2026-11-01", direction: "in", category: "client", partyId: c.id, amountPaise: 200 });
    await pay(w.tokens.ownerA, w.siteA1._id, { date: "2026-11-02", direction: "out", category: "other", amountPaise: 300 });
    await pay(w.tokens.ownerA, w.siteA2._id, { date: "2026-11-02", direction: "out", category: "other", amountPaise: 400 });

    const list = (qs: string) => api().get(sitePath(w.siteA1._id, `/payments${qs}`)).set(auth(w.tokens.engineerA));
    const all = await list("");
    expect(all.body.total).toBe(3);
    expect(all.body.items.map((p: { amountPaise: number }) => p.amountPaise)).toEqual([300, 200, 100]); // newest first
    expect((await list("?direction=in")).body.items.map((p: { amountPaise: number }) => p.amountPaise)).toEqual([200]);
    expect((await list("?category=vendor")).body.total).toBe(1);
    expect((await list(`?partyId=${c.id}`)).body.total).toBe(1);
    expect((await list("?from=2026-11-01&to=2026-11-01")).body.total).toBe(1);
    expect((await list("?sort=amountPaise")).body.items[0].amountPaise).toBe(100);
    expect((await list("?from=2026-11-02&to=2026-11-01")).status).toBe(422);
  });

  it("editing re-posts the ledger entry with a reversal, audited", async () => {
    const w = await world();
    const v = await party(w.orgA._id, [w.siteA1._id], "vendor", "Vendor One");
    await receipt(w, w.siteA1._id, v._id, "2026-11-01", 5000000);
    const p = await pay(w.tokens.ownerA, w.siteA1._id, {
      date: "2026-11-02",
      direction: "out",
      category: "vendor",
      partyId: v.id,
      amountPaise: 2000000,
      reference: "CHQ-1",
    });
    const patched = await api()
      .patch(sitePath(w.siteA1._id, `/payments/${p.body.id}`))
      .set(auth(w.tokens.engineerA))
      .send({ amountPaise: 3000000, reference: null });
    expect(patched.status).toBe(200);
    expect(patched.body).toMatchObject({ amountPaise: 3000000, status: "posted" });
    expect(patched.body.reference).toBeUndefined();

    const l = await ledger(w.tokens.engineerA, w.siteA1._id, v._id, "?from=2026-11-01&to=2026-11-30");
    expect(l.body.entries.map((e: { debitPaise: number; creditPaise: number }) => [e.creditPaise, e.debitPaise])).toEqual([
      [5000000, 0], // receipt
      [0, 2000000], // original payment
      [2000000, 0], // reversal
      [0, 3000000], // re-posted
    ]);
    expect(l.body.closingBalancePaise).toBe(2000000); // still owe ₹20,000
    expect(await AuditEntry.countDocuments({ orgId: w.orgA._id, action: "payment.update" })).toBe(1);

    // a ledger-neutral edit (method) doesn't touch the ledger
    await api().patch(sitePath(w.siteA1._id, `/payments/${p.body.id}`)).set(auth(w.tokens.ownerA)).send({ method: "upi" }).expect(200);
    expect(await LedgerEntry.countDocuments({ orgId: w.orgA._id })).toBe(4);

    // switching to `other` needs the party cleared, then reverses the vendor posting
    const bad = await api().patch(sitePath(w.siteA1._id, `/payments/${p.body.id}`)).set(auth(w.tokens.ownerA)).send({ category: "other" });
    expect(bad.status).toBe(422);
    const other = await api()
      .patch(sitePath(w.siteA1._id, `/payments/${p.body.id}`))
      .set(auth(w.tokens.ownerA))
      .send({ category: "other", partyId: null });
    expect(other.status).toBe(200);
    expect(other.body.party).toBeUndefined();
    const after = await ledger(w.tokens.ownerA, w.siteA1._id, v._id, "?from=2026-11-01&to=2026-11-30");
    expect(after.body.closingBalancePaise).toBe(5000000);

    // mass assignment is refused
    const sneaky = await api().patch(sitePath(w.siteA1._id, `/payments/${p.body.id}`)).set(auth(w.tokens.ownerA)).send({ status: "void" });
    expect(sneaky.status).toBe(422);
  });

  it("voiding reverses the ledger entry once", async () => {
    const w = await world();
    const v = await party(w.orgA._id, [w.siteA1._id], "vendor", "Vendor One");
    await receipt(w, w.siteA1._id, v._id, "2026-11-01", 5000000);
    const p = await pay(w.tokens.ownerA, w.siteA1._id, { date: "2026-11-02", direction: "out", category: "vendor", partyId: v.id, amountPaise: 2000000 });
    const path = sitePath(w.siteA1._id, `/payments/${p.body.id}/void`);
    expect((await api().post(path).set(auth(w.tokens.ownerA)).send({})).status).toBe(422);
    const voided = await api().post(path).set(auth(w.tokens.ownerA)).send({ reason: "Entered twice" });
    expect(voided.status).toBe(200);
    expect(voided.body).toMatchObject({ status: "void", voidReason: "Entered twice" });
    const again = await api().post(path).set(auth(w.tokens.ownerA)).send({ reason: "again" });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe("INVALID_STATE");
    const edit = await api().patch(sitePath(w.siteA1._id, `/payments/${p.body.id}`)).set(auth(w.tokens.ownerA)).send({ amountPaise: 5 });
    expect(edit.status).toBe(409);

    const l = await ledger(w.tokens.ownerA, w.siteA1._id, v._id, "?from=2026-11-01&to=2026-11-30");
    expect(l.body.entries).toHaveLength(3);
    expect(l.body.closingBalancePaise).toBe(5000000);
    expect(await AuditEntry.countDocuments({ orgId: w.orgA._id, action: "payment.void" })).toBe(1);
    // void payments still appear in the list, filterable
    const list = await api().get(sitePath(w.siteA1._id, "/payments?status=void")).set(auth(w.tokens.ownerA));
    expect(list.body.total).toBe(1);
  });

  it("replays a create with the same Idempotency-Key", async () => {
    const w = await world();
    const body = { date: "2026-11-01", direction: "out", category: "other", amountPaise: 5000 };
    const a = await pay(w.tokens.ownerA, w.siteA1._id, body, "pay-123");
    const b = await pay(w.tokens.ownerA, w.siteA1._id, body, "pay-123");
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(b.body.id).toBe(a.body.id);
    expect(await Payment.countDocuments({ orgId: w.orgA._id })).toBe(1);
    // a failed request releases the key
    const bad = await pay(w.tokens.ownerA, w.siteA1._id, { ...body, amountPaise: 0 }, "pay-456");
    expect(bad.status).toBe(422);
    expect((await pay(w.tokens.ownerA, w.siteA1._id, body, "pay-456")).status).toBe(201);
  });

  it("supervisors can't use finance; other orgs get 404", async () => {
    const w = await world();
    const v = await party(w.orgA._id, [w.siteA1._id], "vendor", "Vendor One");
    const p = await pay(w.tokens.ownerA, w.siteA1._id, { date: "2026-11-01", direction: "out", category: "other", amountPaise: 5000 });
    const sup = w.tokens.supervisorA;
    expect((await api().get(sitePath(w.siteA1._id, "/payments")).set(auth(sup))).status).toBe(403);
    expect((await pay(sup, w.siteA1._id, { date: "2026-11-01", direction: "out", category: "other", amountPaise: 5000 })).status).toBe(403);
    expect((await api().get(sitePath(w.siteA1._id, `/payments/${p.body.id}`)).set(auth(sup))).status).toBe(403);
    expect((await api().post(sitePath(w.siteA1._id, `/payments/${p.body.id}/void`)).set(auth(sup)).send({ reason: "x" })).status).toBe(403);
    expect((await ledger(sup, w.siteA1._id, v._id)).status).toBe(403);

    expect((await api().get(sitePath(w.siteA1._id, "/payments")).set(auth(w.tokens.ownerB))).status).toBe(404);
    // org B's own site can't reach org A's payment or vendor
    expect((await api().get(sitePath(w.siteB1._id, `/payments/${p.body.id}`)).set(auth(w.tokens.ownerB))).status).toBe(404);
    expect((await ledger(w.tokens.ownerB, w.siteB1._id, v._id)).status).toBe(404);
    // and a payment from site A1 isn't reachable through site A2
    expect((await api().get(sitePath(w.siteA2._id, `/payments/${p.body.id}`)).set(auth(w.tokens.ownerA))).status).toBe(404);
  });
});

describe("org-level payments", () => {
  it("are owner/admin only, have no site and accept any org party", async () => {
    const w = await world();
    const v = await party(w.orgA._id, [], "vendor", "Auditor & Co");
    const body = { date: "2026-11-01", direction: "out", category: "vendor", partyId: v.id, amountPaise: 1500000 };
    expect((await api().post("/api/v1/payments").set(auth(w.tokens.engineerA)).send(body)).status).toBe(403);
    expect((await api().get("/api/v1/payments").set(auth(w.tokens.engineerA))).status).toBe(403);
    const created = await api().post("/api/v1/payments").set(auth(w.tokens.ownerA)).send(body);
    expect(created.status).toBe(201);
    expect(created.body.siteId).toBeNull();
    await pay(w.tokens.ownerA, w.siteA1._id, { date: "2026-11-01", direction: "out", category: "other", amountPaise: 5000 }).expect(201);

    const list = await api().get("/api/v1/payments").set(auth(w.tokens.ownerA));
    expect(list.body.total).toBe(1);
    expect(list.body.items[0].id).toBe(created.body.id);
    expect((await api().get("/api/v1/payments").set(auth(w.tokens.ownerB))).body.total).toBe(0);

    const foreign = await party(w.orgB._id, [], "vendor", "Foreign");
    const res = await api().post("/api/v1/payments").set(auth(w.tokens.ownerA)).send({ ...body, partyId: foreign.id });
    expect(res.status).toBe(422);

    const voided = await api().post(`/api/v1/payments/${created.body.id}/void`).set(auth(w.tokens.ownerA)).send({ reason: "dup" });
    expect(voided.body.status).toBe("void");
    expect(await LedgerEntry.countDocuments({ orgId: w.orgA._id, siteId: null })).toBe(2);
  });
});

describe("party ledger", () => {
  it("computes opening, running and closing balances for this vendor on this site only", async () => {
    const w = await world();
    const v = await party(w.orgA._id, [w.siteA1._id, w.siteA2._id], "vendor", "Vendor One");
    const other = await party(w.orgA._id, [w.siteA1._id], "vendor", "Vendor Two");
    // before the range: receipt 50,000 − payment 20,000 → opening 30,000
    await receipt(w, w.siteA1._id, v._id, "2026-10-10", 5000000);
    await pay(w.tokens.ownerA, w.siteA1._id, { date: "2026-10-20", direction: "out", category: "vendor", partyId: v.id, amountPaise: 2000000 }).expect(201);
    // noise that must not leak in: another vendor, the same vendor on another site, an org-level payment
    await receipt(w, w.siteA1._id, other._id, "2026-10-15", 9900000);
    await receipt(w, w.siteA2._id, v._id, "2026-10-15", 7700000);
    await receipt(w, w.siteA2._id, v._id, "2026-11-03", 7700000);
    await api()
      .post("/api/v1/payments")
      .set(auth(w.tokens.ownerA))
      .send({ date: "2026-11-03", direction: "out", category: "vendor", partyId: v.id, amountPaise: 100 })
      .expect(201);
    // in range
    await receipt(w, w.siteA1._id, v._id, "2026-11-02", 1000000);
    await pay(w.tokens.ownerA, w.siteA1._id, { date: "2026-11-01", direction: "out", category: "vendor", partyId: v.id, amountPaise: 500000, reference: "UPI-9" }).expect(201);
    // after the range
    await receipt(w, w.siteA1._id, v._id, "2026-12-01", 1234500);

    const res = await ledger(w.tokens.engineerA, w.siteA1._id, v._id, "?from=2026-11-01&to=2026-11-30");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      party: { id: v.id, name: "Vendor One", kind: "vendor" },
      from: "2026-11-01",
      to: "2026-11-30",
      openingBalancePaise: 3000000,
      closingBalancePaise: 3500000,
    });
    expect(res.body.entries).toEqual([
      expect.objectContaining({ date: "2026-11-01", sourceType: "payment", reference: "UPI-9", debitPaise: 500000, creditPaise: 0, balancePaise: 2500000 }),
      expect.objectContaining({ date: "2026-11-02", sourceType: "goods_receipt", debitPaise: 0, creditPaise: 1000000, balancePaise: 3500000 }),
    ]);
  });

  it("defaults to the financial year and handles clients", async () => {
    const w = await world();
    const c = await party(w.orgA._id, [w.siteA1._id], "client", "Client One");
    await pay(w.tokens.ownerA, w.siteA1._id, { date: "2026-03-31", direction: "in", category: "client", partyId: c.id, amountPaise: 100000 }).expect(201);
    await pay(w.tokens.ownerA, w.siteA1._id, { date: "2026-04-01", direction: "in", category: "client", partyId: c.id, amountPaise: 200000 }).expect(201);
    await pay(w.tokens.ownerA, w.siteA1._id, { date: "2026-04-02", direction: "out", category: "client", partyId: c.id, amountPaise: 50000 }).expect(201);
    const res = await ledger(w.tokens.ownerA, w.siteA1._id, c._id, "?to=2026-11-11");
    expect(res.body).toMatchObject({ from: "2026-04-01", openingBalancePaise: 100000, closingBalancePaise: 250000 });
    expect(res.body.entries).toHaveLength(2);
  });

  it("is only for vendors and clients attached to the site", async () => {
    const w = await world();
    const l = await party(w.orgA._id, [w.siteA1._id], "labour", "Ravi K");
    const v2 = await party(w.orgA._id, [w.siteA2._id], "vendor", "Elsewhere");
    const lab = await ledger(w.tokens.ownerA, w.siteA1._id, l._id);
    expect(lab.status).toBe(409);
    expect(lab.body.code).toBe("INVALID_STATE");
    expect((await ledger(w.tokens.ownerA, w.siteA1._id, v2._id)).status).toBe(404);
    expect((await ledger(w.tokens.ownerA, w.siteA1._id, new Types.ObjectId())).status).toBe(404);
    expect((await ledger(w.tokens.ownerA, w.siteA2._id, v2._id, "?from=2026-11-02&to=2026-11-01")).status).toBe(422);
  });
});
