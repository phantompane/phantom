import { deepStrictEqual, strictEqual } from "node:assert";
import { describe, it, vi } from "vitest";

const executeGitCommandMock = vi.fn();

vi.doMock("../executor.ts", () => ({
  executeGitCommand: executeGitCommandMock,
}));

const { setUpstreamBranch } = await import("./set-upstream-branch.ts");
const { isOk, isErr } = await import("@phantompane/shared");

describe("setUpstreamBranch", () => {
  const resetMocks = () => {
    executeGitCommandMock.mockClear();
  };

  it("should successfully set upstream branch", async () => {
    resetMocks();
    executeGitCommandMock.mockImplementation(() =>
      Promise.resolve({ stdout: "", stderr: "" }),
    );

    const result = await setUpstreamBranch(
      "/test/repo",
      "feature-branch",
      "origin/main",
    );

    strictEqual(isOk(result), true);
    strictEqual(executeGitCommandMock.mock.calls.length, 1);
    deepStrictEqual(executeGitCommandMock.mock.calls[0][0], [
      "branch",
      "--set-upstream-to",
      "origin/main",
      "feature-branch",
    ]);
    deepStrictEqual(executeGitCommandMock.mock.calls[0][1], {
      cwd: "/test/repo",
    });
  });

  it("should handle git command failure", async () => {
    resetMocks();
    executeGitCommandMock.mockImplementation(() =>
      Promise.reject(
        new Error("fatal: branch 'feature-branch' does not exist"),
      ),
    );

    const result = await setUpstreamBranch(
      "/test/repo",
      "feature-branch",
      "origin/main",
    );

    strictEqual(isErr(result), true);
    if (isErr(result)) {
      strictEqual(
        result.error.message.includes(
          "fatal: branch 'feature-branch' does not exist",
        ),
        true,
      );
    }
  });

  it("should handle non-Error exceptions", async () => {
    resetMocks();
    executeGitCommandMock.mockImplementation(() =>
      Promise.reject("string error"),
    );

    const result = await setUpstreamBranch(
      "/test/repo",
      "feature-branch",
      "origin/main",
    );

    strictEqual(isErr(result), true);
    if (isErr(result)) {
      strictEqual(
        result.error.message,
        "Failed to set upstream branch: string error",
      );
    }
  });
});
