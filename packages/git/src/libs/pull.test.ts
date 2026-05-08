import { deepEqual, equal } from "node:assert/strict";
import { beforeEach, describe, it, vi } from "vitest";

const executeGitCommandMock = vi.fn();

vi.mock("../executor.ts", () => ({
  executeGitCommand: executeGitCommandMock,
}));

const { pull } = await import("./pull.ts");

describe("pull", () => {
  beforeEach(() => {
    executeGitCommandMock.mockClear();
  });

  it("runs git pull in the provided cwd", async () => {
    executeGitCommandMock.mockResolvedValue({ stdout: "", stderr: "" });

    const result = await pull({ cwd: "/repo/worktree" });

    equal(result.ok, true);
    deepEqual(executeGitCommandMock.mock.calls[0], [
      ["pull"],
      { cwd: "/repo/worktree" },
    ]);
  });

  it("passes remote and branch when provided", async () => {
    executeGitCommandMock.mockResolvedValue({ stdout: "", stderr: "" });

    const result = await pull({
      cwd: "/repo/worktree",
      remote: "origin",
      branch: "main",
    });

    equal(result.ok, true);
    deepEqual(executeGitCommandMock.mock.calls[0], [
      ["pull", "origin", "main"],
      { cwd: "/repo/worktree" },
    ]);
  });

  it("returns an error when git pull fails", async () => {
    executeGitCommandMock.mockRejectedValue(new Error("no upstream"));

    const result = await pull({ cwd: "/repo/worktree" });

    equal(result.ok, false);
    if (!result.ok) {
      equal(result.error.message, "git pull failed: no upstream");
    }
  });
});
