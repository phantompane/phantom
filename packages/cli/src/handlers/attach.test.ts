import { deepStrictEqual, rejects } from "node:assert";
import { describe, it, vi } from "vitest";
import {
  BranchNotFoundError,
  WorktreeAlreadyExistsError,
} from "@phantompane/core";
import { err, ok } from "@phantompane/shared";

const exitWithErrorMock = vi.fn((message, code) => {
  throw new Error(`Exit with code ${code}: ${message}`);
});
const outputLogMock = vi.fn();
const outputErrorMock = vi.fn();
const getGitRootMock = vi.fn();
const attachWorktreeCoreMock = vi.fn();
const shellInWorktreeMock = vi.fn();
const execInWorktreeMock = vi.fn();
const createContextMock = vi.fn();
const isInsideTmuxMock = vi.fn();
const executeTmuxCommandMock = vi.fn();
const getPhantomEnvMock = vi.fn();

vi.doMock("../errors.ts", () => ({
  exitWithError: exitWithErrorMock,
  exitCodes: {
    validationError: 3,
    notFound: 2,
    generalError: 1,
    success: 0,
  },
}));

vi.doMock("../output.ts", () => ({
  output: { log: outputLogMock, error: outputErrorMock },
}));

vi.doMock("@phantompane/git", () => ({
  getGitRoot: getGitRootMock,
}));

vi.doMock("@phantompane/core", () => ({
  attachWorktreeCore: attachWorktreeCoreMock,
  BranchNotFoundError,
  WorktreeAlreadyExistsError,
  shellInWorktree: shellInWorktreeMock,
  execInWorktree: execInWorktreeMock,
  createContext: createContextMock,
  getWorktreesDirectory: vi.fn((gitRoot, worktreesDirectory) => {
    return worktreesDirectory || `${gitRoot}/.git/phantom/worktrees`;
  }),
}));

vi.doMock("@phantompane/process", () => ({
  executeTmuxCommand: executeTmuxCommandMock,
  getPhantomEnv: getPhantomEnvMock,
  isInsideTmux: isInsideTmuxMock,
}));

const { attachHandler } = await import("./attach.ts");

