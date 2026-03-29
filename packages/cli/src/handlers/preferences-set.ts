import { configSet } from "@phantompane/git";
import { exitCodes, exitWithError, exitWithSuccess } from "../errors.ts";
import { output } from "../output.ts";

const supportedKeys = [
  "editor",
  "ai",
  "worktreesDirectory",
  "directoryNameSeparator",
  "keepBranch",
] as const;

export async function preferencesSetHandler(args: string[]): Promise<void> {
  if (args.length < 2) {
    exitWithError(
      "Usage: phantom preferences set <key> <value>",
      exitCodes.validationError,
    );
  }

  const [inputKey, ...valueParts] = args;

  if (!supportedKeys.includes(inputKey as (typeof supportedKeys)[number])) {
    exitWithError(
      `Unknown preference '${inputKey}'. Supported keys: ${supportedKeys.join(", ")}`,
      exitCodes.validationError,
    );
  }

  const value = valueParts.join(" ");

  if (!value) {
    exitWithError(
      `Preference '${inputKey}' requires a value`,
      exitCodes.validationError,
    );
  }

  if (inputKey === "keepBranch" && value !== "true" && value !== "false") {
    exitWithError(
      "Preference 'keepBranch' must be 'true' or 'false'",
      exitCodes.validationError,
    );
  }

  try {
    await configSet({
      key: `phantom.${inputKey}`,
      value,
      global: true,
    });

    output.log(`Set phantom.${inputKey} (global) to '${value}'`);
    exitWithSuccess();
  } catch (error) {
    exitWithError(
      error instanceof Error ? error.message : String(error),
      exitCodes.generalError,
    );
  }
}
