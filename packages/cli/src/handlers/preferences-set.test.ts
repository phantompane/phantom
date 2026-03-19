import { rejects, strictEqual } from "node:assert";
import { afterAll, describe, it, vi } from "vitest";

const exitMock = vi.fn();
const consoleLogMock = vi.fn();
const consoleErrorMock = vi.fn();
const configSetMock = vi.fn();

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
  configSet: configSetMock,
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

const { preferencesSetHandler } = await import("./preferences-set.ts");

function resetMocks() {
  exitMock.mockClear();
  consoleLogMock.mockClear();
  consoleErrorMock.mockClear();
  configSetMock.mockClear();
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
    configSetMock.mockImplementation(async () => undefined);

    await rejects(
      async () => await preferencesSetHandler(["editor", "code"]),
      /Process exit with code 0/,
    );

    strictEqual(configSetMock.mock.calls.length, 1);
    strictEqual(configSetMock.mock.calls[0][0].key, "phantom.editor");
    strictEqual(configSetMock.mock.calls[0][0].value, "code");
    strictEqual(configSetMock.mock.calls[0][0].global, true);
    strictEqual(
      consoleLogMock.mock.calls[0][0],
      "Set phantom.editor (global) to 'code'",
    );
    strictEqual(exitMock.mock.calls[0][0], 0);
  });

  it("joins multi-word value", async () => {
    resetMocks();
    configSetMock.mockImplementation(async () => undefined);

    await rejects(
      async () => await preferencesSetHandler(["editor", "code", "--wait"]),
      /Process exit with code 0/,
    );

    strictEqual(configSetMock.mock.calls[0][0].value, "code --wait");
  });

  it("sets ai preference via git config --global", async () => {
    resetMocks();
    configSetMock.mockImplementation(async () => undefined);

    await rejects(
      async () => await preferencesSetHandler(["ai", "claude"]),
      /Process exit with code 0/,
    );

    strictEqual(configSetMock.mock.calls[0][0].key, "phantom.ai");
    strictEqual(configSetMock.mock.calls[0][0].value, "claude");
    strictEqual(
      consoleLogMock.mock.calls[0][0],
      "Set phantom.ai (global) to 'claude'",
    );
    strictEqual(exitMock.mock.calls[0][0], 0);
  });

  it("sets worktreesDirectory preference via git config --global", async () => {
    resetMocks();
    configSetMock.mockImplementation(async () => undefined);

    await rejects(
      async () =>
        await preferencesSetHandler([
          "worktreesDirectory",
          "../phantom/worktrees",
        ]),
      /Process exit with code 0/,
    );

    strictEqual(
      configSetMock.mock.calls[0][0].key,
      "phantom.worktreesDirectory",
    );
    strictEqual(configSetMock.mock.calls[0][0].value, "../phantom/worktrees");
    strictEqual(
      consoleLogMock.mock.calls[0][0],
      "Set phantom.worktreesDirectory (global) to '../phantom/worktrees'",
    );
    strictEqual(exitMock.mock.calls[0][0], 0);
  });

  it("sets directoryNameSeparator preference via git config --global", async () => {
    resetMocks();
    configSetMock.mockImplementation(async () => undefined);

    await rejects(
      async () => await preferencesSetHandler(["directoryNameSeparator", "-"]),
      /Process exit with code 0/,
    );

    strictEqual(
      configSetMock.mock.calls[0][0].key,
      "phantom.directoryNameSeparator",
    );
    strictEqual(configSetMock.mock.calls[0][0].value, "-");
    strictEqual(
      consoleLogMock.mock.calls[0][0],
      "Set phantom.directoryNameSeparator (global) to '-'",
    );
    strictEqual(exitMock.mock.calls[0][0], 0);
  });
});
