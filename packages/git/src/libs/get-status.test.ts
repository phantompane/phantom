import { deepStrictEqual, strictEqual } from "node:assert";
import { describe, it, vi } from "vitest";

const executeGitCommandMock = vi.fn();

vi.doMock("../executor.ts", () => ({
  executeGitCommand: executeGitCommandMock,
}));

const { getStatus } = await import("./get-status.ts");

describe("getStatus", () => {
  it("parses porcelain entries for the provided directory", async () => {
    executeGitCommandMock.mockResolvedValue({
      stdout: "M  file.txt\nR  old.ts -> new.ts\n?? new-file.ts\n",
      stderr: "",
    });

    const result = await getStatus({
      cwd: "/repo/.git/phantom/worktrees/feature",
    });

    strictEqual(result.isClean, false);
    deepStrictEqual(result.entries, [
      {
        indexStatus: "M",
        workingTreeStatus: " ",
        path: "file.txt",
        originalPath: undefined,
      },
      {
        indexStatus: "R",
        workingTreeStatus: " ",
        path: "new.ts",
        originalPath: "old.ts",
      },
      {
        indexStatus: "?",
        workingTreeStatus: "?",
        path: "new-file.ts",
        originalPath: undefined,
      },
    ]);
    deepStrictEqual(executeGitCommandMock.mock.calls[0], [
      ["status", "--porcelain"],
      { cwd: "/repo/.git/phantom/worktrees/feature" },
    ]);
  });

  it("reports clean repositories when porcelain output is empty", async () => {
    executeGitCommandMock.mockResolvedValue({
      stdout: "",
      stderr: "",
    });

    const result = await getStatus({
      cwd: "/repo/.git/phantom/worktrees/feature",
    });

    strictEqual(result.isClean, true);
    deepStrictEqual(result.entries, []);
  });
});
