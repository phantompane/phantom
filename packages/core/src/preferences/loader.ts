import { configGetRegexp } from "@phantompane/git";
import { z } from "zod";

export interface Preferences {
  editor?: string;
  ai?: string;
  worktreesDirectory?: string;
  directoryNameSeparator?: string;
  keepBranch?: boolean;
}

export class PreferencesValidationError extends Error {
  constructor(message: string) {
    super(`Invalid phantom preferences: ${message}`);
    this.name = this.constructor.name;
  }
}

const preferencesSchema = z
  .object({
    editor: z.string().optional(),
    ai: z.string().optional(),
    worktreesDirectory: z.string().optional(),
    directoryNameSeparator: z.string().optional(),
    keepBranch: z.boolean().optional(),
  })
  .passthrough();

function parsePreferences(output: string): Preferences {
  if (!output) {
    return {};
  }

  // git config --null --get-regexp emits entries separated by \0.
  // Each entry is "key\nvalue" (newline-delimited) even with --null.
  const records = output.split("\0").filter((record) => record.length > 0);
  const preferences: Record<string, unknown> = {};

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
      preferences.keepBranch =
        value === "true" ? true : value === "false" ? false : undefined;
    }
  }

  const parsed = preferencesSchema.safeParse(preferences);

  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0];
    const message = firstIssue?.message ?? parsed.error.message;
    throw new PreferencesValidationError(message);
  }

  return parsed.data;
}

export async function loadPreferences(): Promise<Preferences> {
  const stdout = await configGetRegexp({
    pattern: "^phantom\\.",
    global: true,
    nullSeparated: true,
  });

  return parsePreferences(stdout);
}
