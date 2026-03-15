import type { Result } from "@phantompane/shared";
import type { ProcessError } from "./errors.ts";
import { type SpawnSuccess, spawnProcess } from "./spawn.ts";

export type TmuxSplitDirection = "new" | "vertical" | "horizontal";

export interface TmuxOptions {
  direction: TmuxSplitDirection;
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  windowName?: string;
}

export type TmuxSuccess = SpawnSuccess;

export async function isInsideTmux(): Promise<boolean> {
  return process.env.TMUX !== undefined;
}

export async function executeTmuxCommand(
  options: TmuxOptions,
): Promise<Result<TmuxSuccess, ProcessError>> {
  const { direction, command, args, cwd, env, windowName } = options;

  const tmuxArgs: string[] = [];

  switch (direction) {
    case "new":
      tmuxArgs.push("new-window");
      if (windowName) {
        tmuxArgs.push("-n", windowName);
      }
      break;
    case "vertical":
      tmuxArgs.push("split-window", "-v");
      break;
    case "horizontal":
      tmuxArgs.push("split-window", "-h");
      break;
  }

  if (cwd) {
    tmuxArgs.push("-c", cwd);
  }

  // Add environment variables safely
  if (env) {
    for (const [key, value] of Object.entries(env)) {
      tmuxArgs.push("-e", `${key}=${value}`);
    }
  }

  // Add the command and arguments
  tmuxArgs.push(command);
  if (args && args.length > 0) {
    tmuxArgs.push(...args);
  }

  const result = await spawnProcess({
    command: "tmux",
    args: tmuxArgs,
  });

  return result;
}
