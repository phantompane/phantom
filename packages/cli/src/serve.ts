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
  let currentDirectory = resolve(
    entryPath ? dirname(entryPath) : process.cwd(),
  );

  while (true) {
    const candidate = join(
      currentDirectory,
      "app",
      ".output",
      "server",
      "index.mjs",
    );

    if (await pathExists(candidate)) {
      return candidate;
    }

    const parentDirectory = dirname(currentDirectory);
    if (parentDirectory === currentDirectory) {
      break;
    }

    currentDirectory = parentDirectory;
  }

  throw new Error(
    "Could not find Phantom server assets. Run `pnpm --filter @phantompane/cli-private build` first.",
  );
}

export async function startServeServer(serverEntry: string): Promise<void> {
  await import(pathToFileURL(serverEntry).href);
}
