import { deepStrictEqual, rejects, strictEqual } from "node:assert";
import { describe, it, vi } from "vitest";
import { z } from "zod";

const createWorktreeMock = vi.fn();
const createContextMock = vi.fn();
const getGitRootMock = vi.fn();
const isOkMock = vi.fn((result) => {
  return result && result.ok === true;
});
const okMock = vi.fn((value) => ({ ok: true, value }));
const errMock = vi.fn((error) => ({ ok: false, error }));

vi.doMock("@phantompane/core", () => ({
  createWorktree: createWorktreeMock,
  createContext: createContextMock,
}));

vi.doMock("@phantompane/git", () => ({
  getGitRoot: getGitRootMock,
}));

vi.doMock("@phantompane/shared", () => ({
  isOk: isOkMock,
  ok: okMock,
  err: errMock,
}));

const { createWorktreeTool } = await import("./create-worktree.ts");

const handlerExtra = {} as never;

function getTextContent(result: {
  content: Array<{ type: "text"; text: string } | { type: string }>;
}) {
  const [content] = result.content;
  strictEqual(content.type, "text");

  if (content.type !== "text") {
    throw new Error("Expected text content");
  }

  return (content as { type: "text"; text: string }).text;
}

describe("createWorktreeTool", () => {
  const resetMocks = () => {
    createWorktreeMock.mockClear();
    getGitRootMock.mockClear();
    isOkMock.mockClear();
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

    getGitRootMock.mockImplementation(() => Promise.resolve(gitRoot));
    createContextMock.mockImplementation(() =>
      Promise.resolve({
        gitRoot,
        worktreesDirectory: "/path/to/repo/.git/phantom/worktrees",
      }),
    );
    createWorktreeMock.mockImplementation(() =>
      Promise.resolve(okMock({ path: worktreePath })),
    );

    const result = await createWorktreeTool.handler(
      { name: "feature-1" },
      handlerExtra,
    );

    strictEqual(getGitRootMock.mock.calls.length, 1);
    strictEqual(createWorktreeMock.mock.calls.length, 1);
    deepStrictEqual(createWorktreeMock.mock.calls[0], [
      gitRoot,
      "/path/to/repo/.git/phantom/worktrees",
      "feature-1",
      {
        branch: "feature-1",
        base: undefined,
        copyFiles: undefined,
      },
      undefined,
      undefined,
      undefined,
    ]);

    strictEqual(result.content.length, 1);
    strictEqual(result.content[0].type, "text");

    const parsedContent = JSON.parse(getTextContent(result));
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

    getGitRootMock.mockImplementation(() => Promise.resolve(gitRoot));
    createContextMock.mockImplementation(() =>
      Promise.resolve({
        gitRoot,
        worktreesDirectory: "/path/to/repo/.git/phantom/worktrees",
      }),
    );
    createWorktreeMock.mockImplementation(() =>
      Promise.resolve(okMock({ path: worktreePath })),
    );

    const result = await createWorktreeTool.handler(
      {
        name: "feature-2",
        baseBranch: "develop",
      },
      handlerExtra,
    );

    strictEqual(createWorktreeMock.mock.calls.length, 1);
    deepStrictEqual(createWorktreeMock.mock.calls[0], [
      gitRoot,
      "/path/to/repo/.git/phantom/worktrees",
      "feature-2",
      {
        branch: "feature-2",
        base: "develop",
        copyFiles: undefined,
      },
      undefined,
      undefined,
      undefined,
    ]);

    const parsedContent = JSON.parse(getTextContent(result));
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

    getGitRootMock.mockImplementation(() => Promise.resolve(gitRoot));
    createContextMock.mockImplementation(() =>
      Promise.resolve({
        gitRoot,
        worktreesDirectory: "/path/to/repo/.git/phantom/worktrees",
      }),
    );
    createWorktreeMock.mockImplementation(() => Promise.resolve(errorResult));

    await rejects(
      async () =>
        createWorktreeTool.handler({ name: "existing-worktree" }, handlerExtra),
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
