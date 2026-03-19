import { deepStrictEqual } from "node:assert";
import { describe, it, vi } from "vitest";

const executeGitCommandMock = vi.fn();

vi.doMock("../executor.ts", () => ({
  executeGitCommand: executeGitCommandMock,
}));

const { addWorktree } = await import("./add-worktree.ts");

describe("addWorktree", () => {
  const resetMocks = () => {
    executeGitCommandMock.mockReset();
  };

  it("creates a new branch by default", async () => {
    resetMocks();
    executeGitCommandMock.mockResolvedValue({ stdout: "", stderr: "" });

    await addWorktree({
      path: "/repo/.git/phantom/worktrees/feature",
      branch: "feature",
      base: "main",
    });

    deepStrictEqual(executeGitCommandMock.mock.calls[0], [
      [
        "worktree",
        "add",
        "/repo/.git/phantom/worktrees/feature",
        "-b",
        "feature",
        "main",
      ],
      { cwd: undefined },
    ]);
  });

  it("attaches an existing branch when createBranch is false", async () => {
    resetMocks();
    executeGitCommandMock.mockResolvedValue({ stdout: "", stderr: "" });

    await addWorktree({
      path: "/repo/.git/phantom/worktrees/feature",
      branch: "feature",
      createBranch: false,
      cwd: "/repo",
    });

    deepStrictEqual(executeGitCommandMock.mock.calls[0], [
      ["worktree", "add", "/repo/.git/phantom/worktrees/feature", "feature"],
      { cwd: "/repo" },
    ]);
  });
});
