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
