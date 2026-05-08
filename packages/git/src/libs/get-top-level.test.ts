import { deepStrictEqual, strictEqual } from "node:assert";
import { describe, it, vi } from "vitest";

const executeGitCommandMock = vi.fn();

vi.doMock("../executor.ts", () => ({
  executeGitCommand: executeGitCommandMock,
}));

const { getTopLevel } = await import("./get-top-level.ts");

describe("getTopLevel", () => {
  it("returns the repository top-level path", async () => {
    executeGitCommandMock.mockResolvedValue({
      stdout: "/repo",
      stderr: "",
    });

    const result = await getTopLevel({ cwd: "/repo/subdir" });

    strictEqual(result, "/repo");
    deepStrictEqual(executeGitCommandMock.mock.calls[0], [
      ["rev-parse", "--show-toplevel"],
      { cwd: "/repo/subdir" },
    ]);
  });
});
