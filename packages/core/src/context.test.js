import { deepStrictEqual, equal } from "node:assert/strict";
import { describe, it, mock } from "node:test";

const loadConfigMock = mock.fn();
const loadPreferencesMock = mock.fn();
const getWorktreesDirectoryMock = mock.fn();

mock.module("./config/loader.ts", {
  namedExports: {
    loadConfig: loadConfigMock,
  },
});

mock.module("./preferences/loader.ts", {
  namedExports: {
    loadPreferences: loadPreferencesMock,
  },
});

mock.module("./paths.ts", {
  namedExports: {
    getWorktreesDirectory: getWorktreesDirectoryMock,
  },
});

const { ok, err } = await import("@aku11i/phantom-shared");
const { createContext } = await import("./context.ts");

describe("createContext", () => {
  const resetMocks = () => {
    loadConfigMock.mock.resetCalls();
    loadPreferencesMock.mock.resetCalls();
    getWorktreesDirectoryMock.mock.resetCalls();
  };

  it("uses config worktreesDirectory over preferences", async () => {
    resetMocks();
    loadConfigMock.mock.mockImplementation(async () =>
      ok({ worktreesDirectory: "config-dir" }),
    );
    loadPreferencesMock.mock.mockImplementation(async () => ({
      worktreesDirectory: "../user-worktrees",
    }));
    getWorktreesDirectoryMock.mock.mockImplementation(() => "/resolved/config");

    const context = await createContext("/repo");

    deepStrictEqual(getWorktreesDirectoryMock.mock.calls[0].arguments, [
      "/repo",
      "config-dir",
    ]);
    equal(context.worktreesDirectory, "/resolved/config");
    equal(context.config?.worktreesDirectory, "config-dir");
    equal(context.preferences.worktreesDirectory, "../user-worktrees");
  });

  it("uses preferences worktreesDirectory when config is absent", async () => {
    resetMocks();
    loadConfigMock.mock.mockImplementation(async () => ok({}));
    loadPreferencesMock.mock.mockImplementation(async () => ({
      worktreesDirectory: "../user-worktrees",
    }));
    getWorktreesDirectoryMock.mock.mockImplementation(
      (_gitRoot, worktreesDirectory) => `/resolved/${worktreesDirectory}`,
    );

    const context = await createContext("/repo");

    deepStrictEqual(getWorktreesDirectoryMock.mock.calls[0].arguments, [
      "/repo",
      "../user-worktrees",
    ]);
    equal(context.worktreesDirectory, "/resolved/../user-worktrees");
  });

  it("falls back to default worktreesDirectory when neither preference nor config is set", async () => {
    resetMocks();
    loadConfigMock.mock.mockImplementation(async () => err(new Error("none")));
    loadPreferencesMock.mock.mockImplementation(async () => ({}));
    getWorktreesDirectoryMock.mock.mockImplementation(
      (_gitRoot, worktreesDirectory) =>
        worktreesDirectory ?? "/repo/.git/phantom/worktrees",
    );

    const context = await createContext("/repo");

    deepStrictEqual(getWorktreesDirectoryMock.mock.calls[0].arguments, [
      "/repo",
      undefined,
    ]);
    equal(context.worktreesDirectory, "/repo/.git/phantom/worktrees");
  });
});
