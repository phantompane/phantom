import { deepStrictEqual, rejects } from "node:assert";
import { describe, it, vi } from "vitest";
import { ConfigNotFoundError } from "@phantompane/core";
import { err, ok } from "@phantompane/shared";

const exitWithErrorMock = vi.fn((message, code) => {
  throw new Error(`Exit with code ${code}: ${message}`);
});
const outputLogMock = vi.fn();
const outputErrorMock = vi.fn();
const getGitRootMock = vi.fn();
const createWorktreeMock = vi.fn();
const createContextMock = vi.fn();

vi.doMock("../errors.ts", () => ({
  exitWithError: exitWithErrorMock,
  exitWithSuccess: vi.fn(() => {
    throw new Error("Exit with success");
  }),
  exitCodes: {
    validationError: 3,
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
  ConfigNotFoundError,
  ConfigParseError: class ConfigParseError extends Error {},
  ConfigValidationError: class ConfigValidationError extends Error {},
  WorktreeAlreadyExistsError: class WorktreeAlreadyExistsError extends Error {},
  createWorktree: createWorktreeMock,
  createContext: createContextMock,
  execInWorktree: vi.fn(),
  shellInWorktree: vi.fn(),
  generateUniqueName: vi.fn(() =>
    Promise.resolve({ ok: true, value: "fuzzy-cats-dance" }),
  ),
}));

vi.doMock("@phantompane/process", () => ({
  isInsideTmux: vi.fn(() => false),
  executeTmuxCommand: vi.fn(),
  getPhantomEnv: vi.fn(() => ({})),
}));

const { createHandler } = await import("./create.ts");

describe("createHandler postCreate", () => {
  it("should pass config to createWorktree for postCreate execution", async () => {
    exitWithErrorMock.mockClear();
    outputLogMock.mockClear();
    outputErrorMock.mockClear();
    getGitRootMock.mockClear();
    createWorktreeMock.mockClear();
    createContextMock.mockClear();

    getGitRootMock.mockImplementation(() => Promise.resolve("/repo"));
    createContextMock.mockImplementation((gitRoot) =>
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
    createWorktreeMock.mockImplementation(() =>
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
    ] = createWorktreeMock.mock.calls[0];
    deepStrictEqual(gitRoot, "/repo");
    deepStrictEqual(worktreeDirectory, "/repo/.git/phantom/worktrees");
    deepStrictEqual(name, "feature");
    deepStrictEqual(postCreateCopyFiles, undefined);
    deepStrictEqual(postCreateCommands, ["npm install", "npm test"]);
  });

  it("should exit with error if createWorktree fails due to postCreate", async () => {
    exitWithErrorMock.mockClear();
    getGitRootMock.mockClear();
    createWorktreeMock.mockClear();
    createContextMock.mockClear();

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
    // createWorktree now handles postCreate internally and returns error
    createWorktreeMock.mockImplementation(() =>
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

    deepStrictEqual(exitWithErrorMock.mock.calls[0], [
      "Post-create command failed with exit code 127: invalid-command",
      1,
    ]);
  });

  it("should pass config with only copyFiles to createWorktree", async () => {
    exitWithErrorMock.mockClear();
    outputLogMock.mockClear();
    getGitRootMock.mockClear();
    createWorktreeMock.mockClear();
    createContextMock.mockClear();

    getGitRootMock.mockImplementation(() => Promise.resolve("/repo"));
    createContextMock.mockImplementation((gitRoot) =>
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
    createWorktreeMock.mockImplementation(() =>
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
      createWorktreeMock.mock.calls[0];
    deepStrictEqual(postCreateCopyFiles, [".env"]);
    deepStrictEqual(postCreateCommands, undefined);
  });
});
