import { deepStrictEqual, strictEqual } from "node:assert";
import { describe, it, mock } from "node:test";
import { isErr, isOk } from "@phantompane/shared";
import { WorktreeError, WorktreeNotFoundError } from "./errors.ts";

const validateWorktreeExistsMock = mock.fn();
const executeGitCommandMock = mock.fn();
const executeGitCommandInDirectoryMock = mock.fn();

mock.module("./validate.ts", {
  namedExports: {
    validateWorktreeExists: validateWorktreeExistsMock,
  },
});

mock.module("@phantompane/git", {
  namedExports: {
    executeGitCommand: executeGitCommandMock,
    executeGitCommandInDirectory: executeGitCommandInDirectoryMock,
  },
});

const {
  deleteWorktree,
  getWorktreeChangesStatus: getWorktreeStatus,
  removeWorktree,
  deleteBranch,
} = await import("./delete.ts");
const { ok, err } = await import("@phantompane/shared");

describe("deleteWorktree", () => {
  const resetMocks = () => {
    validateWorktreeExistsMock.mock.resetCalls();
    executeGitCommandMock.mock.resetCalls();
    executeGitCommandInDirectoryMock.mock.resetCalls();
  };

  it("should delete worktree and report when branch deletion fails", async () => {
    resetMocks();
    validateWorktreeExistsMock.mock.mockImplementation(() =>
      Promise.resolve(
        ok({ path: "/test/repo/.git/phantom/worktrees/feature" }),
      ),
    );

    executeGitCommandMock.mock.mockImplementation((command) => {
      if (command[0] === "worktree" && command[1] === "remove") {
        return Promise.resolve({ stdout: "", stderr: "" });
      }
      if (command[0] === "branch" && command[1] === "-D") {
        return Promise.reject(new Error("error: branch 'feature' not found."));
      }
      return Promise.reject(new Error("Unexpected command"));
    });
    executeGitCommandInDirectoryMock.mock.mockImplementation(() =>
      Promise.resolve({ stdout: "", stderr: "" }),
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
      strictEqual(result.value.hasUncommittedChanges, false);
      strictEqual(result.value.changedFiles, undefined);
    }
  });

  it("should delete a worktree successfully when no uncommitted changes", async () => {
    resetMocks();
    validateWorktreeExistsMock.mock.mockImplementation(() =>
      Promise.resolve(
        ok({ path: "/test/repo/.git/phantom/worktrees/feature" }),
      ),
    );

    executeGitCommandMock.mock.mockImplementation((command) => {
      if (command[0] === "worktree" && command[1] === "remove") {
        return Promise.resolve({ stdout: "", stderr: "" });
      }
      if (command[0] === "branch" && command[1] === "-D") {
        return Promise.resolve({ stdout: "", stderr: "" });
      }
      return Promise.reject(new Error("Unexpected command"));
    });
    executeGitCommandInDirectoryMock.mock.mockImplementation(() =>
      Promise.resolve({ stdout: "", stderr: "" }),
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
        "Deleted worktree 'feature' and its branch 'feature'",
      );
      strictEqual(result.value.hasUncommittedChanges, false);
      strictEqual(result.value.changedFiles, undefined);
    }

    strictEqual(validateWorktreeExistsMock.mock.calls.length, 1);
    deepStrictEqual(validateWorktreeExistsMock.mock.calls[0].arguments, [
      "/test/repo",
      "/test/repo/.git/phantom/worktrees",
      "feature",
      { excludeDefault: true },
    ]);

    strictEqual(executeGitCommandInDirectoryMock.mock.calls.length, 1);
    deepStrictEqual(executeGitCommandInDirectoryMock.mock.calls[0].arguments, [
      "/test/repo/.git/phantom/worktrees/feature",
      ["status", "--porcelain"],
    ]);

    strictEqual(executeGitCommandMock.mock.calls.length, 2);
    deepStrictEqual(executeGitCommandMock.mock.calls[0].arguments, [
      ["worktree", "remove", "/test/repo/.git/phantom/worktrees/feature"],
      { cwd: "/test/repo" },
    ]);
    deepStrictEqual(executeGitCommandMock.mock.calls[1].arguments, [
      ["branch", "-D", "feature"],
      { cwd: "/test/repo" },
    ]);
  });

  it("should fail when worktree does not exist", async () => {
    resetMocks();
    validateWorktreeExistsMock.mock.mockImplementation(() =>
      Promise.resolve(err(new WorktreeNotFoundError("nonexistent"))),
    );

    const result = await deleteWorktree(
      "/test/repo",
      "/test/repo/.git/phantom/worktrees",
      "nonexistent",
      {},
      undefined,
    );

    strictEqual(isErr(result), true);
    if (isErr(result)) {
      strictEqual(result.error instanceof WorktreeNotFoundError, true);
      strictEqual(result.error.message, "Worktree 'nonexistent' not found");
    }
  });

  it("should fail when uncommitted changes exist without force", async () => {
    resetMocks();
    validateWorktreeExistsMock.mock.mockImplementation(() =>
      Promise.resolve(
        ok({ path: "/test/repo/.git/phantom/worktrees/feature" }),
      ),
    );

    executeGitCommandInDirectoryMock.mock.mockImplementation(() =>
      Promise.resolve({
        stdout: "M file1.txt\nA file2.txt\n?? file3.txt",
        stderr: "",
      }),
    );

    const result = await deleteWorktree(
      "/test/repo",
      "/test/repo/.git/phantom/worktrees",
      "feature",
      {},
      undefined,
    );

    strictEqual(isErr(result), true);
    if (isErr(result)) {
      strictEqual(result.error instanceof WorktreeError, true);
      strictEqual(
        result.error.message,
        "Worktree 'feature' has uncommitted changes (3 files). Use --force to delete anyway.",
      );
    }
  });

  it("should delete worktree with uncommitted changes when force is true", async () => {
    resetMocks();
    validateWorktreeExistsMock.mock.mockImplementation(() =>
      Promise.resolve(
        ok({ path: "/test/repo/.git/phantom/worktrees/feature" }),
      ),
    );

    executeGitCommandMock.mock.mockImplementation((command) => {
      if (command[0] === "worktree" && command[1] === "remove") {
        return Promise.resolve({ stdout: "", stderr: "" });
      }
      if (command[0] === "branch" && command[1] === "-D") {
        return Promise.resolve({ stdout: "", stderr: "" });
      }
      return Promise.reject(new Error("Unexpected command"));
    });
    executeGitCommandInDirectoryMock.mock.mockImplementation(() =>
      Promise.resolve({
        stdout: "M file1.txt\nA file2.txt",
        stderr: "",
      }),
    );

    const result = await deleteWorktree(
      "/test/repo",
      "/test/repo/.git/phantom/worktrees",
      "feature",
      {
        force: true,
      },
      undefined,
    );

    strictEqual(isOk(result), true);
    if (isOk(result)) {
      strictEqual(
        result.value.message,
        "Warning: Worktree 'feature' had uncommitted changes (2 files)\nDeleted worktree 'feature' and its branch 'feature'",
      );
      strictEqual(result.value.hasUncommittedChanges, true);
      strictEqual(result.value.changedFiles, 2);
    }
  });
});

