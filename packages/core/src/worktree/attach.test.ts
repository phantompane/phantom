import { deepStrictEqual } from "node:assert";
import { describe, it, vi } from "vitest";
import { err, ok } from "@phantompane/utils";
import { BranchNotFoundError, WorktreeAlreadyExistsError } from "./errors.ts";

const validateWorktreeNameMock = vi.fn();
const existsSyncMock = vi.fn();
const branchExistsMock = vi.fn();
const addWorktreeMock = vi.fn();
const getWorktreePathFromDirectoryMock = vi.fn(
  (worktreeDirectory: string, name: string, directoryNameSeparator = "/") => {
    return `${worktreeDirectory}/${name.replaceAll("/", directoryNameSeparator)}`;
  },
);

vi.doMock("./validate.ts", () => ({
  validateWorktreeName: validateWorktreeNameMock,
  validateWorktreeExists: vi.fn(() =>
    Promise.resolve({ ok: true, value: { path: "/mock/path" } }),
  ),
}));

vi.doMock("node:fs", () => ({
  existsSync: existsSyncMock,
}));

vi.doMock("@phantompane/git", () => ({
  branchExists: branchExistsMock,
  addWorktree: addWorktreeMock,
  getGitRoot: vi.fn(),
}));

vi.doMock("../paths.ts", () => ({
  getWorktreePathFromDirectory: getWorktreePathFromDirectoryMock,
}));

const { attachWorktreeCore } = await import("./attach.ts");

