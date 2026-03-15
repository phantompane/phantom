import { strictEqual } from "node:assert";
import { describe, it, vi } from "vitest";

const executeGitCommandMock = vi.fn();
const listWorktreesMock = vi.fn();

vi.doMock("../executor.ts", () => ({
  executeGitCommand: executeGitCommandMock,
}));

vi.doMock("./list-worktrees.ts", () => ({
  listWorktrees: listWorktreesMock,
}));

const { getCurrentWorktree } = await import("./get-current-worktree.ts");

describe("getCurrentWorktree", () => {
  const resetMocks = () => {
    executeGitCommandMock.mockClear();
    listWorktreesMock.mockClear();
  };

  it("should return null when in the main repository", async () => {
    resetMocks();
    const gitRoot = "/path/to/repo";

    executeGitCommandMock.mockImplementation(() =>
      Promise.resolve({
        stdout: gitRoot,
        stderr: "",
      }),
    );

    listWorktreesMock.mockImplementation(() =>
      Promise.resolve([
        {
          path: gitRoot,
          branch: "main",
          head: "abc123",
          isLocked: false,
          isPrunable: false,
        },
      ]),
    );

    const result = await getCurrentWorktree(gitRoot);
    strictEqual(result, null);
  });

  it("should return the branch name when in a worktree", async () => {
    resetMocks();
    const gitRoot = "/path/to/repo";
    const worktreePath = "/path/to/repo/.git/phantom/worktrees/feature-branch";

    executeGitCommandMock.mockImplementation(() =>
      Promise.resolve({
        stdout: `${worktreePath}\n`,
        stderr: "",
      }),
    );

    listWorktreesMock.mockImplementation(() =>
      Promise.resolve([
        {
          path: gitRoot,
          branch: "main",
          head: "abc123",
          isLocked: false,
          isPrunable: false,
        },
        {
          path: worktreePath,
          branch: "feature-branch",
          head: "def456",
          isLocked: false,
          isPrunable: false,
        },
      ]),
    );

    const result = await getCurrentWorktree(gitRoot);
    strictEqual(result, "feature-branch");
  });

  it("should return null when worktree is detached", async () => {
    resetMocks();
    const gitRoot = "/path/to/repo";
    const worktreePath = "/path/to/repo/.git/phantom/worktrees/my-feature";

    executeGitCommandMock.mockImplementation(() =>
      Promise.resolve({
        stdout: worktreePath,
        stderr: "",
      }),
    );

    listWorktreesMock.mockImplementation(() =>
      Promise.resolve([
        {
          path: gitRoot,
          branch: "main",
          head: "abc123",
          isLocked: false,
          isPrunable: false,
        },
        {
          path: worktreePath,
          branch: null,
          head: "def456",
          isLocked: false,
          isPrunable: false,
        },
      ]),
    );

    const result = await getCurrentWorktree(gitRoot);
    strictEqual(result, null);
  });

  it("should handle when worktree not found in list", async () => {
    resetMocks();
    const gitRoot = "/path/to/repo";
    const worktreePath = "/path/to/repo/.git/phantom/worktrees/unknown";

    executeGitCommandMock.mockImplementation(() =>
      Promise.resolve({
        stdout: worktreePath,
        stderr: "",
      }),
    );

    listWorktreesMock.mockImplementation(() =>
      Promise.resolve([
        {
          path: gitRoot,
          branch: "main",
          head: "abc123",
          isLocked: false,
          isPrunable: false,
        },
      ]),
    );

    const result = await getCurrentWorktree(gitRoot);
    strictEqual(result, null);
  });

  it("should return branch name for any worktree", async () => {
    resetMocks();
    const gitRoot = "/path/to/repo";
    const worktreePath = "/path/to/other-worktree";

    executeGitCommandMock.mockImplementation(() =>
      Promise.resolve({
        stdout: worktreePath,
        stderr: "",
      }),
    );

    listWorktreesMock.mockImplementation(() =>
      Promise.resolve([
        {
          path: gitRoot,
          branch: "main",
          head: "abc123",
          isLocked: false,
          isPrunable: false,
        },
        {
          path: worktreePath,
          branch: "other-branch",
          head: "def456",
          isLocked: false,
          isPrunable: false,
        },
      ]),
    );

    const result = await getCurrentWorktree(gitRoot);
    strictEqual(result, "other-branch");
  });
});
