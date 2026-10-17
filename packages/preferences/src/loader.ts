import { configGetRegexp } from "@phantompane/git";
import type { Preferences } from "./keys.ts";

export class PreferencesValidationError extends Error {
  constructor(message: string) {
    super(`Invalid phantom preferences: ${message}`);
    this.name = "PreferencesValidationError";
  }
}

// scriptc 0.3 crashes while compiling zod. Git config values are parsed
// into the known preference fields directly; unknown keys are ignored.
export function parsePreferences(output: string): Preferences {
  if (!output) {
    return {};
  }

  const records = output.split("\0").filter((record) => record.length > 0);
  const preferences: Preferences = {};

  for (const record of records) {
    const newlineIndex = record.indexOf("\n");
    const separatorIndex =
      newlineIndex >= 0 ? newlineIndex : record.indexOf(" ");

    if (separatorIndex < 0) {
      continue;
    }

    const key = record.slice(0, separatorIndex);
    const value = record.slice(separatorIndex + 1);

    if (!key.startsWith("phantom.")) {
      continue;
    }

    const strippedKey = key.slice("phantom.".length).toLowerCase();

    if (strippedKey === "editor") {
      preferences.editor = value;
    } else if (strippedKey === "ai") {
      preferences.ai = value;
    } else if (strippedKey === "worktreesdirectory") {
      preferences.worktreesDirectory = value;
    } else if (strippedKey === "directorynameseparator") {
      preferences.directoryNameSeparator = value;
    } else if (strippedKey === "keepbranch") {
      if (value === "true" || value === "false") {
        preferences.keepBranch = value === "true";
      }
    } else if (strippedKey === "ghqdiscovery") {
      if (value === "true" || value === "false") {
        preferences.ghqDiscovery = value === "true";
      }
    }
  }

  return preferences;
}

export async function loadPreferences(): Promise<Preferences> {
  const stdout = await configGetRegexp({
    pattern: "^phantom\\.",
    global: true,
    nullSeparated: true,
  });

  return parsePreferences(stdout);
}
