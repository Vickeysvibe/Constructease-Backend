/** Clients / Vendors / Labours → Party (deduped per org) and per-site Products → org catalogue Product. */
import type { Types } from "mongoose";
import { Party, nameKeyOf } from "@/modules/parties/models";
import { Product } from "@/modules/products/models";
import type { LClient, LLabour, LVendor } from "../legacy";
import { GSTIN_RE, PLACEHOLDER_PHONE, classifyTaxId, cleanPhone, str, toPaise } from "../clean";
import { newId, type Entity, type Migration, type OrgState, type PartyEntry, type SiteState } from "../context";
import { fit } from "./identity";

type Kind = "vendor" | "client" | "labour";
const ENTITY: Record<Kind, Entity> = { vendor: "vendors", client: "clients", labour: "labours" };

interface Candidate {
  kind: Kind;
  oldId: string;
  org: OrgState;
  sites: SiteState[];
  name: string;
  nameKey: string;
  phone: string;
  fields: Record<string, unknown>;
  archived: boolean;
}

const siteList = (v: unknown): unknown[] => (Array.isArray(v) ? v : v == null ? [] : [v]);

/** Old records that history points at — these are imported even with a bad phone number. */
function referencedSets(m: Migration) {
  const { legacy } = m;
  const vendorIds = new Set<string>();
  for (const po of legacy.purchaseOrders) if (po.vendorId) vendorIds.add(String(po.vendorId));
  for (const mat of legacy.materials) if (mat.fromVendor) vendorIds.add(String(mat.fromVendor));
  const labourIds = new Set<string>();
  for (const a of legacy.labourAttendances) for (const e of a.attendance ?? []) if (e.labourId) labourIds.add(String(e.labourId));
  /** `${type}|${oldSiteId}|${nameKey}` of every payment */
  const paymentNames = new Set<string>();
  for (const p of legacy.payments) {
    if (p.name && p.siteId) paymentNames.add(`${p.type}|${String(p.siteId)}|${nameKeyOf(p.name)}`);
  }
  return { vendorIds, labourIds, paymentNames };
}

