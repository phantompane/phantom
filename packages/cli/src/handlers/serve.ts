import { access } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { exitWithError } from "../errors.ts";
import { serveHelp } from "../help/serve.ts";
import { helpFormatter } from "../help.ts";
import { output } from "../output.ts";

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

    output.warn(
      "Warning: `phantom serve` is experimental and may change without notice.",
    );

    if (values.host) {
      process.env.HOST = values.host;
      process.env.NITRO_HOST = values.host;
    }

    process.env.PORT = port;
    process.env.NITRO_PORT = port;

    const entryDirectory = resolve(
      process.argv[1] ? dirname(process.argv[1]) : process.cwd(),
    );
    const serverEntry = join(
      entryDirectory,
      "app",
      ".output",
      "server",
      "index.mjs",
    );

    try {
      await access(serverEntry);
    } catch {
      throw new Error(
        "Could not find Phantom server assets. Run `pnpm --filter @phantompane/cli-private build` first.",
      );
    }

    output.log(`Starting Phantom server from ${serverEntry}`);
    await import(pathToFileURL(serverEntry).href);
  } catch (error) {
    exitWithError(
      `Failed to start Phantom server: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
