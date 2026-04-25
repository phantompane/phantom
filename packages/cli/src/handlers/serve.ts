import { access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { exitWithError } from "../errors.ts";
import { serveHelp } from "../help/serve.ts";
import { helpFormatter } from "../help.ts";
import { output } from "../output.ts";

function validateCommandAvailable(command: string): void {
  const result = spawnSync(command, ["--version"], {
    stdio: "ignore",
  });
  if (result.error) {
    throw new Error(`Could not find Codex executable '${command}'.`);
  }
}

function openBrowser(url: string): void {
  const command =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "cmd"
        : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];

  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
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
      "codex-bin": {
        type: "string",
      },
      "data-dir": {
        type: "string",
      },
      open: {
        type: "boolean",
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
    const host = values.host ?? "127.0.0.1";
    const codexBin = values["codex-bin"] ?? "codex";

    validateCommandAvailable(codexBin);

    output.warn(
      "Warning: `phantom serve` is experimental and may change without notice.",
    );

    process.env.HOST = host;
    process.env.NITRO_HOST = host;

    process.env.PORT = port;
    process.env.NITRO_PORT = port;
    process.env.PHANTOM_SERVE_CODEX_BIN = codexBin;

    if (values["data-dir"]) {
      process.env.PHANTOM_SERVE_DATA_DIR = values["data-dir"];
    }

    const bundledEntrypoint = fileURLToPath(import.meta.url);
    const serverEntry = join(
      dirname(bundledEntrypoint),
      "app",
      ".output",
      "server",
      "index.mjs",
    );

    try {
      await access(serverEntry);
    } catch {
      throw new Error("Could not find Phantom server assets.");
    }

    const url = `http://${host}:${port}`;
    output.log(`Starting Phantom server from ${serverEntry}`);
    output.log(`Phantom server listening at ${url}`);
    if (values.open) {
      openBrowser(url);
    }
    await import(pathToFileURL(serverEntry).href);
  } catch (error) {
    exitWithError(
      `Failed to start Phantom server: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
