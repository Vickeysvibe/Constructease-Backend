import { afterEach, describe, expect, it, vi } from "vitest";
import type { Types } from "mongoose";
import { config } from "@/core/config";
import { drainJobs, Job } from "@/core/jobs";
import { addDays, todayIn } from "@/core/units";
import { Party, nameKeyOf } from "@/modules/parties/models";
import { AttendanceEntry, CheckinDay } from "@/modules/workforce/models";
import { checkinTotals } from "@/modules/workforce/service";
import { api, auth, sitePath, useDatabase, world } from "./helpers";

useDatabase();

const today = () => todayIn("Asia/Kolkata");

async function labour(
  orgId: Types.ObjectId,
  siteIds: Types.ObjectId[],
  name: string,
  extra: Partial<{ category: string; wageRatePaise: number; phone: string; status: string; kind: string }> = {},
) {
  return Party.create({
    orgId,
    kind: extra.kind ?? "labour",
    name,
    nameKey: nameKeyOf(name),
    phone: extra.phone ?? `97${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`,
    category: extra.category ?? "Mason",
    wageRatePaise: extra.wageRatePaise ?? 95000,
    siteIds,
    status: extra.status ?? "active",
  });
}

const put = (token: string, siteId: Types.ObjectId, body: object) =>
  api().put(sitePath(siteId, "/attendance")).set(auth(token)).send(body);
const sheet = (token: string, siteId: Types.ObjectId, date = today()) =>
  api().get(sitePath(siteId, `/attendance?date=${date}`)).set(auth(token));

