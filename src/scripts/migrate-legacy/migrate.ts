/**
 * One-time migration of the legacy ConstructEase MongoDB data into the new model.
 * Reads the old collections from `source`, writes through the new mongoose models on the default
 * connection (the target), and returns a report. Idempotent via the `legacy_id_map` collection.
 */
import mongoose, { type Connection } from "mongoose";
import { Counter } from "@/core/records";
import { DEFAULT_TZ } from "@/core/units";
import { loadLegacy } from "./legacy";
import { LegacyIdMap, Migration, type Report } from "./context";
import { migrateIdentity } from "./steps/identity";
import { migrateParties, migrateProducts } from "./steps/masters";
import { migratePurchasing } from "./steps/purchasing";
import { migrateCheckins, migrateLabourAttendance } from "./steps/workforce";
import { migratePayments } from "./steps/finance";
import { migrateNotes, migrateWorklog } from "./steps/worklog";

export interface MigrateOptions {
  /** open connection to the OLD database */
  source: Connection;
  /** read + map + validate, write nothing */
  dryRun?: boolean;
  /** organisation timezone used to turn legacy instants into business dates */
  tz?: string;
}

const LOSSY = [
  "Attendance wage rates: the old app kept only the labourer's current wagesPerShift, so every migrated attendance entry uses that rate (historic rate changes are lost).",
  "Old Materials.availableQty is ignored (a hook bug corrupted it); stock is rebuilt from receipts − legacy usage − returns. Differences are listed in availableQtyMismatch.",
  "Legacy material usage (Materials.usedQty) had no date or purpose; it becomes one consumption movement per material (reference \"Opening usage (migrated)\"), dated at the material's last update.",
  "Payments named the party by free text; they are matched by name inside the org (preferring the payment's site). Unmatched ones become category \"other\" with an \"[unmatched: …]\" description.",
  "Supervisor check-ins had one location per day; it is copied onto every check-in/check-out event of that day. Unclosed check-ins (checkout = checkin) carry no check-out.",
  "Plaintext supervisor passwords (old Excel import) cannot be migrated; those accounts get an unusable password and must be reset by an owner.",
  "Products were per site and are merged into one org catalogue by name; old products had no tax rate, so defaultTaxRateBp is 1800 (receipt lines keep the material's own tax).",
  "Parties are merged per org by (kind, name, phone); the first record's details win and the rest only fill blanks.",
  "Old free-form to-do/work columns (additionalCols) become text columns; there was no status, so migrated to-dos have no Status and are not done.",
];

export async function migrate(opts: MigrateOptions): Promise<Report> {
  const tz = opts.tz ?? DEFAULT_TZ;
  const dryRun = Boolean(opts.dryRun);
  if (mongoose.connection.readyState !== 1) throw new Error("Target database is not connected");
  const src = opts.source;
  const tgt = mongoose.connection;
  if (src.name === tgt.name && src.host === tgt.host && src.port === tgt.port) {
    throw new Error("Source and target are the same database; the old and new collections share names (e.g. 'sites').");
  }

  const legacy = await loadLegacy(src);
  const m = new Migration(legacy, dryRun, tz);
  if (!dryRun) await LegacyIdMap.syncIndexes();
  await m.loadIdMap();

  await migrateIdentity(m);
  await migrateParties(m);
  await migrateProducts(m);
  await migratePurchasing(m);
  await migrateLabourAttendance(m);
  await migrateCheckins(m);
  await migratePayments(m);
  await migrateWorklog(m);
  await migrateNotes(m);

  // New documents continue the migrated numbering: counter = highest number used per org/prefix/year.
  if (!dryRun) {
    for (const [k, seq] of m.numbers) {
      const [orgHex, key] = k.split("|") as [string, string];
      await Counter.updateOne({ orgId: new mongoose.Types.ObjectId(orgHex), key }, { $max: { seq } }, { upsert: true });
    }
  }

  m.report.lossy.push(...LOSSY);
  m.report.finishedAt = new Date();
  return m.report;
}
