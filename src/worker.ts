import { connectDb, disconnectDb } from "./core/db";
import { runNextJob } from "./core/jobs";
import { logger } from "./core/logger";
import "./modules"; // registers job handlers

let stopping = false;

async function main() {
  await connectDb();
  logger.info("worker started");
  while (!stopping) {
    const worked = await runNextJob().catch((err) => {
      logger.error({ err }, "worker loop error");
      return false;
    });
    if (!worked) await new Promise((r) => setTimeout(r, 1000));
  }
  await disconnectDb();
}

for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    stopping = true;
  });
}

main().catch((err) => {
  logger.fatal({ err }, "worker failed to start");
  process.exit(1);
});
