import { rejects, strictEqual } from "node:assert";
import { describe, it, mock } from "node:test";

const exitMock = mock.fn();
const consoleLogMock = mock.fn();
const consoleErrorMock = mock.fn();
const loadPreferencesMock = mock.fn();

mock.module("node:process", {
  namedExports: {
    exit: exitMock,
  },
});

mock.module("@phantompane/core", {
  namedExports: {
    loadPreferences: loadPreferencesMock,
  },
});

mock.module("../output.ts", {
  namedExports: {
    output: {
      log: consoleLogMock,
      error: consoleErrorMock,
    },
  },
});

mock.module("../errors.ts", {
  namedExports: {
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
  },
});

const { preferencesGetHandler } = await import("./preferences-get.ts");

function resetMocks() {
  exitMock.mock.resetCalls();
  consoleLogMock.mock.resetCalls();
  consoleErrorMock.mock.resetCalls();
  loadPreferencesMock.mock.resetCalls();
}

describe("preferencesGetHandler", () => {
  it("errors when key is missing", async () => {
    resetMocks();

    await rejects(
      async () => await preferencesGetHandler([]),
      /Exit with code 3: Usage: phantom preferences get <key>/,
    );

    strictEqual(exitMock.mock.calls[0].arguments[0], 3);
    strictEqual(
      consoleErrorMock.mock.calls[0].arguments[0],
      "Error: Usage: phantom preferences get <key>",
    );
  });

  it("errors on unknown key", async () => {
    resetMocks();

    await rejects(
      async () => await preferencesGetHandler(["unknown"]),
      /Exit with code 3: Unknown preference 'unknown'\. Supported keys: editor, ai, worktreesDirectory, directoryNameSeparator/,
    );

    strictEqual(exitMock.mock.calls[0].arguments[0], 3);
  });

  it("prints editor preference when set", async () => {
    resetMocks();
    loadPreferencesMock.mock.mockImplementation(async () => ({
      editor: "code",
    }));

    await rejects(
      async () => await preferencesGetHandler(["editor"]),
      /Process exit with code 0/,
    );

    strictEqual(consoleLogMock.mock.calls[0].arguments[0], "code");
    strictEqual(exitMock.mock.calls[0].arguments[0], 0);
  });

  it("prints ai preference when set", async () => {
    resetMocks();
    loadPreferencesMock.mock.mockImplementation(async () => ({
      ai: "claude",
    }));

    await rejects(
      async () => await preferencesGetHandler(["ai"]),
      /Process exit with code 0/,
    );

    strictEqual(consoleLogMock.mock.calls[0].arguments[0], "claude");
    strictEqual(exitMock.mock.calls[0].arguments[0], 0);
  });

  it("prints worktreesDirectory preference when set", async () => {
    resetMocks();
    loadPreferencesMock.mock.mockImplementation(async () => ({
      worktreesDirectory: "../phantom-worktrees",
    }));

    await rejects(
      async () => await preferencesGetHandler(["worktreesDirectory"]),
      /Process exit with code 0/,
    );

    strictEqual(
      consoleLogMock.mock.calls[0].arguments[0],
      "../phantom-worktrees",
    );
    strictEqual(exitMock.mock.calls[0].arguments[0], 0);
  });

  it("prints directoryNameSeparator preference when set", async () => {
    resetMocks();
    loadPreferencesMock.mock.mockImplementation(async () => ({
      directoryNameSeparator: "-",
    }));

    await rejects(
      async () => await preferencesGetHandler(["directoryNameSeparator"]),
      /Process exit with code 0/,
    );

    strictEqual(consoleLogMock.mock.calls[0].arguments[0], "-");
    strictEqual(exitMock.mock.calls[0].arguments[0], 0);
  });

  it("warns when preference is unset", async () => {
    resetMocks();
    loadPreferencesMock.mock.mockImplementation(async () => ({}));

    await rejects(
      async () => await preferencesGetHandler(["editor"]),
      /Process exit with code 0/,
    );

    strictEqual(
      consoleLogMock.mock.calls[0].arguments[0],
      "Preference 'editor' is not set (git config --global phantom.editor)",
    );
  });

  it("warns when ai preference is unset", async () => {
    resetMocks();
    loadPreferencesMock.mock.mockImplementation(async () => ({}));

    await rejects(
      async () => await preferencesGetHandler(["ai"]),
      /Process exit with code 0/,
    );

    strictEqual(
      consoleLogMock.mock.calls[0].arguments[0],
      "Preference 'ai' is not set (git config --global phantom.ai)",
    );
  });

  it("warns when worktreesDirectory preference is unset", async () => {
    resetMocks();
    loadPreferencesMock.mock.mockImplementation(async () => ({}));

    await rejects(
      async () => await preferencesGetHandler(["worktreesDirectory"]),
      /Process exit with code 0/,
    );

    strictEqual(
      consoleLogMock.mock.calls[0].arguments[0],
      "Preference 'worktreesDirectory' is not set (git config --global phantom.worktreesDirectory)",
    );
  });

  it("warns when directoryNameSeparator preference is unset", async () => {
    resetMocks();
    loadPreferencesMock.mock.mockImplementation(async () => ({}));

    await rejects(
      async () => await preferencesGetHandler(["directoryNameSeparator"]),
      /Process exit with code 0/,
    );

    strictEqual(
      consoleLogMock.mock.calls[0].arguments[0],
      "Preference 'directoryNameSeparator' is not set (git config --global phantom.directoryNameSeparator)",
    );
  });
});
