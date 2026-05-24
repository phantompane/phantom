import { deepStrictEqual, strictEqual } from "node:assert";
import { describe, it, vi } from "vitest";
import { ok } from "@phantompane/utils";

const accessMock = vi.fn();
const mkdirMock = vi.fn();
const validateWorktreeDoesNotExistMock = vi.fn();
const validateWorktreeNameMock = vi.fn();
const addWorktreeMock = vi.fn();
const getGitRootMock = vi.fn();
const createContextMock = vi.fn();
const generateUniqueNameMock = vi.fn();
const getWorktreePathFromDirectoryMock = vi.fn(
  (worktreeDirectory: string, name: string, separator = "/") =>
    `${worktreeDirectory}/${name.replaceAll("/", separator)}`,
);
const copyFilesMock = vi.fn();

vi.doMock("node:fs/promises", () => {
  const mockedFs = {
    access: accessMock,
    mkdir: mkdirMock,
  };

  return {
    ...mockedFs,
    default: mockedFs,
  };
});

vi.doMock("@phantompane/git", () => ({
  addWorktree: addWorktreeMock,
  getGitRoot: getGitRootMock,
}));

vi.doMock("../context.ts", () => ({
  createContext: createContextMock,
}));

vi.doMock("./generate-name.ts", () => ({
  generateUniqueName: generateUniqueNameMock,
}));

vi.doMock("./validate.ts", () => ({
  validateWorktreeDoesNotExist: validateWorktreeDoesNotExistMock,
  validateWorktreeName: validateWorktreeNameMock,
}));

vi.doMock("../paths.ts", () => ({
  getWorktreePathFromDirectory: getWorktreePathFromDirectoryMock,
}));

vi.doMock("./file-copier.ts", () => ({
  copyFiles: copyFilesMock,
}));

const { runCreateWorktree } = await import("./create.ts");

describe("runCreateWorktree", () => {
  const resetMocks = () => {
    accessMock.mockReset();
    mkdirMock.mockReset();
    validateWorktreeDoesNotExistMock.mockReset();
    validateWorktreeNameMock.mockReset();
    addWorktreeMock.mockReset();
    getGitRootMock.mockReset();
    createContextMock.mockReset();
    generateUniqueNameMock.mockReset();
    getWorktreePathFromDirectoryMock.mockClear();
    copyFilesMock.mockReset();
  };

  it("merges configured copy files with CLI copy files and auto-generates the name", async () => {
    resetMocks();
    accessMock.mockResolvedValue(undefined);
    validateWorktreeNameMock.mockReturnValue(ok(undefined));
    validateWorktreeDoesNotExistMock.mockResolvedValue(ok(undefined));
    addWorktreeMock.mockResolvedValue(undefined);
    getGitRootMock.mockResolvedValue("/repo");
    createContextMock.mockResolvedValue({
      gitRoot: "/repo",
      worktreesDirectory: "/repo/.git/phantom/worktrees",
      directoryNameSeparator: "-",
      config: {
        postCreate: {
          copyFiles: [".env"],
          commands: ["npm install"],
        },
      },
      preferences: {},
    });
    generateUniqueNameMock.mockResolvedValue(ok("fuzzy-cats-dance"));
    copyFilesMock.mockResolvedValue(
      ok({
        copiedFiles: [".env", "config.json"],
        skippedFiles: [],
      }),
    );
    const logger = {
      log: vi.fn(),
      warn: vi.fn(),
    };

    const result = await runCreateWorktree({
      copyFiles: ["config.json"],
      logger,
    });

    strictEqual(result.ok, true);
    if (result.ok) {
      strictEqual(result.value.gitRoot, "/repo");
      strictEqual(
        result.value.worktreesDirectory,
        "/repo/.git/phantom/worktrees",
      );
      strictEqual(result.value.name, "fuzzy-cats-dance");
      strictEqual(
        result.value.path,
        "/repo/.git/phantom/worktrees/fuzzy-cats-dance",
      );
    }

    deepStrictEqual(generateUniqueNameMock.mock.calls[0], [
      "/repo",
      "/repo/.git/phantom/worktrees",
      "-",
    ]);
    deepStrictEqual(copyFilesMock.mock.calls[0], [
      "/repo",
      "/repo/.git/phantom/worktrees/fuzzy-cats-dance",
      [".env", "config.json"],
    ]);
    strictEqual(
      logger.log.mock.calls[0][0],
      "Created worktree 'fuzzy-cats-dance' at /repo/.git/phantom/worktrees/fuzzy-cats-dance",
    );
  });

  it("creates from an explicit git root without reading the current cwd", async () => {
    resetMocks();
    accessMock.mockResolvedValue(undefined);
    validateWorktreeNameMock.mockReturnValue(ok(undefined));
    validateWorktreeDoesNotExistMock.mockResolvedValue(ok(undefined));
    addWorktreeMock.mockResolvedValue(undefined);
    createContextMock.mockResolvedValue({
      gitRoot: "/selected/repo",
      worktreesDirectory: "/selected/repo/.git/phantom/worktrees",
      directoryNameSeparator: "/",
      config: null,
      preferences: {},
    });

    const result = await runCreateWorktree({
      gitRoot: "/selected/repo",
      name: "web-chat",
    });

    strictEqual(result.ok, true);
    strictEqual(getGitRootMock.mock.calls.length, 0);
    deepStrictEqual(addWorktreeMock.mock.calls[0][0], {
      path: "/selected/repo/.git/phantom/worktrees/web-chat",
      branch: "web-chat",
      base: "HEAD",
      cwd: "/selected/repo",
    });
  });
});
