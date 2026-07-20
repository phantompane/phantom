#!/usr/bin/env node

import { argv, exit } from "node:process";
import { aiHandler } from "../handlers/ai.ts";
import { attachHandler } from "../handlers/attach.ts";
import { completionHandler } from "../handlers/completion.ts";
import { createHandler } from "../handlers/create.ts";
import { deleteHandler } from "../handlers/delete.ts";
import { editHandler } from "../handlers/edit.ts";
import { execHandler } from "../handlers/exec.ts";
import { githubHandler } from "../handlers/github.ts";
import { githubCheckoutHandler } from "../handlers/github-checkout.ts";
import { listHandler } from "../handlers/list.ts";
import { mcpHandler } from "../handlers/mcp.ts";
import { preferencesHandler } from "../handlers/preferences.ts";
import { preferencesGetHandler } from "../handlers/preferences-get.ts";
import { preferencesRemoveHandler } from "../handlers/preferences-remove.ts";
import { preferencesSetHandler } from "../handlers/preferences-set.ts";
import { shellHandler } from "../handlers/shell.ts";
import { versionHandler } from "../handlers/version.ts";
import { whereHandler } from "../handlers/where.ts";
import { aiHelp } from "../help/ai.ts";
import { attachHelp } from "../help/attach.ts";
import { completionHelp } from "../help/completion.ts";
import { createHelp } from "../help/create.ts";
import { deleteHelp } from "../help/delete.ts";
import { editHelp } from "../help/edit.ts";
import { execHelp } from "../help/exec.ts";
import { githubCheckoutHelp, githubHelp } from "../help/github.ts";
import { listHelp } from "../help/list.ts";
import { mcpHelp } from "../help/mcp.ts";
import {
  preferencesGetHelp,
  preferencesHelp,
  preferencesRemoveHelp,
  preferencesSetHelp,
} from "../help/preferences.ts";
import { shellHelp } from "../help/shell.ts";
import { versionHelp } from "../help/version.ts";
import { whereHelp } from "../help/where.ts";
import { type CommandHelp, helpFormatter } from "../help.ts";

interface Command {
  name: string;
  description: string;
  subcommands?: Command[];
  handler?: (args: string[]) => void | Promise<void>;
  help?: CommandHelp;
}

const commands: Command[] = [
  {
    name: "create",
    description: "Create a new Git worktree (phantom)",
    handler: createHandler,
    help: createHelp,
  },
  {
    name: "attach",
    description: "Attach to an existing branch by creating a new worktree",
    handler: attachHandler,
    help: attachHelp,
  },
  {
    name: "list",
    description: "List all Git worktrees (phantoms)",
    handler: listHandler,
    help: listHelp,
  },
  {
    name: "where",
    description: "Output the filesystem path of a specific worktree",
    handler: whereHandler,
    help: whereHelp,
  },
  {
    name: "delete",
    description: "Delete a Git worktree (phantom)",
    handler: deleteHandler,
    help: deleteHelp,
  },
  {
    name: "exec",
    description: "Execute a command in a worktree directory",
    handler: execHandler,
    help: execHelp,
  },
  {
    name: "edit",
    description: "Open a worktree in your configured editor",
    handler: editHandler,
    help: editHelp,
  },
  {
    name: "ai",
    description: "Launch your configured AI coding assistant in a worktree",
    handler: aiHandler,
    help: aiHelp,
  },
  {
    name: "shell",
    description: "Open an interactive shell in a worktree directory",
    handler: shellHandler,
    help: shellHelp,
  },
  {
    name: "preferences",
    description: "Manage phantom user preferences (git config)",
    handler: preferencesHandler,
    help: preferencesHelp,
    subcommands: [
      {
        name: "get",
        description: "Show a preference value",
        handler: preferencesGetHandler,
        help: preferencesGetHelp,
      },
      {
        name: "set",
        description: "Set a preference value (git config --global)",
        handler: preferencesSetHandler,
        help: preferencesSetHelp,
      },
      {
        name: "remove",
        description: "Remove a preference value (git config --global --unset)",
        handler: preferencesRemoveHandler,
        help: preferencesRemoveHelp,
      },
    ],
  },
  {
    name: "version",
    description: "Display phantom version information",
    handler: versionHandler,
    help: versionHelp,
  },
  {
    name: "completion",
    description: "Generate shell completion scripts",
    handler: completionHandler,
    help: completionHelp,
  },
  {
    name: "mcp",
    description: "Manage MCP server for AI assistants",
    handler: mcpHandler,
    help: mcpHelp,
  },
  {
    name: "github",
    description: "GitHub-specific commands for phantom",
    handler: githubHandler,
    help: githubHelp,
    subcommands: [
      {
        name: "checkout",
        description: "Create a worktree for a GitHub PR or issue",
        handler: githubCheckoutHandler,
        help: githubCheckoutHelp,
      },
    ],
  },
  {
    name: "gh",
    description: "GitHub-specific commands for phantom (alias)",
    handler: githubHandler,
    help: githubHelp,
    subcommands: [
      {
        name: "checkout",
        description: "Create a worktree for a GitHub PR or issue",
        handler: githubCheckoutHandler,
        help: githubCheckoutHelp,
      },
    ],
  },
];

function printHelp(commands: Command[]) {
  const simpleCommands = commands.map((cmd) => ({
    name: cmd.name,
    description: cmd.description,
  }));
  console.log(helpFormatter.formatMainHelp(simpleCommands));
}

function findCommand(
  args: string[],
  commands: Command[],
): { command: Command | null; remainingArgs: string[] } {
  if (args.length === 0) {
    return { command: null, remainingArgs: [] };
  }

  const [cmdName, ...rest] = args;
  const command = commands.find((cmd) => cmd.name === cmdName);

  if (!command) {
    return { command: null, remainingArgs: args };
  }

  if (command.subcommands && rest.length > 0) {
    const { command: subcommand, remainingArgs } = findCommand(
      rest,
      command.subcommands,
    );
    if (subcommand) {
      return { command: subcommand, remainingArgs };
    }
  }

  return { command, remainingArgs: rest };
}

const args = argv.slice(2);

if (args.length === 0 || args[0] === "-h" || args[0] === "--help") {
  printHelp(commands);
  exit(0);
}

if (args[0] === "--version" || args[0] === "-v") {
  versionHandler();
  exit(0);
}

const { command, remainingArgs } = findCommand(args, commands);

if (!command || !command.handler) {
  console.error(`Error: Unknown command '${args.join(" ")}'\n`);
  printHelp(commands);
  exit(1);
}

// Check if user is requesting help for a specific command
if (remainingArgs.includes("--help") || remainingArgs.includes("-h")) {
  if (command.help) {
    console.log(helpFormatter.formatCommandHelp(command.help));
  } else {
    console.log(`Help not available for command '${command.name}'`);
  }
  exit(0);
}

try {
  await command.handler(remainingArgs);
} catch (error) {
  console.error(
    "Error:",
    error instanceof Error ? error.message : String(error),
  );
  exit(1);
}
