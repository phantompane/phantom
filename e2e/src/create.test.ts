import assert from "node:assert";
import { access } from "node:fs/promises";
import { afterEach, beforeEach, it } from "vitest";
import {
  describeE2E,
  getWorktreePath,
  runCommand,
  setupRepo,
  type RepoContext,
} from "./helpers.ts";

describeE2E("phantom create e2e", () => {
  let repo: RepoContext;

  beforeEach(async () => {
    repo = await setupRepo();
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it("creates a worktree in the default phantom directory", async () => {
    const result = await runCommand(
      "phantom",
      ["create", "feature/add-tests"],
      {
        cwd: repo.repoDir,
        env: repo.env,
      },
    );

    assert.strictEqual(result.exitCode, 0, result.stderr);
    assert.match(result.stdout, /Created worktree 'feature\/add-tests' at /);

    const worktreePath = getWorktreePath(repo.repoDir, "feature/add-tests");

    await assert.doesNotReject(access(worktreePath));

    const branchResult = await runCommand("git", ["branch", "--show-current"], {
      cwd: worktreePath,
      env: repo.env,
    });
    assert.strictEqual(branchResult.exitCode, 0, branchResult.stderr);
    assert.strictEqual(branchResult.stdout, "feature/add-tests");
  });

  it("returns a validation error when the worktree name already exists", async () => {
    await runCommand("phantom", ["create", "feature/add-tests"], {
      cwd: repo.repoDir,
      env: repo.env,
    });

    const result = await runCommand(
      "phantom",
      ["create", "feature/add-tests"],
      {
        cwd: repo.repoDir,
        env: repo.env,
      },
    );

    assert.strictEqual(result.exitCode, 3);
    assert.match(result.stderr, /Worktree 'feature\/add-tests' already exists/);
  });
});
