import { strictEqual } from "node:assert";
import { join } from "node:path";
import { describe, it, vi } from "vitest";
import { err, isErr, isOk, ok } from "@phantompane/utils";

const branchExistsMock = vi.fn();
const validateWorktreeDirectoryExistsMock = vi.fn();
const validateWorktreeNameMock = vi.fn(() => ok(undefined));
let humanIdCallCount = 0;

vi.doMock("@phantompane/git", () => ({
  branchExists: branchExistsMock,
}));

vi.doMock("./validate.ts", () => ({
  validateWorktreeDirectoryExists: validateWorktreeDirectoryExistsMock,
  validateWorktreeName: validateWorktreeNameMock,
}));

vi.doMock("human-id", () => ({
  humanId: () => {
    humanIdCallCount++;
    return `generated-name-${humanIdCallCount}`;
  },
}));

const { generateUniqueName } = await import("./generate-name.ts");

describe("generateUniqueName", () => {
  const resetMocks = () => {
    branchExistsMock.mockClear();
    validateWorktreeDirectoryExistsMock.mockClear();
    validateWorktreeNameMock.mockClear();
    validateWorktreeNameMock.mockImplementation(() => ok(undefined));
    humanIdCallCount = 0;
  };

  it("should generate a unique name on first attempt", async () => {
    resetMocks();
    validateWorktreeDirectoryExistsMock.mockImplementation(() =>
      Promise.resolve(false),
    );
    branchExistsMock.mockImplementation(() => Promise.resolve(ok(false)));

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
      validateWorktreeDirectoryExistsMock.mock.calls[0][0],
      join("/test/repo/.git/phantom/worktrees", "generated-name-1"),
    );
    strictEqual(branchExistsMock.mock.calls.length, 1);
  });

  it("should retry when worktree directory already exists", async () => {
    resetMocks();
    let dirCheckCount = 0;
    validateWorktreeDirectoryExistsMock.mockImplementation(() => {
      dirCheckCount++;
      return Promise.resolve(dirCheckCount === 1);
    });
    branchExistsMock.mockImplementation(() => Promise.resolve(ok(false)));

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
    validateWorktreeDirectoryExistsMock.mockImplementation(() =>
      Promise.resolve(false),
    );
    let branchCheckCount = 0;
    branchExistsMock.mockImplementation(() => {
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
    validateWorktreeDirectoryExistsMock.mockImplementation(() =>
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
    validateWorktreeDirectoryExistsMock.mockImplementation(() =>
      Promise.resolve(false),
    );
    branchExistsMock.mockImplementation(() =>
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
    validateWorktreeDirectoryExistsMock.mockImplementation(() =>
      Promise.resolve(false),
    );
    branchExistsMock.mockImplementation(() => Promise.resolve(ok(false)));

    const result = await generateUniqueName(
      "/test/repo",
      "/test/repo/.git/phantom/worktrees",
      "-",
    );

    strictEqual(isOk(result), true);
    strictEqual(
      validateWorktreeDirectoryExistsMock.mock.calls[0][0],
      join("/test/repo/.git/phantom/worktrees", "generated-name-1"),
    );
  });
});
