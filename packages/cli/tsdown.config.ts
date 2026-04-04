import { chmod, cp, mkdir, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
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

      const artifacts = [
        {
          source: resolve("..", "server", "dist"),
          target: join(ctx.options.outDir, "server"),
        },
        {
          source: resolve("..", "gui", "dist"),
          target: join(ctx.options.outDir, "gui"),
        },
      ];

      await Promise.all(
        artifacts.map(async ({ source, target }) => {
          await rm(target, { force: true, recursive: true });
          await mkdir(target, { recursive: true });
          await cp(source, target, { force: true, recursive: true });
        }),
      );
    },
  },
});
