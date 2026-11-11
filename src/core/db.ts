import mongoose, { type ClientSession, type Schema } from "mongoose";
import { config } from "./config";
import { logger } from "./logger";

// strictQuery drops unknown filter keys. Operator injection is prevented at the edge:
// every request input is parsed by zod into primitives before it reaches a query.
mongoose.set("strictQuery", true);

/**
 * Tenant guard: every query on a tenant-owned model must filter by orgId.
 * A forgotten scope throws instead of silently returning another org's data.
 * Opt out per query with `.setOptions({ skipTenantGuard: true })` (login, worker, migrations only).
 */
export function tenantGuard(schema: Schema) {
  const ops = [
    "find",
    "findOne",
    "countDocuments",
    "distinct",
    "updateOne",
    "updateMany",
    "findOneAndUpdate",
    "replaceOne",
    "deleteOne",
    "deleteMany",
    "findOneAndDelete",
    "findOneAndReplace",
  ] as const;
  schema.pre(ops as unknown as RegExp, function (this: mongoose.Query<unknown, unknown>) {
    const opts = this.getOptions() as { skipTenantGuard?: boolean };
    if (opts.skipTenantGuard) return;
    const filter = this.getFilter() as Record<string, unknown>;
    if (filter.orgId === undefined || filter.orgId === null) {
      throw new Error(`tenantGuard: ${this.model.modelName}.${(this as unknown as { op: string }).op} without orgId`);
    }
  });
  schema.pre("aggregate", function () {
    const opts = this.options as { skipTenantGuard?: boolean };
    if (opts.skipTenantGuard) return;
    const first = this.pipeline()[0] as { $match?: Record<string, unknown> } | undefined;
    if (!first?.$match || first.$match.orgId === undefined || first.$match.orgId === null) {
      throw new Error(`tenantGuard: ${this.model().modelName}.aggregate must start with $match on orgId`);
    }
  });
}

export async function connectDb(uri = config.MONGODB_URI): Promise<void> {
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10_000 });
  logger.info({ db: mongoose.connection.name }, "mongo connected");
  await Promise.all(Object.values(mongoose.models).map((m) => m.syncIndexes()));
}

export async function disconnectDb(): Promise<void> {
  await mongoose.disconnect();
}

/** Run `fn` in a multi-document transaction. `fn` may be retried on transient errors: keep it side-effect free outside the DB. */
export async function withTransaction<T>(fn: (session: ClientSession) => Promise<T>): Promise<T> {
  const session = await mongoose.startSession();
  try {
    let result!: T;
    await session.withTransaction(async () => {
      result = await fn(session);
    });
    return result;
  } finally {
    await session.endSession();
  }
}

export const oid = (id: string | mongoose.Types.ObjectId) =>
  typeof id === "string" ? new mongoose.Types.ObjectId(id) : id;

/**
 * Converts lean documents to API shape: `_id` → `id`, ObjectIds → strings, Dates → ISO strings,
 * drops `__v` and `orgId`. Works recursively on arrays and nested objects.
 */
export function serialize<T = unknown>(value: unknown): T {
  return walk(value) as T;
}

function walk(v: unknown): unknown {
  if (v === null || v === undefined) return v;
  if (v instanceof mongoose.Types.ObjectId) return v.toHexString();
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.map(walk);
  if (v instanceof Map) return walk(Object.fromEntries(v));
  if (typeof v === "object") {
    if ((v as { _bsontype?: string })._bsontype === "ObjectId") return String(v);
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (k === "__v" || k === "orgId") continue;
      if (k === "_id") out.id = walk(val);
      else out[k] = walk(val);
    }
    return out;
  }
  return v;
}
