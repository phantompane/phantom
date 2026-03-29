import { deepStrictEqual, equal, rejects } from "node:assert/strict";
import { describe, it, vi } from "vitest";

const configGetRegexpMock = vi.fn();

vi.doMock("@phantompane/git", () => ({
  configGetRegexp: configGetRegexpMock,
}));

const { loadPreferences } = await import("./loader.ts");

describe("loadPreferences", () => {
  const resetMocks = () => {
    configGetRegexpMock.mockClear();
  };

  it("returns editor and ai preferences from git config", async () => {
    resetMocks();
    configGetRegexpMock.mockImplementation(
      async () =>
        "phantom.editor\ncode\u0000phantom.ai\nclaude\u0000phantom.worktreesdirectory\n../phantom-worktrees\u0000phantom.directorynameseparator\n-\u0000phantom.keepbranch\ntrue\u0000",
    );

    const preferences = await loadPreferences();

    deepStrictEqual(preferences, {
      editor: "code",
      ai: "claude",
      worktreesDirectory: "../phantom-worktrees",
      directoryNameSeparator: "-",
      keepBranch: true,
    });
    deepStrictEqual(configGetRegexpMock.mock.calls[0][0], {
      pattern: "^phantom\\.",
      global: true,
      nullSeparated: true,
    });
  });

  it("ignores unknown keys and keeps known ones", async () => {
    resetMocks();
    configGetRegexpMock.mockImplementation(
      async () =>
        "phantom.unknown\nvalue\u0000phantom.editor\nvim\u0000phantom.ai\ncodex\u0000phantom.worktreesdirectory\n../phantom\u0000phantom.directorynameseparator\n_\u0000phantom.keepbranch\nfalse\u0000",
    );

    const preferences = await loadPreferences();

    deepStrictEqual(preferences, {
      editor: "vim",
      ai: "codex",
      worktreesDirectory: "../phantom",
      directoryNameSeparator: "_",
      keepBranch: false,
    });
  });

  it("returns empty preferences when no config entries exist", async () => {
    resetMocks();
    configGetRegexpMock.mockImplementation(async () => "");

    const preferences = await loadPreferences();

    deepStrictEqual(preferences, {});
  });

  it("prefers the last occurrence of the same key", async () => {
    resetMocks();
    configGetRegexpMock.mockImplementation(
      async () =>
        "phantom.editor\nvim\u0000phantom.editor\ncode\u0000phantom.ai\nclaude\u0000phantom.ai\ncursor\u0000phantom.worktreesdirectory\n../phantom-custom\u0000phantom.worktreesdirectory\n../phantom-worktrees\u0000phantom.directorynameseparator\n_\u0000phantom.directorynameseparator\n-\u0000phantom.keepbranch\nfalse\u0000phantom.keepbranch\ntrue\u0000",
    );

    const preferences = await loadPreferences();

    equal(preferences.editor, "code");
    equal(preferences.ai, "cursor");
    equal(preferences.worktreesDirectory, "../phantom-worktrees");
    equal(preferences.directoryNameSeparator, "-");
    equal(preferences.keepBranch, true);
  });

  it("parses preference keys regardless of git config key casing", async () => {
    resetMocks();
    configGetRegexpMock.mockImplementation(
      async () =>
        "phantom.Editor\nvim\u0000phantom.AI\nclaude\u0000phantom.WorktreesDirectory\n../phantom-wt\u0000phantom.DirectoryNameSeparator\n_\u0000phantom.KeepBranch\ntrue\u0000",
    );

    const preferences = await loadPreferences();

    equal(preferences.editor, "vim");
    equal(preferences.ai, "claude");
    equal(preferences.worktreesDirectory, "../phantom-wt");
    equal(preferences.directoryNameSeparator, "_");
    equal(preferences.keepBranch, true);
  });

  it("ignores invalid keepBranch preference values", async () => {
    resetMocks();
    configGetRegexpMock.mockImplementation(
      async () => "phantom.keepbranch\nyes\u0000",
    );

    const preferences = await loadPreferences();

    equal(preferences.keepBranch, undefined);
  });
});
