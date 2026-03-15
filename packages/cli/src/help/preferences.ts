import type { CommandHelp } from "../help.ts";

export const preferencesHelp: CommandHelp = {
  name: "preferences",
  usage: "phantom preferences <subcommand>",
  description: "Manage phantom user preferences stored in git config (global)",
  examples: [
    {
      command: "phantom preferences get editor",
      description: "Show the configured editor preference",
    },
    {
      command: "phantom preferences set editor code",
      description:
        "Set the editor preference (stored as phantom.editor in git config --global)",
    },
    {
      command: 'phantom preferences set ai "codex --full-auto"',
      description:
        "Set the AI assistant preference (stored as phantom.ai in git config --global)",
    },
    {
      command:
        "phantom preferences set worktreesDirectory ../phantom-worktrees",
      description:
        "Store a custom worktreesDirectory (relative to the Git repository root) for all commands",
    },
    {
      command: 'phantom preferences set directoryNameSeparator "-"',
      description:
        "Store a separator for flattening worktree directory names while keeping branch names unchanged",
    },
    {
      command: "phantom preferences remove editor",
      description: "Remove the editor preference (fallback to env/default)",
    },
  ],
  notes: [
    "Subcommands:",
    "  get <key>    Show a preference value",
    "  set <key>    Set a preference value",
    "  remove <key> Remove a preference value",
    "",
    "Preferences are saved in git config with the 'phantom.' prefix (global scope).",
    "Supported keys:",
    "  editor - used by 'phantom edit', preferred over $EDITOR",
    "  ai - used by 'phantom ai'",
    "  worktreesDirectory - path relative to the Git repo root for storing worktrees (defaults to .git/phantom/worktrees)",
    "  directoryNameSeparator - replaces '/' in worktree directory names only (defaults to / for nested directories)",
  ],
};

export const preferencesGetHelp: CommandHelp = {
  name: "preferences get",
  usage: "phantom preferences get <key>",
  description:
    "Show a preference value (reads git config --global phantom.<key>)",
  examples: [
    {
      command: "phantom preferences get editor",
      description: "Show the editor preference",
    },
    {
      command: "phantom preferences get ai",
      description: "Show the AI assistant preference",
    },
    {
      command: "phantom preferences get worktreesDirectory",
      description:
        "Show the preferred worktrees directory (relative to repo root)",
    },
    {
      command: "phantom preferences get directoryNameSeparator",
      description: "Show the preferred worktree directory name separator",
    },
  ],
  notes: [
    "Supported keys: editor, ai, worktreesDirectory, directoryNameSeparator",
  ],
};

export const preferencesSetHelp: CommandHelp = {
  name: "preferences set",
  usage: "phantom preferences set <key> <value>",
  description:
    "Set a preference value (writes git config --global phantom.<key>)",
  examples: [
    {
      command: "phantom preferences set editor code",
      description: "Set VS Code as the editor",
    },
    {
      command: "phantom preferences set ai claude",
      description: "Configure the AI assistant command",
    },
    {
      command:
        "phantom preferences set worktreesDirectory ../phantom-worktrees",
      description:
        "Store worktrees in ../phantom-worktrees relative to the Git repository root",
    },
    {
      command: 'phantom preferences set directoryNameSeparator "-"',
      description:
        "Flatten worktree directory names such as feature/test to feature-test",
    },
  ],
  notes: [
    "Supported keys: editor, ai, worktreesDirectory, directoryNameSeparator",
    "For worktreesDirectory, provide a path relative to the Git repository root; defaults to .git/phantom/worktrees when unset",
    "For directoryNameSeparator, '/' keeps nested directories; any other string replaces '/' only in the directory path",
  ],
};

export const preferencesRemoveHelp: CommandHelp = {
  name: "preferences remove",
  usage: "phantom preferences remove <key>",
  description:
    "Remove a preference value (git config --global --unset phantom.<key>)",
  examples: [
    {
      command: "phantom preferences remove editor",
      description: "Unset the editor preference",
    },
    {
      command: "phantom preferences remove ai",
      description: "Unset the AI assistant preference",
    },
    {
      command: "phantom preferences remove worktreesDirectory",
      description: "Unset the custom worktrees directory preference",
    },
    {
      command: "phantom preferences remove directoryNameSeparator",
      description:
        "Restore nested worktree directories that follow branch slashes",
    },
  ],
  notes: [
    "Supported keys: editor, ai, worktreesDirectory, directoryNameSeparator",
  ],
};
