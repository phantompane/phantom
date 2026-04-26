import { deepEqual, equal } from "node:assert/strict";
import { beforeEach, describe, it, vi } from "vitest";

const executeGitCommandMock = vi.fn();

vi.mock("../executor.ts", () => ({
  executeGitCommand: executeGitCommandMock,
}));

const { getUpstreamBranch } = await import("./get-upstream-branch.ts");

describe("getUpstreamBranch", () => {
  beforeEach(() => {
    executeGitCommandMock.mockReset();
  });

  it("returns the upstream branch for the current branch", async () => {
    executeGitCommandMock.mockResolvedValue({
      stdout: "origin/main\n",
      stderr: "",
    });

    const result = await getUpstreamBranch({ cwd: "/repo/worktree" });

    equal(result, "origin/main");
    deepEqual(executeGitCommandMock.mock.calls[0], [
      ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
      { cwd: "/repo/worktree" },
    ]);
  });

  it("returns null when the branch has no upstream", async () => {
    executeGitCommandMock.mockRejectedValue(new Error("no upstream"));

    const result = await getUpstreamBranch({ cwd: "/repo/worktree" });

    equal(result, null);
  });
});
