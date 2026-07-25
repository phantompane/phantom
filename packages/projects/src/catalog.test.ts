import { execFile } from "node:child_process";
import { deepStrictEqual, strictEqual } from "node:assert";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, it } from "vitest";
import {
  DEFAULT_ROOT_RESOLUTION_CONCURRENCY,
  listProjectCatalog,
  PROJECT_LIST_VERSION,
  type GhqRepositoryDiscoverer,
  type ProjectCatalogStore,
  type ProjectRootResolver,
} from "./catalog.ts";
import { GhqDiscoveryError } from "./ghq.ts";
import type { ProjectRecord } from "./types.ts";

const execFileAsync = promisify(execFile);

function project(
  name: string,
  rootPath: string,
  idSuffix: string,
): ProjectRecord {
  return {
    id: `proj_550e8400-e29b-41d4-a716-44665544${idSuffix}`,
    name,
    rootPath,
    createdAt: "2026-07-20T00:00:00.000Z",
  };
}

function createStore(projects: ProjectRecord[]): ProjectCatalogStore {
  return {
    async list() {
      return projects;
    },
  };
}

describe("listProjectCatalog", () => {
  it("exports a list format version separate from registry storage", async () => {
    strictEqual(PROJECT_LIST_VERSION, 2);

    const result = await listProjectCatalog({
      includeGhq: false,
      store: createStore([]),
    });

    strictEqual(result.version, PROJECT_LIST_VERSION);
  });

  it("lists only registered projects when ghq discovery is disabled", async () => {
    let discoveryCalls = 0;
    const discoverGhqRepositories: GhqRepositoryDiscoverer = async () => {
      discoveryCalls += 1;
      return { available: true, rootPaths: ["/repos/ghq"] };
    };

    const result = await listProjectCatalog({
      includeGhq: false,
      store: createStore([
        project("zeta", "/repos/zeta", "0001"),
        project("alpha", "/repos/alpha", "0002"),
      ]),
      discoverGhqRepositories,
    });

    strictEqual(discoveryCalls, 0);
    deepStrictEqual(
      result.projects.map(({ name, rootPath, source }) => ({
        name,
        rootPath,
        source,
      })),
      [
        { name: "alpha", rootPath: "/repos/alpha", source: "registry" },
        { name: "zeta", rootPath: "/repos/zeta", source: "registry" },
      ],
    );
    deepStrictEqual(result.warnings, []);
  });

  it("merges transient ghq projects while registered roots win", async () => {
    const registeredAlpha = project("alpha", "/repos/alpha", "0001");
    const result = await listProjectCatalog({
      store: createStore([registeredAlpha]),
      discoverGhqRepositories: async () => ({
        available: true,
        rootPaths: ["/ghq/alpha", "/ghq/client/shared", "/ghq/upstream/shared"],
      }),
      resolveRootPath: async (rootPath) =>
        rootPath === "/ghq/alpha" ? "/repos/alpha" : rootPath,
    });

    deepStrictEqual(result.projects, [
      { ...registeredAlpha, source: "registry" },
      {
        source: "ghq",
        name: "shared",
        rootPath: "/ghq/client/shared",
      },
      {
        source: "ghq",
        name: "shared",
        rootPath: "/ghq/upstream/shared",
      },
    ]);
    deepStrictEqual(result.warnings, []);
  });

  it("deduplicates a bare ghq repository and its linked worktree", async () => {
    const temporaryDirectory = await mkdtemp(
      join(tmpdir(), "phantom-ghq-bare-"),
    );
    const seedRoot = join(temporaryDirectory, "seed");
    const bareRoot = join(temporaryDirectory, "example.git");
    const linkedRoot = join(temporaryDirectory, "linked");

    try {
      await execFileAsync("git", ["init", seedRoot]);
      await execFileAsync("git", [
        "-C",
        seedRoot,
        "-c",
        "user.name=Phantom Test",
        "-c",
        "user.email=phantom@example.com",
        "commit",
        "--allow-empty",
        "-m",
        "Initial commit",
      ]);
      await execFileAsync("git", ["clone", "--bare", seedRoot, bareRoot]);
      await execFileAsync("git", [
        "-C",
        bareRoot,
        "worktree",
        "add",
        linkedRoot,
      ]);
      const canonicalRoot = await realpath(bareRoot);

      const result = await listProjectCatalog({
        store: createStore([]),
        discoverGhqRepositories: async () => ({
          available: true,
          rootPaths: [linkedRoot, bareRoot],
        }),
      });

      deepStrictEqual(result.projects, [
        {
          source: "ghq",
          name: "example.git",
          rootPath: canonicalRoot,
        },
      ]);
      deepStrictEqual(result.warnings, []);
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("skips invalid roots and canonicalizes ghq candidates with bounded concurrency", async () => {
    const calls: string[] = [];
    let activeCalls = 0;
    let maximumActiveCalls = 0;
    const resolveRootPath: ProjectRootResolver = async (rootPath) => {
      calls.push(rootPath);
      activeCalls += 1;
      maximumActiveCalls = Math.max(maximumActiveCalls, activeCalls);
      await Promise.resolve();
      activeCalls -= 1;

      if (rootPath === "/ghq/invalid") {
        throw new Error("not a Git repository");
      }
      if (rootPath.endsWith("/duplicate")) {
        return "/repos/canonical";
      }
      return rootPath;
    };

    const result = await listProjectCatalog({
      store: createStore([]),
      discoverGhqRepositories: async () => ({
        available: true,
        rootPaths: [
          "/ghq/invalid",
          "/ghq/first/duplicate",
          "/ghq/second/duplicate",
          "/repos/zeta",
        ],
      }),
      resolveRootPath,
      rootResolutionConcurrency: 2,
    });

    deepStrictEqual(calls, [
      "/ghq/invalid",
      "/ghq/first/duplicate",
      "/ghq/second/duplicate",
      "/repos/zeta",
    ]);
    strictEqual(maximumActiveCalls, 2);
    deepStrictEqual(result.projects, [
      {
        source: "ghq",
        name: "canonical",
        rootPath: "/repos/canonical",
      },
      { source: "ghq", name: "zeta", rootPath: "/repos/zeta" },
    ]);
  });

  it("uses a finite default concurrency and preserves deterministic ordering", async () => {
    let activeCalls = 0;
    let maximumActiveCalls = 0;
    const resolveRootPath: ProjectRootResolver = async (rootPath) => {
      activeCalls += 1;
      maximumActiveCalls = Math.max(maximumActiveCalls, activeCalls);
      await Promise.resolve();
      activeCalls -= 1;
      return rootPath;
    };
    const candidatePaths = Array.from(
      { length: DEFAULT_ROOT_RESOLUTION_CONCURRENCY + 3 },
      (_, index) => `/repos/project-${String(index).padStart(2, "0")}`,
    ).reverse();

    const result = await listProjectCatalog({
      store: createStore([]),
      discoverGhqRepositories: async () => ({
        available: true,
        rootPaths: candidatePaths,
      }),
      resolveRootPath,
    });

    strictEqual(maximumActiveCalls, DEFAULT_ROOT_RESOLUTION_CONCURRENCY);
    deepStrictEqual(
      result.projects.map((entry) => entry.rootPath),
      [...candidatePaths].sort(),
    );
  });

  it("keeps registered projects and returns a warning when ghq fails", async () => {
    const registered = project("alpha", "/repos/alpha", "0001");
    const commandError = new GhqDiscoveryError(
      "Failed to discover ghq repositories: command failed",
    );

    const result = await listProjectCatalog({
      store: createStore([registered]),
      discoverGhqRepositories: async () => {
        throw commandError;
      },
    });

    deepStrictEqual(result.projects, [{ ...registered, source: "registry" }]);
    deepStrictEqual(result.warnings, [
      "Failed to discover ghq repositories: command failed",
    ]);
  });

  it("keeps registered projects and returns a warning when ghq times out", async () => {
    const registered = project("alpha", "/repos/alpha", "0001");
    const timeoutError = new GhqDiscoveryError(
      "Failed to discover ghq repositories: timed out after 5000 ms",
    );

    const result = await listProjectCatalog({
      store: createStore([registered]),
      discoverGhqRepositories: async () => {
        throw timeoutError;
      },
    });

    deepStrictEqual(result.projects, [{ ...registered, source: "registry" }]);
    deepStrictEqual(result.warnings, [timeoutError.message]);
  });

  it("does not warn when ghq is unavailable", async () => {
    const result = await listProjectCatalog({
      store: createStore([]),
      discoverGhqRepositories: async () => ({
        available: false,
        rootPaths: [],
      }),
    });

    deepStrictEqual(result, {
      version: PROJECT_LIST_VERSION,
      projects: [],
      warnings: [],
    });
  });
});
