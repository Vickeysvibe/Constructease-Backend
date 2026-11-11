/** Engineers → Organization + owner, Supervisors → member users, Sites (+ default trackers), Memberships. */
import crypto from "node:crypto";
import { hashPassword, isBcryptHash } from "@/core/auth";
import { Organization, User } from "@/modules/identity/models";
import { Membership, Site } from "@/modules/sites/models";
import { DEFAULT_TRACKERS } from "@/modules/worklog/routes";
import { Tracker, type ColumnDoc } from "@/modules/worklog/models";
import { cleanPhone, clip, str } from "../clean";
import { newId, type Entity, type Migration, type OrgState } from "../context";

/** Truncates to the model's limit and records the loss. */
export function fit(m: Migration, entity: Entity, oldId: unknown, field: string, v: unknown, max: number): string {
  const c = clip(v, max);
  if (c.cut) m.report.add("truncated", { entity, oldId: String(oldId), field, length: str(v).length, max });
  return c.value;
}

/** A bcrypt hash of a random secret nobody knows: the account exists but can only be used after a reset. */
const unusableHash = () => hashPassword(crypto.randomBytes(24).toString("base64url"));

async function emailTaken(m: Migration, email: string, usedThisRun: Set<string>) {
  if (usedThisRun.has(email)) return true;
  return Boolean(await User.exists({ email }).setOptions({ skipTenantGuard: true }));
}

