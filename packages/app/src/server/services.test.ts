import { deepStrictEqual, rejects, strictEqual } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it, vi } from "vitest";
import type { CodexBridge, CodexMessage } from "./codex-bridge";
import { ServeServices } from "./services";
import { createEmptyState, ServeStateStore } from "./storage";
import type { ChatRecord, ProjectRecord, ServeState } from "./types";

const coreMocks = vi.hoisted(() => ({
  deleteBranch: vi.fn(),
  removeWorktree: vi.fn(),
  runCreateWorktree: vi.fn(),
}));

vi.mock("@phantompane/core", () => coreMocks);

const temporaryDirectories: string[] = [];
const timestamp = "2026-04-25T00:00:00.000Z";

class FakeCodexBridge {
  readonly notificationHandlers: Array<(message: CodexMessage) => void> = [];
  readonly processExitHandlers: Array<(error: Error) => void> = [];
  readonly serverRequestHandlers: Array<(message: CodexMessage) => void> = [];
  readonly interruptTurn = vi.fn();
  readonly listModels = vi.fn();
  readonly readAccount = vi.fn();
  readonly respondToServerRequest = vi.fn();
  readonly resumeThread = vi.fn();
  readonly startThread = vi.fn();
  readonly startTurn = vi.fn();
  readonly steerTurn = vi.fn();

  onNotification(handler: (message: CodexMessage) => void): () => void {
    this.notificationHandlers.push(handler);
    return () => undefined;
  }

  onServerRequest(handler: (message: CodexMessage) => void): () => void {
    this.serverRequestHandlers.push(handler);
    return () => undefined;
  }

  onProcessExit(handler: (error: Error) => void): () => void {
    this.processExitHandlers.push(handler);
    return () => undefined;
  }

  emitProcessExit(error = new Error("Codex exited")): void {
    for (const handler of this.processExitHandlers) {
      handler(error);
    }
  }

  emitServerRequest(message: CodexMessage): void {
    for (const handler of this.serverRequestHandlers) {
      handler(message);
    }
  }

  emitNotification(message: CodexMessage): void {
    for (const handler of this.notificationHandlers) {
      handler(message);
    }
  }
}

afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "phantom-serve-services-"));
  temporaryDirectories.push(directory);
  return directory;
}

function createProject(overrides: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    id: "proj_1",
    name: "repo",
    rootPath: "/repo",
    createdAt: timestamp,
    updatedAt: timestamp,
    lastOpenedAt: timestamp,
    ...overrides,
  };
}

function createChat(overrides: Partial<ChatRecord> = {}): ChatRecord {
  return {
    id: "chat_1",
    projectId: "proj_1",
    worktreeName: "worktree",
    worktreePath: "/repo/.git/phantom/worktrees/worktree",
    branchName: "worktree",
    codexThreadId: "thread_1",
    title: "worktree",
    status: "idle",
    activeTurnId: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  };
}

async function createHarness(state: ServeState): Promise<{
  codex: FakeCodexBridge;
  services: ServeServices;
  store: ServeStateStore;
}> {
  const store = new ServeStateStore(await createTemporaryDirectory());
  await store.save(state);
  const codex = new FakeCodexBridge();
  const services = new ServeServices({
    codex: codex as unknown as CodexBridge,
    store,
  });
  return { codex, services, store };
}

