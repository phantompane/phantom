import { deepStrictEqual, rejects, strictEqual } from "node:assert";
import { afterAll, beforeEach, describe, it, vi } from "vitest";

const exitMock = vi.fn();
const outputLogMock = vi.fn();
const outputErrorMock = vi.fn();
const outputWarnMock = vi.fn();
const listProjectCatalogMock = vi.fn();
const loadPreferencesMock = vi.fn();
const resolveProjectRootPathMock = vi.fn();
const storeAddMock = vi.fn();
const storeListMock = vi.fn();
const storeRemoveMock = vi.fn();

const originalProcessExit = process.exit;

process.exit = (code): never => {
  exitMock(code);
  throw new Error(`Exit with code ${code ?? 0}`);
};

vi.doMock("@phantompane/projects", () => ({
  listProjectCatalog: listProjectCatalogMock,
  resolveProjectRootPath: resolveProjectRootPathMock,
  ProjectRegistryStore: class {
    add = storeAddMock;
    list = storeListMock;
    remove = storeRemoveMock;
  },
}));

vi.doMock("@phantompane/preferences", () => ({
  loadPreferences: loadPreferencesMock,
}));

vi.doMock("../output.ts", () => ({
  output: {
    log: outputLogMock,
    error: outputErrorMock,
    warn: outputWarnMock,
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
  outputWarnMock.mockClear();
  listProjectCatalogMock.mockReset();
  loadPreferencesMock.mockReset();
  resolveProjectRootPathMock.mockReset();
  storeAddMock.mockReset();
  storeListMock.mockReset();
  storeRemoveMock.mockReset();

  resolveProjectRootPathMock.mockImplementation(async (inputPath) => inputPath);
  listProjectCatalogMock.mockResolvedValue({
    version: 2,
    projects: [],
    warnings: [],
  });
  loadPreferencesMock.mockResolvedValue({});
  storeListMock.mockResolvedValue([]);
});

afterAll(() => {
  process.exit = originalProcessExit;
});

describe("project add", () => {
  it("registers the canonical Git root", async () => {
    resolveProjectRootPathMock.mockResolvedValueOnce("/repos/alpha");
    storeAddMock.mockResolvedValueOnce({
      project: alphaProject,
      added: true,
    });

    await rejects(
      async () => await projectAddHandler(["/repos/alpha/packages/cli"]),
      /Exit with code 0/,
    );

    deepStrictEqual(resolveProjectRootPathMock.mock.calls[0], [
      "/repos/alpha/packages/cli",
    ]);
    deepStrictEqual(storeAddMock.mock.calls[0], ["/repos/alpha"]);
    strictEqual(
      outputLogMock.mock.calls[0][0],
      "Added project 'alpha' (/repos/alpha)",
    );
  });

  it("reports an idempotent add as existing JSON", async () => {
    resolveProjectRootPathMock.mockResolvedValueOnce("/repos/alpha");
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
  it("prints the catalog in human-readable form", async () => {
    const secondAlpha = {
      ...alphaProject,
      id: "proj_00000000-0000-4000-8000-000000000003",
      rootPath: "/repos/alpha-z",
      source: "registry" as const,
    };
    listProjectCatalogMock.mockResolvedValueOnce({
      version: 2,
      projects: [
        { ...alphaProject, source: "registry" },
        secondAlpha,
        { ...betaProject, source: "registry" },
      ],
      warnings: [],
    });

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

  it("prints the versioned project catalog as JSON", async () => {
    listProjectCatalogMock.mockResolvedValueOnce({
      version: 2,
      projects: [
        { ...alphaProject, source: "registry" },
        { ...betaProject, source: "registry" },
      ],
      warnings: [],
    });

    await rejects(
      async () => await projectListHandler(["--json"]),
      /Exit with code 0/,
    );

    deepStrictEqual(JSON.parse(outputLogMock.mock.calls[0][0]), {
      version: 2,
      projects: [
        { ...alphaProject, source: "registry" },
        { ...betaProject, source: "registry" },
      ],
    });
  });

  it("prints only names or paths when requested", async () => {
    listProjectCatalogMock.mockResolvedValue({
      version: 2,
      projects: [
        { ...alphaProject, source: "registry" },
        { ...betaProject, source: "registry" },
      ],
      warnings: [],
    });

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
    strictEqual(listProjectCatalogMock.mock.calls.length, 0);
  });

  it("reports unexpected positionals as validation errors", async () => {
    await rejects(
      async () => await projectListHandler(["unexpected"]),
      /Exit with code 3/,
    );

    strictEqual(exitMock.mock.calls[0][0], 3);
    strictEqual(listProjectCatalogMock.mock.calls.length, 0);
  });

  it("prints a message for an empty human-readable list", async () => {
    await rejects(async () => await projectListHandler([]), /Exit with code 0/);

    strictEqual(outputLogMock.mock.calls[0][0], "No projects found.");
  });

  it("marks ghq projects in human-readable output", async () => {
    listProjectCatalogMock.mockResolvedValueOnce({
      version: 2,
      projects: [
        { ...alphaProject, source: "registry" },
        {
          source: "ghq",
          name: "beta",
          rootPath: "/repos/beta",
        },
      ],
      warnings: [],
    });

    await rejects(async () => await projectListHandler([]), /Exit with code 0/);

    deepStrictEqual(
      outputLogMock.mock.calls.map(([message]) => message),
      [`alpha (/repos/alpha) [${alphaProject.id}]`, "beta (/repos/beta) [ghq]"],
    );
  });

  it("marks ghq projects in JSON output", async () => {
    listProjectCatalogMock.mockResolvedValueOnce({
      version: 2,
      projects: [
        {
          source: "ghq",
          name: "beta",
          rootPath: "/repos/beta",
        },
      ],
      warnings: [],
    });

    await rejects(
      async () => await projectListHandler(["--json"]),
      /Exit with code 0/,
    );

    deepStrictEqual(JSON.parse(outputLogMock.mock.calls[0][0]), {
      version: 2,
      projects: [
        {
          source: "ghq",
          name: "beta",
          rootPath: "/repos/beta",
        },
      ],
    });
  });

  it("skips ghq discovery when disabled", async () => {
    loadPreferencesMock.mockResolvedValueOnce({ ghqDiscovery: false });
    listProjectCatalogMock.mockResolvedValueOnce({
      version: 2,
      projects: [{ ...alphaProject, source: "registry" }],
      warnings: [],
    });

    await rejects(async () => await projectListHandler([]), /Exit with code 0/);

    deepStrictEqual(listProjectCatalogMock.mock.calls[0], [
      { includeGhq: false },
    ]);
    deepStrictEqual(
      outputLogMock.mock.calls.map(([message]) => message),
      [`alpha (/repos/alpha) [${alphaProject.id}]`],
    );
  });

  it("prints catalog warnings without failing the list", async () => {
    listProjectCatalogMock.mockResolvedValueOnce({
      version: 2,
      projects: [{ ...alphaProject, source: "registry" }],
      warnings: ["Failed to discover ghq repositories: ghq list failed"],
    });

    await rejects(async () => await projectListHandler([]), /Exit with code 0/);

    strictEqual(
      outputWarnMock.mock.calls[0][0],
      "Warning: Failed to discover ghq repositories: ghq list failed",
    );
    deepStrictEqual(
      outputLogMock.mock.calls.map(([message]) => message),
      [`alpha (/repos/alpha) [${alphaProject.id}]`],
    );
  });

  it("enables ghq discovery by default", async () => {
    await rejects(async () => await projectListHandler([]), /Exit with code 0/);

    deepStrictEqual(listProjectCatalogMock.mock.calls[0], [
      { includeGhq: true },
    ]);
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
    strictEqual(resolveProjectRootPathMock.mock.calls.length, 0);
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

    await rejects(
      async () => await projectRemoveHandler([alphaProject.rootPath, "--json"]),
      /Exit with code 0/,
    );

    strictEqual(resolveProjectRootPathMock.mock.calls.length, 0);
    deepStrictEqual(JSON.parse(outputLogMock.mock.calls[0][0]), {
      status: "removed",
      project: alphaProject,
    });
  });

  it("canonicalizes an existing path before matching it", async () => {
    storeListMock.mockResolvedValueOnce([alphaProject]);
    resolveProjectRootPathMock.mockResolvedValueOnce("/repos/alpha");
    storeRemoveMock.mockResolvedValueOnce(alphaProject);

    await rejects(
      async () => await projectRemoveHandler(["./packages/cli"]),
      /Exit with code 0/,
    );

    deepStrictEqual(storeRemoveMock.mock.calls[0], [alphaProject.id]);
    deepStrictEqual(resolveProjectRootPathMock.mock.calls[0], [
      "./packages/cli",
    ]);
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
    resolveProjectRootPathMock.mockRejectedValueOnce(
      new Error("Path does not exist"),
    );

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
