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

describeE2E("phantom where e2e", () => {
  let repo: RepoContext;
  let worktreePath: string;

  beforeEach(async () => {
    repo = await setupRepo();
    worktreePath = getWorktreePath(repo.repoDir, "located");
    await assertCommand(
      "git",
      ["worktree", "add", "-b", "located", worktreePath, "HEAD"],
      {
        cwd: repo.repoDir,
        env: repo.env,
      },
    );
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it("outputs the path of an existing worktree", async () => {
    const result = await runCommand("phantom", ["where", "located"], {
      cwd: repo.repoDir,
      env: repo.env,
    });

    assert.strictEqual(result.exitCode, 0, result.stderr);
    assert.strictEqual(result.stdout, worktreePath);
  });

  it("returns not found when the worktree does not exist", async () => {
    const result = await runCommand("phantom", ["where", "missing-worktree"], {
      cwd: repo.repoDir,
      env: repo.env,
    });

    assert.strictEqual(result.exitCode, 2);
    assert.match(result.stderr, /Worktree 'missing-worktree' not found/);
  });
});
