import pino from "pino";
import { config, isTest } from "./config";

export const logger = pino({
  level: isTest ? "silent" : config.LOG_LEVEL,
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      'res.headers["set-cookie"]',
      "*.password",
      "*.passwordHash",
      "*.newPassword",
      "*.currentPassword",
    ],
    censor: "[redacted]",
  },
});
