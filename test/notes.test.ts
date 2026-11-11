import { describe, expect, it } from "vitest";
import { api, auth, sitePath, useDatabase, world } from "./helpers";

useDatabase();

describe("notes", () => {
  it("creates, lists, searches, updates and deletes a note with createdBy name", async () => {
    const w = await world();
    const path = sitePath(w.siteA1._id, "/notes");
    const created = await api()
      .post(path)
      .set(auth(w.tokens.supervisorA))
      .send({ title: "Slab schedule", body: "Pour on Friday", link: "https://docs.google.com/spreadsheets/d/abc" });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      title: "Slab schedule",
      body: "Pour on Friday",
      link: "https://docs.google.com/spreadsheets/d/abc",
      createdBy: { id: w.supervisorA._id.toHexString(), name: w.supervisorA.name },
    });
    expect(JSON.stringify(created.body)).not.toMatch(/orgId|_id|siteId/);

    const second = await api().post(path).set(auth(w.tokens.ownerA)).send({ title: "Gate pass" });
    expect(second.status).toBe(201);
    expect(second.body.body).toBe("");
    expect(second.body.link).toBeUndefined();

    const list = await api().get(path).set(auth(w.tokens.engineerA));
    expect(list.status).toBe(200);
    expect(list.body.total).toBe(2);
    expect(list.body.items.map((n: { title: string }) => n.title)).toEqual(["Gate pass", "Slab schedule"]);
    expect(list.body.items.map((n: { createdBy: { name: string } }) => n.createdBy.name)).toEqual([w.ownerA.name, w.supervisorA.name]);
    const search = await api().get(`${path}?q=friday`).set(auth(w.tokens.engineerA));
    expect(search.body.items.map((n: { title: string }) => n.title)).toEqual(["Slab schedule"]);

    const id = created.body.id as string;
    const patched = await api().patch(`${path}/${id}`).set(auth(w.tokens.engineerA)).send({ title: "Slab pour", link: null });
    expect(patched.status).toBe(200);
    expect(patched.body).toMatchObject({ title: "Slab pour", body: "Pour on Friday" });
    expect(patched.body.link).toBeUndefined();
    expect(patched.body.createdBy.name).toBe(w.supervisorA.name);

    expect((await api().delete(`${path}/${id}`).set(auth(w.tokens.supervisorA))).status).toBe(204);
    expect((await api().delete(`${path}/${id}`).set(auth(w.tokens.supervisorA))).status).toBe(404);
  });

  it("validates title and link (http/https only) and rejects unknown fields", async () => {
    const w = await world();
    const path = sitePath(w.siteA1._id, "/notes");
    const post = (body: object) => api().post(path).set(auth(w.tokens.ownerA)).send(body);
    expect((await post({ title: "" })).status).toBe(422);
    for (const link of ["not a url", "javascript:alert(1)", "ftp://files.example.com/a", "data:text/html,hi"]) {
      const res = await post({ title: "x", link });
      expect(res.status, link).toBe(422);
      expect(res.body.errors[0].path).toBe("link");
    }
    expect((await post({ title: "x", orgId: w.orgB._id })).status).toBe(422);
    expect((await post({ title: "x", link: "" })).status).toBe(201);
    const n = await post({ title: "y", link: "http://example.com" });
    expect((await api().patch(`${path}/${n.body.id}`).set(auth(w.tokens.ownerA)).send({ link: "javascript:x" })).status).toBe(422);
    expect((await api().patch(`${path}/${n.body.id}`).set(auth(w.tokens.ownerA)).send({ createdBy: w.ownerB._id })).status).toBe(422);
  });

  it("another site's or org's note is 404", async () => {
    const w = await world();
    const n = await api().post(sitePath(w.siteA1._id, "/notes")).set(auth(w.tokens.ownerA)).send({ title: "Private" });
    const id = n.body.id as string;
    expect((await api().patch(sitePath(w.siteA2._id, `/notes/${id}`)).set(auth(w.tokens.ownerA)).send({ title: "x" })).status).toBe(404);
    expect((await api().delete(sitePath(w.siteA2._id, `/notes/${id}`)).set(auth(w.tokens.ownerA))).status).toBe(404);
    expect((await api().get(sitePath(w.siteA1._id, "/notes")).set(auth(w.tokens.ownerB))).status).toBe(404);
    expect((await api().patch(sitePath(w.siteB1._id, `/notes/${id}`)).set(auth(w.tokens.ownerB)).send({ title: "x" })).status).toBe(404);
    expect((await api().get(sitePath(w.siteB1._id, "/notes")).set(auth(w.tokens.ownerB))).body.items).toEqual([]);
    const still = await api().get(sitePath(w.siteA1._id, "/notes")).set(auth(w.tokens.ownerA));
    expect(still.body.items[0].title).toBe("Private");
  });
});
