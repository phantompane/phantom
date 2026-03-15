import { isOk } from "@phantompane/shared";
import { loadConfig, type PhantomConfig } from "./config/loader.ts";
import { getWorktreesDirectory } from "./paths.ts";
import { loadPreferences, type Preferences } from "./preferences/loader.ts";

export interface Context {
  gitRoot: string;
  worktreesDirectory: string;
  directoryNameSeparator?: string;
  config: PhantomConfig | null;
  preferences: Preferences;
}

export async function createContext(gitRoot: string): Promise<Context> {
  const configResult = await loadConfig(gitRoot);
  const config = isOk(configResult) ? configResult.value : null;
  const preferences = await loadPreferences();
  const worktreesDirectoryConfig = config?.worktreesDirectory;
  const worktreesDirectoryPreference = preferences.worktreesDirectory;
  const worktreesDirectory =
    worktreesDirectoryPreference ?? worktreesDirectoryConfig;
  const directoryNameSeparator =
    preferences.directoryNameSeparator ?? config?.directoryNameSeparator;

  return {
    gitRoot,
    worktreesDirectory: getWorktreesDirectory(gitRoot, worktreesDirectory),
    directoryNameSeparator,
    config,
    preferences,
  };
}
