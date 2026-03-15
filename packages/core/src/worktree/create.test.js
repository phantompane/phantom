import { deepStrictEqual, strictEqual } from "node:assert";
import { describe, it, vi } from "vitest";
import { err, isErr, isOk, ok } from "@phantompane/shared";
import { WorktreeAlreadyExistsError, WorktreeError } from "./errors.ts";

const accessMock = vi.fn();
const mkdirMock = vi.fn();
const validateWorktreeDoesNotExistMock = vi.fn();
const validateWorktreeNameMock = vi.fn();
const addWorktreeMock = vi.fn();
const getWorktreesDirectoryMock = vi.fn((gitRoot, worktreesDirectory) => {
  if (worktreesDirectory) {
    // Simulate node.js path.join behavior for resolving relative paths
    if (worktreesDirectory.startsWith("/")) {
      return worktreesDirectory;
    }
    // For relative paths like "../phantom-external", resolve them correctly
    if (worktreesDirectory === "../phantom-external") {
      return "/test/phantom-external";
    }
    return `${gitRoot}/${worktreesDirectory}`;
  }
  return `${gitRoot}/.git/phantom/worktrees`;
});
const getWorktreePathMock = vi.fn((gitRoot, name, worktreesDirectory) => {
  if (worktreesDirectory) {
    if (worktreesDirectory.startsWith("/")) {
      return `${worktreesDirectory}/${name}`;
    }
    if (worktreesDirectory === "../phantom-external") {
      return `/test/phantom-external/${name}`;
    }
    return `${gitRoot}/${worktreesDirectory}/${name}`;
  }
  return `${gitRoot}/.git/phantom/worktrees/${name}`;
});
const getWorktreePathFromDirectoryMock = vi.fn(
  (worktreeDirectory, name, separator = "/") => {
    const directoryName =
      separator === "/" ? name : name.replaceAll("/", separator);
    return `${worktreeDirectory}/${directoryName}`;
  },
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

vi.doMock("./validate.ts", () => ({
  validateWorktreeDoesNotExist: validateWorktreeDoesNotExistMock,
  validateWorktreeName: validateWorktreeNameMock,
  validateWorktreeExists: vi.fn(() =>
    Promise.resolve({ ok: true, value: { path: "/mock/path" } }),
  ),
}));

vi.doMock("@phantompane/git", () => ({
  addWorktree: addWorktreeMock,
}));

vi.doMock("../paths.ts", () => ({
  getWorktreesDirectory: getWorktreesDirectoryMock,
  getWorktreePath: getWorktreePathMock,
  getWorktreePathFromDirectory: getWorktreePathFromDirectoryMock,
}));

vi.doMock("./file-copier.ts", () => ({
  copyFiles: copyFilesMock,
}));

const { createWorktree } = await import("./create.ts");

describe("createWorktree", () => {
  const resetMocks = () => {
    accessMock.mockClear();
    mkdirMock.mockClear();
    validateWorktreeDoesNotExistMock.mockClear();
    validateWorktreeNameMock.mockClear();
    addWorktreeMock.mockClear();
    getWorktreesDirectoryMock.mockClear();
    getWorktreePathMock.mockClear();
    getWorktreePathFromDirectoryMock.mockClear();
    copyFilesMock.mockClear();
  };

  it("should create worktree successfully", async () => {
    resetMocks();
    accessMock.mockImplementation(() => Promise.resolve());
    mkdirMock.mockImplementation(() => Promise.resolve());
    validateWorktreeNameMock.mockImplementation(() => ok(undefined));
    validateWorktreeDoesNotExistMock.mockImplementation(() =>
      Promise.resolve(
        ok({ path: "/test/repo/.git/phantom/worktrees/feature-branch" }),
      ),
    );
    addWorktreeMock.mockImplementation(() => Promise.resolve());
    const result = await createWorktree(
      "/test/repo",
      "/test/repo/.git/phantom/worktrees",
      "feature-branch",
      {},
      undefined,
      undefined,
      "/",
    );

    strictEqual(isOk(result), true);
    if (isOk(result)) {
      deepStrictEqual(result.value, {
        message:
          "Created worktree 'feature-branch' at /test/repo/.git/phantom/worktrees/feature-branch",
        path: "/test/repo/.git/phantom/worktrees/feature-branch",
        copiedFiles: undefined,
        skippedFiles: undefined,
        copyError: undefined,
      });
    }

    const worktreeOptions = addWorktreeMock.mock.calls[0][0];
    strictEqual(
      worktreeOptions.path,
      "/test/repo/.git/phantom/worktrees/feature-branch",
    );
    strictEqual(worktreeOptions.branch, "feature-branch");
    strictEqual(worktreeOptions.base, "HEAD");
  });

  it("should create worktrees directory if it doesn't exist", async () => {
    resetMocks();
    accessMock.mockImplementation(() => Promise.reject(new Error("ENOENT")));
    mkdirMock.mockImplementation(() => Promise.resolve());
    validateWorktreeNameMock.mockImplementation(() => ok(undefined));
    validateWorktreeDoesNotExistMock.mockImplementation(() =>
      Promise.resolve(
        ok({ path: "/test/repo/.git/phantom/worktrees/new-feature" }),
      ),
    );
    addWorktreeMock.mockImplementation(() => Promise.resolve());
    await createWorktree(
      "/test/repo",
      "/test/repo/.git/phantom/worktrees",
      "new-feature",
      {},
      undefined,
      undefined,
      "/",
    );

    strictEqual(mkdirMock.mock.calls.length, 1);
    deepStrictEqual(mkdirMock.mock.calls[0], [
      "/test/repo/.git/phantom/worktrees",
      { recursive: true },
    ]);
  });

  it("should return error when worktree already exists", async () => {
    resetMocks();
    accessMock.mockImplementation(() => Promise.resolve());
    validateWorktreeNameMock.mockImplementation(() => ok(undefined));
    validateWorktreeDoesNotExistMock.mockImplementation(() =>
      Promise.resolve(err(new WorktreeAlreadyExistsError("existing"))),
    );
    const result = await createWorktree(
      "/test/repo",
      "/test/repo/.git/phantom/worktrees",
      "existing",
      {},
      undefined,
      undefined,
      "/",
    );

    strictEqual(isErr(result), true);
    if (isErr(result)) {
      strictEqual(result.error instanceof WorktreeAlreadyExistsError, true);
      strictEqual(result.error.message, "Worktree 'existing' already exists");
    }
  });

  it("should use custom branch and commitish when provided", async () => {
    resetMocks();
    accessMock.mockImplementation(() => Promise.resolve());
    validateWorktreeNameMock.mockImplementation(() => ok(undefined));
    validateWorktreeDoesNotExistMock.mockImplementation(() =>
      Promise.resolve(
        ok({ path: "/test/repo/.git/phantom/worktrees/feature" }),
      ),
    );
    addWorktreeMock.mockImplementation(() => Promise.resolve());
    await createWorktree(
      "/test/repo",
      "/test/repo/.git/phantom/worktrees",
      "feature",
      {
        branch: "custom-branch",
        base: "main",
      },
      undefined,
      undefined,
      "/",
    );

    const worktreeOptions2 = addWorktreeMock.mock.calls[0][0];
    strictEqual(worktreeOptions2.branch, "custom-branch");
    strictEqual(worktreeOptions2.base, "main");
  });

  it("should return error when git worktree add fails", async () => {
    resetMocks();
    accessMock.mockImplementation(() => Promise.resolve());
    validateWorktreeNameMock.mockImplementation(() => ok(undefined));
    validateWorktreeDoesNotExistMock.mockImplementation(() =>
      Promise.resolve(
        ok({ path: "/test/repo/.git/phantom/worktrees/bad-branch" }),
      ),
    );
    addWorktreeMock.mockImplementation(() =>
      Promise.reject(new Error("fatal: branch already exists")),
    );
    const result = await createWorktree(
      "/test/repo",
      "/test/repo/.git/phantom/worktrees",
      "bad-branch",
      {},
      undefined,
      undefined,
      "/",
    );

    strictEqual(isErr(result), true);
    if (isErr(result)) {
      strictEqual(result.error instanceof WorktreeError, true);
      strictEqual(
        result.error.message,
        "worktree add failed: fatal: branch already exists",
      );
    }
  });

  it("should replace slashes in directory names when separator is configured", async () => {
    resetMocks();
    accessMock.mockImplementation(() => Promise.resolve());
    validateWorktreeNameMock.mockImplementation(() => ok(undefined));
    validateWorktreeDoesNotExistMock.mockImplementation(() =>
      Promise.resolve(ok(undefined)),
    );
    addWorktreeMock.mockImplementation(() => Promise.resolve());

    const result = await createWorktree(
      "/test/repo",
      "/test/repo/.git/phantom/worktrees",
      "feature/test",
      {},
      undefined,
      undefined,
      "-",
    );

    strictEqual(isOk(result), true);
    strictEqual(
      addWorktreeMock.mock.calls[0][0].path,
      "/test/repo/.git/phantom/worktrees/feature-test",
    );
    strictEqual(getWorktreePathFromDirectoryMock.mock.calls[0][2], "-");
    if (isOk(result)) {
      strictEqual(
        result.value.path,
        "/test/repo/.git/phantom/worktrees/feature-test",
      );
    }
  });

  describe("with different worktree directories", () => {
    it("should create worktree with relative worktreesDirectory", async () => {
      resetMocks();
      accessMock.mockImplementation(() => Promise.resolve());
      mkdirMock.mockImplementation(() => Promise.resolve());
      validateWorktreeNameMock.mockImplementation(() => ok(undefined));
      validateWorktreeDoesNotExistMock.mockImplementation(() =>
        Promise.resolve(
          ok({
            path: "/test/phantom-external/feature-branch",
          }),
        ),
      );
      addWorktreeMock.mockImplementation(() => Promise.resolve());

      const result = await createWorktree(
        "/test/repo",
        "/test/phantom-external",
        "feature-branch",
        {},
        undefined,
        undefined,
        "/",
      );

      strictEqual(isOk(result), true);
      if (isOk(result)) {
        deepStrictEqual(result.value, {
          message:
            "Created worktree 'feature-branch' at /test/phantom-external/feature-branch",
          path: "/test/phantom-external/feature-branch",
          copiedFiles: undefined,
          skippedFiles: undefined,
          copyError: undefined,
        });
      }

      strictEqual(validateWorktreeDoesNotExistMock.mock.calls.length, 1);
      deepStrictEqual(validateWorktreeDoesNotExistMock.mock.calls[0], [
        "/test/repo",
        "/test/phantom-external",
        "feature-branch",
      ]);
    });

    it("should create worktree with absolute worktreesDirectory", async () => {
      resetMocks();
      accessMock.mockImplementation(() => Promise.resolve());
      mkdirMock.mockImplementation(() => Promise.resolve());
      validateWorktreeNameMock.mockImplementation(() => ok(undefined));
      validateWorktreeDoesNotExistMock.mockImplementation(() =>
        Promise.resolve(
          ok({
            path: "/tmp/phantom-worktrees/feature-branch",
          }),
        ),
      );
      addWorktreeMock.mockImplementation(() => Promise.resolve());

      const result = await createWorktree(
        "/test/repo",
        "/tmp/phantom-worktrees",
        "feature-branch",
        {},
        undefined,
        undefined,
        "/",
      );

      strictEqual(isOk(result), true);
      if (isOk(result)) {
        deepStrictEqual(result.value, {
          message:
            "Created worktree 'feature-branch' at /tmp/phantom-worktrees/feature-branch",
          path: "/tmp/phantom-worktrees/feature-branch",
          copiedFiles: undefined,
          skippedFiles: undefined,
          copyError: undefined,
        });
      }
    });

    it("should pass worktreeDirectory to validateWorktreeDoesNotExist", async () => {
      resetMocks();
      accessMock.mockImplementation(() => Promise.resolve());
      mkdirMock.mockImplementation(() => Promise.resolve());
      validateWorktreeNameMock.mockImplementation(() => ok(undefined));
      validateWorktreeDoesNotExistMock.mockImplementation(() =>
        Promise.resolve(
          ok({
            path: "/test/phantom-external/feature-branch",
          }),
        ),
      );
      addWorktreeMock.mockImplementation(() => Promise.resolve());

      await createWorktree(
        "/test/repo",
        "/test/phantom-external",
        "feature-branch",
        {},
        undefined,
        undefined,
        "/",
      );

      strictEqual(validateWorktreeDoesNotExistMock.mock.calls.length, 1);
      deepStrictEqual(validateWorktreeDoesNotExistMock.mock.calls[0], [
        "/test/repo",
        "/test/phantom-external",
        "feature-branch",
      ]);
    });
  });
});
