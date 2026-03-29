import {
  type ChildProcess,
  spawn as nodeSpawn,
  type SpawnOptions,
} from "node:child_process";
import { err, ok, type Result } from "@phantompane/utils";
import {
  type ProcessError,
  ProcessExecutionError,
  ProcessSignalError,
  ProcessSpawnError,
} from "./errors.ts";
import { resolveWindowsCommandPath } from "./resolve-windows-command-path.ts";

export interface SpawnSuccess {
  exitCode: number;
}

export interface SpawnConfig {
  command: string;
  args?: string[];
  options?: SpawnOptions;
}

export async function spawnProcess(
  config: SpawnConfig,
): Promise<Result<SpawnSuccess, ProcessError>> {
  return new Promise((resolve) => {
    const { command, args = [], options = {} } = config;
    const file =
      process.platform === "win32"
        ? resolveWindowsCommandPath(command)
        : command;

    const childProcess: ChildProcess = nodeSpawn(file, args, {
      stdio: "inherit",
      ...options,
    });

    childProcess.on("error", (error) => {
      resolve(err(new ProcessSpawnError(file, error.message)));
    });

    childProcess.on("exit", (code, signal) => {
      if (signal) {
        resolve(err(new ProcessSignalError(signal)));
      } else {
        const exitCode = code ?? 0;
        if (exitCode === 0) {
          resolve(ok({ exitCode }));
        } else {
          resolve(err(new ProcessExecutionError(file, exitCode)));
        }
      }
    });
  });
}
