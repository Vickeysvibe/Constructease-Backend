/** Payments → Payment (+ vendor/client LedgerEntry). Old payments named the party by free text only. */
import { LedgerEntry, Payment } from "@/modules/finance/models";
import { Party, nameKeyOf } from "@/modules/parties/models";
import { businessDate, paymentMethod, str, toMilliSafe, toPaise } from "../clean";
import { newId, type Migration, type PartyEntry } from "../context";

const CATEGORY = { vendor: "vendor", client: "client", labour: "labour", others: "other" } as const;

export async function migratePayments(m: Migration) {
  const { legacy, report, tz } = m;
  for (const p of legacy.payments) {
    report.count("payments", "read");
    const oldId = String(p._id);
    if (m.mapped("payment", oldId)) {
      report.count("payments", "alreadyMigrated");
      continue;
    }
    const site = p.siteId ? m.siteOf(p.siteId) : undefined;
    if (p.siteId && !site) {
      report.error("payments", oldId, `site ${String(p.siteId)} was not migrated`);
      continue;
    }
    const org = site?.org ?? m.orgs.get(String(p.engineerId));
    if (!org) {
      report.error("payments", oldId, "payment has neither a migrated site nor a migrated engineer");
      continue;
    }
    const type = p.type && p.type in CATEGORY ? p.type : undefined;
    if (!type) {
      report.error("payments", oldId, `unknown payment type "${str(p.type)}"`);
      continue;
    }
    let category: "vendor" | "client" | "labour" | "other" = CATEGORY[type];
    const direction = type === "client" ? "in" : "out";
    const rupees = type === "client" ? Number(p.paymentReceived) || Number(p.amount) : Number(p.amount);
    const amountPaise = toPaise(rupees);
    const date = businessDate(p.date, tz, p.createdAt);
    if (amountPaise < 1 || !date) {
      report.count("payments", "skipped");
      report.add("skippedPayments", { oldId, type, name: str(p.name), amount: rupees, reason: amountPaise < 1 ? "amount is not positive" : "no date" });
      continue;
    }

    let description = str(p.description);
    if (type === "client") {
      const parts = [str(p.paymentBy) && `Paid by ${str(p.paymentBy)}`, str(p.paymentAs) && `via ${str(p.paymentAs)}`].filter(Boolean);
      description = [description, ...parts].filter(Boolean).join(" · ");
    }

    // ---- resolve the party by name (case-insensitive) within the org, preferring the payment's site ----
    let party: PartyEntry | undefined;
    if (category !== "other") {
      const name = str(p.name);
      const key = nameKeyOf(name);
      const all = name ? (m.partiesByOrg.get(org.orgId.toHexString()) ?? []).filter((x) => x.kind === category && x.nameKey === key) : [];
      const onSite = site ? all.filter((x) => x.siteIds.has(site.siteId.toHexString())) : all;
      const pool = onSite.length ? onSite : all;
      party = pool[0];
      if (pool.length > 1) {
        report.add("ambiguousPayments", { oldId, type, name, candidates: pool.map((x) => x.id.toHexString()), chosen: party!.id.toHexString() });
      }
      if (!party) {
        report.add("unmatchedPayments", { oldId, type, name, siteId: site?.siteId.toHexString() ?? null, amountPaise, date });
        description = `[unmatched: ${name || "(no name)"}] ${description}`.trim();
        category = "other";
      }
    }
    const attach = Boolean(party && site && !party.siteIds.has(site.siteId.toHexString()));
    const qty = toMilliSafe(p.quantity);
    const id = newId();
    const doc = {
      _id: id,
      orgId: org.orgId,
      siteId: site?.siteId ?? null,
      date,
      direction,
      category,
      partyId: party?.id,
      amountPaise,
      method: type === "client" ? paymentMethod(p.paymentAs) : undefined,
      description: description.slice(0, 1000) || undefined,
      quantityMilli: qty > 0 ? qty : undefined,
      unit: qty > 0 ? str(p.unit).slice(0, 30) || undefined : undefined,
      unitCostPaise: qty > 0 && toPaise(p.costPerUnit) > 0 ? toPaise(p.costPerUnit) : undefined,
      status: "posted",
      createdBy: org.ownerId,
      createdAt: p.createdAt,
    };
    const res = await m.unit("payments", oldId, async (tx) => {
      await tx.create(Payment, doc);
      if (attach) {
        await tx.update(Party, { _id: party!.id, orgId: org.orgId }, { $addToSet: { siteIds: site!.siteId } });
        tx.issue("notes", { entity: "payments", oldId, message: `party ${party!.name} attached to site "${site!.name}" (paid there)` });
      }
      if (party && (category === "vendor" || category === "client")) {
        await tx.create(LedgerEntry, {
          orgId: org.orgId,
          siteId: site?.siteId ?? null,
          partyId: party.id,
          date,
          sourceType: "payment",
          sourceId: id,
          reference: "",
          description: doc.description || (direction === "in" ? "Payment received" : "Payment made"),
          debitPaise: direction === "out" ? amountPaise : 0,
          creditPaise: direction === "in" ? amountPaise : 0,
          createdBy: org.ownerId,
        });
      }
      tx.map("payment", oldId, id, org.orgId);
      tx.count("payments", "created");
    });
    if (res.ok && attach) party!.siteIds.add(site!.siteId.toHexString());
  }
}
