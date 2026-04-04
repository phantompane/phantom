import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  outDir: "dist",
  format: "esm",
  platform: "node",
  target: "node22",
  sourcemap: true,
  dts: true,
  clean: true,
});
