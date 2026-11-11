import crypto from "node:crypto";
import mongoose from "mongoose";
import request from "supertest";
import { beforeAll, afterAll, beforeEach } from "vitest";
import { connectDb } from "@/core/db";
import { hashPassword } from "@/core/auth";
import { createApp } from "@/app";
import { Organization, User } from "@/modules/identity/models";
import { Membership, Site } from "@/modules/sites/models";

export const app = createApp();
export const api = () => request(app);

/** Connects once per file and wipes all collections before each test. */
export function useDatabase() {
  beforeAll(async () => {
    if (mongoose.connection.readyState !== 1) await connectDb(process.env.TEST_MONGODB_URI);
  });
  beforeEach(async () => {
    const db = mongoose.connection.db!;
    const cols = await db.collections();
    await Promise.all(cols.map((c) => c.deleteMany({})));
  });
  afterAll(async () => {
    await mongoose.disconnect();
  });
}

/** Generated per run; satisfies the password policy (letters + digits, ≥ 8). */
export const TEST_PASSWORD = `t${crypto.randomBytes(9).toString("hex")}9`;
let seq = 0;

export async function makeOrg(name = "Acme Builders") {
  return Organization.create({ name });
}

export async function makeUser(
  orgId: mongoose.Types.ObjectId,
  orgRole: "owner" | "admin" | "member" = "owner",
  extra: Partial<{ name: string; email: string }> = {},
) {
  seq += 1;
  return User.create({
    orgId,
    name: extra.name ?? `User ${seq}`,
    email: extra.email ?? `user${seq}-${Date.now()}@example.com`,
    phone: "9840000000",
    orgRole,
    passwordHash: await hashPassword(TEST_PASSWORD),
  });
}

export async function login(email: string, secret = TEST_PASSWORD) {
  const res = await api().post("/api/v1/auth/login").send({ email, password: secret });
  if (res.status !== 200) throw new Error(`login failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.accessToken as string;
}

export async function makeSite(orgId: mongoose.Types.ObjectId, name = "Site A") {
  return Site.create({ orgId, name, address: "1 Main Road, Chennai" });
}

export async function addMember(
  orgId: mongoose.Types.ObjectId,
  siteId: mongoose.Types.ObjectId,
  userId: mongoose.Types.ObjectId,
  role: "engineer" | "supervisor",
) {
  return Membership.create({ orgId, siteId, userId, role });
}

/**
 * A ready-made world: org A (owner; engineer + supervisor on site A1; site A2 with no members)
 * and org B (owner, site B1). Access tokens included.
 */
export async function world() {
  const orgA = await makeOrg("Acme Builders");
  const orgB = await makeOrg("Other Corp");
  const [ownerA, engineerA, supervisorA, ownerB] = await Promise.all([
    makeUser(orgA._id, "owner"),
    makeUser(orgA._id, "member"),
    makeUser(orgA._id, "member"),
    makeUser(orgB._id, "owner"),
  ]);
  const siteA1 = await makeSite(orgA._id, "Site A1");
  const siteA2 = await makeSite(orgA._id, "Site A2");
  const siteB1 = await makeSite(orgB._id, "Site B1");
  await addMember(orgA._id, siteA1._id, engineerA._id, "engineer");
  await addMember(orgA._id, siteA1._id, supervisorA._id, "supervisor");
  const [ownerAToken, engineerAToken, supervisorAToken, ownerBToken] = await Promise.all([
    login(ownerA.email),
    login(engineerA.email),
    login(supervisorA.email),
    login(ownerB.email),
  ]);
  return {
    orgA, orgB, ownerA, engineerA, supervisorA, ownerB, siteA1, siteA2, siteB1,
    tokens: { ownerA: ownerAToken, engineerA: engineerAToken, supervisorA: supervisorAToken, ownerB: ownerBToken },
  };
}

export const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
export const sitePath = (siteId: { toHexString(): string } | string, rest = "") =>
  `/api/v1/sites/${typeof siteId === "string" ? siteId : siteId.toHexString()}${rest}`;
