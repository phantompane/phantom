export const supportedPreferenceKeys = [
  "editor",
  "ai",
  "worktreesDirectory",
  "directoryNameSeparator",
  "keepBranch",
  "ghqDiscovery",
] as const;

export type PreferenceKey = (typeof supportedPreferenceKeys)[number];

export interface Preferences {
  editor?: string;
  ai?: string;
  worktreesDirectory?: string;
  directoryNameSeparator?: string;
  keepBranch?: boolean;
  ghqDiscovery?: boolean;
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
  switch (key) {
    case "editor":
      return preferences.editor;
    case "ai":
      return preferences.ai;
    case "worktreesDirectory":
      return preferences.worktreesDirectory;
    case "directoryNameSeparator":
      return preferences.directoryNameSeparator;
    case "keepBranch":
      return preferences.keepBranch === undefined
        ? undefined
        : String(preferences.keepBranch);
    case "ghqDiscovery":
      return preferences.ghqDiscovery === undefined
        ? undefined
        : String(preferences.ghqDiscovery);
  }
}

export function validatePreferenceValue(
  key: PreferenceKey,
  value: string,
): string | null {
  if (
    (key === "keepBranch" || key === "ghqDiscovery") &&
    value !== "true" &&
    value !== "false"
  ) {
    return `Preference '${key}' must be 'true' or 'false'`;
  }

  return null;
}
