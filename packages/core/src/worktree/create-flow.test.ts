import { deepStrictEqual, strictEqual } from "node:assert";
import { afterAll, describe, it, vi } from "vitest";
import { ok } from "@phantompane/shared";

const accessMock = vi.fn();
const mkdirMock = vi.fn();
const validateWorktreeDoesNotExistMock = vi.fn();
const validateWorktreeNameMock = vi.fn();
const addWorktreeMock = vi.fn();
const getGitRootMock = vi.fn();
const createContextMock = vi.fn();
const generateUniqueNameMock = vi.fn();
const getWorktreePathFromDirectoryMock = vi.fn(
  (worktreeDirectory: string, name: string, separator = "/") =>
    `${worktreeDirectory}/${name.replaceAll("/", separator)}`,
);
const copyFilesMock = vi.fn();
const executePostCreateCommandsMock = vi.fn();
const isInsideTmuxMock = vi.fn();
const executeTmuxCommandMock = vi.fn();
const getPhantomEnvMock = vi.fn();

const originalProcessEnv = process.env;
const processEnvMock: NodeJS.ProcessEnv = {};
process.env = processEnvMock;

afterAll(() => {
  process.env = originalProcessEnv;
});

vi.doMock("node:fs/promises", () => {
  const mockedFs = {
    access: accessMock,
    mkdir: mkdirMock,
  };

  return {
    ...mockedFs,
    default: mockedFs,
  };
});

vi.doMock("@phantompane/git", () => ({
  addWorktree: addWorktreeMock,
  getGitRoot: getGitRootMock,
}));

vi.doMock("../context.ts", () => ({
  createContext: createContextMock,
}));

vi.doMock("./generate-name.ts", () => ({
  generateUniqueName: generateUniqueNameMock,
}));

vi.doMock("./validate.ts", () => ({
  validateWorktreeDoesNotExist: validateWorktreeDoesNotExistMock,
  validateWorktreeName: validateWorktreeNameMock,
}));

vi.doMock("../paths.ts", () => ({
  getWorktreePathFromDirectory: getWorktreePathFromDirectoryMock,
}));

vi.doMock("./file-copier.ts", () => ({
  copyFiles: copyFilesMock,
}));

vi.doMock("./post-create.ts", () => ({
  executePostCreateCommands: executePostCreateCommandsMock,
}));

vi.doMock("@phantompane/process", () => ({
  getPhantomEnv: getPhantomEnvMock,
}));

vi.doMock("@phantompane/tmux", () => ({
  executeTmuxCommand: executeTmuxCommandMock,
  isInsideTmux: isInsideTmuxMock,
}));

const { runCreateWorktree } = await import("./create.ts");

