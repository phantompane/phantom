import { deepStrictEqual, strictEqual } from "node:assert";
import { describe, it, vi } from "vitest";

const executeGitCommandMock = vi.fn();

vi.doMock("../executor.ts", () => ({
  executeGitCommand: executeGitCommandMock,
}));

const { getGitRoot } = await import("./get-git-root.ts");

describe("getGitRoot", () => {
  const resetMocks = () => {
    executeGitCommandMock.mockReset();
  };

  it("resolves a normal repository root from the provided cwd", async () => {
    resetMocks();
    executeGitCommandMock.mockResolvedValueOnce({
      stdout: "../../.git",
      stderr: "",
    });

    const result = await getGitRoot({ cwd: "/repo/packages/cli" });

    strictEqual(result, "/repo");
    deepStrictEqual(executeGitCommandMock.mock.calls[0], [
      ["rev-parse", "--git-common-dir"],
      { cwd: "/repo/packages/cli" },
    ]);
  });

  it("falls back to show-toplevel for linked worktrees", async () => {
    resetMocks();
    executeGitCommandMock
      .mockResolvedValueOnce({
        stdout: "/repo/.git/worktrees/feature",
        stderr: "",
      })
      .mockResolvedValueOnce({
        stdout: "/repo/.git/phantom/worktrees/feature",
        stderr: "",
      });

    const result = await getGitRoot({
      cwd: "/repo/.git/phantom/worktrees/feature/src",
    });

    strictEqual(result, "/repo/.git/phantom/worktrees/feature");
    deepStrictEqual(executeGitCommandMock.mock.calls[1], [
      ["rev-parse", "--show-toplevel"],
      { cwd: "/repo/.git/phantom/worktrees/feature/src" },
    ]);
  });
});
