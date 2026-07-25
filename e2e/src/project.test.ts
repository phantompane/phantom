import assert from "node:assert";
import { join } from "node:path";
import { afterEach, beforeEach, it } from "vitest";
import {
  describeE2E,
  runCommand,
  setupRepo,
  type RepoContext,
} from "./helpers.ts";

type ProjectRecord = {
  id: string;
  name: string;
  rootPath: string;
  createdAt: string;
};

describeE2E("phantom project e2e", () => {
  let repo: RepoContext;

  beforeEach(async () => {
    repo = await setupRepo();
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it("adds, lists, and removes a project through the global registry", async () => {
    const projectEnv = {
      ...repo.env,
      XDG_STATE_HOME: join(repo.rootDir, "state"),
    };
    const addResult = await runCommand(
      "phantom",
      ["project", "add", repo.repoDir, "--json"],
      {
        cwd: repo.rootDir,
        env: projectEnv,
      },
    );

    assert.strictEqual(addResult.exitCode, 0, addResult.stderr);
    const added = JSON.parse(addResult.stdout) as {
      status: string;
      project: ProjectRecord;
    };
    assert.strictEqual(added.status, "added");
    assert.ok(added.project.id.length > 0);
    assert.strictEqual(added.project.name, "repo");
    assert.strictEqual(added.project.rootPath, repo.repoDir);
    assert.ok(!Number.isNaN(Date.parse(added.project.createdAt)));

    const linkedWorktreePath = join(repo.rootDir, "linked-worktree");
    const worktreeResult = await runCommand(
      "git",
      ["worktree", "add", "-b", "project-linked", linkedWorktreePath],
      {
        cwd: repo.repoDir,
        env: repo.env,
      },
    );
    assert.strictEqual(worktreeResult.exitCode, 0, worktreeResult.stderr);

    const linkedAddResult = await runCommand(
      "phantom",
      ["project", "add", linkedWorktreePath, "--json"],
      {
        cwd: linkedWorktreePath,
        env: projectEnv,
      },
    );
    assert.strictEqual(linkedAddResult.exitCode, 0, linkedAddResult.stderr);
    assert.deepStrictEqual(JSON.parse(linkedAddResult.stdout), {
      status: "existing",
      project: added.project,
    });

    const listResult = await runCommand(
      "phantom",
      ["project", "list", "--json"],
      {
        cwd: repo.rootDir,
        env: projectEnv,
      },
    );

    assert.strictEqual(listResult.exitCode, 0, listResult.stderr);
    assert.deepStrictEqual(JSON.parse(listResult.stdout), {
      version: 1,
      projects: [added.project],
    });

    const removeResult = await runCommand(
      "phantom",
      ["project", "remove", added.project.id, "--json"],
      {
        cwd: repo.rootDir,
        env: projectEnv,
      },
    );

    assert.strictEqual(removeResult.exitCode, 0, removeResult.stderr);
    assert.deepStrictEqual(JSON.parse(removeResult.stdout), {
      status: "removed",
      project: added.project,
    });

    const emptyListResult = await runCommand(
      "phantom",
      ["project", "list", "--json"],
      {
        cwd: repo.rootDir,
        env: projectEnv,
      },
    );
    assert.strictEqual(emptyListResult.exitCode, 0, emptyListResult.stderr);
    assert.deepStrictEqual(JSON.parse(emptyListResult.stdout), {
      version: 1,
      projects: [],
    });

    const gitResult = await runCommand(
      "git",
      ["rev-parse", "--is-inside-work-tree"],
      {
        cwd: repo.repoDir,
        env: repo.env,
      },
    );
    assert.strictEqual(gitResult.exitCode, 0, gitResult.stderr);
    assert.strictEqual(gitResult.stdout, "true");
  });
});
