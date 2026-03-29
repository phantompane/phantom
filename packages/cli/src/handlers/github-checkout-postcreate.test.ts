import { deepStrictEqual, rejects } from "node:assert";
import { describe, it, vi } from "vitest";
import { err, ok } from "@phantompane/utils";

const exitWithErrorMock = vi.fn((message, code) => {
  throw new Error(`Exit with code ${code}: ${message}`);
});
const outputLogMock = vi.fn();
const outputErrorMock = vi.fn();
const githubCheckoutMock = vi.fn();

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

vi.doMock("@phantompane/github", () => ({
  githubCheckout: githubCheckoutMock,
}));

const { githubCheckoutHandler } = await import("./github-checkout.ts");

describe("githubCheckoutHandler", () => {
  it("should call githubCheckout with correct options", async () => {
    exitWithErrorMock.mockClear();
    outputLogMock.mockClear();
    outputErrorMock.mockClear();
    githubCheckoutMock.mockClear();

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
    // The github library internally creates context and handles postCreate
    deepStrictEqual(githubCheckoutMock.mock.calls.length, 1);
    const [options] = githubCheckoutMock.mock.calls[0];
    deepStrictEqual(options, {
      number: "123",
      base: undefined,
    });
    deepStrictEqual(outputLogMock.mock.calls[0][0], "Checked out issue #123");
  });

  it("should handle existing worktree response", async () => {
    exitWithErrorMock.mockClear();
    outputLogMock.mockClear();
    githubCheckoutMock.mockClear();

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
  });

  it("should handle githubCheckout error", async () => {
    exitWithErrorMock.mockClear();
    githubCheckoutMock.mockClear();

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
