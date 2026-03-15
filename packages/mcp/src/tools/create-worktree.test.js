import { deepStrictEqual, rejects, strictEqual } from "node:assert";
import { describe, it, mock } from "node:test";
import { z } from "zod";

const createWorktreeMock = mock.fn();
const createContextMock = mock.fn();
const getGitRootMock = mock.fn();
const isOkMock = mock.fn((result) => {
  return result && result.ok === true;
});
const okMock = mock.fn((value) => ({ ok: true, value }));
const errMock = mock.fn((error) => ({ ok: false, error }));

mock.module("@phantompane/core", {
  namedExports: {
    createWorktree: createWorktreeMock,
    createContext: createContextMock,
  },
});

mock.module("@phantompane/git", {
  namedExports: {
    getGitRoot: getGitRootMock,
  },
});

mock.module("@phantompane/shared", {
  namedExports: {
    isOk: isOkMock,
    ok: okMock,
    err: errMock,
  },
});

const { createWorktreeTool } = await import("./create-worktree.ts");

describe("createWorktreeTool", () => {
  const resetMocks = () => {
    createWorktreeMock.mock.resetCalls();
    getGitRootMock.mock.resetCalls();
    isOkMock.mock.resetCalls();
  };

  it("should have correct name and description", () => {
    strictEqual(createWorktreeTool.name, "phantom_create_worktree");
    strictEqual(
      createWorktreeTool.description,
      "Create a new Git worktree (phantom)",
    );
  });

  it("should have correct input schema", () => {
    const schema = createWorktreeTool.inputSchema;
    strictEqual(schema instanceof z.ZodObject, true);

    const shape = schema.shape;
    strictEqual(shape.name instanceof z.ZodString, true);
    strictEqual(shape.baseBranch instanceof z.ZodOptional, true);
  });

  it("should create worktree successfully with only name", async () => {
    resetMocks();
    const gitRoot = "/path/to/repo";
    const worktreePath = "/path/to/repo/.git/phantom/worktrees/feature-1";

    getGitRootMock.mock.mockImplementation(() => Promise.resolve(gitRoot));
    createContextMock.mock.mockImplementation(() =>
      Promise.resolve({
        gitRoot,
        worktreesDirectory: "/path/to/repo/.git/phantom/worktrees",
      }),
    );
    createWorktreeMock.mock.mockImplementation(() =>
      Promise.resolve(okMock({ path: worktreePath })),
    );

    const result = await createWorktreeTool.handler({ name: "feature-1" });

    strictEqual(getGitRootMock.mock.calls.length, 1);
    strictEqual(createWorktreeMock.mock.calls.length, 1);
    deepStrictEqual(createWorktreeMock.mock.calls[0].arguments, [
      gitRoot,
      "/path/to/repo/.git/phantom/worktrees",
      "feature-1",
      {
        branch: "feature-1",
        base: undefined,
      },
      undefined,
      undefined,
    ]);

    strictEqual(result.content.length, 1);
    strictEqual(result.content[0].type, "text");

    const parsedContent = JSON.parse(result.content[0].text);
    deepStrictEqual(parsedContent, {
      success: true,
      message: "Worktree 'feature-1' created successfully.",
      path: worktreePath,
      note: `You can now switch to the worktree using 'cd ${worktreePath}'`,
    });
  });

  it("should create worktree with base branch", async () => {
    resetMocks();
    const gitRoot = "/path/to/repo";
    const worktreePath = "/path/to/repo/.git/phantom/worktrees/feature-2";

    getGitRootMock.mock.mockImplementation(() => Promise.resolve(gitRoot));
    createContextMock.mock.mockImplementation(() =>
      Promise.resolve({
        gitRoot,
        worktreesDirectory: "/path/to/repo/.git/phantom/worktrees",
      }),
    );
    createWorktreeMock.mock.mockImplementation(() =>
      Promise.resolve(okMock({ path: worktreePath })),
    );

    const result = await createWorktreeTool.handler({
      name: "feature-2",
      baseBranch: "develop",
    });

    strictEqual(createWorktreeMock.mock.calls.length, 1);
    deepStrictEqual(createWorktreeMock.mock.calls[0].arguments, [
      gitRoot,
      "/path/to/repo/.git/phantom/worktrees",
      "feature-2",
      {
        branch: "feature-2",
        base: "develop",
      },
      undefined,
      undefined,
    ]);

    const parsedContent = JSON.parse(result.content[0].text);
    strictEqual(parsedContent.success, true);
    strictEqual(
      parsedContent.message,
      "Worktree 'feature-2' created successfully.",
    );
  });

  it("should throw error when createWorktree fails", async () => {
    resetMocks();
    const gitRoot = "/path/to/repo";
    const errorMessage = "Worktree already exists";
    const errorResult = { ok: false, error: { message: errorMessage } };

    getGitRootMock.mock.mockImplementation(() => Promise.resolve(gitRoot));
    createContextMock.mock.mockImplementation(() =>
      Promise.resolve({
        gitRoot,
        worktreesDirectory: "/path/to/repo/.git/phantom/worktrees",
      }),
    );
    createWorktreeMock.mock.mockImplementation(() =>
      Promise.resolve(errorResult),
    );

    await rejects(
      () => createWorktreeTool.handler({ name: "existing-worktree" }),
      {
        message: errorMessage,
      },
    );
  });

  it("should validate input parameters", () => {
    const validInput = { name: "valid-name" };
    const parsed = createWorktreeTool.inputSchema.safeParse(validInput);
    strictEqual(parsed.success, true);

    const validInputWithBase = { name: "valid-name", baseBranch: "main" };
    const parsedWithBase =
      createWorktreeTool.inputSchema.safeParse(validInputWithBase);
    strictEqual(parsedWithBase.success, true);

    const invalidInput = { baseBranch: "main" };
    const parsedInvalid =
      createWorktreeTool.inputSchema.safeParse(invalidInput);
    strictEqual(parsedInvalid.success, false);
  });
});
