import { deepStrictEqual, strictEqual } from "node:assert";
import { describe, it, vi } from "vitest";
import { isErr, isOk, ok, err } from "@phantompane/utils";
import { WorktreeError, WorktreeNotFoundError } from "./errors.ts";

const validateWorktreeExistsMock = vi.fn();
const getStatusMock = vi.fn();
const removeWorktreeMock = vi.fn();
const deleteBranchMock = vi.fn();

vi.doMock("./validate.ts", () => ({
  validateWorktreeExists: validateWorktreeExistsMock,
}));

vi.doMock("@phantompane/git", () => ({
  getStatus: getStatusMock,
  removeWorktree: removeWorktreeMock,
  deleteBranch: deleteBranchMock,
}));

const {
  deleteWorktree,
  getWorktreeChangesStatus,
  removeWorktree,
  deleteBranch,
} = await import("./delete.ts");

const cleanStatus = () => ({
  entries: [],
  isClean: true,
});

const dirtyStatus = (...paths: string[]) => ({
  entries: paths.map((path) => ({
    indexStatus: path === "file3" ? "?" : "M",
    workingTreeStatus: path === "file3" ? "?" : " ",
    path,
    originalPath: undefined,
  })),
  isClean: false,
});

describe("deleteWorktree", () => {
  const resetMocks = () => {
    validateWorktreeExistsMock.mockReset();
    getStatusMock.mockReset();
    removeWorktreeMock.mockReset();
    deleteBranchMock.mockReset();
  };

  it("deletes the worktree and reports branch deletion failures", async () => {
    resetMocks();
    validateWorktreeExistsMock.mockResolvedValue(
      ok({ path: "/test/repo/.git/phantom/worktrees/feature" }),
    );
    getStatusMock.mockResolvedValue(cleanStatus());
    removeWorktreeMock.mockResolvedValue(undefined);
    deleteBranchMock.mockRejectedValue(
      new Error("error: branch 'feature' not found."),
    );

    const result = await deleteWorktree(
      "/test/repo",
      "/test/repo/.git/phantom/worktrees",
      "feature",
      {},
      undefined,
    );

    strictEqual(isOk(result), true);
    if (isOk(result)) {
      strictEqual(
        result.value.message,
        "Deleted worktree 'feature'\nNote: Branch 'feature' could not be deleted: branch delete failed: error: branch 'feature' not found.",
      );
    }
  });

  it("deletes a clean worktree successfully", async () => {
    resetMocks();
    validateWorktreeExistsMock.mockResolvedValue(
      ok({ path: "/test/repo/.git/phantom/worktrees/feature" }),
    );
    getStatusMock.mockResolvedValue(cleanStatus());
    removeWorktreeMock.mockResolvedValue(undefined);
    deleteBranchMock.mockResolvedValue(undefined);

    const result = await deleteWorktree(
      "/test/repo",
      "/test/repo/.git/phantom/worktrees",
      "feature",
      {},
      undefined,
    );

    strictEqual(isOk(result), true);
    if (isOk(result)) {
      strictEqual(
        result.value.message,
        "Deleted worktree 'feature' and its branch 'feature'",
      );
    }
    deepStrictEqual(validateWorktreeExistsMock.mock.calls[0], [
      "/test/repo",
      "/test/repo/.git/phantom/worktrees",
      "feature",
      { excludeDefault: true },
    ]);
    deepStrictEqual(getStatusMock.mock.calls[0], [
      { cwd: "/test/repo/.git/phantom/worktrees/feature" },
    ]);
    deepStrictEqual(removeWorktreeMock.mock.calls[0], [
      {
        gitRoot: "/test/repo",
        path: "/test/repo/.git/phantom/worktrees/feature",
        force: false,
      },
    ]);
    deepStrictEqual(deleteBranchMock.mock.calls[0], [
      {
        gitRoot: "/test/repo",
        branch: "feature",
      },
    ]);
  });

  it("keeps the branch when keepBranch is enabled", async () => {
    resetMocks();
    validateWorktreeExistsMock.mockResolvedValue(
      ok({ path: "/test/repo/.git/phantom/worktrees/feature" }),
    );
    getStatusMock.mockResolvedValue(cleanStatus());
    removeWorktreeMock.mockResolvedValue(undefined);

    const result = await deleteWorktree(
      "/test/repo",
      "/test/repo/.git/phantom/worktrees",
      "feature",
      { keepBranch: true },
      undefined,
    );

    strictEqual(isOk(result), true);
    if (isOk(result)) {
      strictEqual(
        result.value.message,
        "Deleted worktree 'feature' and kept its branch 'feature'",
      );
    }
    strictEqual(deleteBranchMock.mock.calls.length, 0);
  });

  it("fails when the worktree does not exist", async () => {
    resetMocks();
    validateWorktreeExistsMock.mockResolvedValue(
      err(new WorktreeNotFoundError("missing")),
    );

    const result = await deleteWorktree(
      "/test/repo",
      "/test/repo/.git/phantom/worktrees",
      "missing",
      {},
      undefined,
    );

    strictEqual(isErr(result), true);
    if (isErr(result)) {
      strictEqual(result.error.message, "Worktree 'missing' not found");
    }
  });

  it("fails on uncommitted changes without force", async () => {
    resetMocks();
    validateWorktreeExistsMock.mockResolvedValue(
      ok({ path: "/test/repo/.git/phantom/worktrees/feature" }),
    );
    getStatusMock.mockResolvedValue(dirtyStatus("file1", "file2", "file3"));

    const result = await deleteWorktree(
      "/test/repo",
      "/test/repo/.git/phantom/worktrees",
      "feature",
      {},
      undefined,
    );

    strictEqual(isErr(result), true);
    if (isErr(result)) {
      strictEqual(
        result.error.message,
        "Worktree 'feature' has uncommitted changes (3 files). Use --force to delete anyway.",
      );
    }
  });

  it("deletes with force when uncommitted changes exist", async () => {
    resetMocks();
    validateWorktreeExistsMock.mockResolvedValue(
      ok({ path: "/test/repo/.git/phantom/worktrees/feature" }),
    );
    getStatusMock.mockResolvedValue(dirtyStatus("file1", "file2"));
    removeWorktreeMock.mockResolvedValue(undefined);
    deleteBranchMock.mockResolvedValue(undefined);

    const result = await deleteWorktree(
      "/test/repo",
      "/test/repo/.git/phantom/worktrees",
      "feature",
      { force: true },
      undefined,
    );

    strictEqual(isOk(result), true);
    if (isOk(result)) {
      strictEqual(
        result.value.message,
        "Warning: Worktree 'feature' had uncommitted changes (2 files)\nDeleted worktree 'feature' and its branch 'feature'",
      );
      strictEqual(result.value.changedFiles, 2);
    }
  });
});

