import { deepStrictEqual, strictEqual } from "node:assert";
import { describe, it, vi } from "vitest";

const executeGitCommandMock = vi.fn();

vi.doMock("../executor.ts", () => ({
  executeGitCommand: executeGitCommandMock,
}));

const { getCurrentBranch } = await import("./get-current-branch.ts");

describe("getCurrentBranch", () => {
  it("returns the current branch and passes cwd through", async () => {
    executeGitCommandMock.mockResolvedValue({
      stdout: "feature",
      stderr: "",
    });

    const result = await getCurrentBranch({ cwd: "/repo/worktree" });

    strictEqual(result, "feature");
    deepStrictEqual(executeGitCommandMock.mock.calls[0], [
      ["branch", "--show-current"],
      { cwd: "/repo/worktree" },
    ]);
  });
});
