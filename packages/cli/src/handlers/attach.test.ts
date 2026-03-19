import { deepStrictEqual, rejects, strictEqual } from "node:assert";
import { describe, it, vi } from "vitest";
import {
  BranchNotFoundError,
  TmuxSessionRequiredError,
  WorktreeActionConflictError,
  WorktreeAlreadyExistsError,
} from "@phantompane/core";
import { err, ok } from "@phantompane/shared";

const exitWithErrorMock = vi.fn((message, code) => {
  throw new Error(`Exit with code ${code}: ${message}`);
});
const runAttachWorktreeMock = vi.fn();
const outputMock = {
  log: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
};

vi.doMock("@phantompane/core", () => ({
  BranchNotFoundError,
  runAttachWorktree: runAttachWorktreeMock,
  TmuxSessionRequiredError,
  WorktreeActionConflictError,
  WorktreeAlreadyExistsError,
}));

vi.doMock("../errors.ts", () => ({
  exitWithError: exitWithErrorMock,
  exitCodes: {
    validationError: 3,
    notFound: 2,
    generalError: 1,
    success: 0,
  },
}));

vi.doMock("../output.ts", () => ({
  output: outputMock,
}));

const { attachHandler } = await import("./attach.ts");

describe("attachHandler", () => {
  const resetMocks = () => {
    exitWithErrorMock.mockReset();
    runAttachWorktreeMock.mockReset();
    outputMock.log.mockReset();
    outputMock.error.mockReset();
    outputMock.warn.mockReset();
  };

  it("requires a branch name", async () => {
    resetMocks();

    await rejects(async () => await attachHandler([]), /Exit with code 3/);

    deepStrictEqual(exitWithErrorMock.mock.calls[0], [
      "Missing required argument: branch name",
      3,
    ]);
    strictEqual(runAttachWorktreeMock.mock.calls.length, 0);
  });

  it("passes parsed options to core", async () => {
    resetMocks();
    runAttachWorktreeMock.mockResolvedValue(
      ok({
        name: "feature",
        path: "/repo/.git/phantom/worktrees/feature",
      }),
    );

    await attachHandler([
      "feature",
      "--copy-file",
      ".env",
      "--tmux-horizontal",
    ]);

    strictEqual(runAttachWorktreeMock.mock.calls.length, 1);
    strictEqual(runAttachWorktreeMock.mock.calls[0][0].name, "feature");
    strictEqual(runAttachWorktreeMock.mock.calls[0][0].copyFiles[0], ".env");
    strictEqual(
      runAttachWorktreeMock.mock.calls[0][0].action.tmuxDirection,
      "horizontal",
    );
    strictEqual(runAttachWorktreeMock.mock.calls[0][0].logger, outputMock);
  });

  it("maps branch-not-found errors to notFound", async () => {
    resetMocks();
    runAttachWorktreeMock.mockResolvedValue(
      err(new BranchNotFoundError("missing")),
    );

    await rejects(
      async () => await attachHandler(["missing"]),
      /Exit with code 2/,
    );

    deepStrictEqual(exitWithErrorMock.mock.calls[0], [
      "Branch 'missing' not found",
      2,
    ]);
  });

  it("maps validation errors to validation exit codes", async () => {
    resetMocks();
    runAttachWorktreeMock.mockResolvedValue(
      err(new TmuxSessionRequiredError()),
    );

    await rejects(
      async () => await attachHandler(["feature", "--tmux"]),
      /Exit with code 3/,
    );

    deepStrictEqual(exitWithErrorMock.mock.calls[0], [
      "The --tmux option can only be used inside a tmux session",
      3,
    ]);
  });
});
