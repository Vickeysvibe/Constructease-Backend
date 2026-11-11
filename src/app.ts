import express, { Router } from "express";
import helmet from "helmet";
import cors from "cors";
import cookieParser from "cookie-parser";
import { pinoHttp } from "pino-http";
import mongoose from "mongoose";
import { config, isTest } from "./core/config";
import { logger } from "./core/logger";
import { errorHandler, notFoundHandler } from "./core/errors";
import { requireAuth } from "./core/auth";
import { siteScope } from "./core/access";
import { authRouter } from "./modules/identity/routes";
import { modules } from "./modules";

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use(helmet());
  app.use(
    cors({
      origin: (origin, cb) => cb(null, !origin || config.CORS_ORIGINS.includes(origin)),
      credentials: true,
      allowedHeaders: ["Content-Type", "Authorization", "Idempotency-Key", "X-CE-CSRF"],
      exposedHeaders: ["Content-Disposition"],
      maxAge: 600,
    }),
  );
  if (!isTest) app.use(pinoHttp({ logger, autoLogging: { ignore: (req) => req.url === "/healthz" } }));
  app.use(express.json({ limit: "1mb" }));
  app.use(cookieParser());

  app.get("/healthz", async (_req, res) => {
    const up = mongoose.connection.readyState === 1;
    res.status(up ? 200 : 503).json({ ok: up });
  });

  const api = Router();
  api.use("/auth", authRouter());
  api.use(requireAuth);

  const site = Router({ mergeParams: true });
  site.use(siteScope);
  for (const m of modules) {
    m.org?.(api);
    m.site?.(site);
  }
  api.use("/sites/:siteId", site);

  app.use("/api/v1", api);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
