#!/usr/bin/env node

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
import { projectAddHandler } from "../handlers/project-add.ts";
import { projectListHandler } from "../handlers/project-list.ts";
import { projectRemoveHandler } from "../handlers/project-remove.ts";
import { projectHandler } from "../handlers/project.ts";
import { preferencesHandler } from "../handlers/preferences.ts";
import { preferencesGetHandler } from "../handlers/preferences-get.ts";
import { preferencesRemoveHandler } from "../handlers/preferences-remove.ts";
import { preferencesSetHandler } from "../handlers/preferences-set.ts";
import { shellHandler } from "../handlers/shell.ts";
import { versionHandler } from "../handlers/version.ts";
import { whereHandler } from "../handlers/where.ts";
import { type Command, runCli } from "../run-cli.ts";
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
  projectAddHelp,
  projectHelp,
  projectListHelp,
  projectRemoveHelp,
} from "../help/project.ts";
import {
  preferencesGetHelp,
  preferencesHelp,
  preferencesRemoveHelp,
  preferencesSetHelp,
} from "../help/preferences.ts";
import { shellHelp } from "../help/shell.ts";
import { versionHelp } from "../help/version.ts";
import { whereHelp } from "../help/where.ts";

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
    name: "project",
    description: "Manage and discover Git projects",
    handler: projectHandler,
    help: projectHelp,
    subcommands: [
      {
        name: "add",
        description: "Register a Git repository",
        handler: projectAddHandler,
        help: projectAddHelp,
      },
      {
        name: "list",
        description: "List registered and discovered Git projects",
        handler: projectListHandler,
        help: projectListHelp,
      },
      {
        name: "remove",
        description: "Remove a registered Git project",
        handler: projectRemoveHandler,
        help: projectRemoveHelp,
      },
    ],
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

await runCli(commands);
