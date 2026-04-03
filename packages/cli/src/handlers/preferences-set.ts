import { configSet } from "@phantompane/git";
import {
  getPreferenceConfigKey,
  isPreferenceKey,
  supportedPreferenceKeys,
  validatePreferenceValue,
} from "@phantompane/preferences";
import { exitCodes, exitWithError, exitWithSuccess } from "../errors.ts";
import { output } from "../output.ts";

export async function preferencesSetHandler(args: string[]): Promise<void> {
  if (args.length < 2) {
    exitWithError(
      "Usage: phantom preferences set <key> <value>",
      exitCodes.validationError,
    );
  }

  const [inputKey, ...valueParts] = args;

  if (!isPreferenceKey(inputKey)) {
    exitWithError(
      `Unknown preference '${inputKey}'. Supported keys: ${supportedPreferenceKeys.join(", ")}`,
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

  const validationError = validatePreferenceValue(inputKey, value);
  if (validationError) {
    exitWithError(validationError, exitCodes.validationError);
  }

  try {
    const configKey = getPreferenceConfigKey(inputKey);

    await configSet({
      key: configKey,
      value,
      global: true,
    });

    output.log(`Set ${configKey} (global) to '${value}'`);
    exitWithSuccess();
  } catch (error) {
    exitWithError(
      error instanceof Error ? error.message : String(error),
      exitCodes.generalError,
    );
  }
}
