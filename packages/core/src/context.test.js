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

const { ok, err } = await import("@phantompane/shared");
const { createContext } = await import("./context.ts");

describe("createContext", () => {
  const resetMocks = () => {
    loadConfigMock.mock.resetCalls();
    loadPreferencesMock.mock.resetCalls();
    getWorktreesDirectoryMock.mock.resetCalls();
  };

  it("uses preferences worktreesDirectory over config", async () => {
    resetMocks();
    loadConfigMock.mock.mockImplementation(async () =>
      ok({ worktreesDirectory: "config-dir" }),
    );
    loadPreferencesMock.mock.mockImplementation(async () => ({
      worktreesDirectory: "../user-worktrees",
    }));
    getWorktreesDirectoryMock.mock.mockImplementation(() => "/resolved/user");

    const context = await createContext("/repo");

    deepStrictEqual(getWorktreesDirectoryMock.mock.calls[0].arguments, [
      "/repo",
      "../user-worktrees",
    ]);
    equal(context.worktreesDirectory, "/resolved/user");
    equal(context.config?.worktreesDirectory, "config-dir");
    equal(context.preferences.worktreesDirectory, "../user-worktrees");
    equal(context.directoryNameSeparator, "/");
  });

  it("uses config worktreesDirectory when preference is absent", async () => {
    resetMocks();
    loadConfigMock.mock.mockImplementation(async () =>
      ok({ worktreesDirectory: "../config-worktrees" }),
    );
    loadPreferencesMock.mock.mockImplementation(async () => ({}));
    getWorktreesDirectoryMock.mock.mockImplementation(
      (_gitRoot, worktreesDirectory) => `/resolved/${worktreesDirectory}`,
    );

    const context = await createContext("/repo");

    deepStrictEqual(getWorktreesDirectoryMock.mock.calls[0].arguments, [
      "/repo",
      "../config-worktrees",
    ]);
    equal(context.worktreesDirectory, "/resolved/../config-worktrees");
    equal(context.directoryNameSeparator, "/");
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
    equal(context.directoryNameSeparator, "/");
  });

  it("uses preferences directoryNameSeparator over config", async () => {
    resetMocks();
    loadConfigMock.mock.mockImplementation(async () =>
      ok({ directoryNameSeparator: "-" }),
    );
    loadPreferencesMock.mock.mockImplementation(async () => ({
      directoryNameSeparator: "_",
    }));
    getWorktreesDirectoryMock.mock.mockImplementation(() => "/resolved/user");

    const context = await createContext("/repo");

    equal(context.directoryNameSeparator, "_");
  });

  it("uses config directoryNameSeparator when preference is absent", async () => {
    resetMocks();
    loadConfigMock.mock.mockImplementation(async () =>
      ok({ directoryNameSeparator: "-" }),
    );
    loadPreferencesMock.mock.mockImplementation(async () => ({}));
    getWorktreesDirectoryMock.mock.mockImplementation(() => "/resolved/user");

    const context = await createContext("/repo");

    equal(context.directoryNameSeparator, "-");
  });

  it("falls back to default directoryNameSeparator when configured value is empty", async () => {
    resetMocks();
    loadConfigMock.mock.mockImplementation(async () =>
      ok({ directoryNameSeparator: "" }),
    );
    loadPreferencesMock.mock.mockImplementation(async () => ({
      directoryNameSeparator: "",
    }));
    getWorktreesDirectoryMock.mock.mockImplementation(() => "/resolved/user");

    const context = await createContext("/repo");

    equal(context.directoryNameSeparator, "/");
  });
});
