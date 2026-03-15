import { spawn } from "node:child_process";
import { parseArgs } from "node:util";
import { createContext, validateWorktreeExists } from "@phantompane/core";
import { getGitRoot } from "@phantompane/git";
import { getPhantomEnv } from "@phantompane/process";
import { isErr } from "@phantompane/shared";
import { exitCodes, exitWithError } from "../errors.ts";
import { output } from "../output.ts";

export async function launchAiAssistant(
  aiCommand: string,
  worktreeName: string,
  worktreePath: string,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(aiCommand, [], {
      cwd: worktreePath,
      env: {
        ...process.env,
        ...getPhantomEnv(worktreeName, worktreePath),
      },
      stdio: "inherit",
      shell: true,
    });

    child.on("error", (error) => {
      reject(error);
    });

    child.on("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`Command exited with signal ${signal}`));
        return;
      }

      resolve(code ?? 0);
    });
  });
}

export async function aiHandler(args: string[]): Promise<void> {
  const { positionals } = parseArgs({
    args,
    options: {},
    strict: true,
    allowPositionals: true,
  });

  if (positionals.length !== 1) {
    exitWithError(
      "Usage: phantom ai <worktree-name>",
      exitCodes.validationError,
    );
  }

  const worktreeName = positionals[0];

  try {
    const gitRoot = await getGitRoot();
    const context = await createContext(gitRoot);
    const aiCommand = context.preferences.ai;

    if (!aiCommand) {
      exitWithError(
        "AI assistant is not configured. Run 'phantom preferences set ai <command>' first.",
        exitCodes.validationError,
      );
    }

    const validation = await validateWorktreeExists(
      context.gitRoot,
      context.worktreesDirectory,
      worktreeName,
    );

    if (isErr(validation)) {
      exitWithError(validation.error.message, exitCodes.notFound);
    }

    output.log(`Launching AI assistant in worktree '${worktreeName}'...`);

    const exitCode = await launchAiAssistant(
      aiCommand,
      worktreeName,
      validation.value.path,
    );

    return process.exit(exitCode);
  } catch (error) {
    exitWithError(
      error instanceof Error ? error.message : String(error),
      exitCodes.generalError,
    );
  }
}
