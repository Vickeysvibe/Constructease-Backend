import { config, resolveChromePath, runJobsInApi } from "./core/config";
import { startJobLoop } from "./core/jobs";
import { connectDb, disconnectDb } from "./core/db";
import { logger } from "./core/logger";
import { createApp } from "./app";

async function main() {
  await connectDb(); // refuse to serve traffic without a database
  const server = createApp().listen(config.PORT, () => logger.info({ port: config.PORT }, "api listening"));
  // Development convenience: no separate worker needed for PDFs and exports. Production runs `dist/worker.js`.
  const stopJobs = runJobsInApi ? startJobLoop() : null;
  if (runJobsInApi) {
    logger.info({ chrome: resolveChromePath() || "not found", remote: Boolean(config.PDF_BROWSER_WS_ENDPOINT) }, "running jobs in the API process");
  }

  const shutdown = (signal: string) => {
    logger.info({ signal }, "shutting down");
    server.close(async () => {
      await stopJobs?.();
      await disconnectDb();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

process.on("unhandledRejection", (err) => logger.error({ err }, "unhandled rejection"));

main().catch((err) => {
  logger.fatal({ err }, "failed to start");
  process.exit(1);
});
