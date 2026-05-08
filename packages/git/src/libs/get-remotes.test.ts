import { deepEqual } from "node:assert/strict";
import { beforeEach, describe, it, vi } from "vitest";

const executeGitCommandMock = vi.fn();

vi.mock("../executor.ts", () => ({
  executeGitCommand: executeGitCommandMock,
}));

const { getRemotes } = await import("./get-remotes.ts");

describe("getRemotes", () => {
  beforeEach(() => {
    executeGitCommandMock.mockReset();
  });

  it("returns configured remotes", async () => {
    executeGitCommandMock.mockResolvedValue({
      stdout: "upstream\nfork\n",
      stderr: "",
    });

    const result = await getRemotes({ cwd: "/repo/worktree" });

    deepEqual(result, ["upstream", "fork"]);
    deepEqual(executeGitCommandMock.mock.calls[0], [
      ["remote"],
      { cwd: "/repo/worktree" },
    ]);
  });

  it("returns an empty array when no remotes are configured", async () => {
    executeGitCommandMock.mockResolvedValue({ stdout: "\n", stderr: "" });

    const result = await getRemotes({ cwd: "/repo/worktree" });

    deepEqual(result, []);
  });
});