describe("attendance", () => {
  it("lists the site's active labour, saves a day and computes the summary", async () => {
    const w = await world();
    const ravi = await labour(w.orgA._id, [w.siteA1._id], "Ravi K", { category: "Mason", wageRatePaise: 95000 });
    const mani = await labour(w.orgA._id, [w.siteA1._id], "Mani S", { category: "Helper", wageRatePaise: 60000 });
    const babu = await labour(w.orgA._id, [w.siteA1._id], "Babu R", { category: "Helper", wageRatePaise: 60000 });
    await labour(w.orgA._id, [w.siteA1._id], "Old Timer", { status: "archived" });
    await labour(w.orgA._id, [w.siteA2._id], "Elsewhere");

    const empty = await sheet(w.tokens.supervisorA, w.siteA1._id);
    expect(empty.status).toBe(200);
    expect(empty.body.rows.map((r: { name: string }) => r.name)).toEqual(["Babu R", "Mani S", "Ravi K"]);
    expect(empty.body.rows.every((r: { entry: unknown }) => r.entry === null)).toBe(true);
    expect(empty.body).toMatchObject({ editable: true, summary: { present: 0, absent: 0, unmarked: 3 } });

    const res = await put(w.tokens.supervisorA, w.siteA1._id, {
      date: today(),
      entries: [
        { labourId: ravi.id, status: "present", shifts: 1.5 },
        { labourId: mani.id, status: "present" },
        { labourId: babu.id, status: "absent" },
      ],
    });
    expect(res.status).toBe(200);
    const row = (name: string) => res.body.rows.find((r: { name: string }) => r.name === name);
    // 1.5 shifts × ₹950 = ₹1,425
    expect(row("Ravi K").entry).toMatchObject({ status: "present", shifts: 1.5, wageRatePaise: 95000, wagePaise: 142500 });
    expect(row("Mani S").entry).toMatchObject({ shifts: 1, wagePaise: 60000 });
    expect(row("Babu R").entry).toMatchObject({ status: "absent", shifts: 0, wagePaise: 0 });
    expect(res.body.summary).toEqual({
      present: 2,
      absent: 1,
      unmarked: 0,
      shifts: 2.5,
      wagesPaise: 202500,
      byCategory: [
        { category: "Helper", present: 1, shifts: 1 },
        { category: "Mason", present: 1, shifts: 1.5 },
      ],
    });

    // re-saving updates in place
    const again = await put(w.tokens.supervisorA, w.siteA1._id, {
      date: today(),
      entries: [{ labourId: babu.id, status: "present", shifts: 0.5 }],
    });
    expect(again.body.summary).toMatchObject({ present: 3, absent: 0, shifts: 3, wagesPaise: 232500 });
    expect(await AttendanceEntry.countDocuments({ orgId: w.orgA._id })).toBe(3);
  });

  it("validates shifts and status combinations", async () => {
    const w = await world();
    const ravi = await labour(w.orgA._id, [w.siteA1._id], "Ravi K");
    for (const entry of [
      { labourId: ravi.id, status: "present", shifts: 1.25 },
      { labourId: ravi.id, status: "present", shifts: 3.5 },
      { labourId: ravi.id, status: "present", shifts: 0 },
      { labourId: ravi.id, status: "absent", shifts: 1 },
      { labourId: ravi.id, status: "late" },
    ]) {
      const res = await put(w.tokens.engineerA, w.siteA1._id, { date: today(), entries: [entry] });
      expect(res.status, JSON.stringify(entry)).toBe(422);
      expect(res.body.errors[0].path).toMatch(/^entries\.0\./);
    }
    const dup = await put(w.tokens.engineerA, w.siteA1._id, {
      date: today(),
      entries: [
        { labourId: ravi.id, status: "present" },
        { labourId: ravi.id, status: "absent" },
      ],
    });
    expect(dup.status).toBe(422);
    expect(dup.body.errors[0].path).toBe("entries.1.labourId");
  });

  it("keeps the wage-rate snapshot after a rate change until an engineer refreshes it", async () => {
    const w = await world();
    const ravi = await labour(w.orgA._id, [w.siteA1._id], "Ravi K", { wageRatePaise: 95000 });
    await put(w.tokens.engineerA, w.siteA1._id, { date: today(), entries: [{ labourId: ravi.id, status: "present" }] }).expect(200);
    await api()
      .patch(sitePath(w.siteA1._id, `/parties/${ravi.id}`))
      .set(auth(w.tokens.engineerA))
      .send({ wageRatePaise: 100000 })
      .expect(200);

    const after = await sheet(w.tokens.engineerA, w.siteA1._id);
    expect(after.body.rows[0].wageRatePaise).toBe(100000);
    expect(after.body.rows[0].entry).toMatchObject({ wageRatePaise: 95000, wagePaise: 95000 });

    const edited = await put(w.tokens.engineerA, w.siteA1._id, {
      date: today(),
      entries: [{ labourId: ravi.id, status: "present", shifts: 2 }],
    });
    expect(edited.body.rows[0].entry).toMatchObject({ shifts: 2, wageRatePaise: 95000, wagePaise: 190000 });

    const supRefresh = await put(w.tokens.supervisorA, w.siteA1._id, {
      date: today(),
      refreshRates: true,
      entries: [{ labourId: ravi.id, status: "present", shifts: 2 }],
    });
    expect(supRefresh.status).toBe(403);

    const refreshed = await put(w.tokens.engineerA, w.siteA1._id, {
      date: today(),
      refreshRates: true,
      entries: [{ labourId: ravi.id, status: "present", shifts: 2 }],
    });
    expect(refreshed.body.rows[0].entry).toMatchObject({ wageRatePaise: 100000, wagePaise: 200000 });
  });

  it("supervisors write only today and yesterday; nobody writes the future", async () => {
    const w = await world();
    const ravi = await labour(w.orgA._id, [w.siteA1._id], "Ravi K");
    const entries = [{ labourId: ravi.id, status: "present" }];
    const threeDaysAgo = addDays(today(), -3);

    expect((await put(w.tokens.supervisorA, w.siteA1._id, { date: threeDaysAgo, entries })).status).toBe(403);
    expect((await sheet(w.tokens.supervisorA, w.siteA1._id, threeDaysAgo)).body.editable).toBe(false);
    expect((await sheet(w.tokens.engineerA, w.siteA1._id, threeDaysAgo)).body.editable).toBe(true);
    expect((await put(w.tokens.supervisorA, w.siteA1._id, { date: today(), entries })).status).toBe(200);
    expect((await put(w.tokens.supervisorA, w.siteA1._id, { date: addDays(today(), -1), entries })).status).toBe(200);
    expect((await put(w.tokens.engineerA, w.siteA1._id, { date: threeDaysAgo, entries })).status).toBe(200);

    const future = await put(w.tokens.ownerA, w.siteA1._id, { date: addDays(today(), 1), entries });
    expect(future.status).toBe(422);
    expect(future.body.errors[0].path).toBe("date");
    expect((await sheet(w.tokens.ownerA, w.siteA1._id, addDays(today(), 1))).body.editable).toBe(false);
  });

  it("a labourer can't be present on two sites the same day", async () => {
    const w = await world();
    const ravi = await labour(w.orgA._id, [w.siteA1._id, w.siteA2._id], "Ravi K");
    const mani = await labour(w.orgA._id, [w.siteA1._id, w.siteA2._id], "Mani S");
    await put(w.tokens.ownerA, w.siteA1._id, { date: today(), entries: [{ labourId: ravi.id, status: "present" }] }).expect(200);

    const res = await put(w.tokens.ownerA, w.siteA2._id, {
      date: today(),
      entries: [
        { labourId: mani.id, status: "present" },
        { labourId: ravi.id, status: "present" },
      ],
    });
    expect(res.status).toBe(409);
    expect(res.body.errors).toEqual([{ path: "entries.1.labourId", message: expect.stringContaining("Site A1") }]);
    // nothing from the rejected request was written
    expect(await AttendanceEntry.countDocuments({ orgId: w.orgA._id, siteId: w.siteA2._id })).toBe(0);

    // marking them absent on the second site is fine, and so is another day
    await put(w.tokens.ownerA, w.siteA2._id, { date: today(), entries: [{ labourId: ravi.id, status: "absent" }] }).expect(200);
    await put(w.tokens.ownerA, w.siteA2._id, { date: addDays(today(), -1), entries: [{ labourId: ravi.id, status: "present" }] }).expect(200);
  });

  it("rejects labour that isn't an active labourer on this site", async () => {
    const w = await world();
    const otherSite = await labour(w.orgA._id, [w.siteA2._id], "Elsewhere");
    const archived = await labour(w.orgA._id, [w.siteA1._id], "Gone", { status: "archived" });
    const vendor = await labour(w.orgA._id, [w.siteA1._id], "A Vendor", { kind: "vendor" });
    const foreign = await labour(w.orgB._id, [w.siteB1._id], "Other Org");
    const res = await put(w.tokens.ownerA, w.siteA1._id, {
      date: today(),
      entries: [otherSite, archived, vendor, foreign].map((p) => ({ labourId: p.id, status: "present" })),
    });
    expect(res.status).toBe(422);
    expect(res.body.errors.map((e: { path: string }) => e.path)).toEqual([
      "entries.0.labourId",
      "entries.1.labourId",
      "entries.2.labourId",
      "entries.3.labourId",
    ]);
  });

  it("hides other orgs' sites and refuses mass assignment", async () => {
    const w = await world();
    expect((await sheet(w.tokens.ownerB, w.siteA1._id)).status).toBe(404);
    expect((await sheet(w.tokens.supervisorA, w.siteA2._id)).status).toBe(404);
    const ravi = await labour(w.orgA._id, [w.siteA1._id], "Ravi K");
    const res = await put(w.tokens.ownerA, w.siteA1._id, {
      date: today(),
      entries: [{ labourId: ravi.id, status: "present", wageRatePaise: 1 }],
    });
    expect(res.status).toBe(422);
  });

  it("keeps a detached labourer's entry on the sheet", async () => {
    const w = await world();
    const ravi = await labour(w.orgA._id, [w.siteA1._id], "Ravi K");
    await put(w.tokens.ownerA, w.siteA1._id, { date: today(), entries: [{ labourId: ravi.id, status: "present" }] }).expect(200);
    await api().delete(sitePath(w.siteA1._id, `/parties/${ravi.id}`)).set(auth(w.tokens.ownerA)).expect(204);
    const res = await sheet(w.tokens.ownerA, w.siteA1._id);
    expect(res.body.rows).toHaveLength(1);
    expect(res.body.summary.wagesPaise).toBe(95000);
  });
});

