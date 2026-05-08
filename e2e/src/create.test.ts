import assert from "node:assert";
import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
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

  it("copies files configured in phantom.config.json", async () => {
    await writeFile(join(repo.repoDir, ".env.local"), "API_KEY=test-value\n");
    await writeFile(
      join(repo.repoDir, "phantom.config.json"),
      JSON.stringify(
        {
          postCreate: {
            copyFiles: [".env.local"],
          },
        },
        null,
        2,
      ),
    );

    const result = await runCommand(
      "phantom",
      ["create", "feature/config-copy-files"],
      {
        cwd: repo.repoDir,
        env: repo.env,
      },
    );

    assert.strictEqual(result.exitCode, 0, result.stderr);

    const worktreePath = getWorktreePath(
      repo.repoDir,
      "feature/config-copy-files",
    );
    const copiedFileContent = await readFile(
      join(worktreePath, ".env.local"),
      "utf-8",
    );

    assert.strictEqual(copiedFileContent, "API_KEY=test-value\n");
  });

  it("runs postCreate commands configured in phantom.config.json", async () => {
    await writeFile(
      join(repo.repoDir, "phantom.config.json"),
      JSON.stringify(
        {
          postCreate: {
            commands: ["touch post-create.txt"],
          },
        },
        null,
        2,
      ),
    );

    const result = await runCommand(
      "phantom",
      ["create", "feature/config-post-create"],
      {
        cwd: repo.repoDir,
        env: repo.env,
      },
    );

    assert.strictEqual(result.exitCode, 0, result.stderr);
    assert.match(result.stdout, /Running post-create commands/);
    assert.match(result.stdout, /Executing: touch post-create\.txt/);

    const worktreePath = getWorktreePath(
      repo.repoDir,
      "feature/config-post-create",
    );
    await assert.doesNotReject(access(join(worktreePath, "post-create.txt")));
  });
});
