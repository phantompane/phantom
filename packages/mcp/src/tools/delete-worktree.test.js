import { deepStrictEqual, rejects, strictEqual } from "node:assert";
import { describe, it, mock } from "node:test";
import { z } from "zod";

const deleteWorktreeMock = mock.fn();
const createContextMock = mock.fn();
const getGitRootMock = mock.fn();
const isOkMock = mock.fn((result) => {
  return result && result.ok === true;
});
const okMock = mock.fn((value) => ({ ok: true, value }));
const errMock = mock.fn((error) => ({ ok: false, error }));

mock.module("@phantompane/core", {
  namedExports: {
    deleteWorktree: deleteWorktreeMock,
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

const { deleteWorktreeTool } = await import("./delete-worktree.ts");

describe("deleteWorktreeTool", () => {
  const resetMocks = () => {
    deleteWorktreeMock.mock.resetCalls();
    getGitRootMock.mock.resetCalls();
    isOkMock.mock.resetCalls();
  };

  it("should have correct name and description", () => {
    strictEqual(deleteWorktreeTool.name, "phantom_delete_worktree");
    strictEqual(
      deleteWorktreeTool.description,
      "Delete a Git worktree (phantom)",
    );
  });

  it("should have correct input schema", () => {
    const schema = deleteWorktreeTool.inputSchema;
    strictEqual(schema instanceof z.ZodObject, true);

    const shape = schema.shape;
    strictEqual(shape.name instanceof z.ZodString, true);
    strictEqual(shape.force instanceof z.ZodOptional, true);
  });

  it("should delete worktree successfully without force", async () => {
    resetMocks();
    const gitRoot = "/path/to/repo";

    getGitRootMock.mock.mockImplementation(() => Promise.resolve(gitRoot));
    createContextMock.mock.mockImplementation(() =>
      Promise.resolve({
        gitRoot,
        worktreesDirectory: "/path/to/repo/.git/phantom/worktrees",
        config: null,
      }),
    );
    deleteWorktreeMock.mock.mockImplementation(() =>
      Promise.resolve(okMock({})),
    );

    const result = await deleteWorktreeTool.handler({ name: "feature-1" });

    strictEqual(getGitRootMock.mock.calls.length, 1);
    strictEqual(deleteWorktreeMock.mock.calls.length, 1);
    deepStrictEqual(deleteWorktreeMock.mock.calls[0].arguments, [
      gitRoot,
      "/path/to/repo/.git/phantom/worktrees",
      "feature-1",
      { force: undefined },
      undefined,
    ]);

    strictEqual(result.content.length, 1);
    strictEqual(result.content[0].type, "text");

    const parsedContent = JSON.parse(result.content[0].text);
    deepStrictEqual(parsedContent, {
      success: true,
      message: "Worktree 'feature-1' deleted successfully",
    });
  });

  it("should delete worktree with force option", async () => {
    resetMocks();
    const gitRoot = "/path/to/repo";

    getGitRootMock.mock.mockImplementation(() => Promise.resolve(gitRoot));
    createContextMock.mock.mockImplementation(() =>
      Promise.resolve({
        gitRoot,
        worktreesDirectory: "/path/to/repo/.git/phantom/worktrees",
        config: null,
      }),
    );
    deleteWorktreeMock.mock.mockImplementation(() =>
      Promise.resolve(okMock({})),
    );

    const result = await deleteWorktreeTool.handler({
      name: "feature-2",
      force: true,
    });

    strictEqual(deleteWorktreeMock.mock.calls.length, 1);
    deepStrictEqual(deleteWorktreeMock.mock.calls[0].arguments, [
      gitRoot,
      "/path/to/repo/.git/phantom/worktrees",
      "feature-2",
      { force: true },
      undefined,
    ]);

    const parsedContent = JSON.parse(result.content[0].text);
    strictEqual(parsedContent.success, true);
    strictEqual(
      parsedContent.message,
      "Worktree 'feature-2' deleted successfully",
    );
  });

  it("should throw error when deleteWorktree fails", async () => {
    resetMocks();
    const gitRoot = "/path/to/repo";
    const errorMessage = "Worktree not found";
    const errorResult = { ok: false, error: { message: errorMessage } };

    getGitRootMock.mock.mockImplementation(() => Promise.resolve(gitRoot));
    createContextMock.mock.mockImplementation(() =>
      Promise.resolve({
        gitRoot,
        worktreesDirectory: "/path/to/repo/.git/phantom/worktrees",
        config: null,
      }),
    );
    deleteWorktreeMock.mock.mockImplementation(() =>
      Promise.resolve(errorResult),
    );

    await rejects(() => deleteWorktreeTool.handler({ name: "non-existent" }), {
      message: errorMessage,
    });
  });

  it("should validate input parameters", () => {
    const validInput = { name: "valid-name" };
    const parsed = deleteWorktreeTool.inputSchema.safeParse(validInput);
    strictEqual(parsed.success, true);

    const validInputWithForce = { name: "valid-name", force: true };
    const parsedWithForce =
      deleteWorktreeTool.inputSchema.safeParse(validInputWithForce);
    strictEqual(parsedWithForce.success, true);

    const invalidInput = { force: true };
    const parsedInvalid =
      deleteWorktreeTool.inputSchema.safeParse(invalidInput);
    strictEqual(parsedInvalid.success, false);

    const invalidForceType = { name: "valid-name", force: "true" };
    const parsedInvalidType =
      deleteWorktreeTool.inputSchema.safeParse(invalidForceType);
    strictEqual(parsedInvalidType.success, false);
  });
});
