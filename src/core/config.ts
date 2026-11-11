import "dotenv/config";
import { z } from "zod";

const bool = z
  .enum(["true", "false", "1", "0", ""])
  .optional()
  .transform((v) => v === "true" || v === "1");

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(8000),
  MONGODB_URI: z.string().min(1, "MONGODB_URI is required"),
  JWT_ACCESS_SECRET: z.string().min(32, "JWT_ACCESS_SECRET must be at least 32 characters"),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(30),
  CORS_ORIGINS: z
    .string()
    .default("http://localhost:5173")
    .transform((s) => s.split(",").map((o) => o.trim()).filter(Boolean)),
  COOKIE_SAMESITE: z.enum(["lax", "strict", "none"]).default("lax"),
  COOKIE_SECURE: bool,
  LOGIN_RATE_LIMIT_PER_MIN: z.coerce.number().int().positive().default(10),
  PDF_BROWSER_WS_ENDPOINT: z.string().optional().default(""),
  CHROME_PATH: z.string().optional().default(""),
  GEOCODER_URL: z.string().optional().default(""),
  GEOCODER_USER_AGENT: z.string().optional().default("ConstructEase/2.0"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
});

export type Config = z.infer<typeof schema>;

function load(): Config {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    // Fail fast: never start a half-configured server.
    throw new Error(`Invalid configuration:\n${lines}`);
  }
  const cfg = parsed.data;
  if (cfg.COOKIE_SAMESITE === "none" && !cfg.COOKIE_SECURE) {
    throw new Error("Invalid configuration: COOKIE_SAMESITE=none requires COOKIE_SECURE=true");
  }
  return cfg;
}

export const config = load();
export const isTest = config.NODE_ENV === "test";
export const isProd = config.NODE_ENV === "production";
