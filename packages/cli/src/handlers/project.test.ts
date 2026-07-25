import { deepStrictEqual, rejects, strictEqual } from "node:assert";
import { afterAll, beforeEach, describe, it, vi } from "vitest";

const exitMock = vi.fn();
const outputLogMock = vi.fn();
const outputErrorMock = vi.fn();
const getGitRootMock = vi.fn();
const realpathMock = vi.fn();
const storeAddMock = vi.fn();
const storeListMock = vi.fn();
const storeRemoveMock = vi.fn();

const originalProcessExit = process.exit;

process.exit = (code): never => {
  exitMock(code);
  throw new Error(`Exit with code ${code ?? 0}`);
};

vi.doMock("node:fs/promises", () => ({
  realpath: realpathMock,
}));

vi.doMock("@phantompane/git", () => ({
  getGitRoot: getGitRootMock,
}));

vi.doMock("@phantompane/projects", () => ({
  PROJECT_REGISTRY_VERSION: 1,
  ProjectRegistryStore: class {
    add = storeAddMock;
    list = storeListMock;
    remove = storeRemoveMock;
  },
}));

vi.doMock("../output.ts", () => ({
  output: {
    log: outputLogMock,
    error: outputErrorMock,
  },
}));

const { projectAddHandler } = await import("./project-add.ts");
const { projectListHandler } = await import("./project-list.ts");
const { projectRemoveHandler } = await import("./project-remove.ts");

const alphaProject = {
  id: "proj_00000000-0000-4000-8000-000000000001",
  name: "alpha",
  rootPath: "/repos/alpha",
  createdAt: "2026-07-20T00:00:00.000Z",
};

const betaProject = {
  id: "proj_00000000-0000-4000-8000-000000000002",
  name: "beta",
  rootPath: "/repos/beta",
  createdAt: "2026-07-20T00:00:01.000Z",
};

beforeEach(() => {
  exitMock.mockClear();
  outputLogMock.mockClear();
  outputErrorMock.mockClear();
  getGitRootMock.mockReset();
  realpathMock.mockReset();
  storeAddMock.mockReset();
  storeListMock.mockReset();
  storeRemoveMock.mockReset();

  realpathMock.mockImplementation(async (inputPath) => String(inputPath));
  getGitRootMock.mockImplementation(async ({ cwd }) => cwd);
  storeListMock.mockResolvedValue([]);
});

afterAll(() => {
  process.exit = originalProcessExit;
});

describe("project add", () => {
  it("registers the canonical Git root", async () => {
    getGitRootMock.mockResolvedValueOnce("/repos/alpha");
    storeAddMock.mockResolvedValueOnce({
      project: alphaProject,
      added: true,
    });

    await rejects(
      async () => await projectAddHandler(["/repos/alpha/packages/cli"]),
      /Exit with code 0/,
    );

    deepStrictEqual(getGitRootMock.mock.calls[0], [
      { cwd: "/repos/alpha/packages/cli" },
    ]);
    deepStrictEqual(storeAddMock.mock.calls[0], ["/repos/alpha"]);
    strictEqual(
      outputLogMock.mock.calls[0][0],
      "Added project 'alpha' (/repos/alpha)",
    );
  });

  it("reports an idempotent add as existing JSON", async () => {
    getGitRootMock.mockResolvedValueOnce("/repos/alpha");
    storeAddMock.mockResolvedValueOnce({
      project: alphaProject,
      added: false,
    });

    await rejects(
      async () => await projectAddHandler(["/repos/alpha", "--json"]),
      /Exit with code 0/,
    );

    deepStrictEqual(JSON.parse(outputLogMock.mock.calls[0][0]), {
      status: "existing",
      project: alphaProject,
    });
  });

  it("rejects more than one path", async () => {
    await rejects(
      async () => await projectAddHandler(["one", "two"]),
      /Exit with code 3/,
    );

    strictEqual(
      outputErrorMock.mock.calls[0][0],
      "Usage: phantom project add [path] [--json]",
    );
    strictEqual(storeAddMock.mock.calls.length, 0);
  });

  it("reports unknown options as validation errors", async () => {
    await rejects(
      async () => await projectAddHandler(["--unknown"]),
      /Exit with code 3/,
    );

    strictEqual(exitMock.mock.calls[0][0], 3);
    strictEqual(storeAddMock.mock.calls.length, 0);
  });
});

