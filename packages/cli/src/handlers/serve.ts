import { access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { startServer } from "@phantompane/server";
import { exitCodes, exitWithError } from "../errors.ts";
import { output } from "../output.ts";

const SERVE_PORT = 9640;

export async function serveHandler(args: string[] = []): Promise<void> {
  const { positionals } = parseArgs({
    args,
    options: {},
    strict: true,
    allowPositionals: true,
  });

  if (positionals.length > 0) {
    exitWithError("Usage: phantom serve", exitCodes.validationError);
  }

  const staticDir = await resolveGuiDistDirectory();

  if (!staticDir) {
    exitWithError(
      "Built GUI assets were not found. Run `pnpm build` before `phantom serve` in this repository checkout.",
      exitCodes.generalError,
    );
  }

  startServer({
    port: SERVE_PORT,
    staticDir,
  });

  output.log(
    `phantom serve experimental UI is available at http://127.0.0.1:${SERVE_PORT}`,
  );

  await new Promise(() => {});
}

async function resolveGuiDistDirectory(): Promise<string | null> {
  const executableDirectory = dirname(process.argv[1] ?? "");
  const candidates = [
    join(executableDirectory, "gui"),
    join(executableDirectory, "..", "..", "dist", "gui"),
    join(process.cwd(), "packages", "cli", "dist", "gui"),
  ];

  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      continue;
    }
  }

  return null;
}
