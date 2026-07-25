import assert from "node:assert";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
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
    const disableDiscoveryResult = await runCommand(
      "git",
      ["config", "--global", "phantom.ghqDiscovery", "false"],
      {
        cwd: repo.rootDir,
        env: projectEnv,
      },
    );
    assert.strictEqual(
      disableDiscoveryResult.exitCode,
      0,
      disableDiscoveryResult.stderr,
    );

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
      version: 2,
      projects: [{ ...added.project, source: "registry" }],
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
      version: 2,
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

  it.skipIf(process.platform === "win32")(
    "discovers ghq projects by default and allows disabling discovery",
    async () => {
      const binDirectory = join(repo.rootDir, "bin");
      const ghqPath = join(binDirectory, "ghq");
      await mkdir(binDirectory, { recursive: true });
      await writeFile(
        ghqPath,
        [
          "#!/bin/sh",
          'if [ "$1" != "list" ] || [ "$2" != "--full-path" ]; then',
          "  exit 2",
          "fi",
          'printf "%s\\n" "$PHANTOM_TEST_GHQ_PROJECT"',
          "",
        ].join("\n"),
      );
      await chmod(ghqPath, 0o755);

      const projectEnv = {
        ...repo.env,
        PATH: `${binDirectory}${delimiter}${repo.env.PATH ?? ""}`,
        PHANTOM_TEST_GHQ_PROJECT: repo.repoDir,
        XDG_STATE_HOME: join(repo.rootDir, "state"),
      };
      const discoveredList = await runCommand(
        "phantom",
        ["project", "list", "--json"],
        {
          cwd: repo.rootDir,
          env: projectEnv,
        },
      );

      assert.strictEqual(discoveredList.exitCode, 0, discoveredList.stderr);
      assert.deepStrictEqual(JSON.parse(discoveredList.stdout), {
        version: 2,
        projects: [
          {
            source: "ghq",
            name: "repo",
            rootPath: repo.repoDir,
          },
        ],
      });

      const disableResult = await runCommand(
        "phantom",
        ["preferences", "set", "ghqDiscovery", "false"],
        {
          cwd: repo.rootDir,
          env: projectEnv,
        },
      );
      assert.strictEqual(disableResult.exitCode, 0, disableResult.stderr);

      const disabledList = await runCommand(
        "phantom",
        ["project", "list", "--json"],
        {
          cwd: repo.rootDir,
          env: projectEnv,
        },
      );
      assert.strictEqual(disabledList.exitCode, 0, disabledList.stderr);
      assert.deepStrictEqual(JSON.parse(disabledList.stdout), {
        version: 2,
        projects: [],
      });
    },
  );

  it.skipIf(process.platform === "win32")(
    "returns registered projects and warns on stderr when ghq discovery fails",
    async () => {
      const binDirectory = join(repo.rootDir, "bin");
      const ghqPath = join(binDirectory, "ghq");
      await mkdir(binDirectory, { recursive: true });
      await writeFile(
        ghqPath,
        [
          "#!/bin/sh",
          'printf "%s\\n" "simulated ghq failure" >&2',
          "exit 17",
          "",
        ].join("\n"),
      );
      await chmod(ghqPath, 0o755);

      const projectEnv = {
        ...repo.env,
        PATH: `${binDirectory}${delimiter}${repo.env.PATH ?? ""}`,
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
        project: ProjectRecord;
      };

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
        version: 2,
        projects: [{ ...added.project, source: "registry" }],
      });
      assert.doesNotMatch(listResult.stdout, /Warning:/);
      assert.match(
        listResult.stderr,
        /Warning: Failed to discover ghq repositories:.*simulated ghq failure/s,
      );
    },
  );
});
