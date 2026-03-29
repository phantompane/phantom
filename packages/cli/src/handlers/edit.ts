import { spawn } from "node:child_process";
import { parseArgs } from "node:util";
import { createContext, validateWorktreeExists } from "@phantompane/core";
import { getGitRoot } from "@phantompane/git";
import { getPhantomEnv } from "@phantompane/process";
import { isErr } from "@phantompane/utils";
import { exitCodes, exitWithError } from "../errors.ts";
import { output } from "../output.ts";

async function openEditor(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      // shell:true keeps commands with flags (e.g., "code --wait") working.
      cwd,
      env,
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

export async function editHandler(args: string[]): Promise<void> {
  const { positionals } = parseArgs({
    args,
    options: {},
    strict: true,
    allowPositionals: true,
  });

  if (positionals.length === 0 || positionals.length > 2) {
    exitWithError(
      "Usage: phantom edit <worktree-name> [path]",
      exitCodes.validationError,
    );
  }

  const worktreeName = positionals[0];
  const target = positionals[1] ?? ".";

  try {
    const gitRoot = await getGitRoot();
    const context = await createContext(gitRoot);
    const editor = context.preferences.editor ?? process.env.EDITOR;

    if (!editor) {
      exitWithError(
        "Editor is not configured. Run 'phantom preferences set editor <command>' or set the EDITOR env var.",
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

    output.log(`Opening editor in worktree '${worktreeName}'...`);

    const exitCode = await openEditor(editor, [target], validation.value.path, {
      ...process.env,
      ...getPhantomEnv(worktreeName, validation.value.path),
    });

    return process.exit(exitCode);
  } catch (error) {
    exitWithError(
      error instanceof Error ? error.message : String(error),
      exitCodes.generalError,
    );
  }
}
