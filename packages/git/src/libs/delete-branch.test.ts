import { deepStrictEqual } from "node:assert";
import { describe, it, vi } from "vitest";

const executeGitCommandMock = vi.fn();

vi.doMock("../executor.ts", () => ({
  executeGitCommand: executeGitCommandMock,
}));

const { deleteBranch } = await import("./delete-branch.ts");

describe("deleteBranch", () => {
  const resetMocks = () => {
    executeGitCommandMock.mockReset();
  };

  it("force deletes a branch by default", async () => {
    resetMocks();
    executeGitCommandMock.mockResolvedValue({ stdout: "", stderr: "" });

    await deleteBranch({
      gitRoot: "/repo",
      branch: "feature",
    });

    deepStrictEqual(executeGitCommandMock.mock.calls[0], [
      ["branch", "-D", "feature"],
      { cwd: "/repo" },
    ]);
  });

  it("supports non-force deletion", async () => {
    resetMocks();
    executeGitCommandMock.mockResolvedValue({ stdout: "", stderr: "" });

    await deleteBranch({
      gitRoot: "/repo",
      branch: "feature",
      force: false,
    });

    deepStrictEqual(executeGitCommandMock.mock.calls[0], [
      ["branch", "-d", "feature"],
      { cwd: "/repo" },
    ]);
  });
});
