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

describeE2E("phantom attach e2e", () => {
  let repo: RepoContext;

  beforeEach(async () => {
    repo = await setupRepo();
    await assertCommand("git", ["branch", "existing-feature"], {
      cwd: repo.repoDir,
      env: repo.env,
    });
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it("attaches an existing branch into a phantom worktree", async () => {
    const result = await runCommand("phantom", ["attach", "existing-feature"], {
      cwd: repo.repoDir,
      env: repo.env,
    });

    assert.strictEqual(result.exitCode, 0, result.stderr);
    assert.match(result.stdout, /Attached phantom: existing-feature/);

    const worktreePath = getWorktreePath(repo.repoDir, "existing-feature");

    await assert.doesNotReject(access(worktreePath));

    const branchResult = await runCommand("git", ["branch", "--show-current"], {
      cwd: worktreePath,
      env: repo.env,
    });
    assert.strictEqual(branchResult.exitCode, 0, branchResult.stderr);
    assert.strictEqual(branchResult.stdout, "existing-feature");
  });

  it("returns not found when the branch does not exist", async () => {
    const result = await runCommand("phantom", ["attach", "missing-branch"], {
      cwd: repo.repoDir,
      env: repo.env,
    });

    assert.strictEqual(result.exitCode, 2);
    assert.match(result.stderr, /Branch 'missing-branch' not found/);
  });
});