export async function migrateParties(m: Migration) {
  const { legacy, report } = m;
  const refs = referencedSets(m);
  const inputs: { kind: Kind; doc: LClient | LVendor | LLabour }[] = [
    ...legacy.vendors.map((doc) => ({ kind: "vendor" as const, doc })),
    ...legacy.clients.map((doc) => ({ kind: "client" as const, doc })),
    ...legacy.labours.map((doc) => ({ kind: "labour" as const, doc })),
  ];

  // ---- 1. clean every old record into a candidate ----
  const groups = new Map<string, Candidate[]>();
  for (const { kind, doc } of inputs) {
    const entity = ENTITY[kind];
    const oldId = String(doc._id);
    report.count(entity, "read");
    const oldSites = siteList(doc.siteId);
    const sites = oldSites.map((s) => m.siteOf(s)).filter((s): s is SiteState => Boolean(s));
    if (!sites.length) {
      report.error(entity, oldId, `none of its sites (${oldSites.map(String).join(", ") || "none"}) were migrated`);
      continue;
    }
    const org = sites[0]!.org;
    const sameOrg = sites.filter((s) => s.org === org);
    if (sameOrg.length !== sites.length) {
      report.add("notes", { entity, oldId, message: "attached to sites of several engineers; kept only the first engineer's sites" });
    }
    const name = fit(m, entity, oldId, "name", doc.name, 120);
    if (!name) {
      report.error(entity, oldId, "name is empty");
      continue;
    }
    const nameKey = nameKeyOf(name);
    const phone = cleanPhone(doc.phoneNo);
    let phoneValue = phone.digits;
    if (!phone.valid) {
      const referenced =
        (kind === "vendor" && refs.vendorIds.has(oldId)) ||
        (kind === "labour" && refs.labourIds.has(oldId)) ||
        oldSites.some((s) => refs.paymentNames.has(`${kind}|${String(s)}|${nameKey}`));
      if (!referenced) {
        report.count(entity, "skipped");
        report.add("invalidPhones", { entity, oldId, name, phone: str(doc.phoneNo), action: "skipped (not referenced by any history)" });
        continue;
      }
      phoneValue = phone.digits || PLACEHOLDER_PHONE;
      report.add("invalidPhones", {
        entity,
        oldId,
        name,
        phone: str(doc.phoneNo),
        action: `imported with phone "${phoneValue}" because history references it — fix it in the app`,
      });
    }

    const fields: Record<string, unknown> = { address: fit(m, entity, oldId, "address", (doc as { address?: string }).address, 500) || undefined };
    if (kind === "vendor") {
      const v = doc as LVendor;
      fields.contactName = fit(m, entity, oldId, "ownerName", v.ownerName, 120) || undefined;
      const g = str(v.gstIn).toUpperCase().replace(/\s+/g, "");
      if (GSTIN_RE.test(g)) fields.gstIn = g;
      else if (g) report.add("droppedTaxIds", { entity, oldId, name, field: "gstIn", value: str(v.gstIn) });
    } else if (kind === "client") {
      const t = classifyTaxId((doc as LClient).panGstNo);
      if (t.gstIn) fields.gstIn = t.gstIn;
      if (t.pan) fields.pan = t.pan;
      if (t.dropped) report.add("droppedTaxIds", { entity, oldId, name, field: "panGstNo", value: t.dropped });
    } else {
      const l = doc as LLabour;
      fields.category = fit(m, entity, oldId, "category", l.category, 60) || undefined;
      fields.subCategory = fit(m, entity, oldId, "subCategory", l.subCategory, 60) || undefined;
      fields.wageRatePaise = Math.max(0, toPaise(l.wagesPerShift));
    }
    const cand: Candidate = {
      kind,
      oldId,
      org,
      sites: sameOrg,
      name,
      nameKey,
      phone: phoneValue,
      fields,
      archived: Boolean((doc as LLabour).isDel),
    };
    const key = `${org.orgId.toHexString()}|${kind}|${nameKey}|${phoneValue}`;
    const list = groups.get(key) ?? [];
    list.push(cand);
    groups.set(key, list);
  }

  // ---- 2. one Party per group ----
  for (const group of groups.values()) {
    const first = group[0]!;
    const { kind, org } = first;
    const entity = ENTITY[kind];
    const siteIds = new Set(group.flatMap((c) => c.sites.map((s) => s.siteId.toHexString())));
    const pending = group.filter((c) => !m.mapped(kind, c.oldId));
    let partyId = group.map((c) => m.mapped(kind, c.oldId)).find(Boolean);
    if (!partyId) {
      const existing = await Party.findOne({ orgId: org.orgId, kind, nameKey: first.nameKey, phone: first.phone }).select("_id").lean();
      partyId = existing?._id;
    }
    const entry: PartyEntry = {
      id: partyId ?? newId(),
      org,
      kind,
      name: first.name,
      nameKey: first.nameKey,
      gstIn: group.map((c) => c.fields.gstIn as string | undefined).find(Boolean),
      siteIds,
      wageRatePaise: first.fields.wageRatePaise as number | undefined,
    };
    report.count(entity, "alreadyMigrated", group.length - pending.length);
    if (!pending.length) {
      for (const c of group) m.addParty(`${kind}:${c.oldId}`, entry);
      continue;
    }
    if (group.length > 1) {
      const wages = [...new Set(group.map((c) => c.fields.wageRatePaise).filter((w) => w != null))];
      report.add("partyMerges", {
        kind,
        name: first.name,
        phone: first.phone,
        oldIds: group.map((c) => c.oldId),
        siteCount: siteIds.size,
        ...(wages.length > 1 ? { note: `different wage rates ${wages.join(", ")} paise; kept ${String(first.fields.wageRatePaise)}` } : {}),
      });
    }
    // First record wins; blanks are filled from the later duplicates.
    const merged: Record<string, unknown> = {};
    for (const c of group) for (const [k, v] of Object.entries(c.fields)) if (merged[k] === undefined && v !== undefined) merged[k] = v;
    const siteOids = [...siteIds].map((h) => group.flatMap((c) => c.sites).find((s) => s.siteId.toHexString() === h)!.siteId);
    const isNew = !partyId;
    const res = await m.unit(entity, first.oldId, async (tx) => {
      if (isNew) {
        await tx.create(Party, {
          _id: entry.id,
          orgId: org.orgId,
          kind,
          name: first.name,
          nameKey: first.nameKey,
          phone: first.phone,
          ...merged,
          siteIds: siteOids,
          status: group.every((c) => c.archived) ? "archived" : "active",
        });
        tx.count(entity, "created");
        tx.count(entity, "merged", pending.length - 1);
      } else {
        await tx.update(Party, { _id: entry.id, orgId: org.orgId }, { $addToSet: { siteIds: { $each: siteOids } } });
        tx.count(entity, "merged", pending.length);
      }
      for (const c of pending) tx.map(kind, c.oldId, entry.id, org.orgId);
    });
    if (res.ok) for (const c of group) m.addParty(`${kind}:${c.oldId}`, entry);
  }
}

