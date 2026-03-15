import { chmod, readdir } from "node:fs/promises";
import { join } from "node:path";
import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/bin/*.ts"],
  root: "src/bin",
  outDir: "dist",
  format: "esm",
  platform: "node",
  target: "node22",
  sourcemap: true,
  dts: false,
  clean: ["dist/*.js", "dist/*.js.map"],
  deps: {
    alwaysBundle: [/.*/],
  },
  fixedExtension: false,
  hooks: {
    async "build:done"(ctx) {
      const outputFiles = await readdir(ctx.options.outDir);

      await Promise.all(
        outputFiles
          .filter((file) => file.endsWith(".js"))
          .map((file) => chmod(join(ctx.options.outDir, file), 0o755)),
      );
    },
  },
});