describe("getWorktreeStatus", () => {
  const resetMocks = () => {
    executeGitCommandInDirectoryMock.mock.resetCalls();
  };

  it("should return no uncommitted changes when git status is clean", async () => {
    resetMocks();
    executeGitCommandInDirectoryMock.mock.mockImplementation(() =>
      Promise.resolve({ stdout: "", stderr: "" }),
    );

    const status = await getWorktreeStatus("/test/worktree");

    strictEqual(status.hasUncommittedChanges, false);
    strictEqual(status.changedFiles, 0);

    strictEqual(executeGitCommandInDirectoryMock.mock.calls.length, 1);
    deepStrictEqual(executeGitCommandInDirectoryMock.mock.calls[0].arguments, [
      "/test/worktree",
      ["status", "--porcelain"],
    ]);
  });

  it("should return uncommitted changes when git status shows changes", async () => {
    resetMocks();
    executeGitCommandInDirectoryMock.mock.mockImplementation(() =>
      Promise.resolve({
        stdout: "M file1.txt\nA file2.txt\n?? file3.txt",
        stderr: "",
      }),
    );

    const status = await getWorktreeStatus("/test/worktree");

    strictEqual(status.hasUncommittedChanges, true);
    strictEqual(status.changedFiles, 3);
  });

  it("should return no changes when git status fails", async () => {
    resetMocks();
    executeGitCommandInDirectoryMock.mock.mockImplementation(() =>
      Promise.reject(new Error("Not a git repository")),
    );

    const status = await getWorktreeStatus("/test/worktree");

    strictEqual(status.hasUncommittedChanges, false);
    strictEqual(status.changedFiles, 0);
  });
});