/** Old products were per site; the new catalogue is per org and unique by name. */
export async function migrateProducts(m: Migration) {
  const { legacy, report } = m;
  const groups = new Map<string, { org: OrgState; oldIds: string[]; name: string; nameKey: string; unit: string; category?: string; description?: string; units: Set<string> }>();
  for (const p of legacy.products) {
    report.count("products", "read");
    const oldId = String(p._id);
    const site = m.siteOf(p.siteId);
    if (!site) {
      report.error("products", oldId, `site ${String(p.siteId)} was not migrated`);
      continue;
    }
    const name = fit(m, "products", oldId, "name", p.name, 120);
    if (!name) {
      report.error("products", oldId, "name is empty");
      continue;
    }
    const nameKey = nameKeyOf(name);
    let unit = fit(m, "products", oldId, "unit", p.unit, 20);
    if (!unit) {
      unit = "nos";
      report.add("notes", { entity: "products", oldId, message: 'unit was empty; set to "nos"' });
    }
    const key = `${site.org.orgId.toHexString()}|${nameKey}`;
    const g = groups.get(key);
    if (g) {
      g.oldIds.push(oldId);
      g.units.add(unit);
      g.category ??= fit(m, "products", oldId, "category", p.category, 60) || undefined;
      g.description ??= fit(m, "products", oldId, "description", p.description, 500) || undefined;
    } else {
      groups.set(key, {
        org: site.org,
        oldIds: [oldId],
        name,
        nameKey,
        unit,
        units: new Set([unit]),
        category: fit(m, "products", oldId, "category", p.category, 60) || undefined,
        description: fit(m, "products", oldId, "description", p.description, 500) || undefined,
      });
    }
  }

  for (const g of groups.values()) {
    const pending = g.oldIds.filter((id) => !m.mapped("product", id));
    let id: Types.ObjectId | undefined = g.oldIds.map((o) => m.mapped("product", o)).find(Boolean);
    let entry = { id: id!, orgId: g.org.orgId, name: g.name, unit: g.unit, defaultTaxRateBp: 1800 };
    report.count("products", "alreadyMigrated", g.oldIds.length - pending.length);
    if (!id) {
      const existing = await Product.findOne({ orgId: g.org.orgId, nameKey: g.nameKey }).lean();
      if (existing) {
        id = existing._id;
        entry = { id, orgId: g.org.orgId, name: existing.name, unit: existing.unit, defaultTaxRateBp: existing.defaultTaxRateBp ?? 1800 };
      }
    }
    if (!pending.length) {
      for (const o of g.oldIds) m.products.set(o, entry);
      continue;
    }
    if (g.oldIds.length > 1) {
      report.add("productMerges", {
        name: g.name,
        oldIds: g.oldIds,
        ...(g.units.size > 1 ? { note: `different units ${[...g.units].join(", ")}; kept "${g.unit}"` } : {}),
      });
    }
    const isNew = !id;
    if (isNew) entry.id = newId();
    const res = await m.unit("products", g.oldIds[0], async (tx) => {
      if (isNew) {
        await tx.create(Product, {
          _id: entry.id,
          orgId: g.org.orgId,
          name: g.name,
          nameKey: g.nameKey,
          unit: g.unit,
          category: g.category,
          description: g.description,
          defaultTaxRateBp: 1800,
        });
        tx.count("products", "created");
        tx.count("products", "merged", pending.length - 1);
      } else {
        tx.count("products", "merged", pending.length);
      }
      for (const o of pending) tx.map("product", o, entry.id, g.org.orgId);
    });
    if (res.ok) for (const o of g.oldIds) m.products.set(o, entry);
  }
}
