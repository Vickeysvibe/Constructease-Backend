import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/server.ts", "src/worker.ts"],
  format: ["esm"],
  target: "node20",
  platform: "node",
  sourcemap: true,
  clean: true,
  splitting: false,
  publicDir: "src/templates",
  // dayjs ships CommonJS files without an exports map, so Node ESM can't resolve "dayjs/plugin/utc".
  // Bundling it sidesteps that; everything else stays a normal runtime dependency.
  noExternal: [/^dayjs/],
});
