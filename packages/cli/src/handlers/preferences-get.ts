import { parseArgs } from "node:util";
import { loadPreferences } from "@phantompane/core";
import { exitCodes, exitWithError, exitWithSuccess } from "../errors.ts";
import { output } from "../output.ts";

const supportedKeys = [
  "editor",
  "ai",
  "worktreesDirectory",
  "directoryNameSeparator",
  "keepBranch",
] as const;

export async function preferencesGetHandler(args: string[]): Promise<void> {
  const { positionals } = parseArgs({
    args,
    options: {},
    strict: true,
    allowPositionals: true,
  });

  if (positionals.length !== 1) {
    exitWithError(
      "Usage: phantom preferences get <key>",
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
    const preferences = await loadPreferences();
    const value =
      inputKey === "editor"
        ? preferences.editor
        : inputKey === "ai"
          ? preferences.ai
          : inputKey === "worktreesDirectory"
            ? preferences.worktreesDirectory
            : inputKey === "directoryNameSeparator"
              ? preferences.directoryNameSeparator
              : inputKey === "keepBranch"
                ? preferences.keepBranch?.toString()
                : undefined;

    if (value === undefined) {
      output.log(
        `Preference '${inputKey}' is not set (git config --global phantom.${inputKey})`,
      );
    } else {
      output.log(value);
    }

    exitWithSuccess();
  } catch (error) {
    exitWithError(
      error instanceof Error ? error.message : String(error),
      exitCodes.generalError,
    );
  }
}
