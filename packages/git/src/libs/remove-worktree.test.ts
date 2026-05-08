import { deepStrictEqual } from "node:assert";
import { describe, it, vi } from "vitest";

const executeGitCommandMock = vi.fn();

vi.doMock("../executor.ts", () => ({
  executeGitCommand: executeGitCommandMock,
}));

const { removeWorktree } = await import("./remove-worktree.ts");

describe("removeWorktree", () => {
  const resetMocks = () => {
    executeGitCommandMock.mockReset();
  };

  it("removes a worktree", async () => {
    resetMocks();
    executeGitCommandMock.mockResolvedValue({ stdout: "", stderr: "" });

    await removeWorktree({
      gitRoot: "/repo",
      path: "/repo/.git/phantom/worktrees/feature",
    });

    deepStrictEqual(executeGitCommandMock.mock.calls[0], [
      ["worktree", "remove", "/repo/.git/phantom/worktrees/feature"],
      { cwd: "/repo" },
    ]);
  });

  it("passes the force flag when requested", async () => {
    resetMocks();
    executeGitCommandMock.mockResolvedValue({ stdout: "", stderr: "" });

    await removeWorktree({
      gitRoot: "/repo",
      path: "/repo/.git/phantom/worktrees/feature",
      force: true,
    });

    deepStrictEqual(executeGitCommandMock.mock.calls[0], [
      ["worktree", "remove", "--force", "/repo/.git/phantom/worktrees/feature"],
      { cwd: "/repo" },
    ]);
  });
});
