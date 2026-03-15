import { deepStrictEqual, strictEqual } from "node:assert";
import { describe, it, mock } from "node:test";

const validateMock = mock.fn();

mock.module("./validate.ts", {
  namedExports: {
    validateWorktreeExists: validateMock,
  },
});

const { whereWorktree } = await import("./where.ts");
const { WorktreeNotFoundError } = await import("./errors.ts");
const { ok, err } = await import("@phantompane/shared");

describe("whereWorktree", () => {
  it("should return path when worktree exists", async () => {
    validateMock.mock.mockImplementation(() =>
      Promise.resolve(
        ok({ path: "/test/repo/.git/phantom/worktrees/my-feature" }),
      ),
    );

    const result = await whereWorktree("/test/repo", "my-feature");

    strictEqual(result.ok, true);
    if (result.ok) {
      deepStrictEqual(result.value, {
        path: "/test/repo/.git/phantom/worktrees/my-feature",
      });
    }

    strictEqual(validateMock.mock.calls.length, 1);
    deepStrictEqual(validateMock.mock.calls[0].arguments, [
      "/test/repo",
      "my-feature",
      undefined,
    ]);

    validateMock.mock.resetCalls();
  });

  it("should return error when worktree does not exist", async () => {
    validateMock.mock.mockImplementation(() =>
      Promise.resolve(err(new WorktreeNotFoundError("non-existent"))),
    );

    const result = await whereWorktree("/test/repo", "non-existent");

    strictEqual(result.ok, false);
    if (!result.ok) {
      strictEqual(result.error instanceof WorktreeNotFoundError, true);
      strictEqual(result.error.message, "Worktree 'non-existent' not found");
    }

    validateMock.mock.resetCalls();
  });

  it("should provide default message when validation message is missing", async () => {
    validateMock.mock.mockImplementation(() =>
      Promise.resolve(err(new WorktreeNotFoundError("missing"))),
    );

    const result = await whereWorktree("/test/repo", "missing");

    strictEqual(result.ok, false);
    if (!result.ok) {
      strictEqual(result.error instanceof WorktreeNotFoundError, true);
      strictEqual(result.error.message, "Worktree 'missing' not found");
    }

    validateMock.mock.resetCalls();
  });
});
