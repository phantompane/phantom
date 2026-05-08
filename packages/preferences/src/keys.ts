export const supportedPreferenceKeys = [
  "editor",
  "ai",
  "worktreesDirectory",
  "directoryNameSeparator",
  "keepBranch",
] as const;

export type PreferenceKey = (typeof supportedPreferenceKeys)[number];

export interface Preferences {
  editor?: string;
  ai?: string;
  worktreesDirectory?: string;
  directoryNameSeparator?: string;
  keepBranch?: boolean;
}

export function isPreferenceKey(value: string): value is PreferenceKey {
  return supportedPreferenceKeys.includes(value as PreferenceKey);
}

export function getPreferenceConfigKey(
  key: PreferenceKey,
): `phantom.${PreferenceKey}` {
  return `phantom.${key}`;
}

export function getPreferenceValue(
  preferences: Preferences,
  key: PreferenceKey,
): string | undefined {
  const value = preferences[key];

  return typeof value === "boolean" ? value.toString() : value;
}

export function validatePreferenceValue(
  key: PreferenceKey,
  value: string,
): string | null {
  if (key === "keepBranch" && value !== "true" && value !== "false") {
    return "Preference 'keepBranch' must be 'true' or 'false'";
  }

  return null;
}
