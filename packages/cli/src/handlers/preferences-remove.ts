import { parseArgs } from "node:util";
import { configUnset } from "@phantompane/git";
import {
  getPreferenceConfigKey,
  isPreferenceKey,
  supportedPreferenceKeys,
} from "@phantompane/preferences";
import { exitCodes, exitWithError, exitWithSuccess } from "../errors.ts";
import { output } from "../output.ts";

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

  if (!isPreferenceKey(inputKey)) {
    exitWithError(
      `Unknown preference '${inputKey}'. Supported keys: ${supportedPreferenceKeys.join(", ")}`,
      exitCodes.validationError,
    );
  }

  try {
    const configKey = getPreferenceConfigKey(inputKey);

    await configUnset({
      key: configKey,
      global: true,
    });

    output.log(`Removed ${configKey} from global git config`);
    exitWithSuccess();
  } catch (error) {
    exitWithError(
      error instanceof Error ? error.message : String(error),
      exitCodes.generalError,
    );
  }
}