describe("check-ins", () => {
  const point = { lat: 13.0827, lng: 80.2707, accuracyM: 12 };
  const checkin = (token: string, siteId: Types.ObjectId, type: "in" | "out", body: object = point) =>
    api().post(sitePath(siteId, "/checkins")).set(auth(token)).send({ type, ...body });

  afterEach(() => {
    config.GEOCODER_URL = "";
    vi.restoreAllMocks();
  });

  it("alternates in and out and totals the worked minutes", async () => {
    const w = await world();
    expect((await checkin(w.tokens.supervisorA, w.siteA1._id, "out")).status).toBe(409);
    const first = await checkin(w.tokens.supervisorA, w.siteA1._id, "in");
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ date: today(), user: { id: w.supervisorA.id, name: w.supervisorA.name }, workedMinutes: 0 });
    expect(first.body.firstIn).toBe(first.body.events[0].at);
    expect(first.body.lastOut).toBeUndefined();
    expect((await checkin(w.tokens.supervisorA, w.siteA1._id, "in")).status).toBe(409);

    // pretend the check-in happened 90 minutes ago
    const day = await CheckinDay.findOne({ orgId: w.orgA._id, userId: w.supervisorA._id }).lean();
    const ninetyMinAgo = new Date(Date.now() - 90 * 60_000);
    await CheckinDay.updateOne({ _id: day!._id, orgId: w.orgA._id }, { $set: { "events.0.at": ninetyMinAgo } });

    const out = await checkin(w.tokens.supervisorA, w.siteA1._id, "out");
    expect(out.status).toBe(201);
    expect(out.body.events.map((e: { type: string }) => e.type)).toEqual(["in", "out"]);
    expect(out.body.workedMinutes).toBeGreaterThanOrEqual(90);
    expect(out.body.workedMinutes).toBeLessThan(92);
    expect(out.body.lastOut).toBe(out.body.events[1].at);
    expect((await checkin(w.tokens.supervisorA, w.siteA1._id, "in")).status).toBe(201);
  });

  it("totals only closed in/out pairs", () => {
    const t = (m: number) => new Date(Date.UTC(2026, 10, 11, 3, m));
    const totals = checkinTotals([
      { type: "in", at: t(0) },
      { type: "out", at: t(45) },
      { type: "in", at: t(50) },
      { type: "out", at: t(80) },
      { type: "in", at: t(90) },
    ]);
    expect(totals).toEqual({ firstIn: t(0), lastOut: t(80), workedMinutes: 75 });
  });

  it("validates coordinates", async () => {
    const w = await world();
    const res = await checkin(w.tokens.engineerA, w.siteA1._id, "in", { lat: 91, lng: -181 });
    expect(res.status).toBe(422);
    expect(res.body.errors.map((e: { path: string }) => e.path).sort()).toEqual(["lat", "lng"]);
    expect((await checkin(w.tokens.engineerA, w.siteA1._id, "in", { lat: "13", lng: 80 })).status).toBe(422);
  });

  it("supervisors see only their own check-ins; engineers see everyone", async () => {
    const w = await world();
    await checkin(w.tokens.supervisorA, w.siteA1._id, "in").expect(201);
    await checkin(w.tokens.engineerA, w.siteA1._id, "in").expect(201);
    await checkin(w.tokens.ownerA, w.siteA1._id, "in").expect(201);

    const sup = await api().get(sitePath(w.siteA1._id, "/checkins")).set(auth(w.tokens.supervisorA));
    expect(sup.body.items.map((d: { user: { id: string } }) => d.user.id)).toEqual([w.supervisorA.id]);
    const supOther = await api()
      .get(sitePath(w.siteA1._id, `/checkins?userId=${w.engineerA.id}`))
      .set(auth(w.tokens.supervisorA));
    expect(supOther.status).toBe(403);

    const eng = await api().get(sitePath(w.siteA1._id, "/checkins")).set(auth(w.tokens.engineerA));
    expect(eng.body.items).toHaveLength(3);
    const one = await api().get(sitePath(w.siteA1._id, `/checkins?userId=${w.supervisorA.id}`)).set(auth(w.tokens.engineerA));
    expect(one.body.items).toHaveLength(1);
    expect(one.body.items[0].user.name).toBe(w.supervisorA.name);

    expect((await api().get(sitePath(w.siteA1._id, "/checkins")).set(auth(w.tokens.ownerB))).status).toBe(404);
    expect((await checkin(w.tokens.ownerB, w.siteA1._id, "in")).status).toBe(404);
  });

  it("reverse-geocodes the event address in a background job", async () => {
    const w = await world();
    config.GEOCODER_URL = "https://geo.example.test/reverse";
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ display_name: "Anna Salai, Chennai, Tamil Nadu" }), { status: 200 }));

    const res = await checkin(w.tokens.supervisorA, w.siteA1._id, "in");
    expect(res.status).toBe(201);
    expect(res.body.events[0].address).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled(); // never inside the request

    await drainJobs();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toBe("https://geo.example.test/reverse?format=jsonv2&lat=13.0827&lon=80.2707");
    expect((init?.headers as Record<string, string>)["User-Agent"]).toBe(config.GEOCODER_USER_AGENT);
    expect(init?.signal).toBeInstanceOf(AbortSignal);

    const list = await api().get(sitePath(w.siteA1._id, "/checkins")).set(auth(w.tokens.supervisorA));
    expect(list.body.items[0].events[0].address).toBe("Anna Salai, Chennai, Tamil Nadu");
  });

  it("skips geocoding when no geocoder is configured", async () => {
    const w = await world();
    config.GEOCODER_URL = "";
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await checkin(w.tokens.supervisorA, w.siteA1._id, "in").expect(201);
    expect(await Job.countDocuments({ orgId: w.orgA._id })).toBe(0);
    await drainJobs();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a failing geocoder never affects the check-in", async () => {
    const w = await world();
    config.GEOCODER_URL = "https://geo.example.test/reverse";
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));
    const res = await checkin(w.tokens.supervisorA, w.siteA1._id, "in");
    expect(res.status).toBe(201);
    await drainJobs(1);
    const job = await Job.findOne({ orgId: w.orgA._id }).lean();
    expect(job).toMatchObject({ type: "workforce.geocode", status: "queued", error: "network down" });
  });
});
