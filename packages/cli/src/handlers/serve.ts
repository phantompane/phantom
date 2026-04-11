import { access } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { exitWithError } from "../errors.ts";
import { serveHelp } from "../help/serve.ts";
import { helpFormatter } from "../help.ts";
import { output } from "../output.ts";

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
  const candidate = join(
    entryDirectory,
    "app",
    ".output",
    "server",
    "index.mjs",
  );

  if (await pathExists(candidate)) {
    return candidate;
  }

  throw new Error(
    "Could not find Phantom server assets. Run `pnpm --filter @phantompane/cli-private build` first.",
  );
}

export async function startServeServer(serverEntry: string): Promise<void> {
  await import(pathToFileURL(serverEntry).href);
}

export async function serveHandler(args: string[] = []): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      help: {
        type: "boolean",
        short: "h",
      },
      host: {
        type: "string",
      },
      port: {
        type: "string",
      },
    },
    strict: true,
    allowPositionals: false,
  });

  if (values.help) {
    console.log(helpFormatter.formatCommandHelp(serveHelp));
    return;
  }

  try {
    const port = values.port ?? "9640";

    if (values.host) {
      process.env.HOST = values.host;
      process.env.NITRO_HOST = values.host;
    }

    process.env.PORT = port;
    process.env.NITRO_PORT = port;

    const serverEntry = await resolveServeServerEntry();
    output.log(`Starting Phantom server from ${serverEntry}`);
    await startServeServer(serverEntry);
  } catch (error) {
    exitWithError(
      `Failed to start Phantom server: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