describe("ServeServices", () => {
  it("rejects approval responses from a different chat", async () => {
    const state = {
      ...createEmptyState(),
      projects: [createProject()],
      chats: [
        createChat({ status: "running", activeTurnId: "turn_1" }),
        createChat({
          id: "chat_2",
          worktreeName: "other",
          worktreePath: "/repo/.git/phantom/worktrees/other",
          branchName: "other",
          codexThreadId: "thread_2",
          title: "other",
        }),
      ],
    };
    const { codex, services, store } = await createHarness(state);
    const emitSpy = vi.spyOn(services.eventHub, "emit");

    codex.emitServerRequest({
      id: 99,
      method: "item/commandExecution/requestApproval",
      params: { threadId: "thread_1" },
    });
    await vi.waitFor(async () => {
      const savedState = await store.load();
      strictEqual(savedState.chats[0]?.status, "waitingForApproval");
    });
    const approvalRequest = emitSpy.mock.calls.find(
      (call) => call[0] === "agent.approval.requested",
    )?.[1] as { requestId: string } | undefined;
    const approvalRequestId = approvalRequest?.requestId;
    strictEqual(typeof approvalRequestId, "string");
    if (!approvalRequestId) {
      throw new Error("Approval request id was not emitted");
    }

    await rejects(
      services.answerApproval("chat_2", approvalRequestId, {
        decision: "accept",
      }),
      /does not belong to chat 'chat_2'/,
    );
    strictEqual(codex.respondToServerRequest.mock.calls.length, 0);

    await services.answerApproval("chat_1", approvalRequestId, {
      decision: "accept",
    });

    deepStrictEqual(codex.respondToServerRequest.mock.calls[0], [
      99,
      { decision: "accept" },
    ]);
    strictEqual(
      emitSpy.mock.calls.some((call) => call[0] === "agent.approval.answered"),
      true,
    );
    strictEqual(
      emitSpy.mock.calls.some((call) => call[0] === "agent.approval.resolved"),
      false,
    );
    strictEqual((await store.load()).chats[0]?.status, "waitingForApproval");
    await rejects(
      services.answerApproval("chat_1", approvalRequestId, {
        decision: "decline",
      }),
      /was already answered/,
    );

    codex.emitNotification({
      method: "serverRequest/resolved",
      params: { threadId: "thread_1", requestId: 99 },
    });
    await vi.waitFor(async () => {
      strictEqual((await store.load()).chats[0]?.status, "running");
    });
    strictEqual(
      emitSpy.mock.calls.some((call) => call[0] === "agent.approval.resolved"),
      true,
    );
    await rejects(
      services.answerApproval("chat_1", approvalRequestId, {
        decision: "decline",
      }),
      /was not found/,
    );
  });

  it("keeps numeric and string Codex approval ids separate", async () => {
    const state = {
      ...createEmptyState(),
      projects: [createProject()],
      chats: [
        createChat({ status: "running", activeTurnId: "turn_1" }),
        createChat({
          id: "chat_2",
          worktreeName: "other",
          worktreePath: "/repo/.git/phantom/worktrees/other",
          branchName: "other",
          codexThreadId: "thread_2",
          title: "other",
          status: "running",
          activeTurnId: "turn_2",
        }),
      ],
    };
    const { codex, services } = await createHarness(state);
    const emitSpy = vi.spyOn(services.eventHub, "emit");

    codex.emitServerRequest({
      id: 1,
      method: "item/commandExecution/requestApproval",
      params: { threadId: "thread_1" },
    });
    codex.emitServerRequest({
      id: "1",
      method: "item/commandExecution/requestApproval",
      params: { threadId: "thread_2" },
    });
    await vi.waitFor(() => {
      strictEqual(
        emitSpy.mock.calls.filter(
          (call) => call[0] === "agent.approval.requested",
        ).length,
        2,
      );
    });

    const approvalRequestIds = emitSpy.mock.calls
      .filter((call) => call[0] === "agent.approval.requested")
      .map((call) => (call[1] as { requestId: string }).requestId);
    await services.answerApproval("chat_1", approvalRequestIds[0]!, {
      decision: "accept",
    });
    await services.answerApproval("chat_2", approvalRequestIds[1]!, {
      decision: "decline",
    });

    deepStrictEqual(codex.respondToServerRequest.mock.calls, [
      [1, { decision: "accept" }],
      ["1", { decision: "decline" }],
    ]);
  });

  it("rolls back a created worktree when Codex thread startup fails", async () => {
    const state = {
      ...createEmptyState(),
      projects: [createProject()],
    };
    const { codex, services, store } = await createHarness(state);
    coreMocks.runCreateWorktree.mockResolvedValueOnce({
      ok: true,
      value: {
        name: "feature",
        path: "/repo/.git/phantom/worktrees/feature",
      },
    });
    coreMocks.removeWorktree.mockResolvedValueOnce(undefined);
    coreMocks.deleteBranch.mockResolvedValueOnce({ ok: true, value: true });
    codex.startThread.mockRejectedValueOnce(new Error("Codex login required"));

    await rejects(
      services.createChat("proj_1", { name: "feature" }),
      /Codex login required/,
    );

    deepStrictEqual(coreMocks.removeWorktree.mock.calls[0], [
      "/repo",
      "/repo/.git/phantom/worktrees/feature",
      true,
    ]);
    deepStrictEqual(coreMocks.deleteBranch.mock.calls[0], ["/repo", "feature"]);
    strictEqual((await store.load()).chats.length, 0);
  });

  it("rolls back a created worktree when Codex omits the thread id", async () => {
    const state = {
      ...createEmptyState(),
      projects: [createProject()],
    };
    const { codex, services, store } = await createHarness(state);
    coreMocks.runCreateWorktree.mockResolvedValueOnce({
      ok: true,
      value: {
        name: "feature",
        path: "/repo/.git/phantom/worktrees/feature",
      },
    });
    coreMocks.removeWorktree.mockResolvedValueOnce(undefined);
    coreMocks.deleteBranch.mockResolvedValueOnce({ ok: true, value: true });
    codex.startThread.mockResolvedValueOnce({});

    await rejects(
      services.createChat("proj_1", { name: "feature" }),
      /Codex response did not include a thread id/,
    );

    deepStrictEqual(coreMocks.removeWorktree.mock.calls[0], [
      "/repo",
      "/repo/.git/phantom/worktrees/feature",
      true,
    ]);
    deepStrictEqual(coreMocks.deleteBranch.mock.calls[0], ["/repo", "feature"]);
    strictEqual((await store.load()).chats.length, 0);
  });

  it("resumes persisted threads again after the Codex app-server exits", async () => {
    const state = {
      ...createEmptyState(),
      projects: [createProject()],
    };
    const { codex, services } = await createHarness(state);
    coreMocks.runCreateWorktree.mockResolvedValueOnce({
      ok: true,
      value: {
        name: "feature",
        path: "/repo/.git/phantom/worktrees/feature",
      },
    });
    codex.startThread.mockResolvedValueOnce({ thread: { id: "thread_1" } });
    codex.resumeThread.mockResolvedValueOnce({});
    codex.startTurn.mockResolvedValueOnce({ turn: { id: "turn_1" } });

    const chat = await services.createChat("proj_1", { name: "feature" });
    codex.emitProcessExit();
    await services.sendMessage(chat.id, { text: "resume after restart" });

    deepStrictEqual(codex.resumeThread.mock.calls[0], [
      "thread_1",
      "/repo/.git/phantom/worktrees/feature",
    ]);
    strictEqual(codex.startTurn.mock.calls.length, 1);
  });

  it("resets transient chat state after the Codex app-server exits", async () => {
    const state = {
      ...createEmptyState(),
      projects: [createProject()],
      chats: [
        createChat({ status: "running", activeTurnId: "turn_1" }),
        createChat({
          id: "chat_2",
          worktreeName: "other",
          worktreePath: "/repo/.git/phantom/worktrees/other",
          branchName: "other",
          codexThreadId: "thread_2",
          title: "other",
          status: "running",
          activeTurnId: "turn_2",
        }),
        createChat({
          id: "chat_3",
          worktreeName: "idle",
          worktreePath: "/repo/.git/phantom/worktrees/idle",
          branchName: "idle",
          codexThreadId: "thread_3",
          title: "idle",
        }),
      ],
    };
    const { codex, services, store } = await createHarness(state);
    const emitSpy = vi.spyOn(services.eventHub, "emit");

    codex.emitServerRequest({
      id: 100,
      method: "item/commandExecution/requestApproval",
      params: { threadId: "thread_2", turnId: "turn_2" },
    });
    await vi.waitFor(async () => {
      strictEqual((await store.load()).chats[1]?.status, "waitingForApproval");
    });
    const approvalRequest = emitSpy.mock.calls.find(
      (call) => call[0] === "agent.approval.requested",
    )?.[1] as { requestId: string } | undefined;
    if (!approvalRequest) {
      throw new Error("Approval request was not emitted");
    }

    codex.emitProcessExit();

    await vi.waitFor(async () => {
      const savedState = await store.load();
      strictEqual(savedState.chats[0]?.status, "failed");
      strictEqual(savedState.chats[0]?.activeTurnId, null);
      strictEqual(savedState.chats[1]?.status, "failed");
      strictEqual(savedState.chats[1]?.activeTurnId, null);
      strictEqual(savedState.chats[2]?.status, "idle");
      strictEqual(savedState.chats[2]?.activeTurnId, null);
    });
    strictEqual(
      emitSpy.mock.calls.filter((call) => call[0] === "agent.error").length,
      2,
    );
    await rejects(
      services.answerApproval("chat_2", approvalRequest.requestId, {
        decision: "accept",
      }),
      /was not found/,
    );

    codex.resumeThread.mockResolvedValueOnce({});
    codex.startTurn.mockResolvedValueOnce({ turn: { id: "turn_3" } });
    await services.sendMessage("chat_2", { text: "recover" });

    strictEqual(codex.startTurn.mock.calls.length, 1);
  });

  it("does not broadcast unmapped approval requests as answerable approvals", async () => {
    const state = {
      ...createEmptyState(),
      projects: [createProject()],
      chats: [createChat()],
    };
    const { codex, services } = await createHarness(state);
    const emitSpy = vi.spyOn(services.eventHub, "emit");

    codex.emitServerRequest({
      id: 77,
      method: "item/commandExecution/requestApproval",
      params: { threadId: "thread_missing" },
    });

    await vi.waitFor(() => {
      strictEqual(
        emitSpy.mock.calls.some((call) => call[0] === "agent.error"),
        true,
      );
    });
    strictEqual(
      emitSpy.mock.calls.some((call) => call[0] === "agent.approval.requested"),
      false,
    );
    deepStrictEqual(codex.respondToServerRequest.mock.calls[0], [
      77,
      { decision: "decline" },
    ]);
  });

  it("ignores resolved approval notifications without a mapped chat", async () => {
    const state = {
      ...createEmptyState(),
      projects: [createProject()],
      chats: [createChat({ status: "running", activeTurnId: "turn_1" })],
    };
    const { codex, services } = await createHarness(state);
    const emitSpy = vi.spyOn(services.eventHub, "emit");

    codex.emitNotification({
      method: "serverRequest/resolved",
      params: { requestId: 94 },
    });
    codex.emitNotification({
      method: "serverRequest/resolved",
      params: { threadId: "thread_missing", requestId: 95 },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    strictEqual(
      emitSpy.mock.calls.some((call) => call[0] === "agent.approval.resolved"),
      false,
    );
  });

  it("declines approval requests when the chat has no active turn", async () => {
    const state = {
      ...createEmptyState(),
      projects: [createProject()],
      chats: [createChat({ status: "idle", activeTurnId: null })],
    };
    const { codex, services, store } = await createHarness(state);
    const emitSpy = vi.spyOn(services.eventHub, "emit");

    codex.emitServerRequest({
      id: 91,
      method: "item/commandExecution/requestApproval",
      params: { threadId: "thread_1" },
    });

    await vi.waitFor(() => {
      strictEqual(
        emitSpy.mock.calls.some((call) => call[0] === "agent.error"),
        true,
      );
    });
    strictEqual(
      emitSpy.mock.calls.some((call) => call[0] === "agent.approval.requested"),
      false,
    );
    deepStrictEqual(codex.respondToServerRequest.mock.calls[0], [
      91,
      { decision: "decline" },
    ]);

    codex.emitNotification({
      method: "serverRequest/resolved",
      params: { threadId: "thread_1", requestId: 91 },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    strictEqual(
      emitSpy.mock.calls.some((call) => call[0] === "agent.approval.resolved"),
      false,
    );
    strictEqual((await store.load()).chats[0]?.status, "idle");
  });

  it("declines approval requests for stale turns", async () => {
    const state = {
      ...createEmptyState(),
      projects: [createProject()],
      chats: [createChat({ status: "running", activeTurnId: "turn_current" })],
    };
    const { codex, services, store } = await createHarness(state);
    const emitSpy = vi.spyOn(services.eventHub, "emit");

    codex.emitServerRequest({
      id: 92,
      method: "item/commandExecution/requestApproval",
      params: { threadId: "thread_1", turnId: "turn_old" },
    });

    await vi.waitFor(() => {
      strictEqual(
        emitSpy.mock.calls.some((call) => call[0] === "agent.error"),
        true,
      );
    });
    strictEqual(
      emitSpy.mock.calls.some((call) => call[0] === "agent.approval.requested"),
      false,
    );
    deepStrictEqual(codex.respondToServerRequest.mock.calls[0], [
      92,
      { decision: "decline" },
    ]);

    codex.emitNotification({
      method: "serverRequest/resolved",
      params: { threadId: "thread_1", requestId: 92 },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    strictEqual(
      emitSpy.mock.calls.some((call) => call[0] === "agent.approval.resolved"),
      false,
    );
    const savedState = await store.load();
    strictEqual(savedState.chats[0]?.status, "running");
    strictEqual(savedState.chats[0]?.activeTurnId, "turn_current");
  });

  it("returns a waiting approval chat to running for tracked resolved requests", async () => {
    const state = {
      ...createEmptyState(),
      projects: [createProject()],
      chats: [createChat({ status: "running", activeTurnId: "turn_1" })],
    };
    const { codex, services, store } = await createHarness(state);
    const emitSpy = vi.spyOn(services.eventHub, "emit");

    codex.emitServerRequest({
      id: 93,
      method: "item/commandExecution/requestApproval",
      params: { threadId: "thread_1", turnId: "turn_1" },
    });
    await vi.waitFor(async () => {
      strictEqual((await store.load()).chats[0]?.status, "waitingForApproval");
    });

    codex.emitNotification({
      method: "serverRequest/resolved",
      params: { threadId: "thread_1" },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    strictEqual((await store.load()).chats[0]?.status, "waitingForApproval");
    strictEqual(
      emitSpy.mock.calls.some((call) => call[0] === "agent.approval.resolved"),
      false,
    );

    codex.emitNotification({
      method: "serverRequest/resolved",
      params: { threadId: "thread_1", requestId: 93 },
    });

    await vi.waitFor(async () => {
      strictEqual((await store.load()).chats[0]?.status, "running");
    });
    strictEqual((await store.load()).chats[0]?.activeTurnId, "turn_1");
    strictEqual(
      emitSpy.mock.calls.some((call) => call[0] === "agent.approval.resolved"),
      true,
    );
  });

  it("does not persist a user message when Codex rejects a turn", async () => {
    const state = {
      ...createEmptyState(),
      projects: [createProject()],
      chats: [createChat()],
    };
    const { codex, services, store } = await createHarness(state);
    codex.resumeThread.mockResolvedValueOnce({});
    codex.startTurn.mockRejectedValueOnce(new Error("Codex unavailable"));

    await rejects(
      services.sendMessage("chat_1", { text: "please edit" }),
      /Codex unavailable/,
    );

    const savedState = await store.load();
    strictEqual(savedState.messages.length, 0);
    strictEqual(savedState.chats[0]?.status, "failed");
  });

  it("buffers approval requests until a new turn is committed", async () => {
    const state = {
      ...createEmptyState(),
      projects: [createProject()],
      chats: [createChat()],
    };
    const { codex, services, store } = await createHarness(state);
    const emitSpy = vi.spyOn(services.eventHub, "emit");
    codex.resumeThread.mockResolvedValueOnce({});
    codex.startTurn.mockImplementationOnce(async () => {
      codex.emitServerRequest({
        id: 88,
        method: "item/commandExecution/requestApproval",
        params: { threadId: "thread_1" },
      });
      return { turn: { id: "turn_1" } };
    });

    await services.sendMessage("chat_1", { text: "please edit" });

    const savedState = await store.load();
    strictEqual(savedState.chats[0]?.status, "waitingForApproval");
    strictEqual(savedState.chats[0]?.activeTurnId, "turn_1");
    const approvalRequest = emitSpy.mock.calls.find(
      (call) => call[0] === "agent.approval.requested",
    )?.[1] as { requestId: string } | undefined;
    if (!approvalRequest) {
      throw new Error("Approval request was not emitted");
    }

    await services.answerApproval("chat_1", approvalRequest.requestId, {
      decision: "decline",
    });
    deepStrictEqual(codex.respondToServerRequest.mock.calls[0], [
      88,
      { decision: "decline" },
    ]);
  });

  it("declines buffered approval requests from a failed new turn", async () => {
    const state = {
      ...createEmptyState(),
      projects: [createProject()],
      chats: [createChat()],
    };
    const { codex, services, store } = await createHarness(state);
    const emitSpy = vi.spyOn(services.eventHub, "emit");
    codex.resumeThread.mockResolvedValueOnce({});
    codex.startTurn.mockImplementationOnce(async () => {
      codex.emitServerRequest({
        id: 89,
        method: "item/commandExecution/requestApproval",
        params: { threadId: "thread_1" },
      });
      throw new Error("Codex rejected the turn");
    });

    await rejects(
      services.sendMessage("chat_1", { text: "please edit" }),
      /Codex rejected the turn/,
    );

    const savedState = await store.load();
    strictEqual(savedState.messages.length, 0);
    strictEqual(savedState.chats[0]?.status, "failed");
    strictEqual(
      emitSpy.mock.calls.some((call) => call[0] === "agent.approval.requested"),
      false,
    );
    deepStrictEqual(codex.respondToServerRequest.mock.calls[0], [
      89,
      { decision: "decline" },
    ]);

    await rejects(
      services.sendMessage("chat_1", { text: "retry" }),
      /Chat is waiting for failed Codex turn cleanup/,
    );
    strictEqual(codex.startTurn.mock.calls.length, 1);

    codex.emitServerRequest({
      id: 90,
      method: "item/commandExecution/requestApproval",
      params: { threadId: "thread_1" },
    });
    deepStrictEqual(codex.respondToServerRequest.mock.calls[1], [
      90,
      { decision: "decline" },
    ]);
  });

  it("keeps the user message before fast Codex stream events", async () => {
    const state = {
      ...createEmptyState(),
      projects: [createProject()],
      chats: [createChat()],
    };
    const { codex, services, store } = await createHarness(state);
    codex.resumeThread.mockResolvedValueOnce({});
    codex.startTurn.mockImplementationOnce(async () => {
      codex.emitNotification({
        method: "item/agentMessage/delta",
        params: {
          threadId: "thread_1",
          itemId: "item_1",
          delta: "assistant response",
        },
      });
      return { turn: { id: "turn_1" } };
    });

    await services.sendMessage("chat_1", { text: "hello" });
    await vi.waitFor(async () => {
      strictEqual((await store.load()).messages.length, 2);
    });

    const savedState = await store.load();
    deepStrictEqual(
      savedState.messages.map((message) => message.role),
      ["user", "assistant"],
    );
  });

  it("keeps pending stream order when new notifications arrive during replay", async () => {
    const state = {
      ...createEmptyState(),
      projects: [createProject()],
      chats: [createChat()],
    };
    const { codex, services, store } = await createHarness(state);
    const emit = services.eventHub.emit.bind(services.eventHub);
    let injectedDuringReplay = false;
    vi.spyOn(services.eventHub, "emit").mockImplementation(
      (type, data, options) => {
        const event = emit(type, data, options);
        if (type === "agent.item.delta" && !injectedDuringReplay) {
          injectedDuringReplay = true;
          codex.emitNotification({
            method: "item/agentMessage/delta",
            params: {
              threadId: "thread_1",
              itemId: "item_b",
              delta: "B",
            },
          });
        }
        return event;
      },
    );
    codex.resumeThread.mockResolvedValueOnce({});
    codex.startTurn.mockImplementationOnce(async () => {
      codex.emitNotification({
        method: "item/agentMessage/delta",
        params: {
          threadId: "thread_1",
          itemId: "item_a",
          delta: "A",
        },
      });
      codex.emitNotification({
        method: "item/agentMessage/delta",
        params: {
          threadId: "thread_1",
          itemId: "item_c",
          delta: "C",
        },
      });
      return { turn: { id: "turn_1" } };
    });

    await services.sendMessage("chat_1", { text: "hello" });

    const savedState = await store.load();
    deepStrictEqual(
      savedState.messages.map((message) => message.text),
      ["hello", "A", "C", "B"],
    );
  });

  it("rejects a second new turn while the chat is starting one", async () => {
    const state = {
      ...createEmptyState(),
      projects: [createProject()],
      chats: [createChat()],
    };
    const { codex, services, store } = await createHarness(state);
    let resolveStartTurn: ((value: unknown) => void) | undefined;
    codex.resumeThread.mockResolvedValueOnce({});
    codex.startTurn.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveStartTurn = resolve;
        }),
    );

    const firstSend = services.sendMessage("chat_1", { text: "first" });
    await vi.waitFor(() => {
      strictEqual(codex.startTurn.mock.calls.length, 1);
    });

    await rejects(
      services.sendMessage("chat_1", { text: "second" }),
      /Chat already has an active Codex turn/,
    );
    if (!resolveStartTurn) {
      throw new Error("startTurn was not invoked");
    }
    resolveStartTurn({ turn: { id: "turn_1" } });
    await firstSend;

    const savedState = await store.load();
    deepStrictEqual(
      savedState.messages.map((message) => message.text),
      ["first"],
    );
    strictEqual(savedState.chats[0]?.status, "running");
    strictEqual(savedState.chats[0]?.activeTurnId, "turn_1");
    strictEqual(codex.startTurn.mock.calls.length, 1);
  });

  it("rejects messages while the chat is waiting for approval", async () => {
    const state = {
      ...createEmptyState(),
      projects: [createProject()],
      chats: [
        createChat({ status: "waitingForApproval", activeTurnId: "turn_1" }),
      ],
    };
    const { codex, services, store } = await createHarness(state);

    await rejects(
      services.sendMessage("chat_1", { text: "continue" }),
      /Chat is waiting for approval/,
    );

    const savedState = await store.load();
    strictEqual(savedState.messages.length, 0);
    strictEqual(savedState.chats[0]?.status, "waitingForApproval");
    strictEqual(codex.startTurn.mock.calls.length, 0);
    strictEqual(codex.steerTurn.mock.calls.length, 0);
  });

  it("keeps a running chat active when steering fails", async () => {
    const state = {
      ...createEmptyState(),
      projects: [createProject()],
      chats: [createChat({ status: "running", activeTurnId: "turn_1" })],
    };
    const { codex, services, store } = await createHarness(state);
    codex.resumeThread.mockResolvedValueOnce({});
    codex.steerTurn.mockRejectedValueOnce(new Error("steer rejected"));

    await rejects(
      services.sendMessage("chat_1", { text: "adjust course" }),
      /steer rejected/,
    );

    const savedState = await store.load();
    strictEqual(savedState.messages.length, 0);
    strictEqual(savedState.chats[0]?.status, "running");
    strictEqual(savedState.chats[0]?.activeTurnId, "turn_1");
    deepStrictEqual(codex.steerTurn.mock.calls[0], [
      "thread_1",
      "turn_1",
      "adjust course",
    ]);
    strictEqual(codex.startTurn.mock.calls.length, 0);
  });

  it("rejects steer requests when the chat has no active turn", async () => {
    const state = {
      ...createEmptyState(),
      projects: [createProject()],
      chats: [createChat({ status: "idle", activeTurnId: null })],
    };
    const { codex, services, store } = await createHarness(state);

    await rejects(
      services.steerMessage("chat_1", { text: "adjust course" }),
      /Chat does not have an active Codex turn/,
    );

    const savedState = await store.load();
    strictEqual(savedState.messages.length, 0);
    strictEqual(savedState.chats[0]?.status, "idle");
    strictEqual(codex.startTurn.mock.calls.length, 0);
    strictEqual(codex.steerTurn.mock.calls.length, 0);
  });

  it("removes streamed messages from a failed new turn", async () => {
    const state = {
      ...createEmptyState(),
      projects: [createProject()],
      chats: [createChat()],
    };
    const { codex, services, store } = await createHarness(state);
    codex.resumeThread.mockResolvedValueOnce({});
    codex.startTurn.mockImplementationOnce(async () => {
      codex.emitNotification({
        method: "item/agentMessage/delta",
        params: {
          threadId: "thread_1",
          itemId: "item_1",
          delta: "orphaned response",
        },
      });
      throw new Error("Codex rejected the turn");
    });

    await rejects(
      services.sendMessage("chat_1", { text: "hello" }),
      /Codex rejected the turn/,
    );

    const savedState = await store.load();
    strictEqual(savedState.messages.length, 0);
    strictEqual(savedState.chats[0]?.status, "failed");
  });
});
