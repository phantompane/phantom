import { deepStrictEqual, equal } from "node:assert/strict";
import { describe, it, vi } from "vitest";

const loadConfigMock = vi.fn();
const loadPreferencesMock = vi.fn();
const getWorktreesDirectoryMock = vi.fn();

vi.doMock("./config/loader.ts", () => ({
  loadConfig: loadConfigMock,
}));

vi.doMock("./preferences/loader.ts", () => ({
  loadPreferences: loadPreferencesMock,
}));

vi.doMock("./paths.ts", () => ({
  getWorktreesDirectory: getWorktreesDirectoryMock,
}));

const { ok, err } = await import("@phantompane/utils");
const { createContext } = await import("./context.ts");

describe("createContext", () => {
  const resetMocks = () => {
    loadConfigMock.mockClear();
    loadPreferencesMock.mockClear();
    getWorktreesDirectoryMock.mockClear();
  };

  it("uses preferences worktreesDirectory over config", async () => {
    resetMocks();
    loadConfigMock.mockImplementation(async () =>
      ok({ worktreesDirectory: "config-dir" }),
    );
    loadPreferencesMock.mockImplementation(async () => ({
      worktreesDirectory: "../user-worktrees",
    }));
    getWorktreesDirectoryMock.mockImplementation(() => "/resolved/user");

    const context = await createContext("/repo");

    deepStrictEqual(getWorktreesDirectoryMock.mock.calls[0], [
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
    loadConfigMock.mockImplementation(async () =>
      ok({ worktreesDirectory: "../config-worktrees" }),
    );
    loadPreferencesMock.mockImplementation(async () => ({}));
    getWorktreesDirectoryMock.mockImplementation(
      (_gitRoot, worktreesDirectory) => `/resolved/${worktreesDirectory}`,
    );

    const context = await createContext("/repo");

    deepStrictEqual(getWorktreesDirectoryMock.mock.calls[0], [
      "/repo",
      "../config-worktrees",
    ]);
    equal(context.worktreesDirectory, "/resolved/../config-worktrees");
    equal(context.directoryNameSeparator, "/");
  });

  it("falls back to default worktreesDirectory when neither preference nor config is set", async () => {
    resetMocks();
    loadConfigMock.mockImplementation(async () => err(new Error("none")));
    loadPreferencesMock.mockImplementation(async () => ({}));
    getWorktreesDirectoryMock.mockImplementation(
      (_gitRoot, worktreesDirectory) =>
        worktreesDirectory ?? "/repo/.git/phantom/worktrees",
    );

    const context = await createContext("/repo");

    deepStrictEqual(getWorktreesDirectoryMock.mock.calls[0], [
      "/repo",
      undefined,
    ]);
    equal(context.worktreesDirectory, "/repo/.git/phantom/worktrees");
    equal(context.directoryNameSeparator, "/");
  });

  it("uses preferences directoryNameSeparator over config", async () => {
    resetMocks();
    loadConfigMock.mockImplementation(async () =>
      ok({ directoryNameSeparator: "-" }),
    );
    loadPreferencesMock.mockImplementation(async () => ({
      directoryNameSeparator: "_",
    }));
    getWorktreesDirectoryMock.mockImplementation(() => "/resolved/user");

    const context = await createContext("/repo");

    equal(context.directoryNameSeparator, "_");
  });

  it("uses config directoryNameSeparator when preference is absent", async () => {
    resetMocks();
    loadConfigMock.mockImplementation(async () =>
      ok({ directoryNameSeparator: "-" }),
    );
    loadPreferencesMock.mockImplementation(async () => ({}));
    getWorktreesDirectoryMock.mockImplementation(() => "/resolved/user");

    const context = await createContext("/repo");

    equal(context.directoryNameSeparator, "-");
  });

  it("falls back to default directoryNameSeparator when configured value is empty", async () => {
    resetMocks();
    loadConfigMock.mockImplementation(async () =>
      ok({ directoryNameSeparator: "" }),
    );
    loadPreferencesMock.mockImplementation(async () => ({
      directoryNameSeparator: "",
    }));
    getWorktreesDirectoryMock.mockImplementation(() => "/resolved/user");

    const context = await createContext("/repo");

    equal(context.directoryNameSeparator, "/");
  });
});