describe("attachHandler", () => {
  it("should attach to existing branch successfully", async () => {
    exitWithErrorMock.mockClear();
    outputLogMock.mockClear();
    createContextMock.mockClear();
    attachWorktreeCoreMock.mockClear();

    getGitRootMock.mockImplementation(() => Promise.resolve("/repo"));
    createContextMock.mockImplementation((gitRoot) =>
      Promise.resolve({
        gitRoot,
        worktreesDirectory: `${gitRoot}/.git/phantom/worktrees`,
        config: null,
      }),
    );
    attachWorktreeCoreMock.mockImplementation(() =>
      Promise.resolve(ok("/repo/.git/phantom/worktrees/feature")),
    );

    await attachHandler(["feature"]);

    deepStrictEqual(exitWithErrorMock.mock.calls.length, 0);
    deepStrictEqual(
      outputLogMock.mock.calls[0][0],
      "Attached phantom: feature",
    );
    deepStrictEqual(attachWorktreeCoreMock.mock.calls[0], [
      "/repo",
      "/repo/.git/phantom/worktrees",
      "feature",
      undefined, // postCreateCopyFiles
      undefined, // postCreateCommands
      undefined, // directoryNameSeparator
    ]);
  });

  it("should exit with error when no branch name provided", async () => {
    exitWithErrorMock.mockClear();
    createContextMock.mockClear();

    await rejects(async () => await attachHandler([]), /Exit with code 3/);

    deepStrictEqual(exitWithErrorMock.mock.calls[0], [
      "Missing required argument: branch name",
      3,
    ]);
    deepStrictEqual(createContextMock.mock.calls.length, 0);
  });

  it("should exit with error when both --shell and --exec are provided", async () => {
    exitWithErrorMock.mockClear();
    getGitRootMock.mockClear();
    attachWorktreeCoreMock.mockClear();
    createContextMock.mockClear();

    await rejects(
      async () => await attachHandler(["feature", "--shell", "--exec", "ls"]),
      /Exit with code 3/,
    );

    deepStrictEqual(exitWithErrorMock.mock.calls[0], [
      "Cannot use --shell, --exec, and --tmux options together",
      3,
    ]);
    deepStrictEqual(getGitRootMock.mock.calls.length, 0);
    deepStrictEqual(attachWorktreeCoreMock.mock.calls.length, 0);
    deepStrictEqual(createContextMock.mock.calls.length, 0);
  });

  it("should handle BranchNotFoundError", async () => {
    exitWithErrorMock.mockClear();
    createContextMock.mockClear();
    getGitRootMock.mockImplementation(() => Promise.resolve("/repo"));
    createContextMock.mockImplementation((gitRoot) =>
      Promise.resolve({
        gitRoot,
        worktreesDirectory: `${gitRoot}/.git/phantom/worktrees`,
        config: null,
      }),
    );
    attachWorktreeCoreMock.mockImplementation(() =>
      Promise.resolve(err(new BranchNotFoundError("nonexistent"))),
    );

    await rejects(
      async () => await attachHandler(["nonexistent"]),
      /Exit with code 2/,
    );

    deepStrictEqual(exitWithErrorMock.mock.calls[0], [
      "Branch 'nonexistent' not found",
      2,
    ]);
  });

  it("should spawn shell when --shell flag is provided", async () => {
    exitWithErrorMock.mockClear();
    outputLogMock.mockClear();
    createContextMock.mockClear();
    shellInWorktreeMock.mockClear();
    shellInWorktreeMock.mockImplementation(() =>
      Promise.resolve(ok({ exitCode: 0 })),
    );
    getGitRootMock.mockImplementation(() => Promise.resolve("/repo"));
    createContextMock.mockImplementation((gitRoot) =>
      Promise.resolve({
        gitRoot,
        worktreesDirectory: `${gitRoot}/.git/phantom/worktrees`,
        config: null,
      }),
    );
    attachWorktreeCoreMock.mockImplementation(() =>
      Promise.resolve(ok("/repo/.git/phantom/worktrees/feature")),
    );

    await attachHandler(["feature", "--shell"]);

    deepStrictEqual(shellInWorktreeMock.mock.calls[0], [
      "/repo",
      "/repo/.git/phantom/worktrees",
      "feature",
    ]);
  });

  it("should execute command when --exec flag is provided", async () => {
    exitWithErrorMock.mockClear();
    outputLogMock.mockClear();
    createContextMock.mockClear();
    execInWorktreeMock.mockClear();
    execInWorktreeMock.mockImplementation(() =>
      Promise.resolve(ok({ exitCode: 0 })),
    );
    getGitRootMock.mockImplementation(() => Promise.resolve("/repo"));
    createContextMock.mockImplementation((gitRoot) =>
      Promise.resolve({
        gitRoot,
        worktreesDirectory: `${gitRoot}/.git/phantom/worktrees`,
        config: null,
      }),
    );
    attachWorktreeCoreMock.mockImplementation(() =>
      Promise.resolve(ok("/repo/.git/phantom/worktrees/feature")),
    );

    process.env.SHELL = "/bin/bash";
    await attachHandler(["feature", "--exec", "echo hello"]);

    deepStrictEqual(execInWorktreeMock.mock.calls[0][0], "/repo");
    deepStrictEqual(
      execInWorktreeMock.mock.calls[0][1],
      "/repo/.git/phantom/worktrees",
    );
    deepStrictEqual(execInWorktreeMock.mock.calls[0][2], "feature");
    const execArgs = execInWorktreeMock.mock.calls[0][3];
    deepStrictEqual(execArgs[0], "/bin/bash");
    deepStrictEqual(execArgs[1], "-c");
    deepStrictEqual(execArgs[2], "echo hello");
  });

  it("should error when tmux option is used outside a tmux session", async () => {
    exitWithErrorMock.mockClear();
    outputLogMock.mockClear();
    createContextMock.mockClear();
    attachWorktreeCoreMock.mockClear();
    isInsideTmuxMock.mockClear();

    getGitRootMock.mockImplementation(() => Promise.resolve("/repo"));
    createContextMock.mockImplementation((gitRoot) =>
      Promise.resolve({
        gitRoot,
        worktreesDirectory: `${gitRoot}/.git/phantom/worktrees`,
        config: null,
      }),
    );
    isInsideTmuxMock.mockImplementation(() => Promise.resolve(false));

    await rejects(
      async () => await attachHandler(["feature", "--tmux"]),
      /Exit with code 3/,
    );

    deepStrictEqual(exitWithErrorMock.mock.calls[0], [
      "The --tmux option can only be used inside a tmux session",
      3,
    ]);
    deepStrictEqual(attachWorktreeCoreMock.mock.calls.length, 0);
  });

  it("should attach and open worktree in a tmux window", async () => {
    exitWithErrorMock.mockClear();
    outputLogMock.mockClear();
    createContextMock.mockClear();
    attachWorktreeCoreMock.mockClear();
    executeTmuxCommandMock.mockClear();
    isInsideTmuxMock.mockClear();
    getPhantomEnvMock.mockClear();

    process.env.SHELL = "/bin/bash";
    getGitRootMock.mockImplementation(() => Promise.resolve("/repo"));
    createContextMock.mockImplementation((gitRoot) =>
      Promise.resolve({
        gitRoot,
        worktreesDirectory: `${gitRoot}/.git/phantom/worktrees`,
        config: null,
      }),
    );
    attachWorktreeCoreMock.mockImplementation(() =>
      Promise.resolve(ok("/repo/.git/phantom/worktrees/feature")),
    );
    isInsideTmuxMock.mockImplementation(() => Promise.resolve(true));
    getPhantomEnvMock.mockImplementation((name, path) => ({
      PHANTOM_NAME: name,
      PHANTOM_PATH: path,
    }));
    executeTmuxCommandMock.mockImplementation(() =>
      Promise.resolve(ok({ exitCode: 0 })),
    );

    await attachHandler(["feature", "--tmux"]);

    deepStrictEqual(executeTmuxCommandMock.mock.calls.length, 1);
    const tmuxCall = executeTmuxCommandMock.mock.calls[0][0];
    deepStrictEqual(tmuxCall.direction, "new");
    deepStrictEqual(tmuxCall.command, "/bin/bash");
    deepStrictEqual(tmuxCall.cwd, "/repo/.git/phantom/worktrees/feature");
    deepStrictEqual(tmuxCall.windowName, "feature");
    deepStrictEqual(tmuxCall.env.PHANTOM_NAME, "feature");
    deepStrictEqual(
      tmuxCall.env.PHANTOM_PATH,
      "/repo/.git/phantom/worktrees/feature",
    );
  });

  it("should pass postCreate config to attachWorktreeCore", async () => {
    exitWithErrorMock.mockClear();
    outputLogMock.mockClear();
    outputErrorMock.mockClear();
    createContextMock.mockClear();
    attachWorktreeCoreMock.mockClear();

    getGitRootMock.mockImplementation(() => Promise.resolve("/repo"));
    createContextMock.mockImplementation((gitRoot) =>
      Promise.resolve({
        gitRoot,
        worktreesDirectory: `${gitRoot}/.git/phantom/worktrees`,
        config: {
          postCreate: {
            copyFiles: [".env", "config.json"],
            commands: ["npm install", "npm run build"],
          },
        },
      }),
    );
    attachWorktreeCoreMock.mockImplementation(() =>
      Promise.resolve(ok("/repo/.git/phantom/worktrees/feature")),
    );

    await attachHandler(["feature"]);

    // Verify that attachWorktreeCore was called with extracted postCreate values
    deepStrictEqual(attachWorktreeCoreMock.mock.calls.length, 1);
    const [
      gitRoot,
      worktreeDirectory,
      name,
      postCreateCopyFiles,
      postCreateCommands,
    ] = attachWorktreeCoreMock.mock.calls[0];
    deepStrictEqual(gitRoot, "/repo");
    deepStrictEqual(worktreeDirectory, "/repo/.git/phantom/worktrees");
    deepStrictEqual(name, "feature");
    deepStrictEqual(postCreateCopyFiles, [".env", "config.json"]);
    deepStrictEqual(postCreateCommands, ["npm install", "npm run build"]);
  });

  it("should merge copy-file options with config values", async () => {
    exitWithErrorMock.mockClear();
    outputLogMock.mockClear();
    outputErrorMock.mockClear();
    createContextMock.mockClear();
    attachWorktreeCoreMock.mockClear();

    getGitRootMock.mockImplementation(() => Promise.resolve("/repo"));
    createContextMock.mockImplementation((gitRoot) =>
      Promise.resolve({
        gitRoot,
        worktreesDirectory: `${gitRoot}/.git/phantom/worktrees`,
        config: {
          postCreate: {
            copyFiles: [".env"],
            commands: ["echo test"],
          },
        },
      }),
    );
    attachWorktreeCoreMock.mockImplementation(() =>
      Promise.resolve(ok("/repo/.git/phantom/worktrees/feature")),
    );

    await attachHandler([
      "feature",
      "--copy-file",
      ".env",
      "--copy-file",
      "config.json",
    ]);

    deepStrictEqual(attachWorktreeCoreMock.mock.calls.length, 1);
    const [, , , postCreateCopyFiles, postCreateCommands] =
      attachWorktreeCoreMock.mock.calls[0];
    deepStrictEqual(postCreateCopyFiles, [".env", "config.json"]);
    deepStrictEqual(postCreateCommands, ["echo test"]);
  });

  it("should handle config not found gracefully", async () => {
    exitWithErrorMock.mockClear();
    outputLogMock.mockClear();
    outputErrorMock.mockClear();
    createContextMock.mockClear();
    attachWorktreeCoreMock.mockClear();

    getGitRootMock.mockImplementation(() => Promise.resolve("/repo"));
    createContextMock.mockImplementation((gitRoot) =>
      Promise.resolve({
        gitRoot,
        worktreesDirectory: `${gitRoot}/.git/phantom/worktrees`,
        config: null,
      }),
    );
    attachWorktreeCoreMock.mockImplementation(() =>
      Promise.resolve(ok("/repo/.git/phantom/worktrees/feature")),
    );

    await attachHandler(["feature"]);

    // Verify that attachWorktreeCore was called with undefined postCreate parameters
    deepStrictEqual(attachWorktreeCoreMock.mock.calls.length, 1);
    const [, , , postCreateCopyFiles, postCreateCommands] =
      attachWorktreeCoreMock.mock.calls[0];
    deepStrictEqual(postCreateCopyFiles, undefined);
    deepStrictEqual(postCreateCommands, undefined);
    deepStrictEqual(outputErrorMock.mock.calls.length, 0);
  });

  it("should forward copy-file options when config is missing", async () => {
    exitWithErrorMock.mockClear();
    outputLogMock.mockClear();
    outputErrorMock.mockClear();
    createContextMock.mockClear();
    attachWorktreeCoreMock.mockClear();

    getGitRootMock.mockImplementation(() => Promise.resolve("/repo"));
    createContextMock.mockImplementation((gitRoot) =>
      Promise.resolve({
        gitRoot,
        worktreesDirectory: `${gitRoot}/.git/phantom/worktrees`,
        config: null,
      }),
    );
    attachWorktreeCoreMock.mockImplementation(() =>
      Promise.resolve(ok("/repo/.git/phantom/worktrees/feature")),
    );

    await attachHandler(["feature", "--copy-file", "README.md"]);

    deepStrictEqual(attachWorktreeCoreMock.mock.calls.length, 1);
    const [, , , postCreateCopyFiles, postCreateCommands] =
      attachWorktreeCoreMock.mock.calls[0];
    deepStrictEqual(postCreateCopyFiles, ["README.md"]);
    deepStrictEqual(postCreateCommands, undefined);
  });

  it("should pass config with postCreate to attachWorktreeCore", async () => {
    exitWithErrorMock.mockClear();
    outputLogMock.mockClear();
    outputErrorMock.mockClear();
    createContextMock.mockClear();
    attachWorktreeCoreMock.mockClear();

    getGitRootMock.mockImplementation(() => Promise.resolve("/repo"));
    createContextMock.mockImplementation((gitRoot) =>
      Promise.resolve({
        gitRoot,
        worktreesDirectory: `${gitRoot}/.git/phantom/worktrees`,
        config: {
          postCreate: {
            copyFiles: [".env"],
            commands: ["echo test"],
          },
        },
      }),
    );
    attachWorktreeCoreMock.mockImplementation(() =>
      Promise.resolve(ok("/repo/.git/phantom/worktrees/feature")),
    );

    await attachHandler(["feature"]);

    // Verify that attachWorktreeCore was called with the extracted postCreate values
    deepStrictEqual(attachWorktreeCoreMock.mock.calls.length, 1);
    const [, , , postCreateCopyFiles, postCreateCommands] =
      attachWorktreeCoreMock.mock.calls[0];
    deepStrictEqual(postCreateCopyFiles, [".env"]);
    deepStrictEqual(postCreateCommands, ["echo test"]);
  });

  it("should exit with error if attachWorktreeCore fails due to postCreate", async () => {
    exitWithErrorMock.mockClear();
    outputLogMock.mockClear();
    createContextMock.mockClear();
    attachWorktreeCoreMock.mockClear();

    getGitRootMock.mockImplementation(() => Promise.resolve("/repo"));
    createContextMock.mockImplementation((gitRoot) =>
      Promise.resolve({
        gitRoot,
        worktreesDirectory: `${gitRoot}/.git/phantom/worktrees`,
        config: {
          postCreate: {
            commands: ["invalid-command"],
          },
        },
      }),
    );
    // attachWorktreeCore now handles postCreate internally and returns error
    attachWorktreeCoreMock.mockImplementation(() =>
      Promise.resolve(err(new Error("Command failed: invalid-command"))),
    );

    await rejects(
      async () => await attachHandler(["feature"]),
      /Exit with code 1/,
    );

    deepStrictEqual(exitWithErrorMock.mock.calls[0], [
      "Command failed: invalid-command",
      1,
    ]);

    // Verify that attachWorktreeCore was called with extracted postCreate values
    deepStrictEqual(attachWorktreeCoreMock.mock.calls.length, 1);
    const [, , , postCreateCopyFiles, postCreateCommands] =
      attachWorktreeCoreMock.mock.calls[0];
    deepStrictEqual(postCreateCopyFiles, undefined);
    deepStrictEqual(postCreateCommands, ["invalid-command"]);
  });
});
