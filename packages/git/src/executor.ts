import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

export interface GitExecutorOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  trimStdout?: boolean;
  trimStderr?: boolean;
}

export interface GitExecutorResult {
  stdout: string;
  stderr: string;
}

/**
 * Execute a git command with consistent error handling.
 *
 * scriptc's execFile rejection does not include stdout or stderr. `git config
 * --get-regexp` exits 1 with empty output when nothing matches, which is not
 * a phantom error.
 */
export async function executeGitCommand(
  args: string[],
  options: GitExecutorOptions = {},
): Promise<GitExecutorResult> {
  const trimStdout = options.trimStdout ?? true;
  const trimStderr = options.trimStderr ?? true;
  const env = options.env !== undefined ? options.env : process.env;

  try {
    const result =
      options.cwd !== undefined
        ? await execFile("git", args, {
            cwd: options.cwd,
            env,
            encoding: "utf8",
          })
        : await execFile("git", args, {
            env,
            encoding: "utf8",
          });

    return {
      stdout: trimStdout ? result.stdout.trim() : result.stdout,
      stderr: trimStderr ? result.stderr.trim() : result.stderr,
    };
  } catch (caught) {
    if (
      caught instanceof Error &&
      args.includes("--get-regexp") &&
      caught.message.startsWith("Command failed:")
    ) {
      return { stdout: "", stderr: "" };
    }

    if (!(caught instanceof Error)) {
      throw new Error(String(caught));
    }

    const stdout = readExecOutput(caught, "stdout");
    const stderr = readExecOutput(caught, "stderr");
    if (stdout === undefined && stderr === undefined) {
      throw caught;
    }

    const stderrText = stderr ?? "";
    if (stderrText.trim()) {
      throw new Error(stderrText.trim());
    }

    const stdoutText = stdout ?? "";
    return {
      stdout: trimStdout ? stdoutText.trim() : stdoutText,
      stderr: trimStderr ? stderrText.trim() : stderrText,
    };
  }
}

function readExecOutput(
  error: Error,
  key: "stdout" | "stderr",
): string | undefined {
  if (!(key in error)) {
    return undefined;
  }

  const value = (error as Error & Record<"stdout" | "stderr", unknown>)[key];
  return typeof value === "string" ? value : undefined;
}
