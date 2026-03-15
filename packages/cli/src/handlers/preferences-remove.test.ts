import { rejects, strictEqual } from "node:assert";
import { afterAll, describe, it, vi } from "vitest";

const exitMock = vi.fn();
const consoleLogMock = vi.fn();
const consoleErrorMock = vi.fn();
const executeGitCommandMock = vi.fn();

const originalProcessExit = process.exit;
const originalProcessEnv = process.env;

process.exit = (code): never => {
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
  exitWithError: (message: string, code: number) => {
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

const { preferencesRemoveHandler } = await import("./preferences-remove.ts");

function resetMocks() {
  exitMock.mockClear();
  consoleLogMock.mockClear();
  consoleErrorMock.mockClear();
  executeGitCommandMock.mockClear();
}

describe("preferencesRemoveHandler", () => {
  it("errors when key is missing", async () => {
    resetMocks();

    await rejects(
      async () => await preferencesRemoveHandler([]),
      /Exit with code 3: Usage: phantom preferences remove <key>/,
    );

    strictEqual(exitMock.mock.calls[0][0], 3);
  });

  it("errors on unknown key", async () => {
    resetMocks();

    await rejects(
      async () => await preferencesRemoveHandler(["unknown"]),
      /Exit with code 3: Unknown preference 'unknown'\. Supported keys: editor, ai, worktreesDirectory, directoryNameSeparator/,
    );

    strictEqual(exitMock.mock.calls[0][0], 3);
  });

  it("unsets editor preference via git config --global", async () => {
    resetMocks();
    executeGitCommandMock.mockImplementation(async () => ({
      stdout: "",
      stderr: "",
    }));

    await rejects(
      async () => await preferencesRemoveHandler(["editor"]),
      /Process exit with code 0/,
    );

    strictEqual(executeGitCommandMock.mock.calls.length, 1);
    strictEqual(executeGitCommandMock.mock.calls[0][0][0], "config");
    strictEqual(executeGitCommandMock.mock.calls[0][0][3], "phantom.editor");
    strictEqual(
      consoleLogMock.mock.calls[0][0],
      "Removed phantom.editor from global git config",
    );
    strictEqual(exitMock.mock.calls[0][0], 0);
  });

  it("unsets ai preference via git config --global", async () => {
    resetMocks();
    executeGitCommandMock.mockImplementation(async () => ({
      stdout: "",
      stderr: "",
    }));

    await rejects(
      async () => await preferencesRemoveHandler(["ai"]),
      /Process exit with code 0/,
    );

    strictEqual(executeGitCommandMock.mock.calls[0][0][3], "phantom.ai");
    strictEqual(
      consoleLogMock.mock.calls[0][0],
      "Removed phantom.ai from global git config",
    );
    strictEqual(exitMock.mock.calls[0][0], 0);
  });

  it("unsets worktreesDirectory preference via git config --global", async () => {
    resetMocks();
    executeGitCommandMock.mockImplementation(async () => ({
      stdout: "",
      stderr: "",
    }));

    await rejects(
      async () => await preferencesRemoveHandler(["worktreesDirectory"]),
      /Process exit with code 0/,
    );

    strictEqual(
      executeGitCommandMock.mock.calls[0][0][3],
      "phantom.worktreesDirectory",
    );
    strictEqual(
      consoleLogMock.mock.calls[0][0],
      "Removed phantom.worktreesDirectory from global git config",
    );
    strictEqual(exitMock.mock.calls[0][0], 0);
  });

  it("unsets directoryNameSeparator preference via git config --global", async () => {
    resetMocks();
    executeGitCommandMock.mockImplementation(async () => ({
      stdout: "",
      stderr: "",
    }));

    await rejects(
      async () => await preferencesRemoveHandler(["directoryNameSeparator"]),
      /Process exit with code 0/,
    );

    strictEqual(
      executeGitCommandMock.mock.calls[0][0][3],
      "phantom.directoryNameSeparator",
    );
    strictEqual(
      consoleLogMock.mock.calls[0][0],
      "Removed phantom.directoryNameSeparator from global git config",
    );
    strictEqual(exitMock.mock.calls[0][0], 0);
  });
});
