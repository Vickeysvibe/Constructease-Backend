import { describe, expect, it } from "vitest";
import { Tracker, TrackerRow } from "@/modules/worklog/models";
import { api, auth, sitePath, useDatabase, world } from "./helpers";

useDatabase();

type W = Awaited<ReturnType<typeof world>>;
type Col = { key: string; label: string; type: string; required: boolean; options: string[] };

const customTracker = {
  name: "Snags",
  columns: [
    { label: "Item", type: "text", required: true },
    { label: "Qty", type: "number" },
    { label: "Due", type: "date" },
    { label: "State", type: "status", options: ["Open", "Closed"] },
  ],
};

async function createTracker(w: W, token = w.tokens.ownerA, body: object = customTracker) {
  const res = await api().post(sitePath(w.siteA1._id, "/trackers")).set(auth(token)).send(body);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const keys = Object.fromEntries((res.body.columns as Col[]).map((c) => [c.label, c.key]));
  return { tracker: res.body as { id: string; columns: Col[] }, keys };
}

const rowsPath = (w: W, trackerId: string, rest = "") => sitePath(w.siteA1._id, `/trackers/${trackerId}/rows${rest}`);

async function addRow(w: W, trackerId: string, values: object, done = false, token = w.tokens.ownerA) {
  const res = await api().post(rowsPath(w, trackerId)).set(auth(token)).send({ values, done });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as { id: string; values: Record<string, unknown> };
}

describe("default trackers", () => {
  it("POST /sites creates To-do and Work done for the new site", async () => {
    const w = await world();
    const site = await api().post("/api/v1/sites").set(auth(w.tokens.ownerA)).send({ name: "Tower C", address: "OMR, Chennai" });
    expect(site.status).toBe(201);
    const res = await api().get(sitePath(site.body.id, "/trackers")).set(auth(w.tokens.ownerA));
    expect(res.status).toBe(200);
    expect(res.body.items.map((t: { name: string; kind: string }) => [t.name, t.kind])).toEqual([
      ["To-do", "todo"],
      ["Work done", "work"],
    ]);
    const todo = res.body.items[0];
    expect(todo.rowCount).toBe(0);
    expect(todo.columns.map((c: Col) => [c.label, c.type, c.required])).toEqual([
      ["Task", "text", true],
      ["Start date", "date", false],
      ["End date", "date", false],
      ["Status", "status", false],
    ]);
    expect(todo.columns[3].options).toEqual(["Not started", "In progress", "Done"]);
    const work = res.body.items[1];
    expect(work.columns.map((c: Col) => [c.label, c.type, c.required])).toEqual([
      ["Title", "text", true],
      ["Description", "text", false],
      ["Date", "date", true],
    ]);
    // other sites are untouched
    expect(await Tracker.countDocuments({ orgId: w.orgA._id, siteId: w.siteA1._id })).toBe(0);
  });
});