describe("project list", () => {
  it("prints a deterministic human-readable list", async () => {
    storeListMock.mockResolvedValueOnce([
      betaProject,
      {
        ...alphaProject,
        id: "proj_00000000-0000-4000-8000-000000000003",
        rootPath: "/repos/alpha-z",
      },
      alphaProject,
    ]);

    await rejects(async () => await projectListHandler([]), /Exit with code 0/);

    deepStrictEqual(
      outputLogMock.mock.calls.map(([message]) => message),
      [
        `alpha (/repos/alpha) [${alphaProject.id}]`,
        "alpha (/repos/alpha-z) [proj_00000000-0000-4000-8000-000000000003]",
        `beta (/repos/beta) [${betaProject.id}]`,
      ],
    );
  });

  it("prints the versioned registry as JSON", async () => {
    storeListMock.mockResolvedValueOnce([betaProject, alphaProject]);

    await rejects(
      async () => await projectListHandler(["--json"]),
      /Exit with code 0/,
    );

    deepStrictEqual(JSON.parse(outputLogMock.mock.calls[0][0]), {
      version: 1,
      projects: [alphaProject, betaProject],
    });
  });

  it("sorts JSON output by code point instead of the host locale", async () => {
    const uppercaseProject = {
      ...alphaProject,
      id: "proj_00000000-0000-4000-8000-000000000005",
      name: "Alpha",
      rootPath: "/repos/uppercase",
    };
    const zetaProject = {
      ...alphaProject,
      id: "proj_00000000-0000-4000-8000-000000000006",
      name: "zeta",
      rootPath: "/repos/zeta",
    };
    const umlautProject = {
      ...alphaProject,
      id: "proj_00000000-0000-4000-8000-000000000007",
      name: "äther",
      rootPath: "/repos/umlaut",
    };
    storeListMock.mockResolvedValueOnce([
      umlautProject,
      zetaProject,
      uppercaseProject,
    ]);

    await rejects(
      async () => await projectListHandler(["--json"]),
      /Exit with code 0/,
    );

    deepStrictEqual(JSON.parse(outputLogMock.mock.calls[0][0]).projects, [
      uppercaseProject,
      zetaProject,
      umlautProject,
    ]);
  });

  it("prints only names or paths when requested", async () => {
    storeListMock.mockResolvedValue([betaProject, alphaProject]);

    await rejects(
      async () => await projectListHandler(["--names"]),
      /Exit with code 0/,
    );
    deepStrictEqual(
      outputLogMock.mock.calls.map(([message]) => message),
      ["alpha", "beta"],
    );

    outputLogMock.mockClear();
    await rejects(
      async () => await projectListHandler(["--paths"]),
      /Exit with code 0/,
    );
    deepStrictEqual(
      outputLogMock.mock.calls.map(([message]) => message),
      ["/repos/alpha", "/repos/beta"],
    );
  });

  it("rejects conflicting output modes", async () => {
    await rejects(
      async () => await projectListHandler(["--json", "--paths"]),
      /Exit with code 3/,
    );

    strictEqual(
      outputErrorMock.mock.calls[0][0],
      "Only one of --json, --names, or --paths can be specified",
    );
    strictEqual(storeListMock.mock.calls.length, 0);
  });

  it("reports unexpected positionals as validation errors", async () => {
    await rejects(
      async () => await projectListHandler(["unexpected"]),
      /Exit with code 3/,
    );

    strictEqual(exitMock.mock.calls[0][0], 3);
    strictEqual(storeListMock.mock.calls.length, 0);
  });

  it("prints a message for an empty human-readable list", async () => {
    await rejects(async () => await projectListHandler([]), /Exit with code 0/);

    strictEqual(outputLogMock.mock.calls[0][0], "No projects found.");
  });
});

