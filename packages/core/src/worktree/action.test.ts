import { deepStrictEqual, strictEqual } from "node:assert";
import { describe, it, vi } from "vitest";
import { err, ok } from "@phantompane/utils";
import { WorktreeActionConflictError } from "./errors.ts";

const shellInWorktreeMock = vi.fn();
const execInWorktreeMock = vi.fn();
const executeTmuxCommandMock = vi.fn();
const isInsideTmuxMock = vi.fn();
const getPhantomEnvMock = vi.fn();

vi.doMock("../shell.ts", () => ({
  shellInWorktree: shellInWorktreeMock,
}));

vi.doMock("../exec.ts", () => ({
  execInWorktree: execInWorktreeMock,
}));

vi.doMock("@phantompane/tmux", () => ({
  executeTmuxCommand: executeTmuxCommandMock,
  isInsideTmux: isInsideTmuxMock,
}));

vi.doMock("@phantompane/process", () => ({
  getPhantomEnv: getPhantomEnvMock,
}));

const { resolveWorktreeAction, runWorktreeAction } =
  await import("./action.ts");

describe("resolveWorktreeAction", () => {
  it("returns an error when multiple actions are requested", () => {
    const result = resolveWorktreeAction({
      shell: true,
      exec: "echo hello",
    });

    strictEqual(result.ok, false);
    if (!result.ok) {
      strictEqual(result.error instanceof WorktreeActionConflictError, true);
    }
  });
});

describe("runWorktreeAction", () => {
  const resetMocks = () => {
    shellInWorktreeMock.mockReset();
    execInWorktreeMock.mockReset();
    executeTmuxCommandMock.mockReset();
    isInsideTmuxMock.mockReset();
    getPhantomEnvMock.mockReset();
  };

  it("starts shell actions with the start callback", async () => {
    resetMocks();
    const onStarted = vi.fn();
    shellInWorktreeMock.mockResolvedValue(ok({ exitCode: 0 }));

    const result = await runWorktreeAction({
      gitRoot: "/repo",
      worktreeDirectory: "/repo/.git/phantom/worktrees",
      worktreeName: "feature",
      worktreePath: "/repo/.git/phantom/worktrees/feature",
      action: { kind: "shell" },
      onStarted,
    });

    strictEqual(result.ok, true);
    deepStrictEqual(shellInWorktreeMock.mock.calls[0], [
      "/repo",
      "/repo/.git/phantom/worktrees",
      "feature",
      { onStarted },
    ]);
  });

  it("starts tmux actions only after tmux opens successfully", async () => {
    resetMocks();
    const onStarted = vi.fn();
    executeTmuxCommandMock.mockResolvedValue(ok({ exitCode: 0 }));
    getPhantomEnvMock.mockReturnValue({
      PHANTOM_NAME: "feature",
      PHANTOM_PATH: "/repo/.git/phantom/worktrees/feature",
    });

    const result = await runWorktreeAction({
      gitRoot: "/repo",
      worktreeDirectory: "/repo/.git/phantom/worktrees",
      worktreeName: "feature",
      worktreePath: "/repo/.git/phantom/worktrees/feature",
      action: { kind: "tmux", direction: "new" },
      onStarted,
    });

    strictEqual(result.ok, true);
    strictEqual(onStarted.mock.calls.length, 1);
    deepStrictEqual(executeTmuxCommandMock.mock.calls[0][0], {
      direction: "new",
      command: process.env.SHELL || "/bin/sh",
      cwd: "/repo/.git/phantom/worktrees/feature",
      env: {
        PHANTOM_NAME: "feature",
        PHANTOM_PATH: "/repo/.git/phantom/worktrees/feature",
      },
      windowName: "feature",
    });
  });

  it("does not start tmux actions when opening tmux fails", async () => {
    resetMocks();
    const onStarted = vi.fn();
    executeTmuxCommandMock.mockResolvedValue(err(new Error("tmux failed")));

    const result = await runWorktreeAction({
      gitRoot: "/repo",
      worktreeDirectory: "/repo/.git/phantom/worktrees",
      worktreeName: "feature",
      worktreePath: "/repo/.git/phantom/worktrees/feature",
      action: { kind: "tmux", direction: "new" },
      onStarted,
    });

    strictEqual(result.ok, false);
    strictEqual(onStarted.mock.calls.length, 0);
  });
});
