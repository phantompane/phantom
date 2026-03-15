import { rejects, strictEqual } from "node:assert";
import { afterAll, describe, it, vi } from "vitest";

const exitMock = vi.fn();
const consoleLogMock = vi.fn();
const consoleErrorMock = vi.fn();
const executeGitCommandMock = vi.fn();

const originalProcessExit = process.exit;
const originalProcessEnv = process.env;

process.exit = (code) => {
  exitMock(code);
  throw new Error(`Exit with code ${code ?? 0}`);
};

afterAll(() => {
  process.exit = originalProcessExit;
  process.env = originalProcessEnv;
});

vi.doMock("@phantompane/git", () => ({
  executeGitCommand: executeGitCommandMock,
}));

vi.doMock("../output.ts", () => ({
  output: {
    log: consoleLogMock,
    error: consoleErrorMock,
  },
}));

vi.doMock("../errors.ts", () => ({
  exitWithError: (message, code) => {
    consoleErrorMock(`Error: ${message}`);
    exitMock(code);
    throw new Error(`Exit with code ${code}: ${message}`);
  },
  exitWithSuccess: () => {
    exitMock(0);
    throw new Error("Process exit with code 0");
  },
  exitCodes: {
    success: 0,
    generalError: 1,
    notFound: 2,
    validationError: 3,
  },
}));

const { preferencesSetHandler } = await import("./preferences-set.ts");

function resetMocks() {
  exitMock.mockClear();
  consoleLogMock.mockClear();
  consoleErrorMock.mockClear();
  executeGitCommandMock.mockClear();
}

describe("preferencesSetHandler", () => {
  it("errors when key or value is missing", async () => {
    resetMocks();

    await rejects(
      async () => await preferencesSetHandler(["editor"]),
      /Exit with code 3: Usage: phantom preferences set <key> <value>/,
    );

    strictEqual(exitMock.mock.calls[0][0], 3);
  });

  it("errors on unknown key", async () => {
    resetMocks();

    await rejects(
      async () => await preferencesSetHandler(["unknown", "value"]),
      /Exit with code 3: Unknown preference 'unknown'\. Supported keys: editor, ai, worktreesDirectory, directoryNameSeparator/,
    );

    strictEqual(exitMock.mock.calls[0][0], 3);
  });

  it("errors when value is empty after join", async () => {
    resetMocks();

    await rejects(
      async () => await preferencesSetHandler(["editor", ""]),
      /Exit with code 3: Preference 'editor' requires a value/,
    );

    strictEqual(exitMock.mock.calls[0][0], 3);
  });

  it("sets editor preference via git config --global", async () => {
    resetMocks();
    executeGitCommandMock.mockImplementation(async () => ({
      stdout: "",
      stderr: "",
    }));

    await rejects(
      async () => await preferencesSetHandler(["editor", "code"]),
      /Process exit with code 0/,
    );

    strictEqual(executeGitCommandMock.mock.calls.length, 1);
    strictEqual(executeGitCommandMock.mock.calls[0][0][0], "config");
    strictEqual(executeGitCommandMock.mock.calls[0][0][2], "phantom.editor");
    strictEqual(executeGitCommandMock.mock.calls[0][0][3], "code");
    strictEqual(
      consoleLogMock.mock.calls[0][0],
      "Set phantom.editor (global) to 'code'",
    );
    strictEqual(exitMock.mock.calls[0][0], 0);
  });

  it("joins multi-word value", async () => {
    resetMocks();
    executeGitCommandMock.mockImplementation(async () => ({
      stdout: "",
      stderr: "",
    }));

    await rejects(
      async () => await preferencesSetHandler(["editor", "code", "--wait"]),
      /Process exit with code 0/,
    );

    strictEqual(executeGitCommandMock.mock.calls[0][0][3], "code --wait");
  });

  it("sets ai preference via git config --global", async () => {
    resetMocks();
    executeGitCommandMock.mockImplementation(async () => ({
      stdout: "",
      stderr: "",
    }));

    await rejects(
      async () => await preferencesSetHandler(["ai", "claude"]),
      /Process exit with code 0/,
    );

    strictEqual(executeGitCommandMock.mock.calls[0][0][2], "phantom.ai");
    strictEqual(executeGitCommandMock.mock.calls[0][0][3], "claude");
    strictEqual(
      consoleLogMock.mock.calls[0][0],
      "Set phantom.ai (global) to 'claude'",
    );
    strictEqual(exitMock.mock.calls[0][0], 0);
  });

  it("sets worktreesDirectory preference via git config --global", async () => {
    resetMocks();
    executeGitCommandMock.mockImplementation(async () => ({
      stdout: "",
      stderr: "",
    }));

    await rejects(
      async () =>
        await preferencesSetHandler([
          "worktreesDirectory",
          "../phantom/worktrees",
        ]),
      /Process exit with code 0/,
    );

    strictEqual(
      executeGitCommandMock.mock.calls[0][0][2],
      "phantom.worktreesDirectory",
    );
    strictEqual(
      executeGitCommandMock.mock.calls[0][0][3],
      "../phantom/worktrees",
    );
    strictEqual(
      consoleLogMock.mock.calls[0][0],
      "Set phantom.worktreesDirectory (global) to '../phantom/worktrees'",
    );
    strictEqual(exitMock.mock.calls[0][0], 0);
  });

  it("sets directoryNameSeparator preference via git config --global", async () => {
    resetMocks();
    executeGitCommandMock.mockImplementation(async () => ({
      stdout: "",
      stderr: "",
    }));

    await rejects(
      async () => await preferencesSetHandler(["directoryNameSeparator", "-"]),
      /Process exit with code 0/,
    );

    strictEqual(
      executeGitCommandMock.mock.calls[0][0][2],
      "phantom.directoryNameSeparator",
    );
    strictEqual(executeGitCommandMock.mock.calls[0][0][3], "-");
    strictEqual(
      consoleLogMock.mock.calls[0][0],
      "Set phantom.directoryNameSeparator (global) to '-'",
    );
    strictEqual(exitMock.mock.calls[0][0], 0);
  });
});
