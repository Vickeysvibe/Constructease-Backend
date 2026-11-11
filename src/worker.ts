import { connectDb, disconnectDb } from "./core/db";
import { startJobLoop } from "./core/jobs";
import { logger } from "./core/logger";
import "./modules"; // registers job handlers

async function main() {
  await connectDb();
  logger.info("worker started");
  const stop = startJobLoop();
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.on(sig, async () => {
      await stop();
      await disconnectDb();
      process.exit(0);
    });
  }
}

main().catch((err) => {
  logger.fatal({ err }, "worker failed to start");
  process.exit(1);
});
