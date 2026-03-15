import { deepStrictEqual, equal } from "node:assert/strict";
import { describe, it, vi } from "vitest";

const executeGitCommandMock = vi.fn();

vi.doMock("@phantompane/git", () => ({
  executeGitCommand: executeGitCommandMock,
}));

const { loadPreferences } = await import("./loader.ts");

describe("loadPreferences", () => {
  const resetMocks = () => {
    executeGitCommandMock.mockClear();
  };

  it("returns editor and ai preferences from git config", async () => {
    resetMocks();
    executeGitCommandMock.mockImplementation(async () => ({
      stdout:
        "phantom.editor\ncode\u0000phantom.ai\nclaude\u0000phantom.worktreesdirectory\n../phantom-worktrees\u0000phantom.directorynameseparator\n-\u0000",
      stderr: "",
    }));

    const preferences = await loadPreferences();

    deepStrictEqual(preferences, {
      editor: "code",
      ai: "claude",
      worktreesDirectory: "../phantom-worktrees",
      directoryNameSeparator: "-",
    });
    deepStrictEqual(executeGitCommandMock.mock.calls[0][0], [
      "config",
      "--global",
      "--null",
      "--get-regexp",
      "^phantom\\.",
    ]);
  });

  it("ignores unknown keys and keeps known ones", async () => {
    resetMocks();
    executeGitCommandMock.mockImplementation(async () => ({
      stdout:
        "phantom.unknown\nvalue\u0000phantom.editor\nvim\u0000phantom.ai\ncodex\u0000phantom.worktreesdirectory\n../phantom\u0000phantom.directorynameseparator\n_\u0000",
      stderr: "",
    }));

    const preferences = await loadPreferences();

    deepStrictEqual(preferences, {
      editor: "vim",
      ai: "codex",
      worktreesDirectory: "../phantom",
      directoryNameSeparator: "_",
    });
  });

  it("returns empty preferences when no config entries exist", async () => {
    resetMocks();
    executeGitCommandMock.mockImplementation(async () => ({
      stdout: "",
      stderr: "",
    }));

    const preferences = await loadPreferences();

    deepStrictEqual(preferences, {});
  });

  it("prefers the last occurrence of the same key", async () => {
    resetMocks();
    executeGitCommandMock.mockImplementation(async () => ({
      stdout:
        "phantom.editor\nvim\u0000phantom.editor\ncode\u0000phantom.ai\nclaude\u0000phantom.ai\ncursor\u0000phantom.worktreesdirectory\n../phantom-custom\u0000phantom.worktreesdirectory\n../phantom-worktrees\u0000phantom.directorynameseparator\n_\u0000phantom.directorynameseparator\n-\u0000",
      stderr: "",
    }));

    const preferences = await loadPreferences();

    equal(preferences.editor, "code");
    equal(preferences.ai, "cursor");
    equal(preferences.worktreesDirectory, "../phantom-worktrees");
    equal(preferences.directoryNameSeparator, "-");
  });

  it("parses preferences regardless of git config key casing", async () => {
    resetMocks();
    executeGitCommandMock.mockImplementation(async () => ({
      stdout:
        "phantom.Editor\nvim\u0000phantom.AI\nclaude\u0000phantom.WorktreesDirectory\n../phantom-wt\u0000phantom.DirectoryNameSeparator\n_\u0000",
      stderr: "",
    }));

    const preferences = await loadPreferences();

    equal(preferences.editor, "vim");
    equal(preferences.ai, "claude");
    equal(preferences.worktreesDirectory, "../phantom-wt");
    equal(preferences.directoryNameSeparator, "_");
  });
});