describe("attachWorktreeCore", () => {
  const resetMocks = () => {
    validateWorktreeNameMock.mockClear();
    existsSyncMock.mockClear();
    branchExistsMock.mockClear();
    addWorktreeMock.mockClear();
    getWorktreePathFromDirectoryMock.mockClear();
  };

  it("should attach to existing branch successfully", async () => {
    resetMocks();
    validateWorktreeNameMock.mockImplementation(() => ok(undefined));
    existsSyncMock.mockImplementation(() => false);
    branchExistsMock.mockImplementation(() => Promise.resolve(ok(true)));
    addWorktreeMock.mockImplementation(() => Promise.resolve(undefined));

    const result = await attachWorktreeCore(
      "/repo",
      "/repo/.git/phantom/worktrees",
      "feature-branch",
      undefined,
      undefined,
      "/",
    );

    deepStrictEqual(result.ok, true);
    if (result.ok) {
      deepStrictEqual(
        result.value,
        "/repo/.git/phantom/worktrees/feature-branch",
      );
    }

    deepStrictEqual(validateWorktreeNameMock.mock.calls[0], ["feature-branch"]);
    deepStrictEqual(existsSyncMock.mock.calls[0], [
      "/repo/.git/phantom/worktrees/feature-branch",
    ]);
    deepStrictEqual(branchExistsMock.mock.calls[0], [
      "/repo",
      "feature-branch",
    ]);
    deepStrictEqual(addWorktreeMock.mock.calls[0], [
      {
        path: "/repo/.git/phantom/worktrees/feature-branch",
        branch: "feature-branch",
        createBranch: false,
        cwd: "/repo",
      },
    ]);
  });

  it("should return error when worktree name is invalid", async () => {
    resetMocks();
    validateWorktreeNameMock.mockImplementation(() =>
      err(new Error("Invalid worktree name: feature/branch")),
    );

    const result = await attachWorktreeCore(
      "/repo",
      "/repo/.git/phantom/worktrees",
      "feature/branch",
      undefined,
      undefined,
      "/",
    );

    deepStrictEqual(result.ok, false);
    if (!result.ok) {
      deepStrictEqual(
        result.error.message,
        "Invalid worktree name: feature/branch",
      );
    }

    deepStrictEqual(existsSyncMock.mock.calls.length, 0);
    deepStrictEqual(branchExistsMock.mock.calls.length, 0);
  });

  it("should return error when worktree already exists", async () => {
    resetMocks();
    validateWorktreeNameMock.mockImplementation(() => ok(undefined));
    existsSyncMock.mockImplementation(() => true);

    const result = await attachWorktreeCore(
      "/repo",
      "/repo/.git/phantom/worktrees",
      "existing-feature",
      undefined,
      undefined,
      "/",
    );

    deepStrictEqual(result.ok, false);
    if (!result.ok) {
      deepStrictEqual(result.error instanceof WorktreeAlreadyExistsError, true);
      deepStrictEqual(
        result.error.message,
        "Worktree 'existing-feature' already exists",
      );
    }

    deepStrictEqual(branchExistsMock.mock.calls.length, 0);
  });

  it("should return error when branch does not exist", async () => {
    resetMocks();
    validateWorktreeNameMock.mockImplementation(() => ok(undefined));
    existsSyncMock.mockImplementation(() => false);
    branchExistsMock.mockImplementation(() => Promise.resolve(ok(false)));

    const result = await attachWorktreeCore(
      "/repo",
      "/repo/.git/phantom/worktrees",
      "non-existent",
      undefined,
      undefined,
      "/",
    );

    deepStrictEqual(result.ok, false);
    if (!result.ok) {
      deepStrictEqual(result.error instanceof BranchNotFoundError, true);
      deepStrictEqual(result.error.message, "Branch 'non-existent' not found");
    }

    deepStrictEqual(addWorktreeMock.mock.calls.length, 0);
  });

  it("should pass through git attach errors", async () => {
    resetMocks();
    validateWorktreeNameMock.mockImplementation(() => ok(undefined));
    existsSyncMock.mockImplementation(() => false);
    branchExistsMock.mockImplementation(() => Promise.resolve(ok(true)));
    addWorktreeMock.mockImplementation(() =>
      Promise.reject(new Error("Git operation failed")),
    );

    const result = await attachWorktreeCore(
      "/repo",
      "/repo/.git/phantom/worktrees",
      "feature",
      undefined,
      undefined,
      "/",
    );

    deepStrictEqual(result.ok, false);
    if (!result.ok) {
      deepStrictEqual(result.error.message, "Git operation failed");
    }
  });

  it("should handle branch existence check errors", async () => {
    resetMocks();
    validateWorktreeNameMock.mockImplementation(() => ok(undefined));
    existsSyncMock.mockImplementation(() => false);
    branchExistsMock.mockImplementation(() =>
      Promise.resolve(err(new Error("Failed to check branch"))),
    );

    const result = await attachWorktreeCore(
      "/repo",
      "/repo/.git/phantom/worktrees",
      "feature",
      undefined,
      undefined,
      "/",
    );

    deepStrictEqual(result.ok, false);
    if (!result.ok) {
      deepStrictEqual(result.error.message, "Failed to check branch");
    }

    deepStrictEqual(addWorktreeMock.mock.calls.length, 0);
  });

  it("replaces slashes in directory names when separator is configured", async () => {
    resetMocks();
    validateWorktreeNameMock.mockImplementation(() => ok(undefined));
    existsSyncMock.mockImplementation(() => false);
    branchExistsMock.mockImplementation(() => Promise.resolve(ok(true)));
    addWorktreeMock.mockImplementation(() => Promise.resolve(undefined));
    getWorktreePathFromDirectoryMock.mockImplementation(
      (_worktreeDirectory: string, name: string, separator = "/") =>
        `/repo/.git/phantom/worktrees/${name.replaceAll("/", separator)}`,
    );

    const result = await attachWorktreeCore(
      "/repo",
      "/repo/.git/phantom/worktrees",
      "feature/test",
      undefined,
      undefined,
      "-",
    );

    deepStrictEqual(result.ok, true);
    deepStrictEqual(getWorktreePathFromDirectoryMock.mock.calls[0], [
      "/repo/.git/phantom/worktrees",
      "feature/test",
      "-",
    ]);
    deepStrictEqual(addWorktreeMock.mock.calls[0], [
      {
        path: "/repo/.git/phantom/worktrees/feature-test",
        branch: "feature/test",
        createBranch: false,
        cwd: "/repo",
      },
    ]);
  });
});
