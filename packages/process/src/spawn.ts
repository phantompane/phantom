import { type ChildProcess, spawn as nodeSpawn } from "node:child_process";
import { err, ok, type Result } from "@phantompane/utils";
import {
  type ProcessError,
  ProcessExecutionError,
  ProcessSignalError,
  ProcessSpawnError,
} from "./errors.ts";

export interface SpawnSuccess {
  exitCode: number;
}

type SpawnStdio =
  | "inherit"
  | "ignore"
  | "pipe"
  | Array<"inherit" | "ignore" | "pipe">;

export interface SpawnProcessOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdio?: SpawnStdio;
}

export interface SpawnConfig {
  command: string;
  args?: string[];
  options?: SpawnProcessOptions;
}

export async function spawnProcess(
  config: SpawnConfig,
): Promise<Result<SpawnSuccess, ProcessError>> {
  return new Promise((resolve) => {
    const { command, args = [], options = {} } = config;

    // scriptc rejects a spread of the options object. Pass the supported
    // fields as explicit object literals. Callers use stdio, cwd, and env.
    const stdio = options.stdio ?? "inherit";
    const childProcess: ChildProcess = spawnWithOptions(
      command,
      args,
      stdio,
      options,
    );

    childProcess.on("error", (error) => {
      resolve(err(new ProcessSpawnError(command, error.message)));
    });

    childProcess.on("exit", (code, signal) => {
      if (signal) {
        resolve(err(new ProcessSignalError(signal)));
      } else {
        const exitCode = code ?? 0;
        if (exitCode === 0) {
          resolve(ok({ exitCode }));
        } else {
          resolve(err(new ProcessExecutionError(command, exitCode)));
        }
      }
    });
  });
}

function spawnWithOptions(
  command: string,
  args: string[],
  stdio: SpawnStdio,
  options: SpawnProcessOptions,
): ChildProcess {
  // scriptc only lowers stdio when the argument is a literal.
  if (Array.isArray(stdio)) {
    return spawnWithLiteralStdio(
      command,
      args,
      ["ignore", "inherit", "inherit"],
      options,
    );
  }
  if (stdio === "ignore") {
    return spawnWithLiteralStdio(command, args, "ignore", options);
  }
  if (stdio === "pipe") {
    return spawnWithLiteralStdio(command, args, "pipe", options);
  }
  return spawnWithLiteralStdio(command, args, "inherit", options);
}

function spawnWithLiteralStdio(
  command: string,
  args: string[],
  stdio: "inherit",
  options: SpawnProcessOptions,
): ChildProcess;
function spawnWithLiteralStdio(
  command: string,
  args: string[],
  stdio: "ignore",
  options: SpawnProcessOptions,
): ChildProcess;
function spawnWithLiteralStdio(
  command: string,
  args: string[],
  stdio: "pipe",
  options: SpawnProcessOptions,
): ChildProcess;
function spawnWithLiteralStdio(
  command: string,
  args: string[],
  stdio: ["ignore", "inherit", "inherit"],
  options: SpawnProcessOptions,
): ChildProcess;
function spawnWithLiteralStdio(
  command: string,
  args: string[],
  stdio: "inherit" | "ignore" | "pipe" | ["ignore", "inherit", "inherit"],
  options: SpawnProcessOptions,
): ChildProcess {
  const cwd = options.cwd;
  const env = options.env;

  if (stdio === "inherit") {
    if (cwd !== undefined && env !== undefined) {
      return nodeSpawn(command, args, { stdio: "inherit", cwd, env });
    }
    if (cwd !== undefined) {
      return nodeSpawn(command, args, { stdio: "inherit", cwd });
    }
    if (env !== undefined) {
      return nodeSpawn(command, args, { stdio: "inherit", env });
    }
    return nodeSpawn(command, args, { stdio: "inherit" });
  }

  if (stdio === "ignore") {
    if (cwd !== undefined && env !== undefined) {
      return nodeSpawn(command, args, { stdio: "ignore", cwd, env });
    }
    if (cwd !== undefined) {
      return nodeSpawn(command, args, { stdio: "ignore", cwd });
    }
    if (env !== undefined) {
      return nodeSpawn(command, args, { stdio: "ignore", env });
    }
    return nodeSpawn(command, args, { stdio: "ignore" });
  }

  if (stdio === "pipe") {
    if (cwd !== undefined && env !== undefined) {
      return nodeSpawn(command, args, { stdio: "pipe", cwd, env });
    }
    if (cwd !== undefined) {
      return nodeSpawn(command, args, { stdio: "pipe", cwd });
    }
    if (env !== undefined) {
      return nodeSpawn(command, args, { stdio: "pipe", env });
    }
    return nodeSpawn(command, args, { stdio: "pipe" });
  }

  if (cwd !== undefined && env !== undefined) {
    return nodeSpawn(command, args, {
      stdio: ["ignore", "inherit", "inherit"],
      cwd,
      env,
    });
  }
  if (cwd !== undefined) {
    return nodeSpawn(command, args, {
      stdio: ["ignore", "inherit", "inherit"],
      cwd,
    });
  }
  if (env !== undefined) {
    return nodeSpawn(command, args, {
      stdio: ["ignore", "inherit", "inherit"],
      env,
    });
  }
  return nodeSpawn(command, args, { stdio: ["ignore", "inherit", "inherit"] });
}
