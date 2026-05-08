import assert from "node:assert";
import { afterEach, beforeEach, it } from "vitest";
import {
  assertCommand,
  describeE2E,
  getWorktreePath,
  runCommand,
  setupRepo,
  type RepoContext,
} from "./helpers.ts";

describeE2E("phantom list e2e", () => {
  let repo: RepoContext;

  beforeEach(async () => {
    repo = await setupRepo();
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it("lists non-default phantom worktrees by name", async () => {
    await assertCommand(
      "git",
      [
        "worktree",
        "add",
        "-b",
        "listed",
        getWorktreePath(repo.repoDir, "listed"),
        "HEAD",
      ],
      {
        cwd: repo.repoDir,
        env: repo.env,
      },
    );

    const result = await runCommand(
      "phantom",
      ["list", "--names", "--no-default"],
      {
        cwd: repo.repoDir,
        env: repo.env,
      },
    );

    assert.strictEqual(result.exitCode, 0, result.stderr);
    assert.deepStrictEqual(result.stdout.split("\n"), ["listed"]);
  });

  it("reports when there are no non-default worktrees", async () => {
    const result = await runCommand("phantom", ["list", "--no-default"], {
      cwd: repo.repoDir,
      env: repo.env,
    });

    assert.strictEqual(result.exitCode, 0, result.stderr);
    assert.match(result.stdout, /No sub worktrees found/);
  });
});
