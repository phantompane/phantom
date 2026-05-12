export interface SlashCommandOption {
  availableDuringActiveTurn?: boolean;
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

export type SlashCommandSubmitMode = "queue" | "send" | "steer";

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
    availableDuringActiveTurn: true,
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
    availableDuringActiveTurn: true,
  },
  {
    command: "/skills",
    label: "Skills",
    description: "List available Codex skills.",
    keywords: ["skill"],
    availableDuringActiveTurn: true,
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
    availableDuringActiveTurn: true,
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
    availableDuringActiveTurn: true,
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
    availableDuringActiveTurn: true,
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

export function filterSlashCommandsForState(
  commands: SlashCommandOption[],
  options: {
    canQueueCommands: boolean;
    hasActiveTurn: boolean;
  },
): SlashCommandOption[] {
  if (!options.hasActiveTurn || options.canQueueCommands) {
    return commands;
  }

  return commands.filter((command) => command.availableDuringActiveTurn);
}

export function getSlashCommandForText(
  commands: SlashCommandOption[],
  text: string,
): SlashCommandOption | null {
  const commandTokenMatch = text.match(/^\/[^\s\r\n]*/);
  const commandToken = commandTokenMatch?.[0];
  if (!commandToken) {
    return null;
  }

  return commands.find((command) => command.command === commandToken) ?? null;
}

export function getSlashCommandSubmitMode(
  commands: SlashCommandOption[],
  options: {
    composerText: string;
    submitMode: SlashCommandSubmitMode;
  },
): SlashCommandSubmitMode {
  if (options.submitMode !== "steer") {
    return options.submitMode;
  }

  const command = getSlashCommandForText(commands, options.composerText);
  if (!command || command.availableDuringActiveTurn) {
    return options.submitMode;
  }

  return "queue";
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

  if (hasSlashCommandKeyModifier(event)) {
    return null;
  }

  if (event.key === "Escape") {
    return "dismiss";
  }

  if (!hasOptions) {
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