describe("trackers", () => {
  it("creates a custom tracker with server-generated keys and lists it with rowCount", async () => {
    const w = await world();
    const { tracker, keys } = await createTracker(w);
    expect(tracker).toMatchObject({ name: "Snags", kind: "custom", rowCount: 0 });
    expect(Object.values(keys).every((k) => /^c_[a-z0-9]+$/.test(k))).toBe(true);
    expect(new Set(Object.values(keys)).size).toBe(4);
    await addRow(w, tracker.id, { [keys.Item!]: "Door hinge" });
    await addRow(w, tracker.id, { [keys.Item!]: "Window seal" });
    const list = await api().get(sitePath(w.siteA1._id, "/trackers")).set(auth(w.tokens.ownerA));
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0].rowCount).toBe(2);
    expect(JSON.stringify(list.body)).not.toMatch(/orgId|_id/);
  });

  it("validates tracker input", async () => {
    const w = await world();
    const post = (body: object) => api().post(sitePath(w.siteA1._id, "/trackers")).set(auth(w.tokens.ownerA)).send(body);
    expect((await post({ name: "X", columns: [] })).status).toBe(422);
    const dupLabels = await post({ name: "X", columns: [{ label: "A", type: "text" }, { label: "a", type: "number" }] });
    expect(dupLabels.status).toBe(422);
    expect(dupLabels.body.errors[0].path).toBe("columns.1.label");
    expect((await post({ name: "X", columns: [{ label: "S", type: "status" }] })).status).toBe(422);
    expect((await post({ name: "X", columns: [{ label: "S", type: "text", options: ["a"] }] })).status).toBe(422);
    expect((await post({ name: "X", columns: [{ label: "S", type: "text", key: "c_mine" }] })).status).toBe(422);
    const many = Array.from({ length: 31 }, (_, i) => ({ label: `C${i}`, type: "text" }));
    expect((await post({ name: "X", columns: many })).status).toBe(422);
    expect((await post({ name: "X", columns: [{ label: "A", type: "text" }], orgId: w.orgB._id })).status).toBe(422);
  });

  it("adds, renames and removes columns: existing values survive, removed keys are gone", async () => {
    const w = await world();
    const { tracker, keys } = await createTracker(w);
    const row = await addRow(w, tracker.id, { [keys.Item!]: "Tiles", [keys.Qty!]: 40, [keys.Due!]: "2026-12-01" });

    const patch = await api()
      .patch(sitePath(w.siteA1._id, `/trackers/${tracker.id}`))
      .set(auth(w.tokens.ownerA))
      .send({
        name: "Snag list",
        columns: [
          { key: keys.Item, label: "Item name", type: "text", required: true }, // renamed
          { key: keys.State, label: "State", type: "status", options: ["Open", "Closed", "Blocked"] },
          { key: keys.Due, label: "Due", type: "date" },
          { label: "Owner", type: "text" }, // new; Qty removed
        ],
      });
    expect(patch.status, JSON.stringify(patch.body)).toBe(200);
    expect(patch.body.name).toBe("Snag list");
    expect(patch.body.rowCount).toBe(1);
    const cols = patch.body.columns as Col[];
    expect(cols.map((c) => c.label)).toEqual(["Item name", "State", "Due", "Owner"]);
    expect(cols[0]!.key).toBe(keys.Item);
    const ownerKey = cols[3]!.key;
    expect(Object.values(keys)).not.toContain(ownerKey);

    const rows = await api().get(rowsPath(w, tracker.id)).set(auth(w.tokens.ownerA));
    expect(rows.body.items[0].values).toEqual({ [keys.Item!]: "Tiles", [keys.Due!]: "2026-12-01" });
    const stored = await TrackerRow.findOne({ _id: row.id, orgId: w.orgA._id }).lean();
    expect(Object.keys(stored!.values as object)).not.toContain(keys.Qty);

    // the removed key is no longer accepted; the new one is
    expect((await api().post(rowsPath(w, tracker.id)).set(auth(w.tokens.ownerA)).send({ values: { [keys.Item!]: "x", [keys.Qty!]: 1 } })).status).toBe(422);
    await addRow(w, tracker.id, { [keys.Item!]: "Paint", [ownerKey]: "Ravi" });

    // unknown key in the column list
    const bad = await api()
      .patch(sitePath(w.siteA1._id, `/trackers/${tracker.id}`))
      .set(auth(w.tokens.ownerA))
      .send({ columns: [{ key: "c_nothere", label: "X", type: "text" }] });
    expect(bad.status).toBe(422);
  });

  it("blocks a type change when existing values don't fit, allows it when they do", async () => {
    const w = await world();
    const { tracker, keys } = await createTracker(w);
    await addRow(w, tracker.id, { [keys.Item!]: "12", [keys.State!]: "Open" });
    const patchCols = (columns: unknown[]) =>
      api().patch(sitePath(w.siteA1._id, `/trackers/${tracker.id}`)).set(auth(w.tokens.ownerA)).send({ columns });
    const base = [
      { key: keys.Item, label: "Item", type: "text", required: true },
      { key: keys.Qty, label: "Qty", type: "number" },
      { key: keys.Due, label: "Due", type: "date" },
      { key: keys.State, label: "State", type: "status", options: ["Open", "Closed"] },
    ];

    // text "12" → number: blocked (a string is not a number)
    const toNumber = await patchCols([{ ...base[0], type: "number" }, ...base.slice(1)]);
    expect(toNumber.status).toBe(409);
    expect(toNumber.body.errors[0].path).toBe("columns.0");
    // removing an option that is in use: blocked
    const dropOpen = await patchCols([...base.slice(0, 3), { ...base[3], options: ["Closed"] }]);
    expect(dropOpen.status).toBe(409);
    // Qty has no values → number → date is fine
    const qtyToDate = await patchCols([base[0], { ...base[1], type: "date" }, base[2], base[3]]);
    expect(qtyToDate.status).toBe(200);
    expect(qtyToDate.body.columns[1].type).toBe("date");
    // status → text: "Open" is valid text
    const stateToText = await patchCols([base[0], base[1], base[2], { key: keys.State, label: "State", type: "text" }]);
    expect(stateToText.status).toBe(200);
    expect(stateToText.body.columns[3].options).toEqual([]);

    const dupLabel = await patchCols([base[0], { ...base[1], label: "ITEM" }]);
    expect(dupLabel.status).toBe(422);
  });

  it("deletes a tracker: 409 with rows, ok with force (rows removed too)", async () => {
    const w = await world();
    const { tracker, keys } = await createTracker(w);
    await addRow(w, tracker.id, { [keys.Item!]: "A" });
    const path = sitePath(w.siteA1._id, `/trackers/${tracker.id}`);
    expect((await api().delete(path).set(auth(w.tokens.ownerA))).status).toBe(409);
    expect((await api().delete(`${path}?force=true`).set(auth(w.tokens.ownerA))).status).toBe(204);
    expect(await TrackerRow.countDocuments({ orgId: w.orgA._id, trackerId: tracker.id })).toBe(0);
    expect((await api().get(sitePath(w.siteA1._id, "/trackers")).set(auth(w.tokens.ownerA))).body.items).toEqual([]);

    const { tracker: empty } = await createTracker(w);
    expect((await api().delete(sitePath(w.siteA1._id, `/trackers/${empty.id}`)).set(auth(w.tokens.ownerA))).status).toBe(204);
  });
});

