import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { exitWithError } from "../errors.ts";
import { helpFormatter } from "../help.ts";
import { serveHelp } from "../help/serve.ts";

export async function serveHandler(args: string[] = []): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      help: {
        type: "boolean",
        short: "h",
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
    process.env.PORT ??= "9640";

    const require = createRequire(import.meta.url);
    let serverPath: string;

    try {
      serverPath = require.resolve("@phantompane/server/server.js");
    } catch {
      serverPath = resolve(
        import.meta.dirname,
        "..",
        "..",
        "..",
        "server",
        "dist",
        "server.js",
      );
    }

    await import(pathToFileURL(serverPath).href);
  } catch (error) {
    exitWithError(
      `Failed to start standalone server: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
