import { basename } from "node:path";
import { discoverGhqRepositories, type GhqDiscoveryResult } from "./ghq.ts";
import { resolveProjectRootPath } from "./resolve-root.ts";
import { ProjectRegistryStore } from "./store.ts";
import type { ProjectRecord } from "./types.ts";

export const PROJECT_LIST_VERSION = 2 as const;
export const DEFAULT_ROOT_RESOLUTION_CONCURRENCY = 4;

export type ProjectListEntry =
  | (ProjectRecord & { source: "registry" })
  | {
      source: "ghq";
      name: string;
      rootPath: string;
    };

export interface ProjectCatalogResult {
  version: typeof PROJECT_LIST_VERSION;
  projects: ProjectListEntry[];
  warnings: string[];
}

export interface ProjectCatalogStore {
  list(): Promise<ProjectRecord[]>;
}

export type GhqRepositoryDiscoverer = () => Promise<GhqDiscoveryResult>;
export type ProjectRootResolver = (rootPath: string) => Promise<string>;

export interface ProjectCatalogOptions {
  includeGhq?: boolean;
  store?: ProjectCatalogStore;
  discoverGhqRepositories?: GhqRepositoryDiscoverer;
  resolveRootPath?: ProjectRootResolver;
  rootResolutionConcurrency?: number;
}

export async function listProjectCatalog(
  options: ProjectCatalogOptions = {},
): Promise<ProjectCatalogResult> {
  const store = options.store ?? new ProjectRegistryStore();
  const registeredProjects = await store.list();
  const projects: ProjectListEntry[] = registeredProjects.map((project) => ({
    ...project,
    source: "registry",
  }));
  const warnings: string[] = [];

  if (options.includeGhq !== false) {
    const discover = options.discoverGhqRepositories ?? discoverGhqRepositories;
    let discovery: GhqDiscoveryResult | undefined;
    try {
      discovery = await discover();
    } catch (error) {
      warnings.push(toWarningMessage(error));
    }

    if (discovery?.available) {
      const resolveRootPath = options.resolveRootPath ?? resolveProjectRootPath;
      const knownRootPaths = new Set(
        registeredProjects.map((project) => project.rootPath),
      );
      const resolvedRootPaths = await resolveCandidateRootPaths(
        discovery.rootPaths,
        resolveRootPath,
        options.rootResolutionConcurrency ??
          DEFAULT_ROOT_RESOLUTION_CONCURRENCY,
      );

      for (const rootPath of resolvedRootPaths) {
        if (rootPath === undefined) {
          continue;
        }

        if (knownRootPaths.has(rootPath)) {
          continue;
        }

        knownRootPaths.add(rootPath);
        projects.push({
          source: "ghq",
          name: basename(rootPath),
          rootPath,
        });
      }
    }
  }

  return {
    version: PROJECT_LIST_VERSION,
    projects: sortProjects(projects),
    warnings,
  };
}

async function resolveCandidateRootPaths(
  candidatePaths: readonly string[],
  resolveRootPath: ProjectRootResolver,
  concurrency: number,
): Promise<Array<string | undefined>> {
  const resolvedRootPaths = Array.from(
    { length: candidatePaths.length },
    (): string | undefined => undefined,
  );
  const workerCount = Math.min(
    candidatePaths.length,
    normalizeConcurrency(concurrency),
  );
  let nextIndex = 0;

  async function resolveNext(): Promise<void> {
    while (nextIndex < candidatePaths.length) {
      const index = nextIndex;
      nextIndex += 1;

      try {
        resolvedRootPaths[index] = await resolveRootPath(candidatePaths[index]);
      } catch {
        resolvedRootPaths[index] = undefined;
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => resolveNext()));
  return resolvedRootPaths;
}

function normalizeConcurrency(concurrency: number): number {
  if (!Number.isFinite(concurrency) || concurrency < 1) {
    return 1;
  }
  return Math.floor(concurrency);
}

function sortProjects(projects: ProjectListEntry[]): ProjectListEntry[] {
  return [...projects].sort((left, right) => {
    const nameComparison = compareStrings(left.name, right.name);
    return nameComparison || compareStrings(left.rootPath, right.rootPath);
  });
}

function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function toWarningMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }
  const message = String(error).trim();
  return message || "Failed to discover ghq repositories";
}