describe("getWorktreeChangesStatus", () => {
  it("returns no changes for a clean worktree", async () => {
    getStatusMock.mockReset();
    getStatusMock.mockResolvedValue(cleanStatus());

    const status = await getWorktreeChangesStatus("/test/worktree");

    strictEqual(status.hasUncommittedChanges, false);
    strictEqual(status.changedFiles, 0);
    deepStrictEqual(getStatusMock.mock.calls[0], [{ cwd: "/test/worktree" }]);
  });

  it("returns changed files when status is dirty", async () => {
    getStatusMock.mockReset();
    getStatusMock.mockResolvedValue(dirtyStatus("file1", "file2", "file3"));

    const status = await getWorktreeChangesStatus("/test/worktree");

    strictEqual(status.hasUncommittedChanges, true);
    strictEqual(status.changedFiles, 3);
  });

  it("treats git status failures as clean", async () => {
    getStatusMock.mockReset();
    getStatusMock.mockRejectedValue(new Error("Not a git repository"));

    const status = await getWorktreeChangesStatus("/test/worktree");

    strictEqual(status.hasUncommittedChanges, false);
    strictEqual(status.changedFiles, 0);
  });
});

describe("removeWorktree", () => {
  it("delegates to the git wrapper", async () => {
    removeWorktreeMock.mockReset();
    removeWorktreeMock.mockResolvedValue(undefined);

    await removeWorktree(
      "/test/repo",
      "/test/repo/.git/phantom/worktrees/feature",
    );

    deepStrictEqual(removeWorktreeMock.mock.calls[0], [
      {
        gitRoot: "/test/repo",
        path: "/test/repo/.git/phantom/worktrees/feature",
        force: false,
      },
    ]);
  });
});

describe("deleteBranch", () => {
  it("returns ok when branch deletion succeeds", async () => {
    deleteBranchMock.mockReset();
    deleteBranchMock.mockResolvedValue(undefined);

    const result = await deleteBranch("/test/repo", "feature");

    strictEqual(isOk(result), true);
  });

  it("wraps git errors in WorktreeError", async () => {
    deleteBranchMock.mockReset();
    deleteBranchMock.mockRejectedValue(new Error("Branch not found"));

    const result = await deleteBranch("/test/repo", "feature");

    strictEqual(isErr(result), true);
    if (isErr(result)) {
      strictEqual(result.error instanceof WorktreeError, true);
      strictEqual(
        result.error.message,
        "branch delete failed: Branch not found",
      );
    }
  });
});
