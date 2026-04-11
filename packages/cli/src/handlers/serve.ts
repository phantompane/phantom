import { parseArgs } from "node:util";
import { exitWithError } from "../errors.ts";
import { serveHelp } from "../help/serve.ts";
import { helpFormatter } from "../help.ts";
import { output } from "../output.ts";
import { resolveServeServerEntry, startServeServer } from "../serve.ts";

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
    if (values.host) {
      process.env.HOST = values.host;
      process.env.NITRO_HOST = values.host;
    }

    if (values.port) {
      process.env.PORT = values.port;
      process.env.NITRO_PORT = values.port;
    }

    const serverEntry = await resolveServeServerEntry();
    output.log(`Starting Phantom server from ${serverEntry}`);
    await startServeServer(serverEntry);
  } catch (error) {
    exitWithError(
      `Failed to start Phantom server: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
