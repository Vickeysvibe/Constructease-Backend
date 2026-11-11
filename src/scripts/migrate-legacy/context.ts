/** Shared migration plumbing: the legacy id map, the write unit (transaction or dry-run validation) and the report. */
import mongoose, { Schema, Types, type ClientSession } from "mongoose";
import { withTransaction } from "@/core/db";
import type { ColumnDoc } from "@/modules/worklog/models";
import type { LegacyData } from "./legacy";

// ---------- legacy_id_map: makes re-runs idempotent ----------
const LegacyIdMapSchema = new Schema(
  {
    kind: { type: String, required: true },
    oldId: { type: String, required: true },
    newId: { type: Schema.Types.ObjectId, required: true },
    orgId: { type: Schema.Types.ObjectId },
  },
  { collection: "legacy_id_map", timestamps: { createdAt: true, updatedAt: false }, versionKey: false },
);
LegacyIdMapSchema.index({ kind: 1, oldId: 1 }, { unique: true });
export const LegacyIdMap = mongoose.model("LegacyIdMap", LegacyIdMapSchema);

export type MapKind =
  | "engineer"
  | "engineer_owner"
  | "supervisor"
  | "site"
  | "membership"
  | "vendor"
  | "client"
  | "labour"
  | "product"
  | "purchase_order"
  | "material_inward"
  | "purchase_return"
  | "labour_attendance"
  | "supervisor_checkin"
  | "payment"
  | "todo"
  | "work"
  | "note";

// ---------- report ----------
export const ENTITIES = [
  "engineers",
  "supervisors",
  "sites",
  "memberships",
  "clients",
  "vendors",
  "labours",
  "products",
  "purchaseOrders",
  "materialInwards",
  "materials",
  "purchaseReturns",
  "labourAttendance",
  "supervisorAttendance",
  "payments",
  "todos",
  "works",
  "notes",
] as const;
export type Entity = (typeof ENTITIES)[number];

export interface Counts {
  /** old records seen */
  read: number;
  /** new documents created (or that would be created in a dry run) */
  created: number;
  /** old records folded into an existing new document (dedupe) */
  merged: number;
  /** old records already in legacy_id_map (previous run) */
  alreadyMigrated: number;
  /** old records intentionally not imported (see issues) */
  skipped: number;
  /** old records that failed (see issues.errors) */
  errors: number;
}

export const ISSUE_LISTS = [
  "errors",
  "mustResetPassword",
  "invalidPhones",
  "droppedTaxIds",
  "partyMerges",
  "productMerges",
  "truncated",
  "purchaseOrderAdjustments",
  "receiptTotalMismatch",
  "availableQtyMismatch",
  "usageClamped",
  "orphanMaterials",
  "doubleBookings",
  "attendanceAdjustments",
  "checkinAdjustments",
  "unmatchedPayments",
  "ambiguousPayments",
  "skippedPayments",
  "trackerColumns",
  "notes",
] as const;
export type IssueList = (typeof ISSUE_LISTS)[number];
export type Issue = Record<string, unknown>;

export class Report {
  readonly startedAt = new Date();
  finishedAt?: Date;
  readonly counts = Object.fromEntries(
    ENTITIES.map((e) => [e, { read: 0, created: 0, merged: 0, alreadyMigrated: 0, skipped: 0, errors: 0 }]),
  ) as Record<Entity, Counts>;
  readonly issues = Object.fromEntries(ISSUE_LISTS.map((l) => [l, [] as Issue[]])) as Record<IssueList, Issue[]>;
  /** statements about information the new model cannot hold */
  readonly lossy: string[] = [];

  constructor(readonly dryRun: boolean, readonly timezone: string) {}

  count(entity: Entity, field: keyof Counts, n = 1) {
    this.counts[entity][field] += n;
  }
  add(list: IssueList, item: Issue) {
    this.issues[list].push(item);
  }
  error(entity: Entity, oldId: unknown, message: string, extra: Issue = {}) {
    this.counts[entity].errors += 1;
    this.issues.errors.push({ entity, oldId: oldId == null ? null : String(oldId), message, ...extra });
  }

