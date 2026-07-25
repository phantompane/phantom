import { execFile } from "node:child_process";
import { normalize, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const GHQ_COMMAND = "ghq";
const GHQ_LIST_ARGUMENTS = ["list", "--full-path"] as const;
export const DEFAULT_GHQ_DISCOVERY_TIMEOUT_MS = 5_000;

export interface GhqCommandResult {
  stdout: string;
  stderr: string;
}

export interface GhqCommandOptions {
  timeoutMs: number;
}

export type GhqCommandRunner = (
  command: string,
  args: readonly string[],
  options: GhqCommandOptions,
) => Promise<GhqCommandResult>;

export interface GhqDiscoveryOptions {
  commandRunner?: GhqCommandRunner;
  timeoutMs?: number;
}

export interface GhqDiscoveryResult {
  available: boolean;
  rootPaths: string[];
}

export class GhqDiscoveryError extends Error {
  readonly exitCode: number | string | undefined;
  readonly stderr: string;

  constructor(
    message: string,
    options: {
      cause?: unknown;
      exitCode?: number | string;
      stderr?: string;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "GhqDiscoveryError";
    this.exitCode = options.exitCode;
    this.stderr = options.stderr ?? "";
  }
}

export async function discoverGhqRepositories(
  options: GhqDiscoveryOptions = {},
): Promise<GhqDiscoveryResult> {
  const commandRunner = options.commandRunner ?? runCommand;
  const timeoutMs = options.timeoutMs ?? DEFAULT_GHQ_DISCOVERY_TIMEOUT_MS;

  try {
    const { stdout } = await commandRunner(GHQ_COMMAND, GHQ_LIST_ARGUMENTS, {
      timeoutMs,
    });
    return {
      available: true,
      rootPaths: parseRootPaths(stdout),
    };
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") {
      return {
        available: false,
        rootPaths: [],
      };
    }

    const stderr = getErrorStderr(error);
    const detail = wasKilled(error)
      ? `timed out after ${timeoutMs} ms`
      : stderr ||
        (error instanceof Error ? error.message.trim() : String(error).trim());
    throw new GhqDiscoveryError(
      detail
        ? `Failed to discover ghq repositories: ${detail}`
        : "Failed to discover ghq repositories",
      {
        cause: error,
        exitCode: getErrorCode(error),
        stderr,
      },
    );
  }
}

async function runCommand(
  command: string,
  args: readonly string[],
  options: GhqCommandOptions,
): Promise<GhqCommandResult> {
  const { stdout, stderr } = await execFileAsync(command, [...args], {
    encoding: "utf8",
    timeout: options.timeoutMs,
  });
  return { stdout, stderr };
}

function parseRootPaths(stdout: string): string[] {
  return [
    ...new Set(
      stdout
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((rootPath) => normalize(resolve(rootPath))),
    ),
  ].sort();
}

function getErrorCode(error: unknown): number | string | undefined {
  if (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (typeof error.code === "number" || typeof error.code === "string")
  ) {
    return error.code;
  }
  return undefined;
}

function getErrorStderr(error: unknown): string {
  if (
    error !== null &&
    typeof error === "object" &&
    "stderr" in error &&
    typeof error.stderr === "string"
  ) {
    return error.stderr.trim();
  }
  return "";
}

function wasKilled(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "killed" in error &&
    error.killed === true
  );
}
