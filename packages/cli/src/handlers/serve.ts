import { access, realpath } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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

    const currentModulePath = fileURLToPath(import.meta.url);
    const bundledEntrypoint =
      basename(currentModulePath) === "phantom.js" &&
      basename(dirname(currentModulePath)) === "dist"
        ? currentModulePath
        : process.argv[1]
          ? await realpath(process.argv[1])
          : currentModulePath;
    const serverEntry = fileURLToPath(
      new URL(
        "./app/.output/server/index.mjs",
        pathToFileURL(bundledEntrypoint),
      ),
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
