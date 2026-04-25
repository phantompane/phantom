import { cp, mkdir, readdir, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

const appDirectory = join("..", "app");
const appOutputDirectory = join(appDirectory, ".output");
const appServerEntry = join(appOutputDirectory, "server", "index.mjs");
const targetOutputDirectory = join("dist", "app", ".output");
const sourcePaths = [
  join(appDirectory, "package.json"),
  join(appDirectory, "src"),
  join(appDirectory, "tsconfig.json"),
  join(appDirectory, "vite.config.ts"),
];

await assertFreshAppBuild();
await rm(targetOutputDirectory, { recursive: true, force: true });
await mkdir(dirname(targetOutputDirectory), { recursive: true });
await cp(appOutputDirectory, targetOutputDirectory, { recursive: true });

async function assertFreshAppBuild(): Promise<void> {
  const outputStat = await stat(appServerEntry).catch(() => null);
  if (!outputStat) {
    throw new Error(
      "Phantom app assets are missing. Run `pnpm --filter app-private build` before building the CLI.",
    );
  }

  const sourceMtime = await getNewestMtime(sourcePaths);
  if (sourceMtime > outputStat.mtimeMs) {
    throw new Error(
      "Phantom app assets are stale. Run `pnpm --filter app-private build` before building the CLI.",
    );
  }
}

async function getNewestMtime(paths: string[]): Promise<number> {
  const mtimes = await Promise.all(paths.map((path) => getPathMtime(path)));
  return Math.max(...mtimes);
}

async function getPathMtime(path: string): Promise<number> {
  const pathStat = await stat(path);
  if (!pathStat.isDirectory()) {
    return pathStat.mtimeMs;
  }

  const entries = await readdir(path, { withFileTypes: true });
  const childMtimes = await Promise.all(
    entries.map((entry) => getPathMtime(join(path, entry.name))),
  );
  return Math.max(pathStat.mtimeMs, ...childMtimes);
}
