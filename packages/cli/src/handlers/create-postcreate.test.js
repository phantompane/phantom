import { deepStrictEqual, rejects } from "node:assert";
import { describe, it, mock } from "node:test";
import { ConfigNotFoundError } from "@phantompane/core";
import { err, ok } from "@phantompane/shared";

const exitWithErrorMock = mock.fn((message, code) => {
  throw new Error(`Exit with code ${code}: ${message}`);
});
const outputLogMock = mock.fn();
const outputErrorMock = mock.fn();
const getGitRootMock = mock.fn();
const createWorktreeMock = mock.fn();
const createContextMock = mock.fn();

mock.module("../errors.ts", {
  namedExports: {
    exitWithError: exitWithErrorMock,
    exitWithSuccess: mock.fn(() => {
      throw new Error("Exit with success");
    }),
    exitCodes: {
      validationError: 3,
      generalError: 1,
      success: 0,
    },
  },
});

mock.module("../output.ts", {
  namedExports: {
    output: { log: outputLogMock, error: outputErrorMock },
  },
});

mock.module("@phantompane/git", {
  namedExports: {
    getGitRoot: getGitRootMock,
  },
});

mock.module("@phantompane/core", {
  namedExports: {
    ConfigNotFoundError,
    ConfigParseError: class ConfigParseError extends Error {},
    ConfigValidationError: class ConfigValidationError extends Error {},
    WorktreeAlreadyExistsError: class WorktreeAlreadyExistsError extends Error {},
    createWorktree: createWorktreeMock,
    createContext: createContextMock,
    execInWorktree: mock.fn(),
    shellInWorktree: mock.fn(),
    generateUniqueName: mock.fn(() =>
      Promise.resolve({ ok: true, value: "fuzzy-cats-dance" }),
    ),
  },
});

mock.module("@phantompane/process", {
  namedExports: {
    isInsideTmux: mock.fn(() => false),
    executeTmuxCommand: mock.fn(),
    getPhantomEnv: mock.fn(() => ({})),
  },
});

const { createHandler } = await import("./create.ts");

describe("createHandler postCreate", () => {
  it("should pass config to createWorktree for postCreate execution", async () => {
    exitWithErrorMock.mock.resetCalls();
    outputLogMock.mock.resetCalls();
    outputErrorMock.mock.resetCalls();
    getGitRootMock.mock.resetCalls();
    createWorktreeMock.mock.resetCalls();
    createContextMock.mock.resetCalls();

    getGitRootMock.mock.mockImplementation(() => Promise.resolve("/repo"));
    createContextMock.mock.mockImplementation((gitRoot) =>
      Promise.resolve({
        gitRoot,
        worktreesDirectory: `${gitRoot}/.git/phantom/worktrees`,
        config: {
          postCreate: {
            commands: ["npm install", "npm test"],
          },
        },
      }),
    );
    createWorktreeMock.mock.mockImplementation(() =>
      Promise.resolve(
        ok({
          message:
            "Created worktree 'feature' at /repo/.git/phantom/worktrees/feature",
          path: "/repo/.git/phantom/worktrees/feature",
        }),
      ),
    );

    await rejects(
      async () => await createHandler(["feature"]),
      /Exit with success/,
    );

    // Verify that createWorktree was called with extracted postCreate values
    deepStrictEqual(createWorktreeMock.mock.calls.length, 1);
    const [
      gitRoot,
      worktreeDirectory,
      name,
      ,
      postCreateCopyFiles,
      postCreateCommands,
    ] = createWorktreeMock.mock.calls[0].arguments;
    deepStrictEqual(gitRoot, "/repo");
    deepStrictEqual(worktreeDirectory, "/repo/.git/phantom/worktrees");
    deepStrictEqual(name, "feature");
    deepStrictEqual(postCreateCopyFiles, undefined);
    deepStrictEqual(postCreateCommands, ["npm install", "npm test"]);
  });

  it("should exit with error if createWorktree fails due to postCreate", async () => {
    exitWithErrorMock.mock.resetCalls();
    getGitRootMock.mock.resetCalls();
    createWorktreeMock.mock.resetCalls();
    createContextMock.mock.resetCalls();

    getGitRootMock.mock.mockImplementation(() => Promise.resolve("/repo"));
    createContextMock.mock.mockImplementation((gitRoot) =>
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
    // createWorktree now handles postCreate internally and returns error
    createWorktreeMock.mock.mockImplementation(() =>
      Promise.resolve(
        err(
          new Error(
            "Post-create command failed with exit code 127: invalid-command",
          ),
        ),
      ),
    );

    await rejects(
      async () => await createHandler(["feature"]),
      /Exit with code 1/,
    );

    deepStrictEqual(exitWithErrorMock.mock.calls[0].arguments, [
      "Post-create command failed with exit code 127: invalid-command",
      1,
    ]);
  });

  it("should pass config with only copyFiles to createWorktree", async () => {
    exitWithErrorMock.mock.resetCalls();
    outputLogMock.mock.resetCalls();
    getGitRootMock.mock.resetCalls();
    createWorktreeMock.mock.resetCalls();
    createContextMock.mock.resetCalls();

    getGitRootMock.mock.mockImplementation(() => Promise.resolve("/repo"));
    createContextMock.mock.mockImplementation((gitRoot) =>
      Promise.resolve({
        gitRoot,
        worktreesDirectory: `${gitRoot}/.git/phantom/worktrees`,
        config: {
          postCreate: {
            copyFiles: [".env"],
          },
        },
      }),
    );
    createWorktreeMock.mock.mockImplementation(() =>
      Promise.resolve(
        ok({
          message: "Created worktree 'feature'",
          path: "/repo/.git/phantom/worktrees/feature",
        }),
      ),
    );

    await rejects(
      async () => await createHandler(["feature"]),
      /Exit with success/,
    );

    // Verify that createWorktree was called with correct config
    deepStrictEqual(createWorktreeMock.mock.calls.length, 1);
    const [, , , , postCreateCopyFiles, postCreateCommands] =
      createWorktreeMock.mock.calls[0].arguments;
    deepStrictEqual(postCreateCopyFiles, [".env"]);
    deepStrictEqual(postCreateCommands, undefined);
  });
});
