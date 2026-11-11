import crypto from "node:crypto";
import mongoose from "mongoose";

// Test files share one process (singleFork) but re-import src/: clear models registered by the previous file.
for (const name of mongoose.modelNames()) mongoose.deleteModel(name);

// Runs before every test file, before any app module is imported. Secrets are generated per run.
process.env.NODE_ENV = "test";
process.env.MONGODB_URI = process.env.TEST_MONGODB_URI ?? "mongodb://invalid";
process.env.JWT_ACCESS_SECRET = crypto.randomBytes(48).toString("base64");
process.env.LOGIN_RATE_LIMIT_PER_MIN = "10000";
process.env.CORS_ORIGINS = "http://localhost:5173";
