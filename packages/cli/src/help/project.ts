import type { CommandHelp } from "../help.ts";

export const projectHelp: CommandHelp = {
  name: "project",
  description: "Manage registered Git projects",
  usage: "phantom project <subcommand> [options]",
  examples: [
    {
      description: "Register the current Git repository",
      command: "phantom project add",
    },
    {
      description: "List registered projects for an AI agent",
      command: "phantom project list --json",
    },
    {
      description: "Remove a project from the registry",
      command:
        "phantom project remove proj_550e8400-e29b-41d4-a716-446655440000",
    },
  ],
  notes: [
    "Available subcommands: add, list, remove",
    "Removing a project only updates Phantom's registry; it never deletes the Git repository.",
  ],
};

export const projectAddHelp: CommandHelp = {
  name: "project add",
  description: "Register a Git repository as a Phantom project",
  usage: "phantom project add [path] [options]",
  options: [
    {
      name: "json",
      type: "boolean",
      description: "Output the result as JSON",
    },
  ],
  notes: [
    "When path is omitted, the current directory is used.",
    "Adding an already registered repository succeeds without creating a duplicate.",
  ],
};

export const projectListHelp: CommandHelp = {
  name: "project list",
  description: "List registered Phantom projects",
  usage: "phantom project list [options]",
  options: [
    {
      name: "json",
      type: "boolean",
      description: "Output a versioned JSON object for automation",
    },
    {
      name: "names",
      type: "boolean",
      description: "Output only project names",
    },
    {
      name: "paths",
      type: "boolean",
      description: "Output only project root paths",
    },
  ],
  notes: ["Only one output format option can be used at a time."],
};

export const projectRemoveHelp: CommandHelp = {
  name: "project remove",
  description: "Remove a Git project from Phantom's registry",
  usage: "phantom project remove <id|name|path> [options]",
  options: [
    {
      name: "json",
      type: "boolean",
      description: "Output the result as JSON",
    },
  ],
  notes: [
    "The project can be specified by id, name, or root path.",
    "If a name matches multiple projects, use an id or path instead.",
    "This command never deletes the Git repository or its worktrees.",
  ],
};