describe("removeWorktree", () => {
  const resetMocks = () => {
    executeGitCommandMock.mock.resetCalls();
  };

  it("should remove worktree successfully", async () => {
    resetMocks();
    executeGitCommandMock.mock.mockImplementation(() =>
      Promise.resolve({ stdout: "", stderr: "" }),
    );

    await removeWorktree(
      "/test/repo",
      "/test/repo/.git/phantom/worktrees/feature",
    );

    strictEqual(executeGitCommandMock.mock.calls.length, 1);
    deepStrictEqual(executeGitCommandMock.mock.calls[0].arguments, [
      ["worktree", "remove", "/test/repo/.git/phantom/worktrees/feature"],
      { cwd: "/test/repo" },
    ]);
  });

  it("should use force flag when force parameter is true", async () => {
    resetMocks();
    executeGitCommandMock.mock.mockImplementation(() =>
      Promise.resolve({ stdout: "", stderr: "" }),
    );

    await removeWorktree(
      "/test/repo",
      "/test/repo/.git/phantom/worktrees/feature",
      true,
    );

    strictEqual(executeGitCommandMock.mock.calls.length, 1);
    deepStrictEqual(executeGitCommandMock.mock.calls[0].arguments, [
      [
        "worktree",
        "remove",
        "--force",
        "/test/repo/.git/phantom/worktrees/feature",
      ],
      { cwd: "/test/repo" },
    ]);
  });

  it("should throw error when removal fails", async () => {
    resetMocks();
    executeGitCommandMock.mock.mockImplementation(() =>
      Promise.reject(new Error("Permission denied")),
    );

    try {
      await removeWorktree(
        "/test/repo",
        "/test/repo/.git/phantom/worktrees/feature",
      );
      throw new Error("Expected removeWorktree to throw");
    } catch (error) {
      strictEqual(error.message, "Permission denied");
    }

    strictEqual(executeGitCommandMock.mock.calls.length, 1);
  });
});

describe("deleteBranch", () => {
  const resetMocks = () => {
    executeGitCommandMock.mock.resetCalls();
  };

  it("should delete branch successfully", async () => {
    resetMocks();
    executeGitCommandMock.mock.mockImplementation(() =>
      Promise.resolve({ stdout: "", stderr: "" }),
    );

    const result = await deleteBranch("/test/repo", "feature");

    strictEqual(isOk(result), true);
    if (isOk(result)) {
      strictEqual(result.value, true);
    }
    strictEqual(executeGitCommandMock.mock.calls.length, 1);
    deepStrictEqual(executeGitCommandMock.mock.calls[0].arguments, [
      ["branch", "-D", "feature"],
      { cwd: "/test/repo" },
    ]);
  });

  it("should return error when branch deletion fails", async () => {
    resetMocks();
    executeGitCommandMock.mock.mockImplementation(() =>
      Promise.reject(new Error("Branch not found")),
    );

    const result = await deleteBranch("/test/repo", "feature");

    strictEqual(isErr(result), true);
    if (isErr(result)) {
      strictEqual(result.error instanceof WorktreeError, true);
      strictEqual(
        result.error.message,
        "branch delete failed: Branch not found",
      );
    }
    strictEqual(executeGitCommandMock.mock.calls.length, 1);
  });
});
