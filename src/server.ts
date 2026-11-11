import { config } from "./core/config";
import { connectDb, disconnectDb } from "./core/db";
import { logger } from "./core/logger";
import { createApp } from "./app";

async function main() {
  await connectDb(); // refuse to serve traffic without a database
  const server = createApp().listen(config.PORT, () => logger.info({ port: config.PORT }, "api listening"));

  const shutdown = (signal: string) => {
    logger.info({ signal }, "shutting down");
    server.close(async () => {
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