  toJSON() {
    return {
      dryRun: this.dryRun,
      timezone: this.timezone,
      startedAt: this.startedAt.toISOString(),
      finishedAt: this.finishedAt?.toISOString(),
      counts: this.counts,
      issues: this.issues,
      lossy: this.lossy,
    };
  }

  /** Human-readable summary for the console. */
  format(): string {
    const lines: string[] = [];
    lines.push(`Legacy migration ${this.dryRun ? "(DRY RUN — nothing written)" : ""}`.trim());
    lines.push("");
    const head = ["entity", "read", "created", "merged", "already", "skipped", "errors"];
    lines.push(head.map((h, i) => (i === 0 ? h.padEnd(22) : h.padStart(8))).join(""));
    for (const e of ENTITIES) {
      const c = this.counts[e];
      lines.push(
        [e.padEnd(22), ...[c.read, c.created, c.merged, c.alreadyMigrated, c.skipped, c.errors].map((n) => String(n).padStart(8))].join(""),
      );
    }
    lines.push("");
    for (const l of ISSUE_LISTS) {
      const items = this.issues[l];
      if (!items.length) continue;
      lines.push(`${l}: ${items.length}`);
      for (const it of items.slice(0, 10)) lines.push(`  - ${JSON.stringify(it)}`);
      if (items.length > 10) lines.push(`  … ${items.length - 10} more in the JSON report`);
    }
    if (this.lossy.length) {
      lines.push("", "Lossy by design:");
      for (const s of this.lossy) lines.push(`  - ${s}`);
    }
    return lines.join("\n");
  }
}

// ---------- write unit ----------
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyModel = mongoose.Model<any>;

interface PendingMap {
  kind: MapKind;
  oldId: string;
  newId: Types.ObjectId;
  orgId?: Types.ObjectId;
}

/**
 * One atomic unit of migration work. In a real run every write goes through one transaction session and the
 * legacy_id_map rows are written in the same transaction, so a crash never leaves a half-migrated record that a
 * re-run would duplicate. In a dry run, documents are only validated against the new mongoose models.
 * Issues are buffered and only reported once the unit commits (a transaction may be retried).
 */
export class Tx {
  readonly maps: PendingMap[] = [];
  readonly issues: [IssueList, Issue][] = [];
  readonly counts: [Entity, keyof Counts, number][] = [];
  constructor(
    readonly session: ClientSession | undefined,
    readonly dryRun: boolean,
  ) {}

  async create(model: AnyModel, docs: object | object[]) {
    const arr = Array.isArray(docs) ? docs : [docs];
    if (!arr.length) return;
    if (this.dryRun) {
      for (const d of arr) await new model(d).validate();
      return;
    }
    await model.create(arr, { session: this.session, ordered: true });
  }

  /** Updates an existing (non-ledger) document. Validators run; nothing happens in a dry run. */
  async update(model: AnyModel, filter: Record<string, unknown>, update: Record<string, unknown>) {
    if (this.dryRun) return;
    await model.updateOne(filter, update, { session: this.session, runValidators: true });
  }

  map(kind: MapKind, oldId: unknown, newId: Types.ObjectId, orgId?: Types.ObjectId) {
    this.maps.push({ kind, oldId: String(oldId), newId, orgId });
  }
  issue(list: IssueList, item: Issue) {
    this.issues.push([list, item]);
  }
  count(entity: Entity, field: keyof Counts, n = 1) {
    this.counts.push([entity, field, n]);
  }
}

export interface OrgState {
  oldEngineerId: string;
  orgId: Types.ObjectId;
  ownerId: Types.ObjectId;
  ownerName: string;
}
export interface SiteState {
  oldId: string;
  siteId: Types.ObjectId;
  org: OrgState;
  name: string;
}
export interface PartyEntry {
  id: Types.ObjectId;
  org: OrgState;
  kind: "vendor" | "client" | "labour";
  name: string;
  nameKey: string;
  gstIn?: string;
  siteIds: Set<string>;
  wageRatePaise?: number;
}
export interface ProductEntry {
  id: Types.ObjectId;
  orgId: Types.ObjectId;
  name: string;
  unit: string;
  defaultTaxRateBp: number;
}