export async function migrateIdentity(m: Migration) {
  const { legacy, report } = m;
  const emails = new Set<string>();

  // ---- engineers → organisations + owners ----
  for (const e of legacy.engineers) {
    report.count("engineers", "read");
    const oldId = String(e._id);
    const mappedOrg = m.mapped("engineer", oldId);
    const mappedOwner = m.mapped("engineer_owner", oldId);
    const ownerName = fit(m, "engineers", oldId, "name", e.name, 120) || str(e.email);
    if (mappedOrg && mappedOwner) {
      m.orgs.set(oldId, { oldEngineerId: oldId, orgId: mappedOrg, ownerId: mappedOwner, ownerName });
      report.count("engineers", "alreadyMigrated");
      continue;
    }
    const email = str(e.email).toLowerCase();
    if (!email) {
      report.error("engineers", oldId, "engineer has no email; organisation not created (its sites and data are skipped)");
      continue;
    }
    if (await emailTaken(m, email, emails)) {
      report.error("engineers", oldId, `a user with email ${email} already exists in the target; organisation not created`);
      continue;
    }
    let passwordHash = str(e.password);
    if (!isBcryptHash(passwordHash)) {
      passwordHash = await unusableHash();
      report.add("mustResetPassword", { kind: "owner", oldId, email, reason: "legacy password was not a bcrypt hash" });
    }
    const org: OrgState = { oldEngineerId: oldId, orgId: newId(), ownerId: newId(), ownerName };
    const phone = cleanPhone(e.phoneNo);
    const res = await m.unit("engineers", oldId, async (tx) => {
      await tx.create(Organization, {
        _id: org.orgId,
        name: fit(m, "engineers", oldId, "companyName", e.companyName, 120) || ownerName,
        logoUrl: str(e.companyLogo) || undefined,
        description: fit(m, "engineers", oldId, "companyDesc", e.companyDesc, 1000) || undefined,
        address: fit(m, "engineers", oldId, "address", e.address, 500) || undefined,
        phone: phone.digits || undefined,
        timezone: m.tz,
        createdAt: e.createdAt,
      });
      await tx.create(User, {
        _id: org.ownerId,
        orgId: org.orgId,
        name: ownerName,
        email,
        phone: phone.digits,
        passwordHash,
        orgRole: "owner",
        status: "active",
        createdAt: e.createdAt,
      });
      tx.map("engineer", oldId, org.orgId, org.orgId);
      tx.map("engineer_owner", oldId, org.ownerId, org.orgId);
      tx.count("engineers", "created");
    });
    if (res.ok) {
      emails.add(email);
      m.orgs.set(oldId, org);
    }
  }

  // ---- sites (each gets the default "To-do" and "Work done" trackers, exactly like POST /sites) ----
  for (const s of legacy.sites) {
    report.count("sites", "read");
    const oldId = String(s._id);
    const org = m.orgs.get(String(s.engineerId));
    const name = fit(m, "sites", oldId, "siteName", s.siteName, 120) || "Unnamed site";
    if (!org) {
      report.error("sites", oldId, `engineer ${String(s.engineerId)} was not migrated`);
      continue;
    }
    const mappedSite = m.mapped("site", oldId);
    if (mappedSite) {
      m.sites.set(oldId, { oldId, siteId: mappedSite, org, name });
      report.count("sites", "alreadyMigrated");
      continue;
    }
    const siteId = newId();
    const trackers = DEFAULT_TRACKERS.map((t) => ({
      _id: newId(),
      ...t,
      columns: t.columns.map((c) => ({ ...c, options: [...c.options] })),
      orgId: org.orgId,
      siteId,
    }));
    const res = await m.unit("sites", oldId, async (tx) => {
      await tx.create(Site, {
        _id: siteId,
        orgId: org.orgId,
        name,
        address: fit(m, "sites", oldId, "siteAddress", s.siteAddress, 500) || "-",
        status: "active",
        createdAt: s.createdAt,
      });
      await tx.create(Tracker, trackers);
      tx.map("site", oldId, siteId, org.orgId);
      tx.count("sites", "created");
    });
    if (res.ok) {
      m.sites.set(oldId, { oldId, siteId, org, name });
      for (const t of trackers) m.trackers.set(`${siteId.toHexString()}|${t.kind}`, { id: t._id, columns: t.columns as ColumnDoc[] });
    }
  }

  // ---- supervisors → org members ----
  for (const sup of legacy.supervisors) {
    report.count("supervisors", "read");
    const oldId = String(sup._id);
    const org = m.orgs.get(String(sup.engineerId));
    if (!org) {
      report.error("supervisors", oldId, `engineer ${String(sup.engineerId)} was not migrated`);
      continue;
    }
    const mappedUser = m.mapped("supervisor", oldId);
    if (mappedUser) {
      m.users.set(oldId, mappedUser);
      report.count("supervisors", "alreadyMigrated");
      continue;
    }
    const email = str(sup.email).toLowerCase();
    if (!email) {
      report.error("supervisors", oldId, "supervisor has no email");
      continue;
    }
    if (await emailTaken(m, email, emails)) {
      report.error("supervisors", oldId, `email ${email} is already used by another user (e.g. the engineer); supervisor not imported`);
      continue;
    }
    let passwordHash = str(sup.password);
    if (!isBcryptHash(passwordHash)) {
      passwordHash = await unusableHash();
      report.add("mustResetPassword", {
        kind: "supervisor",
        oldId,
        email,
        reason: "legacy password was stored in plaintext (old Excel import); set to an unusable hash",
      });
    }
    const userId = newId();
    const res = await m.unit("supervisors", oldId, async (tx) => {
      await tx.create(User, {
        _id: userId,
        orgId: org.orgId,
        name: fit(m, "supervisors", oldId, "name", sup.name, 120) || email,
        email,
        phone: cleanPhone(sup.phoneNo).digits,
        passwordHash,
        orgRole: "member",
        status: sup.isDel ? "disabled" : "active",
        createdAt: sup.createdAt,
      });
      tx.map("supervisor", oldId, userId, org.orgId);
      tx.count("supervisors", "created");
    });
    if (res.ok) {
      emails.add(email);
      m.users.set(oldId, userId);
    }
  }

  // ---- memberships: local supervisors on the sites listing them; global ones on every site of the org ----
  const wanted = new Map<string, { supId: string; siteOld: string }>();
  for (const s of legacy.sites) {
    for (const supId of s.supervisorsId ?? []) wanted.set(`${String(supId)}:${String(s._id)}`, { supId: String(supId), siteOld: String(s._id) });
  }
  for (const sup of legacy.supervisors) {
    if (sup.role !== "global") continue;
    for (const s of legacy.sites) {
      if (String(s.engineerId) === String(sup.engineerId)) {
        wanted.set(`${String(sup._id)}:${String(s._id)}`, { supId: String(sup._id), siteOld: String(s._id) });
      }
    }
  }
  const supById = new Map(legacy.supervisors.map((s) => [String(s._id), s]));
  for (const [key, w] of wanted) {
    report.count("memberships", "read");
    const site = m.siteOf(w.siteOld);
    const userId = m.users.get(w.supId);
    const sup = supById.get(w.supId);
    if (!site || !userId || !sup) {
      report.count("memberships", "skipped");
      report.add("notes", { entity: "memberships", key, message: "site or supervisor was not migrated; membership skipped" });
      continue;
    }
    if (String(sup.engineerId) !== site.org.oldEngineerId) {
      report.error("memberships", key, "supervisor belongs to another engineer than the site; membership skipped");
      continue;
    }
    if (m.mapped("membership", key)) {
      report.count("memberships", "alreadyMigrated");
      continue;
    }
    const membershipId = newId();
    await m.unit("memberships", key, async (tx) => {
      await tx.create(Membership, { _id: membershipId, orgId: site.org.orgId, siteId: site.siteId, userId, role: "supervisor" });
      tx.map("membership", key, membershipId, site.org.orgId);
      tx.count("memberships", "created");
    });
  }
}
