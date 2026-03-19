import { deepStrictEqual, strictEqual } from "node:assert";
import { describe, it, vi } from "vitest";

const executeGitCommandMock = vi.fn();

vi.doMock("../executor.ts", () => ({
  executeGitCommand: executeGitCommandMock,
}));

const { configGetRegexp } = await import("./config-get-regexp.ts");
const { configSet } = await import("./config-set.ts");
const { configUnset } = await import("./config-unset.ts");

describe("git config wrappers", () => {
  const resetMocks = () => {
    executeGitCommandMock.mockReset();
  };

  it("reads config entries with flags", async () => {
    resetMocks();
    executeGitCommandMock.mockResolvedValue({
      stdout: "phantom.editor\ncode\u0000",
      stderr: "",
    });

    const result = await configGetRegexp({
      pattern: "^phantom\\.",
      global: true,
      nullSeparated: true,
    });

    strictEqual(result, "phantom.editor\ncode\u0000");
    deepStrictEqual(executeGitCommandMock.mock.calls[0], [
      ["config", "--global", "--null", "--get-regexp", "^phantom\\."],
      { cwd: undefined },
    ]);
  });

  it("sets config values", async () => {
    resetMocks();
    executeGitCommandMock.mockResolvedValue({ stdout: "", stderr: "" });

    await configSet({
      key: "phantom.editor",
      value: "code",
      global: true,
    });

    deepStrictEqual(executeGitCommandMock.mock.calls[0], [
      ["config", "--global", "phantom.editor", "code"],
      { cwd: undefined },
    ]);
  });

  it("unsets config values", async () => {
    resetMocks();
    executeGitCommandMock.mockResolvedValue({ stdout: "", stderr: "" });

    await configUnset({
      key: "phantom.editor",
      global: true,
    });

    deepStrictEqual(executeGitCommandMock.mock.calls[0], [
      ["config", "--global", "--unset", "phantom.editor"],
      { cwd: undefined },
    ]);
  });
});
