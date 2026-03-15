import { deepStrictEqual, strictEqual } from "node:assert";
import { describe, it, mock } from "node:test";

const executeGitCommandMock = mock.fn();

mock.module("../executor.ts", {
  namedExports: {
    executeGitCommand: executeGitCommandMock,
  },
});

const { setUpstreamBranch } = await import("./set-upstream-branch.ts");
const { isOk, isErr } = await import("@phantompane/shared");

describe("setUpstreamBranch", () => {
  const resetMocks = () => {
    executeGitCommandMock.mock.resetCalls();
  };

  it("should successfully set upstream branch", async () => {
    resetMocks();
    executeGitCommandMock.mock.mockImplementation(() =>
      Promise.resolve({ stdout: "", stderr: "" }),
    );

    const result = await setUpstreamBranch(
      "/test/repo",
      "feature-branch",
      "origin/main",
    );

    strictEqual(isOk(result), true);
    strictEqual(executeGitCommandMock.mock.calls.length, 1);
    deepStrictEqual(executeGitCommandMock.mock.calls[0].arguments[0], [
      "branch",
      "--set-upstream-to",
      "origin/main",
      "feature-branch",
    ]);
    deepStrictEqual(executeGitCommandMock.mock.calls[0].arguments[1], {
      cwd: "/test/repo",
    });
  });

  it("should handle git command failure", async () => {
    resetMocks();
    executeGitCommandMock.mock.mockImplementation(() =>
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
    strictEqual(
      result.error.message.includes(
        "fatal: branch 'feature-branch' does not exist",
      ),
      true,
    );
  });

  it("should handle non-Error exceptions", async () => {
    resetMocks();
    executeGitCommandMock.mock.mockImplementation(() =>
      Promise.reject("string error"),
    );

    const result = await setUpstreamBranch(
      "/test/repo",
      "feature-branch",
      "origin/main",
    );

    strictEqual(isErr(result), true);
    strictEqual(
      result.error.message,
      "Failed to set upstream branch: string error",
    );
  });
});
