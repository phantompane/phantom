import { execFile } from "node:child_process";
import { chmod, cp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { defineConfig } from "tsdown";

const execFileAsync = promisify(execFile);
const packageManagerCommand =
  process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const appOutputDirectory = join("..", "app", ".output");

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
      await execFileAsync(packageManagerCommand, [
        "--filter",
        "app-private",
        "build",
      ]);

      const bundledAppDirectory = join(ctx.options.outDir, "app");

      await rm(bundledAppDirectory, { recursive: true, force: true });
      await cp(appOutputDirectory, join(bundledAppDirectory, ".output"), {
        recursive: true,
      });

      const outputFiles = await readdir(ctx.options.outDir);

      await Promise.all(
        outputFiles
          .filter((file) => file.endsWith(".js"))
          .map((file) => chmod(join(ctx.options.outDir, file), 0o755)),
      );
    },
  },
});
