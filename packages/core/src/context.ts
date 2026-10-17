import { loadConfig, type PhantomConfig } from "@phantompane/config";
import { loadPreferences, type Preferences } from "@phantompane/preferences";
import { getWorktreesDirectory } from "./paths.ts";

export interface Context {
  gitRoot: string;
  worktreesDirectory: string;
  directoryNameSeparator: string;
  config: PhantomConfig | null;
  preferences: Preferences;
}

export async function createContext(gitRoot: string): Promise<Context> {
  const configResult = await loadConfig(gitRoot);
  let config: PhantomConfig | null = null;
  if (configResult.ok) {
    config = configResult.value;
  }
  const preferences = await loadPreferences();
  const worktreesDirectoryConfig = config?.worktreesDirectory;
  const worktreesDirectoryPreference = preferences.worktreesDirectory;
  const worktreesDirectory =
    worktreesDirectoryPreference ?? worktreesDirectoryConfig;
  const directoryNameSeparator =
    preferences.directoryNameSeparator || config?.directoryNameSeparator || "/";

  return {
    gitRoot,
    worktreesDirectory: getWorktreesDirectory(gitRoot, worktreesDirectory),
    directoryNameSeparator,
    config,
    preferences,
  };
}
