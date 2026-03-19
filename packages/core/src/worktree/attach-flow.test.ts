import { deepStrictEqual, strictEqual } from "node:assert";
import { afterAll, describe, it, vi } from "vitest";
import { ok } from "@phantompane/shared";

const existsSyncMock = vi.fn();
const branchExistsMock = vi.fn();
const addWorktreeMock = vi.fn();
const getGitRootMock = vi.fn();
const createContextMock = vi.fn();
const getWorktreePathFromDirectoryMock = vi.fn(
  (worktreeDirectory: string, name: string, separator = "/") =>
    `${worktreeDirectory}/${name.replaceAll("/", separator)}`,
);
const validateWorktreeNameMock = vi.fn();
const copyFilesToWorktreeMock = vi.fn();
const executePostCreateCommandsMock = vi.fn();
const execInWorktreeMock = vi.fn();

const originalProcessEnv = process.env;
const processEnvMock: NodeJS.ProcessEnv = {};
process.env = processEnvMock;

afterAll(() => {
  process.env = originalProcessEnv;
});

vi.doMock("node:fs", () => ({
  existsSync: existsSyncMock,
}));

vi.doMock("@phantompane/git", () => ({
  addWorktree: addWorktreeMock,
  branchExists: branchExistsMock,
  getGitRoot: getGitRootMock,
}));

vi.doMock("../context.ts", () => ({
  createContext: createContextMock,
}));

vi.doMock("../paths.ts", () => ({
  getWorktreePathFromDirectory: getWorktreePathFromDirectoryMock,
}));

vi.doMock("./validate.ts", () => ({
  validateWorktreeName: validateWorktreeNameMock,
}));

vi.doMock("./post-create.ts", () => ({
  copyFilesToWorktree: copyFilesToWorktreeMock,
  executePostCreateCommands: executePostCreateCommandsMock,
}));

vi.doMock("../exec.ts", () => ({
  execInWorktree: execInWorktreeMock,
}));

vi.doMock("../shell.ts", () => ({
  shellInWorktree: vi.fn(),
}));

vi.doMock("@phantompane/process", () => ({
  executeTmuxCommand: vi.fn(),
  getPhantomEnv: vi.fn(),
  isInsideTmux: vi.fn(() => Promise.resolve(true)),
}));

const { runAttachWorktree } = await import("./attach.ts");

describe("runAttachWorktree", () => {
  const resetMocks = () => {
    existsSyncMock.mockReset();
    branchExistsMock.mockReset();
    addWorktreeMock.mockReset();
    getGitRootMock.mockReset();
    createContextMock.mockReset();
    getWorktreePathFromDirectoryMock.mockClear();
    validateWorktreeNameMock.mockReset();
    copyFilesToWorktreeMock.mockReset();
    executePostCreateCommandsMock.mockReset();
    execInWorktreeMock.mockReset();

    for (const key of Object.keys(processEnvMock)) {
      delete processEnvMock[key];
    }
  };

  it("merges configured copy files and logs from core", async () => {
    resetMocks();
    existsSyncMock.mockReturnValue(false);
    validateWorktreeNameMock.mockReturnValue(ok(undefined));
    branchExistsMock.mockResolvedValue(ok(true));
    addWorktreeMock.mockResolvedValue(undefined);
    getGitRootMock.mockResolvedValue("/repo");
    createContextMock.mockResolvedValue({
      gitRoot: "/repo",
      worktreesDirectory: "/repo/.git/phantom/worktrees",
      directoryNameSeparator: "/",
      config: {
        postCreate: {
          copyFiles: [".env"],
          commands: ["npm install"],
        },
      },
      preferences: {},
    });
    copyFilesToWorktreeMock.mockResolvedValue(ok(undefined));
    executePostCreateCommandsMock.mockResolvedValue(
      ok({ executedCommands: ["npm install"] }),
    );
    const logger = {
      log: vi.fn(),
      warn: vi.fn(),
    };

    const result = await runAttachWorktree({
      name: "feature",
      copyFiles: ["config.json"],
      logger,
    });

    strictEqual(result.ok, true);
    deepStrictEqual(copyFilesToWorktreeMock.mock.calls[0], [
      "/repo",
      "/repo/.git/phantom/worktrees",
      "feature",
      [".env", "config.json"],
      "/",
    ]);
    strictEqual(logger.log.mock.calls[0][0], "Attached phantom: feature");
  });

  it("executes --exec actions from core", async () => {
    resetMocks();
    processEnvMock.SHELL = "/bin/bash";
    existsSyncMock.mockReturnValue(false);
    validateWorktreeNameMock.mockReturnValue(ok(undefined));
    branchExistsMock.mockResolvedValue(ok(true));
    addWorktreeMock.mockResolvedValue(undefined);
    getGitRootMock.mockResolvedValue("/repo");
    createContextMock.mockResolvedValue({
      gitRoot: "/repo",
      worktreesDirectory: "/repo/.git/phantom/worktrees",
      directoryNameSeparator: "/",
      config: null,
      preferences: {},
    });
    execInWorktreeMock.mockResolvedValue(ok({ exitCode: 0 }));
    const logger = {
      log: vi.fn(),
      warn: vi.fn(),
    };

    const result = await runAttachWorktree({
      name: "feature",
      action: {
        exec: "echo hello",
      },
      logger,
    });

    strictEqual(result.ok, true);
    deepStrictEqual(execInWorktreeMock.mock.calls[0], [
      "/repo",
      "/repo/.git/phantom/worktrees",
      "feature",
      ["/bin/bash", "-c", "echo hello"],
      { interactive: true },
    ]);
    strictEqual(
      logger.log.mock.calls[1][0],
      "\nExecuting command in worktree 'feature': echo hello",
    );
  });
});
