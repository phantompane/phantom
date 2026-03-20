import assert from "node:assert";
import { access } from "node:fs/promises";
import { afterEach, beforeEach, it } from "vitest";
import {
  assertCommand,
  describeE2E,
  getWorktreePath,
  runCommand,
  setupRepo,
  type RepoContext,
} from "./helpers.ts";

describeE2E("phantom delete e2e", () => {
  let repo: RepoContext;
  let worktreePath: string;

  beforeEach(async () => {
    repo = await setupRepo();
    worktreePath = getWorktreePath(repo.repoDir, "removable");
    await assertCommand(
      "git",
      ["worktree", "add", "-b", "removable", worktreePath, "HEAD"],
      {
        cwd: repo.repoDir,
        env: repo.env,
      },
    );
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it("removes the worktree and its branch", async () => {
    const result = await runCommand("phantom", ["delete", "removable"], {
      cwd: repo.repoDir,
      env: repo.env,
    });

    assert.strictEqual(result.exitCode, 0, result.stderr);
    assert.match(
      result.stdout,
      /Deleted worktree 'removable' and its branch 'removable'/,
    );

    await assert.rejects(access(worktreePath), { code: "ENOENT" });

    const branchResult = await runCommand(
      "git",
      ["branch", "--list", "removable"],
      {
        cwd: repo.repoDir,
        env: repo.env,
      },
    );
    assert.strictEqual(branchResult.exitCode, 0, branchResult.stderr);
    assert.strictEqual(branchResult.stdout, "");
  });

  it("returns a validation error when the worktree does not exist", async () => {
    const result = await runCommand("phantom", ["delete", "missing-worktree"], {
      cwd: repo.repoDir,
      env: repo.env,
    });

    assert.strictEqual(result.exitCode, 3);
    assert.match(result.stderr, /Worktree 'missing-worktree' not found/);
  });
});