describe("rows", () => {
  it("validates values per column type, required columns and unknown keys", async () => {
    const w = await world();
    const { tracker, keys } = await createTracker(w);
    const post = (values: object) => api().post(rowsPath(w, tracker.id)).set(auth(w.tokens.ownerA)).send({ values });
    const errOf = async (values: object) => {
      const res = await post(values);
      expect(res.status).toBe(422);
      return (res.body.errors as { path: string }[]).map((e) => e.path);
    };
    expect(await errOf({})).toEqual([`values.${keys.Item}`]);
    expect(await errOf({ [keys.Item!]: "  " })).toEqual([`values.${keys.Item}`]);
    expect(await errOf({ [keys.Item!]: 5 })).toEqual([`values.${keys.Item}`]);
    expect(await errOf({ [keys.Item!]: "a", [keys.Qty!]: "5" })).toEqual([`values.${keys.Qty}`]);
    expect(await errOf({ [keys.Item!]: "a", [keys.Due!]: "01-12-2026" })).toEqual([`values.${keys.Due}`]);
    expect(await errOf({ [keys.Item!]: "a", [keys.Due!]: "2026-02-30" })).toEqual([`values.${keys.Due}`]);
    expect(await errOf({ [keys.Item!]: "a", [keys.State!]: "Maybe" })).toEqual([`values.${keys.State}`]);
    expect(await errOf({ [keys.Item!]: "a", c_unknown: "x" })).toEqual(["values.c_unknown"]);
    expect(await errOf({ [keys.Item!]: "a", "$where": "1" })).toEqual(["values.$where"]);
    // a non-finite number (JSON 1e999 → Infinity)
    const inf = await api()
      .post(rowsPath(w, tracker.id))
      .set(auth(w.tokens.ownerA))
      .set("Content-Type", "application/json")
      .send(`{"values":{"${keys.Item}":"a","${keys.Qty}":1e999}}`);
    expect(inf.status).toBe(422);

    const ok = await post({ [keys.Item!]: " Hinge ", [keys.Qty!]: 2.5, [keys.Due!]: "2026-12-01", [keys.State!]: "Open" });
    expect(ok.status).toBe(201);
    expect(ok.body.values).toEqual({ [keys.Item!]: "Hinge", [keys.Qty!]: 2.5, [keys.Due!]: "2026-12-01", [keys.State!]: "Open" });
    expect(ok.body.done).toBe(false);
    expect(ok.body.createdBy).toEqual({ id: w.ownerA._id.toHexString(), name: w.ownerA.name });
  });

  it("PATCH merges values, clears with null, and toggles done", async () => {
    const w = await world();
    const { tracker, keys } = await createTracker(w);
    const row = await addRow(w, tracker.id, { [keys.Item!]: "Hinge", [keys.Qty!]: 2 });
    const path = rowsPath(w, tracker.id, `/${row.id}`);
    const res = await api().patch(path).set(auth(w.tokens.ownerA)).send({ values: { [keys.State!]: "Closed" }, done: true });
    expect(res.status).toBe(200);
    expect(res.body.values).toEqual({ [keys.Item!]: "Hinge", [keys.Qty!]: 2, [keys.State!]: "Closed" });
    expect(res.body.done).toBe(true);
    const cleared = await api().patch(path).set(auth(w.tokens.ownerA)).send({ values: { [keys.Qty!]: null } });
    expect(cleared.body.values).toEqual({ [keys.Item!]: "Hinge", [keys.State!]: "Closed" });
    // can't clear a required column, unknown key rejected, unknown body field rejected
    expect((await api().patch(path).set(auth(w.tokens.ownerA)).send({ values: { [keys.Item!]: null } })).status).toBe(422);
    expect((await api().patch(path).set(auth(w.tokens.ownerA)).send({ values: { c_nope: 1 } })).status).toBe(422);
    expect((await api().patch(path).set(auth(w.tokens.ownerA)).send({ createdBy: w.ownerB._id })).status).toBe(422);
    // delete
    expect((await api().delete(path).set(auth(w.tokens.ownerA))).status).toBe(204);
    expect((await api().delete(path).set(auth(w.tokens.ownerA))).status).toBe(404);
  });

  it("lists with search, done filter, pagination and sort by a column", async () => {
    const w = await world();
    const { tracker, keys } = await createTracker(w);
    await addRow(w, tracker.id, { [keys.Item!]: "Fix door (main)", [keys.Qty!]: 3 }, false);
    await addRow(w, tracker.id, { [keys.Item!]: "Paint wall", [keys.Qty!]: 10 }, true);
    await addRow(w, tracker.id, { [keys.Item!]: "Fix window", [keys.Qty!]: 1, [keys.State!]: "Closed" }, true);
    const list = (query: string) => api().get(rowsPath(w, tracker.id, `?${query}`)).set(auth(w.tokens.ownerA));
    const items = (res: { body: { items: { values: Record<string, unknown> }[] } }) =>
      res.body.items.map((r) => r.values[keys.Item!]);

    expect(items(await list(""))).toEqual(["Fix door (main)", "Paint wall", "Fix window"]);
    expect(items(await list("q=fix"))).toEqual(["Fix door (main)", "Fix window"]);
    expect(items(await list("q=(main)"))).toEqual(["Fix door (main)"]); // regex chars are escaped
    expect(items(await list("q=closed"))).toEqual(["Fix window"]); // status values are searchable
    expect(items(await list("done=true"))).toEqual(["Paint wall", "Fix window"]);
    expect(items(await list("done=false&q=fix"))).toEqual(["Fix door (main)"]);
    expect(items(await list(`sort=${keys.Qty}`))).toEqual(["Fix window", "Fix door (main)", "Paint wall"]);
    expect(items(await list(`sort=-${keys.Qty}`))).toEqual(["Paint wall", "Fix door (main)", "Fix window"]);
    expect(items(await list("sort=-createdAt"))).toEqual(["Fix window", "Paint wall", "Fix door (main)"]);
    // a key that is not a column falls back to the default order
    expect(items(await list("sort=-c_unknown"))).toEqual(["Fix door (main)", "Paint wall", "Fix window"]);
    const page = await list("pageSize=2&page=2");
    expect(page.body).toMatchObject({ page: 2, pageSize: 2, total: 3 });
    expect(items(page)).toEqual(["Fix window"]);
    expect((await list("done=maybe")).status).toBe(422);
  });
});

