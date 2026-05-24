import { deepStrictEqual, rejects } from "node:assert";
import { describe, it, vi } from "vitest";
import { err, ok } from "@phantompane/utils";

const exitWithErrorMock = vi.fn((message, code) => {
  throw new Error(`Exit with code ${code}: ${message}`);
});
const outputLogMock = vi.fn();
const outputErrorMock = vi.fn();
const githubCheckoutMock = vi.fn();
const runPostCreateWorktreeMock = vi.fn();

vi.doMock("../errors.ts", () => ({
  exitWithError: exitWithErrorMock,
  exitCodes: {
    validationError: 3,
    generalError: 1,
  },
}));

vi.doMock("../output.ts", () => ({
  output: { log: outputLogMock, error: outputErrorMock },
}));

vi.doMock("@phantompane/core", () => ({
  githubCheckout: githubCheckoutMock,
  runPostCreateWorktree: runPostCreateWorktreeMock,
}));

const { githubCheckoutHandler } = await import("./github-checkout.ts");

describe("githubCheckoutHandler", () => {
  it("should call githubCheckout with correct options", async () => {
    exitWithErrorMock.mockClear();
    outputLogMock.mockClear();
    outputErrorMock.mockClear();
    githubCheckoutMock.mockClear();
    runPostCreateWorktreeMock.mockClear();
    runPostCreateWorktreeMock.mockResolvedValue(ok({ executedCommands: [] }));

    githubCheckoutMock.mockImplementation(() =>
      Promise.resolve(
        ok({
          message: "Checked out issue #123",
          worktree: "issues/123",
          path: "/repo/.git/phantom/worktrees/issues/123",
        }),
      ),
    );

    await githubCheckoutHandler(["123"]);

    // Verify that githubCheckout was called with options only
    // The handler defers postCreate so checkout output and navigation can happen first
    deepStrictEqual(githubCheckoutMock.mock.calls.length, 1);
    const [options] = githubCheckoutMock.mock.calls[0];
    deepStrictEqual(options, {
      number: "123",
      base: undefined,
    });
    deepStrictEqual(outputLogMock.mock.calls[0][0], "Checked out issue #123");
    deepStrictEqual(runPostCreateWorktreeMock.mock.calls[0][0], {
      worktreeName: "issues/123",
      logger: { log: outputLogMock, error: outputErrorMock },
    });
  });

  it("should handle existing worktree response", async () => {
    exitWithErrorMock.mockClear();
    outputLogMock.mockClear();
    githubCheckoutMock.mockClear();
    runPostCreateWorktreeMock.mockClear();

    githubCheckoutMock.mockImplementation(() =>
      Promise.resolve(
        ok({
          message: "Worktree for PR #456 is already checked out",
          worktree: "pulls/456",
          path: "/repo/.git/phantom/worktrees/pulls/456",
          alreadyExists: true,
        }),
      ),
    );

    await githubCheckoutHandler(["456"]);

    deepStrictEqual(githubCheckoutMock.mock.calls.length, 1);
    deepStrictEqual(
      outputLogMock.mock.calls[0][0],
      "Worktree for PR #456 is already checked out",
    );
    deepStrictEqual(runPostCreateWorktreeMock.mock.calls.length, 0);
  });

  it("should run deferred post-create after checkout output", async () => {
    exitWithErrorMock.mockClear();
    outputLogMock.mockClear();
    githubCheckoutMock.mockClear();
    runPostCreateWorktreeMock.mockClear();

    githubCheckoutMock.mockResolvedValueOnce(
      ok({
        message: "Checked out issue #123",
        worktree: "issues/123",
        path: "/repo/.git/phantom/worktrees/issues/123",
      }),
    );
    runPostCreateWorktreeMock.mockResolvedValueOnce(
      ok({ executedCommands: ["pnpm install"] }),
    );

    await githubCheckoutHandler(["123"]);

    deepStrictEqual(outputLogMock.mock.calls[0][0], "Checked out issue #123");
    deepStrictEqual(runPostCreateWorktreeMock.mock.calls[0][0], {
      worktreeName: "issues/123",
      logger: { log: outputLogMock, error: outputErrorMock },
    });
  });

  it("should handle githubCheckout error", async () => {
    exitWithErrorMock.mockClear();
    githubCheckoutMock.mockClear();
    runPostCreateWorktreeMock.mockClear();

    githubCheckoutMock.mockImplementation(() =>
      Promise.resolve(err(new Error("GitHub API error"))),
    );

    await rejects(
      async () => await githubCheckoutHandler(["123"]),
      /Exit with code 1/,
    );

    deepStrictEqual(exitWithErrorMock.mock.calls[0], ["GitHub API error", 1]);
  });

  it("should pass base option to githubCheckout", async () => {
    exitWithErrorMock.mockClear();
    githubCheckoutMock.mockClear();
    runPostCreateWorktreeMock.mockClear();
    runPostCreateWorktreeMock.mockResolvedValue(ok({ executedCommands: [] }));

    githubCheckoutMock.mockImplementation(() =>
      Promise.resolve(
        ok({
          message: "Checked out issue #123",
          worktree: "issues/123",
          path: "/repo/.git/phantom/worktrees/issues/123",
        }),
      ),
    );

    await githubCheckoutHandler(["123", "--base", "develop"]);

    deepStrictEqual(githubCheckoutMock.mock.calls[0][0], {
      number: "123",
      base: "develop",
    });
  });

  it("should work correctly", async () => {
    exitWithErrorMock.mockClear();
    outputLogMock.mockClear();
    outputErrorMock.mockClear();
    githubCheckoutMock.mockClear();
    runPostCreateWorktreeMock.mockClear();
    runPostCreateWorktreeMock.mockResolvedValue(ok({ executedCommands: [] }));

    githubCheckoutMock.mockImplementation(() =>
      Promise.resolve(
        ok({
          message: "Checked out issue #123",
          worktree: "issues/123",
          path: "/repo/.git/phantom/worktrees/issues/123",
        }),
      ),
    );

    await githubCheckoutHandler(["123"]);

    // Verify that githubCheckout was called with options only
    deepStrictEqual(githubCheckoutMock.mock.calls.length, 1);
    const [options] = githubCheckoutMock.mock.calls[0];
    deepStrictEqual(options, {
      number: "123",
      base: undefined,
    });
    deepStrictEqual(outputErrorMock.mock.calls.length, 0);
  });
});
