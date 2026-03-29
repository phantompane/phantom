export function getPhantomEnv(
  worktreeName: string,
  worktreePath: string,
): Record<string, string> {
  return {
    PHANTOM: "1",
    PHANTOM_NAME: worktreeName,
    PHANTOM_PATH: worktreePath,
  };
}

export interface ShellCommand {
  command: string;
  args: string[];
}

export function getShellCommand(shellValue = process.env.SHELL): ShellCommand {
  const trimmedShell = (shellValue ?? "").trim();
  const shellParts = trimmedShell
    ? trimmedShell.split(/\s+/).filter(Boolean)
    : [];
  const command = shellParts[0] ?? "/bin/sh";

  return {
    command,
    args: shellParts.slice(1),
  };
}
