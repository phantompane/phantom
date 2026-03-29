import assert from "node:assert";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe } from "vitest";

const execFile = promisify(execFileCallback);

export const describeE2E =
  process.platform === "win32" ? describe.skip : describe;

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface CommandOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export interface RepoContext {
  cleanup: () => Promise<void>;
  env: NodeJS.ProcessEnv;
  repoDir: string;
  rootDir: string;
}

export async function runCommand(
  command: string,
  args: string[],
  options: CommandOptions,
): Promise<CommandResult> {
  try {
    const result = await execFile(command, args, {
      cwd: options.cwd,
      env: options.env,
      encoding: "utf8",
    });

    return {
      exitCode: 0,
      stdout: result.stdout.trimEnd(),
      stderr: result.stderr.trimEnd(),
    };
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "stdout" in error &&
      "stderr" in error
    ) {
      const execError = error as {
        code?: number | string;
        stdout: string;
        stderr: string;
      };

      return {
        exitCode: typeof execError.code === "number" ? execError.code : 1,
        stdout: execError.stdout.trimEnd(),
        stderr: execError.stderr.trimEnd(),
      };
    }

    throw error;
  }
}

export async function assertCommand(
  command: string,
  args: string[],
  options: CommandOptions,
): Promise<void> {
  const result = await runCommand(command, args, options);

  assert.strictEqual(
    result.exitCode,
    0,
    `${command} ${args.join(" ")} failed: ${result.stderr || result.stdout}`,
  );
}

export function getWorktreePath(repoDir: string, name: string): string {
  return join(repoDir, ".git", "phantom", "worktrees", ...name.split("/"));
}

export async function setupRepo(): Promise<RepoContext> {
  const rootDir = await mkdtemp(join(tmpdir(), "phantom-e2e-"));
  const repoDir = join(rootDir, "repo");
  const homeDir = join(rootDir, "home");

  await mkdir(repoDir, { recursive: true });
  await mkdir(join(homeDir, ".config", "git"), { recursive: true });
  await writeFile(join(homeDir, ".gitconfig"), "");

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    HOME: homeDir,
    XDG_CONFIG_HOME: join(homeDir, ".config"),
  };

  const repoOptions = { cwd: repoDir, env };

  await assertCommand("git", ["init", "-b", "main"], repoOptions);
  await assertCommand(
    "git",
    ["config", "user.name", "Phantom E2E"],
    repoOptions,
  );
  await assertCommand(
    "git",
    ["config", "user.email", "phantom-e2e@example.com"],
    repoOptions,
  );
  await writeFile(join(repoDir, "README.md"), "# phantom e2e\n");
  await assertCommand("git", ["add", "README.md"], repoOptions);
  await assertCommand("git", ["commit", "-m", "initial commit"], repoOptions);

  return {
    cleanup: async () => {
      await rm(rootDir, { recursive: true, force: true });
    },
    env,
    repoDir,
    rootDir,
  };
}
