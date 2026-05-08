import { parseArgs } from "node:util";
import {
  getPreferenceConfigKey,
  getPreferenceValue,
  isPreferenceKey,
  loadPreferences,
  supportedPreferenceKeys,
} from "@phantompane/preferences";
import { exitCodes, exitWithError, exitWithSuccess } from "../errors.ts";
import { output } from "../output.ts";

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

  if (!isPreferenceKey(inputKey)) {
    exitWithError(
      `Unknown preference '${inputKey}'. Supported keys: ${supportedPreferenceKeys.join(", ")}`,
      exitCodes.validationError,
    );
  }

  try {
    const preferences = await loadPreferences();
    const value = getPreferenceValue(preferences, inputKey);

    if (value === undefined) {
      output.log(
        `Preference '${inputKey}' is not set (git config --global ${getPreferenceConfigKey(inputKey)})`,
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
