import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/server/index.ts"],
  outDir: "dist",
  format: "esm",
  platform: "node",
  target: "node22",
  sourcemap: true,
  dts: false,
  clean: ["dist/server.js", "dist/server.js.map"],
  deps: {
    alwaysBundle: [/.*/],
  },
  fixedExtension: false,
});
