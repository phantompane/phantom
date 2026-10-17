#!/usr/bin/env node

// scriptc entry for the standalone phantom binary.
// The npm package still starts at src/bin/phantom.ts (tsdown). This file is
// the same command table with the commands whose dependencies scriptc 0.3
// cannot compile replaced by explicit errors. Do not import those modules
// from here: a static import would put them in the native graph.

import { aiHandler } from "../../src/handlers/ai.ts";
import { attachHandler } from "../../src/handlers/attach.ts";
import { completionHandler } from "../../src/handlers/completion.ts";
import { createHandler } from "../../src/handlers/create.ts";
import { deleteHandler } from "../../src/handlers/delete.ts";
import { editHandler } from "../../src/handlers/edit.ts";
import { execHandler } from "../../src/handlers/exec.ts";
import { githubHandler } from "../../src/handlers/github.ts";
import { listHandler } from "../../src/handlers/list.ts";
import { preferencesGetHandler } from "../../src/handlers/preferences-get.ts";
import { preferencesRemoveHandler } from "../../src/handlers/preferences-remove.ts";
import { preferencesSetHandler } from "../../src/handlers/preferences-set.ts";
import { preferencesHandler } from "../../src/handlers/preferences.ts";
import { projectHandler } from "../../src/handlers/project.ts";
import { shellHandler } from "../../src/handlers/shell.ts";
import { versionHandler } from "../../src/handlers/version.ts";
import { whereHandler } from "../../src/handlers/where.ts";
import { aiHelp } from "../../src/help/ai.ts";
import { attachHelp } from "../../src/help/attach.ts";
import { completionHelp } from "../../src/help/completion.ts";
import { createHelp } from "../../src/help/create.ts";
import { deleteHelp } from "../../src/help/delete.ts";
import { editHelp } from "../../src/help/edit.ts";
import { execHelp } from "../../src/help/exec.ts";
import { githubCheckoutHelp, githubHelp } from "../../src/help/github.ts";
import { listHelp } from "../../src/help/list.ts";
import { mcpHelp } from "../../src/help/mcp.ts";
import {
  preferencesGetHelp,
  preferencesHelp,
  preferencesRemoveHelp,
  preferencesSetHelp,
} from "../../src/help/preferences.ts";
import {
  projectAddHelp,
  projectHelp,
  projectListHelp,
  projectRemoveHelp,
} from "../../src/help/project.ts";
import { shellHelp } from "../../src/help/shell.ts";
import { versionHelp } from "../../src/help/version.ts";
import { whereHelp } from "../../src/help/where.ts";
import { type CommandHelp, helpFormatter } from "../../src/help.ts";

interface Command {
  name: string;
  description: string;
  subcommands?: Command[];
  help?: CommandHelp;
}

async function unsupported(command: string, detail: string): Promise<void> {
  console.error(
    `Error: \`${command}\` is not available in the scriptc native binary. ${detail}`,
  );
  process.exit(1);
}

const commands: Command[] = [
  {
    name: "create",
    description: "Create a new Git worktree (phantom)",
    help: createHelp,
  },
  {
    name: "attach",
    description: "Attach to an existing branch by creating a new worktree",
    help: attachHelp,
  },
  {
    name: "list",
    description: "List all Git worktrees (phantoms)",
    help: listHelp,
  },
  {
    name: "where",
    description: "Output the filesystem path of a specific worktree",
    help: whereHelp,
  },
  {
    name: "delete",
    description: "Delete a Git worktree (phantom)",
    help: deleteHelp,
  },
  {
    name: "exec",
    description: "Execute a command in a worktree directory",
    help: execHelp,
  },
  {
    name: "edit",
    description: "Open a worktree in your configured editor",
    help: editHelp,
  },
  {
    name: "ai",
    description: "Launch your configured AI coding assistant in a worktree",
    help: aiHelp,
  },
  {
    name: "shell",
    description: "Open an interactive shell in a worktree directory",
    help: shellHelp,
  },
  {
    name: "preferences",
    description: "Manage phantom user preferences (git config)",
    help: preferencesHelp,
    subcommands: [
      {
        name: "get",
        description: "Show a preference value",
        help: preferencesGetHelp,
      },
      {
        name: "set",
        description: "Set a preference value (git config --global)",
        help: preferencesSetHelp,
      },
      {
        name: "remove",
        description: "Remove a preference value (git config --global --unset)",
        help: preferencesRemoveHelp,
      },
    ],
  },
  {
    name: "version",
    description: "Display phantom version information",
    help: versionHelp,
  },
  {
    name: "completion",
    description: "Generate shell completion scripts",
    help: completionHelp,
  },
  {
    name: "mcp",
    description: "Manage MCP server for AI assistants",
    help: mcpHelp,
  },
  {
    name: "project",
    description: "Manage and discover Git projects",
    help: projectHelp,
    subcommands: [
      {
        name: "add",
        description: "Register a Git repository",
        help: projectAddHelp,
      },
      {
        name: "list",
        description: "List registered and discovered Git projects",
        help: projectListHelp,
      },
      {
        name: "remove",
        description: "Remove a registered Git project",
        help: projectRemoveHelp,
      },
    ],
  },
  {
    name: "github",
    description: "GitHub-specific commands for phantom",
    help: githubHelp,
    subcommands: [
      {
        name: "checkout",
        description: "Create a worktree for a GitHub PR or issue",
        help: githubCheckoutHelp,
      },
    ],
  },
  {
    name: "gh",
    description: "GitHub-specific commands for phantom (alias)",
    help: githubHelp,
    subcommands: [
      {
        name: "checkout",
        description: "Create a worktree for a GitHub PR or issue",
        help: githubCheckoutHelp,
      },
    ],
  },
];

