import { cp, mkdir, readdir, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

const serverDirectory = join("..", "server");
const webDirectory = join("..", "web");
const serverOutputDirectory = join(serverDirectory, "dist");
const webOutputDirectory = join(webDirectory, "dist");
const serverEntry = join(serverOutputDirectory, "start.mjs");
const webIndex = join(webOutputDirectory, "index.html");
const targetAppDirectory = join("dist", "app");
const targetServerDirectory = join(targetAppDirectory, "server");
const targetWebDirectory = join(targetAppDirectory, "web");
const sourcePaths = [
  join(serverDirectory, "package.json"),
  join(serverDirectory, "src"),
  join(serverDirectory, "tsconfig.json"),
  join(webDirectory, "index.html"),
  join(webDirectory, "package.json"),
  join(webDirectory, "src"),
  join(webDirectory, "tsconfig.json"),
  join(webDirectory, "vite.config.ts"),
];

await assertFreshAppBuild();
await rm(targetAppDirectory, { recursive: true, force: true });
await mkdir(dirname(targetAppDirectory), { recursive: true });
await cp(serverOutputDirectory, targetServerDirectory, { recursive: true });
await cp(webOutputDirectory, targetWebDirectory, { recursive: true });

async function assertFreshAppBuild(): Promise<void> {
  const serverOutputStat = await stat(serverEntry).catch(() => null);
  const webOutputStat = await stat(webIndex).catch(() => null);
  if (!serverOutputStat || !webOutputStat) {
    throw new Error(
      "Phantom app assets are missing. Run `pnpm --filter @phantompane/server build` and `pnpm --filter @phantompane/web build` before building the CLI.",
    );
  }

  const sourceMtime = await getNewestMtime(sourcePaths);
  const oldestOutputMtime = Math.min(
    serverOutputStat.mtimeMs,
    webOutputStat.mtimeMs,
  );
  if (sourceMtime > oldestOutputMtime) {
    throw new Error(
      "Phantom app assets are stale. Run `pnpm --filter @phantompane/server build` and `pnpm --filter @phantompane/web build` before building the CLI.",
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
