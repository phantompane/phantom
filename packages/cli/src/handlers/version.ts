import { parseArgs } from "node:util";
import { exitWithSuccess } from "../errors.ts";
import { output } from "../output.ts";
import { getVersion } from "../version.ts";

export async function versionHandler(args: string[]): Promise<void> {
  parseArgs({
    args,
    options: {},
    strict: true,
    allowPositionals: false,
  });
  const version = getVersion();
  output.log(`Phantom v${version}`);
  exitWithSuccess();
}
