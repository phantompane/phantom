import { strictEqual } from "node:assert";
import { join } from "node:path";
import { describe, it, mock } from "node:test";
import { err, isErr, isOk, ok } from "@phantompane/shared";

const branchExistsMock = mock.fn();
const validateWorktreeDirectoryExistsMock = mock.fn();
const validateWorktreeNameMock = mock.fn(() => ok(undefined));
let humanIdCallCount = 0;

mock.module("@phantompane/git", {
  namedExports: {
    branchExists: branchExistsMock,
  },
});

mock.module("./validate.ts", {
  namedExports: {
    validateWorktreeDirectoryExists: validateWorktreeDirectoryExistsMock,
    validateWorktreeName: validateWorktreeNameMock,
  },
});

mock.module("human-id", {
  namedExports: {
    humanId: () => {
      humanIdCallCount++;
      return `generated-name-${humanIdCallCount}`;
    },
  },
});

const { generateUniqueName } = await import("./generate-name.ts");

describe("generateUniqueName", () => {
  const resetMocks = () => {
    branchExistsMock.mock.resetCalls();
    validateWorktreeDirectoryExistsMock.mock.resetCalls();
    validateWorktreeNameMock.mock.resetCalls();
    validateWorktreeNameMock.mock.mockImplementation(() => ok(undefined));
    humanIdCallCount = 0;
  };

  it("should generate a unique name on first attempt", async () => {
    resetMocks();
    validateWorktreeDirectoryExistsMock.mock.mockImplementation(() =>
      Promise.resolve(false),
    );
    branchExistsMock.mock.mockImplementation(() => Promise.resolve(ok(false)));

    const result = await generateUniqueName(
      "/test/repo",
      "/test/repo/.git/phantom/worktrees",
      "/",
    );

    strictEqual(isOk(result), true);
    if (isOk(result)) {
      strictEqual(result.value, "generated-name-1");
    }
    strictEqual(validateWorktreeDirectoryExistsMock.mock.calls.length, 1);
    strictEqual(
      validateWorktreeDirectoryExistsMock.mock.calls[0].arguments[0],
      join("/test/repo/.git/phantom/worktrees", "generated-name-1"),
    );
    strictEqual(branchExistsMock.mock.calls.length, 1);
  });

  it("should retry when worktree directory already exists", async () => {
    resetMocks();
    let dirCheckCount = 0;
    validateWorktreeDirectoryExistsMock.mock.mockImplementation(() => {
      dirCheckCount++;
      return Promise.resolve(dirCheckCount === 1);
    });
    branchExistsMock.mock.mockImplementation(() => Promise.resolve(ok(false)));

    const result = await generateUniqueName(
      "/test/repo",
      "/test/repo/.git/phantom/worktrees",
      "/",
    );

    strictEqual(isOk(result), true);
    if (isOk(result)) {
      strictEqual(result.value, "generated-name-2");
    }
    strictEqual(validateWorktreeDirectoryExistsMock.mock.calls.length, 2);
    strictEqual(branchExistsMock.mock.calls.length, 1);
  });

  it("should retry when name collides with existing branch", async () => {
    resetMocks();
    validateWorktreeDirectoryExistsMock.mock.mockImplementation(() =>
      Promise.resolve(false),
    );
    let branchCheckCount = 0;
    branchExistsMock.mock.mockImplementation(() => {
      branchCheckCount++;
      if (branchCheckCount === 1) {
        return Promise.resolve(ok(true));
      }
      return Promise.resolve(ok(false));
    });

    const result = await generateUniqueName(
      "/test/repo",
      "/test/repo/.git/phantom/worktrees",
      "/",
    );

    strictEqual(isOk(result), true);
    if (isOk(result)) {
      strictEqual(result.value, "generated-name-2");
    }
    strictEqual(branchExistsMock.mock.calls.length, 2);
  });

  it("should return error after max retries exceeded", async () => {
    resetMocks();
    validateWorktreeDirectoryExistsMock.mock.mockImplementation(() =>
      Promise.resolve(true),
    );

    const result = await generateUniqueName(
      "/test/repo",
      "/test/repo/.git/phantom/worktrees",
      "/",
    );

    strictEqual(isErr(result), true);
    if (isErr(result)) {
      strictEqual(
        result.error.message,
        "Failed to generate a unique worktree name after maximum retries",
      );
    }
    strictEqual(validateWorktreeDirectoryExistsMock.mock.calls.length, 10);
    strictEqual(branchExistsMock.mock.calls.length, 0);
  });

  it("should return error when branchExists fails", async () => {
    resetMocks();
    validateWorktreeDirectoryExistsMock.mock.mockImplementation(() =>
      Promise.resolve(false),
    );
    branchExistsMock.mock.mockImplementation(() =>
      Promise.resolve(err(new Error("git command failed"))),
    );

    const result = await generateUniqueName(
      "/test/repo",
      "/test/repo/.git/phantom/worktrees",
      "/",
    );

    strictEqual(isErr(result), true);
    if (isErr(result)) {
      strictEqual(result.error.message, "git command failed");
    }
  });

  it("uses directoryNameSeparator when checking generated paths", async () => {
    resetMocks();
    validateWorktreeDirectoryExistsMock.mock.mockImplementation(() =>
      Promise.resolve(false),
    );
    branchExistsMock.mock.mockImplementation(() => Promise.resolve(ok(false)));

    const result = await generateUniqueName(
      "/test/repo",
      "/test/repo/.git/phantom/worktrees",
      "-",
    );

    strictEqual(isOk(result), true);
    strictEqual(
      validateWorktreeDirectoryExistsMock.mock.calls[0].arguments[0],
      join("/test/repo/.git/phantom/worktrees", "generated-name-1"),
    );
  });
});
