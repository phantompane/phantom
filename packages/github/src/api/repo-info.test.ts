import { deepStrictEqual, rejects, strictEqual } from "node:assert";
import type { ExecFileException } from "node:child_process";
import { describe, it, vi } from "vitest";

const execFileMock = vi.fn();

vi.doMock("node:child_process", () => ({
  execFile: (
    cmd: string,
    args: string[],
    callback?: (
      error: ExecFileException | null,
      result?: { stdout: string; stderr: string },
    ) => void,
  ) => {
    const result = execFileMock(cmd, args);
    if (callback) {
      result.then(
        (res: { stdout: string; stderr: string }) => callback(null, res),
        (err: ExecFileException) => callback(err),
      );
    }
    return {};
  },
}));

vi.doMock("node:util", () => ({
  promisify: () => execFileMock,
}));

const { getGitHubRepoInfo } = await import("./repo-info.ts");

describe("getGitHubRepoInfo", () => {
  const resetMocks = () => {
    execFileMock.mockClear();
  };

  it("should export getGitHubRepoInfo function", () => {
    strictEqual(typeof getGitHubRepoInfo, "function");
  });

  it("should return repository info successfully", async () => {
    resetMocks();
    execFileMock.mockImplementation(() =>
      Promise.resolve({
        stdout: JSON.stringify({
          owner: { login: "test-owner" },
          name: "test-repo",
        }),
        stderr: "",
      }),
    );

    const result = await getGitHubRepoInfo();
    deepStrictEqual(result, {
      owner: "test-owner",
      repo: "test-repo",
    });

    strictEqual(execFileMock.mock.calls.length, 1);
    const [cmd, args] = execFileMock.mock.calls[0];
    strictEqual(cmd, "gh");
    deepStrictEqual(args, ["repo", "view", "--json", "owner,name"]);
  });

  it("should throw error when gh command fails", async () => {
    resetMocks();
    execFileMock.mockImplementation(() =>
      Promise.reject(new Error("Command failed")),
    );

    await rejects(
      getGitHubRepoInfo(),
      /Failed to get repository info: Command failed/,
    );
  });

  it("should throw error when response is invalid", async () => {
    resetMocks();
    execFileMock.mockImplementation(() =>
      Promise.resolve({
        stdout: JSON.stringify({
          owner: { login: 123 }, // Invalid: should be string
          name: "test-repo",
        }),
        stderr: "",
      }),
    );

    await rejects(
      getGitHubRepoInfo(),
      /Invalid input: expected string, received number/,
    );
  });
});
