/**
 * Legacy data migration CLI. Target = MONGODB_URI (config); source = the old app's database.
 *   npm run migrate:legacy -- --source-uri "mongodb://…/constructease_old" [--dry-run] [--org-tz Asia/Kolkata] [--report-dir .]
 * See docs/MIGRATION.md.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import mongoose from "mongoose";
import { config } from "@/core/config";
import { assertNotLegacyDatabase, connectDb, disconnectDb } from "@/core/db";
import { DEFAULT_TZ, dayjs } from "@/core/units";
import { migrate } from "./migrate";

export { migrate } from "./migrate";

async function main() {
  const { values } = parseArgs({
    options: {
      "source-uri": { type: "string" },
      "dry-run": { type: "boolean", default: false },
      "org-tz": { type: "string", default: DEFAULT_TZ },
      "report-dir": { type: "string", default: "." },
    },
  });
  const sourceUri = values["source-uri"];
  if (!sourceUri) throw new Error("Usage: npm run migrate:legacy -- --source-uri <old mongo uri> [--dry-run] [--org-tz Asia/Kolkata]");
  const tz = values["org-tz"]!;
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
  } catch {
    throw new Error(`Unknown timezone: ${tz}`);
  }
  const dryRun = Boolean(values["dry-run"]);

  // A dry run must not write anything, not even indexes: connect without syncing them.
  if (dryRun) {
    await mongoose.connect(config.MONGODB_URI, { serverSelectionTimeoutMS: 10_000, autoIndex: false, autoCreate: false });
    await assertNotLegacyDatabase(); // the target must be the new database, never the old one
  }
  else await connectDb();
  const source = await mongoose.createConnection(sourceUri, { serverSelectionTimeoutMS: 10_000 }).asPromise();
  try {
    const report = await migrate({ source, dryRun, tz });
    console.log(report.format());
    const file = path.resolve(values["report-dir"]!, `migration-report-${dayjs().format("YYYYMMDD-HHmmss")}.json`);
    await fs.writeFile(file, JSON.stringify(report, null, 2));
    console.log(`\nFull report: ${file}`);
    const errors = report.issues.errors.length;
    if (errors) process.exitCode = 2;
  } finally {
    await source.close();
    await disconnectDb();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(async (err) => {
    console.error(err instanceof Error ? err.message : err);
    await disconnectDb().catch(() => undefined);
    process.exit(1);
  });
}