describe("runCreateWorktree", () => {
  const resetMocks = () => {
    accessMock.mockReset();
    mkdirMock.mockReset();
    validateWorktreeDoesNotExistMock.mockReset();
    validateWorktreeNameMock.mockReset();
    addWorktreeMock.mockReset();
    getGitRootMock.mockReset();
    createContextMock.mockReset();
    generateUniqueNameMock.mockReset();
    getWorktreePathFromDirectoryMock.mockClear();
    copyFilesMock.mockReset();
    executePostCreateCommandsMock.mockReset();
    isInsideTmuxMock.mockReset();
    executeTmuxCommandMock.mockReset();
    getPhantomEnvMock.mockReset();

    for (const key of Object.keys(processEnvMock)) {
      delete processEnvMock[key];
    }
  };

  it("merges configured copy files with CLI copy files and auto-generates the name", async () => {
    resetMocks();
    accessMock.mockResolvedValue(undefined);
    validateWorktreeNameMock.mockReturnValue(ok(undefined));
    validateWorktreeDoesNotExistMock.mockResolvedValue(ok(undefined));
    addWorktreeMock.mockResolvedValue(undefined);
    getGitRootMock.mockResolvedValue("/repo");
    createContextMock.mockResolvedValue({
      gitRoot: "/repo",
      worktreesDirectory: "/repo/.git/phantom/worktrees",
      directoryNameSeparator: "-",
      config: {
        postCreate: {
          copyFiles: [".env"],
          commands: ["npm install"],
        },
      },
      preferences: {},
    });
    generateUniqueNameMock.mockResolvedValue(ok("fuzzy-cats-dance"));
    copyFilesMock.mockResolvedValue(
      ok({
        copiedFiles: [".env", "config.json"],
        skippedFiles: [],
      }),
    );
    executePostCreateCommandsMock.mockResolvedValue(
      ok({ executedCommands: ["npm install"] }),
    );
    const logger = {
      log: vi.fn(),
      warn: vi.fn(),
    };

    const result = await runCreateWorktree({
      copyFiles: ["config.json"],
      logger,
    });

    strictEqual(result.ok, true);
    if (result.ok) {
      strictEqual(result.value.name, "fuzzy-cats-dance");
      strictEqual(
        result.value.path,
        "/repo/.git/phantom/worktrees/fuzzy-cats-dance",
      );
    }

    deepStrictEqual(generateUniqueNameMock.mock.calls[0], [
      "/repo",
      "/repo/.git/phantom/worktrees",
      "-",
    ]);
    deepStrictEqual(copyFilesMock.mock.calls[0], [
      "/repo",
      "/repo/.git/phantom/worktrees/fuzzy-cats-dance",
      [".env", "config.json"],
    ]);
    strictEqual(
      logger.log.mock.calls[1][0],
      "Created worktree 'fuzzy-cats-dance' at /repo/.git/phantom/worktrees/fuzzy-cats-dance",
    );
  });

  it("returns a validation error when multiple open actions are requested", async () => {
    resetMocks();

    const result = await runCreateWorktree({
      name: "feature",
      action: {
        shell: true,
        exec: "echo hello",
      },
    });

    strictEqual(result.ok, false);
    if (!result.ok) {
      strictEqual(
        result.error.message,
        "Cannot use --shell, --exec, and --tmux options together",
      );
    }
    strictEqual(getGitRootMock.mock.calls.length, 0);
  });

  it("opens the created worktree in tmux from core", async () => {
    resetMocks();
    processEnvMock.SHELL = "/bin/bash";
    accessMock.mockResolvedValue(undefined);
    validateWorktreeNameMock.mockReturnValue(ok(undefined));
    validateWorktreeDoesNotExistMock.mockResolvedValue(ok(undefined));
    addWorktreeMock.mockResolvedValue(undefined);
    getGitRootMock.mockResolvedValue("/repo");
    createContextMock.mockResolvedValue({
      gitRoot: "/repo",
      worktreesDirectory: "/repo/.git/phantom/worktrees",
      directoryNameSeparator: "/",
      config: null,
      preferences: {},
    });
    copyFilesMock.mockResolvedValue(
      ok({
        copiedFiles: [],
        skippedFiles: [],
      }),
    );
    isInsideTmuxMock.mockResolvedValue(true);
    executeTmuxCommandMock.mockResolvedValue(ok({ exitCode: 0 }));
    getPhantomEnvMock.mockReturnValue({
      PHANTOM_NAME: "feature",
      PHANTOM_PATH: "/repo/.git/phantom/worktrees/feature",
    });
    const logger = {
      log: vi.fn(),
      warn: vi.fn(),
    };

    const result = await runCreateWorktree({
      name: "feature",
      action: {
        tmuxDirection: "new",
      },
      logger,
    });

    strictEqual(result.ok, true);
    deepStrictEqual(executeTmuxCommandMock.mock.calls[0][0], {
      direction: "new",
      command: "/bin/bash",
      cwd: "/repo/.git/phantom/worktrees/feature",
      env: {
        PHANTOM_NAME: "feature",
        PHANTOM_PATH: "/repo/.git/phantom/worktrees/feature",
      },
      windowName: "feature",
    });
    strictEqual(
      logger.log.mock.calls[1][0],
      "\nOpening worktree 'feature' in tmux window...",
    );
  });
});
