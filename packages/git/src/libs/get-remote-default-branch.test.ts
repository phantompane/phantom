import { deepEqual, equal } from "node:assert/strict";
import { beforeEach, describe, it, vi } from "vitest";

const executeGitCommandMock = vi.fn();

vi.mock("../executor.ts", () => ({
  executeGitCommand: executeGitCommandMock,
}));

const { getRemoteDefaultBranch } =
  await import("./get-remote-default-branch.ts");

describe("getRemoteDefaultBranch", () => {
  beforeEach(() => {
    executeGitCommandMock.mockReset();
  });

  it("returns the remote HEAD branch", async () => {
    executeGitCommandMock.mockResolvedValue({
      stdout:
        "ref: refs/heads/trunk\tHEAD\n0123456789abcdef0123456789abcdef01234567\tHEAD\n",
      stderr: "",
    });

    const result = await getRemoteDefaultBranch({
      cwd: "/repo/worktree",
      remote: "upstream",
    });

    equal(result, "trunk");
    deepEqual(executeGitCommandMock.mock.calls[0], [
      ["ls-remote", "--symref", "upstream", "HEAD"],
      { cwd: "/repo/worktree" },
    ]);
  });

  it("returns null when the remote HEAD cannot be resolved", async () => {
    executeGitCommandMock.mockRejectedValue(new Error("remote failed"));

    const result = await getRemoteDefaultBranch({
      cwd: "/repo/worktree",
      remote: "upstream",
    });

    equal(result, null);
  });
});
