import type { CommandHelp } from "../help.ts";

export const projectHelp: CommandHelp = {
  name: "project",
  description: "Manage Phantom projects",
  usage: "phantom project <subcommand> [options]",
  examples: [
    {
      description: "List registered projects",
      command: "phantom project list",
    },
    {
      description: "Register the current repository as a project",
      command: "phantom project add",
    },
    {
      description: "Register a repository by path",
      command: "phantom project add ~/src/example",
    },
    {
      description: "Remove a project by id, name, or path",
      command: "phantom project remove proj_abc123",
    },
  ],
  notes: [
    "Available subcommands: list, add, remove",
    "Projects are stored in the same state used by phantom serve.",
  ],
};

export const projectListHelp: CommandHelp = {
  name: "project list",
  description: "List registered Phantom projects",
  usage: "phantom project list [options]",
  options: [
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
};

export const projectAddHelp: CommandHelp = {
  name: "project add",
  description: "Register a Git repository as a Phantom project",
  usage: "phantom project add [path]",
  notes: ["When path is omitted, the current directory is used."],
};

export const projectRemoveHelp: CommandHelp = {
  name: "project remove",
  description: "Remove a registered Phantom project",
  usage: "phantom project remove <project>",
  notes: [
    "The project can be specified by id, name, or root path.",
    "Projects with running, approval, or queued chats cannot be removed.",
  ],
};
