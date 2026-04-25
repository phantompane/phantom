import { deepStrictEqual } from "node:assert";
import { describe, it, vi } from "vitest";

const executeGitCommandMock = vi.fn();

vi.doMock("../executor.ts", () => ({
  executeGitCommand: executeGitCommandMock,
}));

const { listWorktrees } = await import("./list-worktrees.ts");

describe("listWorktrees", () => {
  const resetMocks = () => {
    executeGitCommandMock.mockReset();
  };

  it("lists worktrees from the provided git root", async () => {
    resetMocks();
    executeGitCommandMock.mockResolvedValue({
      stdout: [
        "worktree /repo",
        "HEAD abc1234",
        "branch refs/heads/main",
        "",
        "worktree /repo/.git/phantom/worktrees/feature",
        "HEAD def5678",
        "branch refs/heads/feature",
      ].join("\n"),
      stderr: "",
    });

    const result = await listWorktrees("/repo");

    deepStrictEqual(executeGitCommandMock.mock.calls[0], [
      ["worktree", "list", "--porcelain"],
      { cwd: "/repo" },
    ]);
    deepStrictEqual(result, [
      {
        path: "/repo",
        head: "abc1234",
        branch: "main",
        isLocked: false,
        isPrunable: false,
      },
      {
        path: "/repo/.git/phantom/worktrees/feature",
        head: "def5678",
        branch: "feature",
        isLocked: false,
        isPrunable: false,
      },
    ]);
  });
});