describe("worklog permissions and scoping", () => {
  it("supervisors can create trackers and rows; outsiders can't see the site", async () => {
    const w = await world();
    const { tracker, keys } = await createTracker(w, w.tokens.supervisorA);
    const row = await addRow(w, tracker.id, { [keys.Item!]: "From supervisor" }, false, w.tokens.supervisorA);
    expect(row).toMatchObject({ createdBy: { id: w.supervisorA._id.toHexString(), name: w.supervisorA.name } });
    expect((await api().get(rowsPath(w, tracker.id)).set(auth(w.tokens.engineerA))).status).toBe(200);
    // supervisor isn't a member of A2 → 404
    expect((await api().get(sitePath(w.siteA2._id, "/trackers")).set(auth(w.tokens.supervisorA))).status).toBe(404);
  });

  it("another site's or org's tracker and rows are 404", async () => {
    const w = await world();
    const { tracker, keys } = await createTracker(w);
    const row = await addRow(w, tracker.id, { [keys.Item!]: "A" });
    const owner = auth(w.tokens.ownerA);
    // same org, wrong site
    const a2 = (rest: string) => sitePath(w.siteA2._id, rest);
    expect((await api().get(a2(`/trackers/${tracker.id}/rows`)).set(owner)).status).toBe(404);
    expect((await api().post(a2(`/trackers/${tracker.id}/rows`)).set(owner).send({ values: { [keys.Item!]: "x" } })).status).toBe(404);
    expect((await api().patch(a2(`/trackers/${tracker.id}`)).set(owner).send({ name: "Hijack" })).status).toBe(404);
    expect((await api().delete(a2(`/trackers/${tracker.id}?force=true`)).set(owner)).status).toBe(404);
    // a row id under a different tracker of the same site
    const { tracker: other } = await createTracker(w, w.tokens.ownerA, { ...customTracker, name: "Other" });
    expect((await api().patch(rowsPath(w, other.id, `/${row.id}`)).set(owner).send({ done: true })).status).toBe(404);
    expect((await api().delete(rowsPath(w, other.id, `/${row.id}`)).set(owner)).status).toBe(404);
    // other org
    const ownerB = auth(w.tokens.ownerB);
    expect((await api().get(rowsPath(w, tracker.id)).set(ownerB)).status).toBe(404);
    expect((await api().get(sitePath(w.siteB1._id, `/trackers/${tracker.id}/rows`)).set(ownerB)).status).toBe(404);
    expect((await api().patch(sitePath(w.siteB1._id, `/trackers/${tracker.id}/rows/${row.id}`)).set(ownerB).send({ done: true })).status).toBe(404);
    expect((await api().get(sitePath(w.siteB1._id, "/trackers")).set(ownerB)).body.items).toEqual([]);
    // still intact
    const after = await api().get(rowsPath(w, tracker.id)).set(owner);
    expect(after.body.items[0]).toMatchObject({ id: row.id, done: false });
  });

  it("archived sites are read-only", async () => {
    const w = await world();
    const { tracker, keys } = await createTracker(w);
    expect((await api().post(sitePath(w.siteA1._id, "/archive")).set(auth(w.tokens.ownerA))).status).toBe(200);
    expect((await api().post(rowsPath(w, tracker.id)).set(auth(w.tokens.ownerA)).send({ values: { [keys.Item!]: "x" } })).status).toBe(409);
    expect((await api().get(rowsPath(w, tracker.id)).set(auth(w.tokens.ownerA))).status).toBe(200);
  });
});
