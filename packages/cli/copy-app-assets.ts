import { cp, mkdir, readdir, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

const serverDirectory = join("..", "server");
const serverOutputDirectory = join(serverDirectory, "dist");
const serverEntry = join(serverOutputDirectory, "start.mjs");
const targetAppDirectory = join("dist", "app");
const targetServerDirectory = join(targetAppDirectory, "server");
const sourcePaths = [
  join(serverDirectory, "package.json"),
  join(serverDirectory, "src"),
  join(serverDirectory, "tsconfig.json"),
  join(serverDirectory, "tsdown.config.ts"),
];

await assertFreshAppBuild();
await rm(targetAppDirectory, { recursive: true, force: true });
await mkdir(dirname(targetAppDirectory), { recursive: true });
await cp(serverOutputDirectory, targetServerDirectory, { recursive: true });

async function assertFreshAppBuild(): Promise<void> {
  const serverOutputStat = await stat(serverEntry).catch(() => null);
  if (!serverOutputStat) {
    throw new Error(
      "Phantom server assets are missing. Run `pnpm --filter @phantompane/server build` before building the CLI.",
    );
  }

  const sourceMtime = await getNewestMtime(sourcePaths);
  if (sourceMtime > serverOutputStat.mtimeMs) {
    throw new Error(
      "Phantom server assets are stale. Run `pnpm --filter @phantompane/server build` before building the CLI.",
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
