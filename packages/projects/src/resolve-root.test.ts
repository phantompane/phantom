import { deepStrictEqual, rejects, strictEqual } from "node:assert";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it, vi } from "vitest";

const getGitRootMock = vi.fn();

vi.doMock("@phantompane/git", () => ({
  getGitRoot: getGitRootMock,
}));

const { resolveProjectRootPath } = await import("./resolve-root.ts");

const temporaryDirectories: string[] = [];

afterEach(async () => {
  getGitRootMock.mockReset();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "phantom-project-root-"));
  temporaryDirectories.push(directory);
  return directory;
}

describe("resolveProjectRootPath", () => {
  it("realpaths the input before resolving the common Git root", async () => {
    const directory = await createTemporaryDirectory();
    const repositoryPath = join(directory, "repository");
    const nestedPath = join(repositoryPath, "packages", "projects");
    const inputLink = join(directory, "input-link");
    await mkdir(nestedPath, { recursive: true });
    await symlink(nestedPath, inputLink);
    getGitRootMock.mockResolvedValue(repositoryPath);

    const result = await resolveProjectRootPath(inputLink);

    strictEqual(result, await realpath(repositoryPath));
    deepStrictEqual(getGitRootMock.mock.calls, [
      [{ cwd: await realpath(nestedPath) }],
    ]);
  });

  it("realpaths the Git common root returned by getGitRoot", async () => {
    const directory = await createTemporaryDirectory();
    const repositoryPath = join(directory, "repository");
    const repositoryLink = join(directory, "repository-link");
    await mkdir(repositoryPath);
    await symlink(repositoryPath, repositoryLink);
    getGitRootMock.mockResolvedValue(repositoryLink);

    strictEqual(
      await resolveProjectRootPath(repositoryPath),
      await realpath(repositoryPath),
    );
  });

  it("rejects paths that cannot be resolved", async () => {
    const directory = await createTemporaryDirectory();

    await rejects(resolveProjectRootPath(join(directory, "missing")), /ENOENT/);
    strictEqual(getGitRootMock.mock.calls.length, 0);
  });
});
