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
 * Execute a git command with consistent error handling
 */
export async function executeGitCommand(
  args: string[],
  options: GitExecutorOptions = {},
): Promise<GitExecutorResult> {
  const trimStdout = options.trimStdout ?? true;
  const trimStderr = options.trimStderr ?? true;

  try {
    const result = await execFile("git", args, {
      cwd: options.cwd,
      env: options.env || process.env,
      encoding: "utf8",
    });

    return {
      stdout: trimStdout ? result.stdout.trim() : result.stdout,
      stderr: trimStderr ? result.stderr.trim() : result.stderr,
    };
  } catch (error) {
    // Git commands often return non-zero exit codes for normal operations
    // (e.g., `git diff` returns 1 when there are differences)
    // So we need to handle errors carefully
    if (
      error &&
      typeof error === "object" &&
      "stdout" in error &&
      "stderr" in error
    ) {
      const execError = error as {
        stdout: string;
        stderr: string;
        code?: number;
      };

      // If we have stderr content, it's likely a real error
      if (execError.stderr?.trim()) {
        throw new Error(execError.stderr.trim());
      }

      // Otherwise, return the output even though the exit code was non-zero
      return {
        stdout: trimStdout
          ? (execError.stdout?.trim() ?? "")
          : (execError.stdout ?? ""),
        stderr: trimStderr
          ? (execError.stderr?.trim() ?? "")
          : (execError.stderr ?? ""),
      };
    }

    throw error;
  }
}

/**
 * Execute a git command in a specific directory
 */
export async function executeGitCommandInDirectory(
  directory: string,
  args: string[],
): Promise<GitExecutorResult> {
  return executeGitCommand(["-C", directory, ...args], {});
}
