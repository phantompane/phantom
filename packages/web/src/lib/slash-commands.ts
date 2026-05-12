export interface SlashCommandOption {
  command: `/${string}`;
  description: string;
  keywords?: string[];
  label: string;
}

export type SlashCommandKeyAction =
  | "complete"
  | "dismiss"
  | "first"
  | "last"
  | "next"
  | "previous";

export interface SlashCommandKeyEvent {
  altKey?: boolean;
  ctrlKey?: boolean;
  isComposing?: boolean;
  key: string;
  keyCode?: number;
  metaKey?: boolean;
  shiftKey?: boolean;
}

export interface SlashCommandMenuState {
  composerText: string;
  dismissedText: string | null;
  hasSelectedChat: boolean;
  hasSelectedProject: boolean;
  isComposerBlocked: boolean;
  query: string | null;
}

export const slashCommandOptions: SlashCommandOption[] = [
  {
    command: "/plan",
    label: "Plan",
    description: "Ask Codex to plan before making changes.",
    keywords: ["planning", "steps"],
  },
  {
    command: "/init",
    label: "Init",
    description: "Create an AGENTS.md guide for this project.",
    keywords: ["agents", "instructions"],
  },
  {
    command: "/status",
    label: "Status",
    description: "Show the current session, model, and usage state.",
    keywords: ["usage", "tokens", "limits"],
  },
  {
    command: "/permissions",
    label: "Permissions",
    description: "Choose what Codex is allowed to do.",
    keywords: ["approval", "sandbox"],
  },
  {
    command: "/model",
    label: "Model",
    description: "Choose the model and reasoning effort.",
    keywords: ["reasoning", "effort"],
  },
  {
    command: "/review",
    label: "Review",
    description: "Review current changes and find issues.",
    keywords: ["code review", "diff"],
  },
  {
    command: "/compact",
    label: "Compact",
    description: "Summarize history and free up context.",
    keywords: ["context", "summary"],
  },
  {
    command: "/diff",
    label: "Diff",
    description: "View current file changes.",
    keywords: ["changes", "patch"],
  },
  {
    command: "/skills",
    label: "Skills",
    description: "List available Codex skills.",
    keywords: ["skill"],
  },
  {
    command: "/fast",
    label: "Fast",
    description: "Use faster inference for upcoming turns.",
    keywords: ["speed", "tier"],
  },
  {
    command: "/rename",
    label: "Rename",
    description: "Rename the current thread.",
    keywords: ["thread", "title"],
  },
  {
    command: "/approvals",
    label: "Approvals",
    description: "Adjust approval behavior for commands.",
    keywords: ["permission", "reviewer"],
  },
  {
    command: "/statusline",
    label: "Status Line",
    description: "Configure status line items.",
    keywords: ["status", "display"],
  },
  {
    command: "/sandbox-add-read-dir",
    label: "Add Read Directory",
    description: "Allow Codex to read an extra absolute directory.",
    keywords: ["sandbox", "directory", "read"],
  },
  {
    command: "/feedback",
    label: "Feedback",
    description: "Report a problem with Codex.",
    keywords: ["issue", "bug"],
  },
];

export function getSlashCommandQuery(text: string): string | null {
  if (!text.startsWith("/")) {
    return null;
  }

  const commandTokenMatch = text.match(/^\/[^\s\r\n]*/);
  if (!commandTokenMatch || commandTokenMatch[0].length !== text.length) {
    return null;
  }

  return commandTokenMatch[0].slice(1);
}

export function filterSlashCommands(
  commands: SlashCommandOption[],
  query: string,
): SlashCommandOption[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return commands;
  }

  return commands.filter((command) => {
    const searchableText = [
      command.command,
      command.label,
      command.description,
      ...(command.keywords ?? []),
    ]
      .join(" ")
      .toLowerCase();
    return searchableText.includes(normalizedQuery);
  });
}

export function completeSlashCommand(command: SlashCommandOption): string {
  return `${command.command} `;
}

export function shouldOpenSlashCommandMenu(
  state: SlashCommandMenuState,
): boolean {
  return (
    state.hasSelectedProject &&
    state.hasSelectedChat &&
    !state.isComposerBlocked &&
    state.query !== null &&
    state.dismissedText !== state.composerText
  );
}

export function getSlashCommandKeyAction(
  event: SlashCommandKeyEvent,
  hasOptions: boolean,
): SlashCommandKeyAction | null {
  if (event.isComposing || event.keyCode === 229) {
    return null;
  }

  if (event.key === "Escape") {
    return "dismiss";
  }

  if (!hasOptions || hasSlashCommandKeyModifier(event)) {
    return null;
  }

  if (event.key === "ArrowDown") {
    return "next";
  }
  if (event.key === "ArrowUp") {
    return "previous";
  }
  if (event.key === "Home") {
    return "first";
  }
  if (event.key === "End") {
    return "last";
  }
  if (event.key === "Enter" || event.key === "Tab") {
    return "complete";
  }

  return null;
}

function hasSlashCommandKeyModifier(event: SlashCommandKeyEvent): boolean {
  return Boolean(
    event.altKey || event.ctrlKey || event.metaKey || event.shiftKey,
  );
}
