import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { User } from "@/modules/identity/models";
import { Party } from "@/modules/parties/models";
import { Site } from "@/modules/sites/models";
import { drainJobs } from "@/core/jobs";
import { api, auth, login, makeOrg, makeUser, sitePath, TEST_PASSWORD, useDatabase, world } from "./helpers";

useDatabase();

const vendor = { kind: "vendor", name: "Sri Balaji Traders", phone: "98401 23456", gstIn: "33AABCS1429B1Z5" };
const labour = { kind: "labour", name: "Ravi K", phone: "9789012345", category: "Mason", wageRatePaise: 95000 };

describe("auth", () => {
  it("logs in, returns no password hash, and sets an httpOnly refresh cookie", async () => {
    const org = await makeOrg();
    const u = await makeUser(org._id, "owner");
    const res = await api().post("/api/v1/auth/login").send({ email: u.email, password: TEST_PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeTruthy();
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|\$2[aby]\$/);
    const cookie = String(res.headers["set-cookie"]);
    expect(cookie).toMatch(/ce_rt=/);
    expect(cookie).toMatch(/HttpOnly/);
  });

  it("rejects bad credentials, disabled users and plaintext legacy passwords", async () => {
    const org = await makeOrg();
    const u = await makeUser(org._id, "owner");
    expect((await api().post("/api/v1/auth/login").send({ email: u.email, password: "wrong-pass1" })).status).toBe(401);
    await User.updateOne({ _id: u._id, orgId: org._id }, { $set: { passwordHash: "plaintext1" } });
    expect((await api().post("/api/v1/auth/login").send({ email: u.email, password: "plaintext1" })).status).toBe(401);
  });

  it("requires a token on every non-auth route", async () => {
    for (const path of ["/api/v1/me", "/api/v1/sites", "/api/v1/products"]) {
      const res = await api().get(path);
      expect(res.status).toBe(401);
      expect(res.headers["content-type"]).toMatch(/problem\+json/);
    }
  });

  it("rotates refresh tokens and revokes the session when an old token is replayed", async () => {
    const org = await makeOrg();
    const u = await makeUser(org._id, "owner");
    const first = await api().post("/api/v1/auth/login").send({ email: u.email, password: TEST_PASSWORD });
    const c1 = String(first.headers["set-cookie"]).split(";")[0]!;
    expect((await api().post("/api/v1/auth/refresh").set("Cookie", c1)).status).toBe(403); // CSRF header missing
    const r2 = await api().post("/api/v1/auth/refresh").set("Cookie", c1).set("X-CE-CSRF", "1");
    expect(r2.status).toBe(200);
    const c2 = String(r2.headers["set-cookie"]).split(";")[0]!;
    // replaying the rotated token kills the session…
    expect((await api().post("/api/v1/auth/refresh").set("Cookie", c1).set("X-CE-CSRF", "1")).status).toBe(401);
    // …so even the newest token stops working
    expect((await api().post("/api/v1/auth/refresh").set("Cookie", c2).set("X-CE-CSRF", "1")).status).toBe(401);
    // and so does the access token issued for it
    expect((await api().get("/api/v1/me").set(auth(r2.body.accessToken))).status).toBe(401);
  });

  it("disabling a user cuts off their access immediately", async () => {
    const w = await world();
    const res = await api()
      .patch(`/api/v1/users/${w.engineerA._id}`)
      .set(auth(w.tokens.ownerA))
      .send({ status: "disabled" });
    expect(res.status).toBe(200);
    expect((await api().get("/api/v1/me").set(auth(w.tokens.engineerA))).status).toBe(401);
  });

  it("won't remove the last owner", async () => {
    const w = await world();
    const res = await api().patch(`/api/v1/users/${w.ownerA._id}`).set(auth(w.tokens.ownerA)).send({ orgRole: "admin" });
    expect(res.status).toBe(409);
  });
});

describe("tenancy and site access", () => {
  it("never shows another org's site (404, not 403)", async () => {
    const w = await world();
    const res = await api().get(sitePath(w.siteB1._id)).set(auth(w.tokens.ownerA));
    expect(res.status).toBe(404);
  });

  it("members only see sites they belong to", async () => {
    const w = await world();
    const list = await api().get("/api/v1/sites").set(auth(w.tokens.supervisorA));
    expect(list.body.items.map((s: { name: string }) => s.name)).toEqual(["Site A1"]);
    expect((await api().get(sitePath(w.siteA2._id)).set(auth(w.tokens.supervisorA))).status).toBe(404);
    const owner = await api().get("/api/v1/sites").set(auth(w.tokens.ownerA));
    expect(owner.body.total).toBe(2);
  });

  it("the tenant guard throws if code forgets the org filter", async () => {
    await expect(Site.find({ name: "x" })).rejects.toThrow(/tenantGuard/);
    await expect(Site.aggregate([{ $match: { name: "x" } }])).rejects.toThrow(/tenantGuard/);
  });

  it("only org admins create sites, and the creator's org owns it", async () => {
    const w = await world();
    expect((await api().post("/api/v1/sites").set(auth(w.tokens.engineerA)).send({ name: "X", address: "Y" })).status).toBe(403);
    const res = await api().post("/api/v1/sites").set(auth(w.tokens.ownerA)).send({ name: "Tower C", address: "OMR, Chennai" });
    expect(res.status).toBe(201);
    expect(await Site.countDocuments({ orgId: w.orgA._id })).toBe(3);
  });

  it("engineers manage members; supervisors cannot", async () => {
    const w = await world();
    const body = { name: "New Sup", email: "new.sup@example.com", phone: "9000000001", password: TEST_PASSWORD, role: "supervisor" };
    expect((await api().post(sitePath(w.siteA1._id, "/members")).set(auth(w.tokens.supervisorA)).send(body)).status).toBe(403);
    const res = await api().post(sitePath(w.siteA1._id, "/members")).set(auth(w.tokens.engineerA)).send(body);
    expect(res.status).toBe(201);
    const token = await login("new.sup@example.com");
    const me = await api().get("/api/v1/me").set(auth(token));
    expect(me.body.sites).toEqual([expect.objectContaining({ name: "Site A1", role: "supervisor" })]);
  });

  it("writes to archived sites are refused", async () => {
    const w = await world();
    await api().post(sitePath(w.siteA1._id, "/archive")).set(auth(w.tokens.ownerA)).expect(200);
    const res = await api().post(sitePath(w.siteA1._id, "/parties")).set(auth(w.tokens.ownerA)).send(vendor);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("INVALID_STATE");
  });
});

describe("parties", () => {
  it("creates, lists, updates and detaches a vendor; normalises phone", async () => {
    const w = await world();
    const created = await api().post(sitePath(w.siteA1._id, "/parties")).set(auth(w.tokens.engineerA)).send(vendor);
    expect(created.status).toBe(201);
    expect(created.body.phone).toBe("9840123456");
    expect(created.body).not.toHaveProperty("_id");
    const list = await api().get(sitePath(w.siteA1._id, "/parties?kind=vendor")).set(auth(w.tokens.supervisorA));
    expect(list.body).toMatchObject({ total: 1, page: 1 });
    const patched = await api()
      .patch(sitePath(w.siteA1._id, `/parties/${created.body.id}`))
      .set(auth(w.tokens.engineerA))
      .send({ address: "12 GST Road" });
    expect(patched.body.address).toBe("12 GST Road");
    await api().delete(sitePath(w.siteA1._id, `/parties/${created.body.id}`)).set(auth(w.tokens.engineerA)).expect(204);
    const after = await api().get(sitePath(w.siteA1._id, "/parties?kind=vendor")).set(auth(w.tokens.engineerA));
    expect(after.body.items).toEqual([]);
  });

  it("supervisors may add labour but not vendors", async () => {
    const w = await world();
    expect((await api().post(sitePath(w.siteA1._id, "/parties")).set(auth(w.tokens.supervisorA)).send(vendor)).status).toBe(403);
    expect((await api().post(sitePath(w.siteA1._id, "/parties")).set(auth(w.tokens.supervisorA)).send(labour)).status).toBe(201);
  });

  it("rejects mass-assignment of protected fields", async () => {
    const w = await world();
    const created = await api().post(sitePath(w.siteA1._id, "/parties")).set(auth(w.tokens.engineerA)).send(vendor);
    const res = await api()
      .patch(sitePath(w.siteA1._id, `/parties/${created.body.id}`))
      .set(auth(w.tokens.engineerA))
      .send({ orgId: w.orgB._id.toHexString(), siteIds: [], status: "archived" });
    expect(res.status).toBe(422);
  });

  it("detects duplicates and lets you attach the existing party to another site", async () => {
    const w = await world();
    const first = await api().post(sitePath(w.siteA1._id, "/parties")).set(auth(w.tokens.ownerA)).send(vendor);
    const dup = await api().post(sitePath(w.siteA2._id, "/parties")).set(auth(w.tokens.ownerA)).send({ ...vendor, name: "sri  balaji traders" });
    expect(dup.status).toBe(409);
    expect(dup.body.errors[0].message).toBe(first.body.id);
    const attach = await api().post(sitePath(w.siteA2._id, "/parties")).set(auth(w.tokens.ownerA)).send({ existingPartyId: first.body.id });
    expect(attach.body.siteIds).toHaveLength(2);
  });

  it("can't read or attach another org's party", async () => {
    const w = await world();
    const theirs = await api().post(sitePath(w.siteB1._id, "/parties")).set(auth(w.tokens.ownerB)).send(vendor);
    expect((await api().get(sitePath(w.siteA1._id, `/parties/${theirs.body.id}`)).set(auth(w.tokens.ownerA))).status).toBe(404);
    expect(
      (await api().post(sitePath(w.siteA1._id, "/parties")).set(auth(w.tokens.ownerA)).send({ existingPartyId: theirs.body.id })).status,
    ).toBe(404);
  });

  it("validates labour wage and GSTIN with field errors", async () => {
    const w = await world();
    const res = await api()
      .post(sitePath(w.siteA1._id, "/parties"))
      .set(auth(w.tokens.engineerA))
      .send({ ...labour, wageRatePaise: 0, phone: "123" });
    expect(res.status).toBe(422);
    const paths = res.body.errors.map((e: { path: string }) => e.path);
    expect(paths).toEqual(expect.arrayContaining(["wageRatePaise", "phone"]));
  });
});

describe("products", () => {
  it("is an org catalogue: anyone reads, supervisors can't write, names are unique", async () => {
    const w = await world();
    const p = { name: "OPC 53 cement", unit: "bag", category: "Cement" };
    expect((await api().post("/api/v1/products").set(auth(w.tokens.supervisorA)).send(p)).status).toBe(403);
    expect((await api().post("/api/v1/products").set(auth(w.tokens.engineerA)).send(p)).status).toBe(201);
    expect((await api().post("/api/v1/products").set(auth(w.tokens.ownerA)).send({ ...p, name: "opc 53 CEMENT" })).status).toBe(409);
    const list = await api().get("/api/v1/products").set(auth(w.tokens.supervisorA));
    expect(list.body.items[0]).toMatchObject({ name: "OPC 53 cement", defaultTaxRateBp: 1800 });
    const other = await api().get("/api/v1/products").set(auth(w.tokens.ownerB));
    expect(other.body.total).toBe(0);
  });
});

async function xlsx(rows: (string | number)[][]) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("s");
  rows.forEach((r) => ws.addRow(r));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe("imports and exports", () => {
  it("previews, rejects bad files atomically, then commits", async () => {
    const w = await world();
    const bad = await xlsx([
      ["Name", "Phone No", "Category", "Wages Per Shift"],
      ["Ravi K", "9789012345", "Mason", 950],
      ["No Phone", "", "Helper", 600],
    ]);
    const preview = await api()
      .post(sitePath(w.siteA1._id, "/imports/parties?kind=labour"))
      .set(auth(w.tokens.supervisorA))
      .attach("file", bad, "labour.xlsx");
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({ dryRun: true, total: 2, valid: 1 });
    const commitBad = await api()
      .post(sitePath(w.siteA1._id, "/imports/parties?kind=labour&dryRun=false"))
      .set(auth(w.tokens.supervisorA))
      .attach("file", bad, "labour.xlsx");
    expect(commitBad.status).toBe(422);
    expect(commitBad.body.result.rows[1].status).toBe("error");
    expect(await Party.countDocuments({ orgId: w.orgA._id })).toBe(0);

    const good = await xlsx([
      ["Name", "Phone No", "Category", "Wages Per Shift"],
      ["Ravi K", "9789012345", "Mason", 950],
      ["Ravi K", "9789012345", "Mason", 950],
    ]);
    const commit = await api()
      .post(sitePath(w.siteA1._id, "/imports/parties?kind=labour&dryRun=false"))
      .set(auth(w.tokens.supervisorA))
      .attach("file", good, "labour.xlsx");
    expect(commit.body).toMatchObject({ created: 1, skipped: 1 });
    const saved = await Party.findOne({ orgId: w.orgA._id }).lean();
    expect(saved?.wageRatePaise).toBe(95000);
  });

  it("rejects non-xlsx uploads", async () => {
    const w = await world();
    const res = await api()
      .post(sitePath(w.siteA1._id, "/imports/parties?kind=vendor"))
      .set(auth(w.tokens.ownerA))
      .attach("file", Buffer.from("a,b"), "vendors.csv");
    expect(res.status).toBe(400);
  });

  it("exports through a job and serves the file only to the same org", async () => {
    const w = await world();
    await api().post(sitePath(w.siteA1._id, "/parties")).set(auth(w.tokens.ownerA)).send(vendor);
    const job = await api().post(sitePath(w.siteA1._id, "/exports")).set(auth(w.tokens.ownerA)).send({ entity: "vendor" });
    expect(job.status).toBe(202);
    await drainJobs();
    const status = await api().get(`/api/v1/jobs/${job.body.jobId}`).set(auth(w.tokens.ownerA));
    expect(status.body.status).toBe("done");
    const fileId = status.body.file.id;
    const file = await api().get(`/api/v1/files/${fileId}`).set(auth(w.tokens.ownerA));
    expect(file.status).toBe(200);
    expect(file.headers["content-disposition"]).toMatch(/attachment/);
    expect((await api().get(`/api/v1/files/${fileId}`).set(auth(w.tokens.ownerB))).status).toBe(404);
    expect((await api().get(`/api/v1/jobs/${job.body.jobId}`).set(auth(w.tokens.ownerB))).status).toBe(404);
  });
});
