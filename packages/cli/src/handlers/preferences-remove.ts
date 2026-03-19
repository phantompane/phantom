import { parseArgs } from "node:util";
import { configUnset } from "@phantompane/git";
import { exitCodes, exitWithError, exitWithSuccess } from "../errors.ts";
import { output } from "../output.ts";

const supportedKeys = [
  "editor",
  "ai",
  "worktreesDirectory",
  "directoryNameSeparator",
] as const;

export async function preferencesRemoveHandler(args: string[]): Promise<void> {
  const { positionals } = parseArgs({
    args,
    options: {},
    strict: true,
    allowPositionals: true,
  });

  if (positionals.length !== 1) {
    exitWithError(
      "Usage: phantom preferences remove <key>",
      exitCodes.validationError,
    );
  }

  const inputKey = positionals[0];

  if (!supportedKeys.includes(inputKey as (typeof supportedKeys)[number])) {
    exitWithError(
      `Unknown preference '${inputKey}'. Supported keys: ${supportedKeys.join(", ")}`,
      exitCodes.validationError,
    );
  }

  try {
    await configUnset({
      key: `phantom.${inputKey}`,
      global: true,
    });

    output.log(`Removed phantom.${inputKey} from global git config`);
    exitWithSuccess();
  } catch (error) {
    exitWithError(
      error instanceof Error ? error.message : String(error),
      exitCodes.generalError,
    );
  }
}
