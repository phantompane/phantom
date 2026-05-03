import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts", "src/start.ts"],
  outDir: "dist",
  format: "esm",
  platform: "node",
  target: "node22",
  sourcemap: true,
  dts: false,
  clean: true,
  deps: {
    alwaysBundle: [/.*/],
  },
});
