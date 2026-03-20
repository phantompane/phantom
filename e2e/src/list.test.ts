import assert from "node:assert";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, it } from "vitest";

const execFile = promisify(execFileCallback);
const describeE2E = process.platform === "win32" ? describe.skip : describe;

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

describeE2E("phantom list e2e", () => {
  let env: NodeJS.ProcessEnv;
  let repoDir: string;
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await mkdtemp("/tmp/phantom-e2e-");
    repoDir = join(rootDir, "repo");
    const homeDir = join(rootDir, "home");

    await mkdir(repoDir, { recursive: true });
    await mkdir(join(homeDir, ".config", "git"), { recursive: true });
    await writeFile(join(homeDir, ".gitconfig"), "");

    env = {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      HOME: homeDir,
      XDG_CONFIG_HOME: join(homeDir, ".config"),
    };

    await assertCommand(["git", ["init", "-b", "main"]]);
    await assertCommand(["git", ["config", "user.name", "Phantom E2E"]]);
    await assertCommand([
      "git",
      ["config", "user.email", "phantom-e2e@example.com"],
    ]);
    await writeFile(join(repoDir, "README.md"), "# phantom e2e\n");
    await assertCommand(["git", ["add", "README.md"]]);
    await assertCommand(["git", ["commit", "-m", "initial commit"]]);
    await assertCommand([
      "git",
      [
        "worktree",
        "add",
        "-b",
        "listed",
        join(repoDir, ".git", "phantom", "worktrees", "listed"),
        "HEAD",
      ],
    ]);
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  it("lists non-default phantom worktrees by name", async () => {
    const result = await runCommand("phantom", [
      "list",
      "--names",
      "--no-default",
    ]);

    assert.strictEqual(result.exitCode, 0, result.stderr);
    assert.deepStrictEqual(result.stdout.split("\n"), ["listed"]);
  });

  async function runCommand(
    command: string,
    args: string[],
    cwd = repoDir,
  ): Promise<CommandResult> {
    try {
      const result = await execFile(command, args, {
        cwd,
        env,
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
          code?: number;
          stdout: string;
          stderr: string;
        };

        return {
          exitCode: execError.code ?? 1,
          stdout: execError.stdout.trimEnd(),
          stderr: execError.stderr.trimEnd(),
        };
      }

      throw error;
    }
  }

  async function assertCommand(
    [command, args]: [string, string[]],
    cwd = repoDir,
  ): Promise<void> {
    const result = await runCommand(command, args, cwd);
    assert.strictEqual(
      result.exitCode,
      0,
      `${command} ${args.join(" ")} failed: ${result.stderr || result.stdout}`,
    );
  }
});
