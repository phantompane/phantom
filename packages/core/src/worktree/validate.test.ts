import { deepStrictEqual } from "node:assert";
import { describe, it, vi } from "vitest";
import { err, ok } from "@phantompane/utils";

const listWorktreesMock = vi.fn();

vi.doMock("./list.ts", () => ({
  listWorktrees: listWorktreesMock,
}));

const { validateWorktreeExists, validateWorktreeDoesNotExist } =
  await import("./validate.ts");
const { isOk, isErr } = await import("@phantompane/utils");

describe("validateWorktreeExists", () => {
  const resetMocks = () => {
    listWorktreesMock.mockClear();
  };

  it("should return ok when worktree is registered", async () => {
    resetMocks();
    listWorktreesMock.mockImplementation(() =>
      Promise.resolve(
        ok({
          worktrees: [
            {
              name: "my-feature",
              path: "/test/repo/.git/phantom/worktrees/my-feature",
              branch: "my-feature",
              isClean: true,
            },
          ],
        }),
      ),
    );

    const result = await validateWorktreeExists(
      "/test/repo",
      "/test/repo/.git/phantom/worktrees",
      "my-feature",
    );

    deepStrictEqual(isOk(result), true);
    if (isOk(result)) {
      deepStrictEqual(result.value, {
        path: "/test/repo/.git/phantom/worktrees/my-feature",
      });
    }
  });

  it("should return err when worktree is not registered", async () => {
    resetMocks();
    listWorktreesMock.mockImplementation(() =>
      Promise.resolve(ok({ worktrees: [] })),
    );

    const result = await validateWorktreeExists(
      "/test/repo",
      "/test/repo/.git/phantom/worktrees",
      "non-existent",
    );

    deepStrictEqual(isErr(result), true);
    if (isErr(result)) {
      deepStrictEqual(
        result.error.message,
        "Worktree 'non-existent' not found",
      );
    }
  });

  it("should return ok for worktrees outside the managed directory", async () => {
    resetMocks();
    listWorktreesMock.mockImplementation(() =>
      Promise.resolve(
        ok({
          worktrees: [
            {
              name: "my-feature",
              path: "/test/repo/other-worktree",
              branch: "my-feature",
              isClean: true,
            },
          ],
        }),
      ),
    );

    const result = await validateWorktreeExists(
      "/test/repo",
      "/test/repo/.git/phantom/worktrees",
      "my-feature",
    );

    deepStrictEqual(isOk(result), true);
    if (isOk(result)) {
      deepStrictEqual(result.value, {
        path: "/test/repo/other-worktree",
      });
    }
  });

  it("should use the expected path when worktree names collide", async () => {
    resetMocks();
    listWorktreesMock.mockImplementation(() =>
      Promise.resolve(
        ok({
          worktrees: [
            {
              name: "abc1234",
              path: "/test/repo/.git/phantom/worktrees/first",
              branch: "abc1234",
              isClean: true,
            },
            {
              name: "abc1234",
              path: "/test/repo/.git/phantom/worktrees/second",
              branch: "abc1234",
              isClean: true,
            },
          ],
        }),
      ),
    );

    const result = await validateWorktreeExists(
      "/test/repo",
      "/test/repo/.git/phantom/worktrees",
      "abc1234",
      {
        expectedPath: "/test/repo/.git/phantom/worktrees/second",
      },
    );

    deepStrictEqual(isOk(result), true);
    if (isOk(result)) {
      deepStrictEqual(result.value, {
        path: "/test/repo/.git/phantom/worktrees/second",
      });
    }
  });

  it("should return err when worktree listing fails", async () => {
    resetMocks();
    listWorktreesMock.mockImplementation(() =>
      Promise.resolve(err(new Error("list failed"))),
    );

    const result = await validateWorktreeExists(
      "/test/repo",
      "/test/repo/.git/phantom/worktrees",
      "any",
    );

    deepStrictEqual(isErr(result), true);
    if (isErr(result)) {
      deepStrictEqual(result.error.message, "Worktree 'any' not found");
    }
  });

  it("should pass excludeDefault to listWorktrees", async () => {
    resetMocks();
    listWorktreesMock.mockImplementation(() =>
      Promise.resolve(ok({ worktrees: [] })),
    );

    const result = await validateWorktreeExists(
      "/test/repo",
      "/test/repo/.git/phantom/worktrees",
      "main",
      { excludeDefault: true },
    );

    deepStrictEqual(isErr(result), true);
    deepStrictEqual(listWorktreesMock.mock.calls.length, 1);
    deepStrictEqual(listWorktreesMock.mock.calls[0], [
      "/test/repo",
      { excludeDefault: true },
    ]);
  });
});

describe("validateWorktreeDoesNotExist", () => {
  const resetMocks = () => {
    listWorktreesMock.mockClear();
  };

  it("should return ok when worktree is not registered", async () => {
    resetMocks();
    listWorktreesMock.mockImplementation(() =>
      Promise.resolve(ok({ worktrees: [] })),
    );

    const result = await validateWorktreeDoesNotExist(
      "/test/repo",
      "/test/repo/.git/phantom/worktrees",
      "new-feature",
    );

    deepStrictEqual(isOk(result), true);
    if (isOk(result)) {
      deepStrictEqual(result.value, undefined);
    }
  });

  it("should return err when worktree is already registered", async () => {
    resetMocks();
    listWorktreesMock.mockImplementation(() =>
      Promise.resolve(
        ok({
          worktrees: [
            {
              name: "existing-feature",
              path: "/test/repo/.git/phantom/worktrees/existing-feature",
              branch: "existing-feature",
              isClean: true,
            },
          ],
        }),
      ),
    );

    const result = await validateWorktreeDoesNotExist(
      "/test/repo",
      "/test/repo/.git/phantom/worktrees",
      "existing-feature",
    );

    deepStrictEqual(isErr(result), true);
    if (isErr(result)) {
      deepStrictEqual(
        result.error.message,
        "Worktree 'existing-feature' already exists",
      );
    }
  });

  it("should return err when listing fails", async () => {
    resetMocks();
    listWorktreesMock.mockImplementation(() =>
      Promise.resolve(err(new Error("list failed"))),
    );

    const result = await validateWorktreeDoesNotExist(
      "/test/repo",
      "/test/repo/.git/phantom/worktrees",
      "new-feature",
    );

    deepStrictEqual(isErr(result), true);
    if (isErr(result)) {
      deepStrictEqual(
        result.error.message,
        "Worktree 'new-feature' already exists",
      );
    }
  });
});
