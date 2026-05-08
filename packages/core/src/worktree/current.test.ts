import { strictEqual } from "node:assert";
import { describe, it, vi } from "vitest";

const getTopLevelMock = vi.fn();
const getCurrentBranchMock = vi.fn();

vi.doMock("@phantompane/git", () => ({
  getTopLevel: getTopLevelMock,
  getCurrentBranch: getCurrentBranchMock,
}));

const { getCurrentWorktreeName } = await import("./current.ts");

describe("getCurrentWorktreeName", () => {
  const resetMocks = () => {
    getTopLevelMock.mockReset();
    getCurrentBranchMock.mockReset();
  };

  it("returns null in the main repository", async () => {
    resetMocks();
    getTopLevelMock.mockResolvedValue("/repo");

    const result = await getCurrentWorktreeName("/repo");

    strictEqual(result, null);
    strictEqual(getCurrentBranchMock.mock.calls.length, 0);
  });

  it("returns the current branch in a sub-worktree", async () => {
    resetMocks();
    getTopLevelMock.mockResolvedValue("/repo/.git/phantom/worktrees/feature");
    getCurrentBranchMock.mockResolvedValue("feature");

    const result = await getCurrentWorktreeName("/repo");

    strictEqual(result, "feature");
    strictEqual(
      getCurrentBranchMock.mock.calls[0][0].cwd,
      "/repo/.git/phantom/worktrees/feature",
    );
  });

  it("returns null for detached worktrees", async () => {
    resetMocks();
    getTopLevelMock.mockResolvedValue("/repo/.git/phantom/worktrees/feature");
    getCurrentBranchMock.mockResolvedValue("");

    const result = await getCurrentWorktreeName("/repo");

    strictEqual(result, null);
  });

  it("returns null when git commands fail", async () => {
    resetMocks();
    getTopLevelMock.mockRejectedValue(new Error("fatal"));

    const result = await getCurrentWorktreeName("/repo");

    strictEqual(result, null);
  });
});
