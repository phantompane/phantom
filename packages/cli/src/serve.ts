import { access } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function resolveServeServerEntry(
  entryPath: string | undefined = process.argv[1],
): Promise<string> {
  const entryDirectory = resolve(
    entryPath ? dirname(entryPath) : process.cwd(),
  );
  const candidates = [
    join(entryDirectory, "app", ".output", "server", "index.mjs"),
    join(
      entryDirectory,
      "..",
      "..",
      "dist",
      "app",
      ".output",
      "server",
      "index.mjs",
    ),
  ];

  for (const candidate of candidates) {
    if (await pathExists(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    "Could not find Phantom server assets. Run `pnpm --filter @phantompane/cli-private build` first.",
  );
}

export async function startServeServer(serverEntry: string): Promise<void> {
  await import(pathToFileURL(serverEntry).href);
}