describe("project remove", () => {
  it("removes a project by id without touching the repository", async () => {
    storeListMock.mockResolvedValueOnce([alphaProject]);
    storeRemoveMock.mockResolvedValueOnce(alphaProject);

    await rejects(
      async () => await projectRemoveHandler([alphaProject.id]),
      /Exit with code 0/,
    );

    deepStrictEqual(storeRemoveMock.mock.calls[0], [alphaProject.id]);
    strictEqual(realpathMock.mock.calls.length, 0);
    strictEqual(
      outputLogMock.mock.calls[0][0],
      "Removed project 'alpha' (/repos/alpha)",
    );
  });

  it("prefers an exact id over another project's matching name", async () => {
    const collidingProject = {
      ...betaProject,
      name: alphaProject.id,
    };
    storeListMock.mockResolvedValueOnce([alphaProject, collidingProject]);
    storeRemoveMock.mockResolvedValueOnce(alphaProject);

    await rejects(
      async () => await projectRemoveHandler([alphaProject.id]),
      /Exit with code 0/,
    );

    deepStrictEqual(storeRemoveMock.mock.calls[0], [alphaProject.id]);
  });

  it("removes a missing repository by its exact stored path", async () => {
    storeListMock.mockResolvedValueOnce([alphaProject]);
    storeRemoveMock.mockResolvedValueOnce(alphaProject);
    realpathMock.mockRejectedValueOnce(new Error("Path does not exist"));

    await rejects(
      async () => await projectRemoveHandler([alphaProject.rootPath, "--json"]),
      /Exit with code 0/,
    );

    strictEqual(realpathMock.mock.calls.length, 0);
    deepStrictEqual(JSON.parse(outputLogMock.mock.calls[0][0]), {
      status: "removed",
      project: alphaProject,
    });
  });

  it("canonicalizes an existing path before matching it", async () => {
    storeListMock.mockResolvedValueOnce([alphaProject]);
    realpathMock
      .mockResolvedValueOnce("/repos/alpha/packages/cli")
      .mockResolvedValueOnce("/repos/alpha");
    getGitRootMock.mockResolvedValueOnce("/repos/alpha");
    storeRemoveMock.mockResolvedValueOnce(alphaProject);

    await rejects(
      async () => await projectRemoveHandler(["./packages/cli"]),
      /Exit with code 0/,
    );

    deepStrictEqual(storeRemoveMock.mock.calls[0], [alphaProject.id]);
  });

  it("requires an id or path when a name is ambiguous", async () => {
    storeListMock.mockResolvedValueOnce([
      alphaProject,
      {
        ...alphaProject,
        id: "proj_00000000-0000-4000-8000-000000000004",
        rootPath: "/other/alpha",
      },
    ]);

    await rejects(
      async () => await projectRemoveHandler(["alpha"]),
      /Exit with code 3/,
    );

    strictEqual(
      outputErrorMock.mock.calls[0][0],
      "Project 'alpha' is ambiguous; use its id or path",
    );
    strictEqual(storeRemoveMock.mock.calls.length, 0);
  });

  it("returns not found for an unknown selector", async () => {
    storeListMock.mockResolvedValueOnce([alphaProject]);
    realpathMock.mockRejectedValueOnce(new Error("Path does not exist"));

    await rejects(
      async () => await projectRemoveHandler(["missing"]),
      /Exit with code 2/,
    );

    strictEqual(
      outputErrorMock.mock.calls[0][0],
      "Project 'missing' not found",
    );
  });

  it("reports unknown options as validation errors", async () => {
    await rejects(
      async () => await projectRemoveHandler(["alpha", "--unknown"]),
      /Exit with code 3/,
    );

    strictEqual(exitMock.mock.calls[0][0], 3);
    strictEqual(storeListMock.mock.calls.length, 0);
  });
});