const args = process.argv.slice(2);

if (args.length === 0 || args[0] === "-h" || args[0] === "--help") {
  console.log(
    helpFormatter.formatMainHelp(
      commands.map((command) => ({
        name: command.name,
        description: command.description,
      })),
    ),
  );
  process.exit(0);
}

if (args[0] === "--version" || args[0] === "-v") {
  await versionHandler([]);
  process.exit(0);
}

const [name, ...rest] = args;
const command = commands.find((entry) => entry.name === name);

if (!command) {
  console.error(`Error: Unknown command '${args.join(" ")}'\n`);
  console.log(
    helpFormatter.formatMainHelp(
      commands.map((entry) => ({
        name: entry.name,
        description: entry.description,
      })),
    ),
  );
  process.exit(1);
}

const subName = rest[0];
const subcommand = command.subcommands?.find((entry) => entry.name === subName);
const selected = subcommand ?? command;
const handlerArgs = subcommand ? rest.slice(1) : rest;

if (handlerArgs.includes("--help") || handlerArgs.includes("-h")) {
  if (selected.help) {
    console.log(helpFormatter.formatCommandHelp(selected.help));
  }
  process.exit(0);
}

switch (subcommand ? `${command.name} ${subcommand.name}` : command.name) {
  case "create":
    await createHandler(handlerArgs);
    break;
  case "attach":
    await attachHandler(handlerArgs);
    break;
  case "list":
    await listHandler(handlerArgs);
    break;
  case "where":
    await whereHandler(handlerArgs);
    break;
  case "delete":
    await deleteHandler(handlerArgs);
    break;
  case "exec":
    await execHandler(handlerArgs);
    break;
  case "edit":
    await editHandler(handlerArgs);
    break;
  case "ai":
    await aiHandler(handlerArgs);
    break;
  case "shell":
    await shellHandler(handlerArgs);
    break;
  case "preferences":
    await preferencesHandler(handlerArgs);
    break;
  case "preferences get":
    await preferencesGetHandler(handlerArgs);
    break;
  case "preferences set":
    await preferencesSetHandler(handlerArgs);
    break;
  case "preferences remove":
    await preferencesRemoveHandler(handlerArgs);
    break;
  case "version":
    await versionHandler(handlerArgs);
    break;
  case "completion":
    await completionHandler(handlerArgs);
    break;
  case "mcp":
    await unsupported(
      "phantom mcp",
      "scriptc 0.3 cannot compile @modelcontextprotocol/sdk.",
    );
    break;
  case "project":
    await projectHandler(handlerArgs);
    break;
  case "project add":
  case "project list":
  case "project remove":
    await unsupported(
      "phantom project",
      "scriptc 0.3 crashes while compiling zod, which the project registry uses.",
    );
    break;
  case "github":
  case "gh":
    await githubHandler(handlerArgs);
    break;
  case "github checkout":
  case "gh checkout":
    await unsupported(
      "phantom github checkout",
      "scriptc 0.3 cannot compile @octokit/rest.",
    );
    break;
  default:
    console.error(`Error: Unknown command '${args.join(" ")}'\n`);
    process.exit(1);
}