export class Migration {
  readonly report: Report;
  /** `${kind}:${oldId}` → new id */
  private readonly idMap = new Map<string, Types.ObjectId>();

  readonly orgs = new Map<string, OrgState>(); // old engineer id →
  readonly sites = new Map<string, SiteState>(); // old site id →
  readonly users = new Map<string, Types.ObjectId>(); // old supervisor id → user id
  readonly parties = new Map<string, PartyEntry>(); // `${kind}:${oldId}` →
  readonly partiesByOrg = new Map<string, PartyEntry[]>(); // org hex →
  readonly products = new Map<string, ProductEntry>(); // old product id →
  /** `${siteHex}|todo|work` → tracker created in this run (others are read from the target) */
  readonly trackers = new Map<string, { id: Types.ObjectId; columns: ColumnDoc[] }>();
  /** highest document number used per `${orgHex}|${PREFIX}-${year}` */
  readonly numbers = new Map<string, number>();

  constructor(
    readonly legacy: LegacyData,
    readonly dryRun: boolean,
    readonly tz: string,
  ) {
    this.report = new Report(dryRun, tz);
  }

  async loadIdMap() {
    const rows = await LegacyIdMap.find({}).lean<{ kind: string; oldId: string; newId: Types.ObjectId }[]>();
    for (const r of rows) this.idMap.set(`${r.kind}:${r.oldId}`, r.newId);
  }

  mapped(kind: MapKind, oldId: unknown): Types.ObjectId | undefined {
    return this.idMap.get(`${kind}:${String(oldId)}`);
  }

  /** Runs `fn` as one atomic unit; on failure reports the error and returns `{ ok: false }`. */
  async unit<T>(entity: Entity, oldId: unknown, fn: (tx: Tx) => Promise<T>): Promise<{ ok: true; value: T } | { ok: false }> {
    let tx!: Tx;
    try {
      let value: T;
      if (this.dryRun) {
        tx = new Tx(undefined, true);
        value = await fn(tx);
      } else {
        value = await withTransaction(async (session) => {
          tx = new Tx(session, false);
          const v = await fn(tx);
          if (tx.maps.length) await LegacyIdMap.create(tx.maps, { session, ordered: true });
          return v;
        });
      }
      for (const m of tx.maps) this.idMap.set(`${m.kind}:${m.oldId}`, m.newId);
      for (const [l, i] of tx.issues) this.report.add(l, i);
      for (const [e, f, n] of tx.counts) this.report.count(e, f, n);
      return { ok: true, value };
    } catch (err) {
      this.report.error(entity, oldId, errorMessage(err));
      return { ok: false };
    }
  }

  /** Remembers the highest sequence used for a document-number key. */
  useNumber(orgId: Types.ObjectId, prefix: string, year: string, seq: number) {
    const k = `${orgId.toHexString()}|${prefix}-${year}`;
    this.numbers.set(k, Math.max(this.numbers.get(k) ?? 0, seq));
  }

  addParty(key: string, p: PartyEntry) {
    this.parties.set(key, p);
    const list = this.partiesByOrg.get(p.org.orgId.toHexString()) ?? [];
    if (!list.includes(p)) list.push(p);
    this.partiesByOrg.set(p.org.orgId.toHexString(), list);
  }

  siteOf(oldSiteId: unknown): SiteState | undefined {
    return oldSiteId == null ? undefined : this.sites.get(String(oldSiteId));
  }
}

export function errorMessage(err: unknown): string {
  if (err instanceof mongoose.Error.ValidationError) {
    return `validation failed: ${Object.values(err.errors)
      .map((e) => `${e.path}: ${e.message}`)
      .join("; ")}`;
  }
  if ((err as { code?: number }).code === 11000) return `duplicate key: ${(err as Error).message}`;
  return err instanceof Error ? err.message : String(err);
}

export const newId = () => new Types.ObjectId();
