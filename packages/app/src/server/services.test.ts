import { deepStrictEqual, rejects, strictEqual } from "node:assert";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it, vi } from "vitest";
import type { CodexBridge, CodexMessage } from "@phantompane/codex";
import { ServeStateStore } from "@phantompane/state";
import type { ChatRecord, ProjectRecord, ServeState } from "@phantompane/state";
import { ServeServices } from "./services";

const coreMocks = vi.hoisted(() => ({
  createContext: vi.fn(),
  deleteBranch: vi.fn(),
  deleteWorktree: vi.fn(),
  listWorktrees: vi.fn(),
  removeWorktree: vi.fn(),
  runCreateWorktree: vi.fn(),
}));

const gitMocks = vi.hoisted(() => ({
  getGitRoot: vi.fn(),
  getRemoteDefaultBranch: vi.fn(),
  getRemotes: vi.fn(),
  getUpstreamBranch: vi.fn(),
  pull: vi.fn(),
}));

vi.mock("@phantompane/core", () => coreMocks);
vi.mock("@phantompane/git", () => gitMocks);

const temporaryDirectories: string[] = [];
const timestamp = "2026-04-25T00:00:00.000Z";

class FakeCodexBridge {
  readonly notificationHandlers: Array<(message: CodexMessage) => void> = [];
  readonly processExitHandlers: Array<(error: Error) => void> = [];
  readonly serverRequestHandlers: Array<(message: CodexMessage) => void> = [];
  readonly interruptTurn = vi.fn();
  readonly listModels = vi.fn();
  readonly listSkills = vi.fn();
  readonly readAccount = vi.fn();
  readonly respondToServerRequest = vi.fn();
  readonly resumeThread = vi.fn();
  readonly searchFiles = vi.fn();
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

function createTestState(overrides: Partial<ServeState> = {}): ServeState {
  return {
    version: 1,
    projects: [],
    chats: [],
    messages: [],
    selectedProjectId: null,
    selectedChatId: null,
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
  const codexHome = await createTemporaryDirectory();
  const services = new ServeServices({
    codex: codex as unknown as CodexBridge,
    codexHome,
    store,
  });
  return { codex, services, store };
}

class ImportRaceStore extends ServeStateStore {
  private hasInjectedState = false;

  constructor(
    dataDir: string,
    private readonly injectState: (state: ServeState) => ServeState,
  ) {
    super(dataDir);
  }

  override async update(
    updater: (state: ServeState) => ServeState | Promise<ServeState>,
  ): Promise<ServeState> {
    if (!this.hasInjectedState) {
      this.hasInjectedState = true;
      await this.save(this.injectState(await this.load()));
    }
    return await super.update(updater);
  }
}

async function writeCodexSession(
  codexHome: string,
  lines: Array<Record<string, unknown>>,
  fileName = "rollout-2026-04-25T00-00-00-019dc000-0000-7000-8000-000000000001.jsonl",
): Promise<void> {
  const directory = join(codexHome, "archived_sessions");
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, fileName),
    `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
  );
}

describe("ServeServices", () => {
  it("lists project worktrees with phantom list data and creates missing chat records", async () => {
    const state = {
      ...createTestState(),
      projects: [createProject()],
    };
    const { services, store } = await createHarness(state);
    coreMocks.listWorktrees.mockResolvedValueOnce({
      ok: true,
      value: {
        worktrees: [
          {
            name: "main",
            path: "/repo",
            pathToDisplay: ".",
            branch: "main",
            isClean: true,
          },
          {
            name: "feature/list",
            path: "/repo/.git/phantom/worktrees/feature/list",
            pathToDisplay: ".git/phantom/worktrees/feature/list",
            branch: "feature/list",
            isClean: false,
          },
        ],
      },
    });

    const worktrees = await services.listProjectWorktrees("proj_1");

    deepStrictEqual(coreMocks.listWorktrees.mock.calls[0], [
      "/repo",
      { includePrunable: false },
    ]);
    deepStrictEqual(
      worktrees.map((worktree) => ({
        name: worktree.name,
        path: worktree.path,
        pathToDisplay: worktree.pathToDisplay,
        isClean: worktree.isClean,
        isMainWorktree: worktree.isMainWorktree,
        chatStatus: worktree.chatStatus,
      })),
      [
        {
          name: "main",
          path: "/repo",
          pathToDisplay: ".",
          isClean: true,
          isMainWorktree: true,
          chatStatus: "idle",
        },
        {
          name: "feature/list",
          path: "/repo/.git/phantom/worktrees/feature/list",
          pathToDisplay: ".git/phantom/worktrees/feature/list",
          isClean: false,
          isMainWorktree: false,
          chatStatus: "idle",
        },
      ],
    );
    strictEqual(
      worktrees.every((worktree) => worktree.chatId),
      true,
    );

    const savedState = await store.load();
    deepStrictEqual(
      savedState.chats.map((chat) => chat.worktreePath),
      ["/repo", "/repo/.git/phantom/worktrees/feature/list"],
    );
  });

  it("does not persist state when worktree sync has no changes", async () => {
    const state = {
      ...createTestState(),
      projects: [createProject()],
      chats: [createChat({ worktreeName: "main", worktreePath: "/repo" })],
    };
    const { services, store } = await createHarness(state);
    const saveSpy = vi.spyOn(store, "save");
    coreMocks.listWorktrees.mockResolvedValueOnce({
      ok: true,
      value: {
        worktrees: [
          {
            name: "main",
            path: "/repo",
            pathToDisplay: ".",
            branch: "main",
            isClean: true,
          },
        ],
      },
    });

    const worktrees = await services.listProjectWorktrees("proj_1");

    strictEqual(worktrees[0]?.chatId, "chat_1");
    strictEqual(saveSpy.mock.calls.length, 0);
  });

  it("pins the main worktree above managed worktrees", async () => {
    const state = {
      ...createTestState(),
      projects: [createProject()],
    };
    const { services } = await createHarness(state);
    coreMocks.listWorktrees.mockResolvedValueOnce({
      ok: true,
      value: {
        worktrees: [
          {
            name: "feature/list",
            path: "/repo/.git/phantom/worktrees/feature/list",
            pathToDisplay: ".git/phantom/worktrees/feature/list",
            branch: "feature/list",
            isClean: true,
          },
          {
            name: "main",
            path: "/repo",
            pathToDisplay: ".",
            branch: "main",
            isClean: true,
          },
        ],
      },
    });

    const worktrees = await services.listProjectWorktrees("proj_1");

    deepStrictEqual(
      worktrees.map((worktree) => ({
        path: worktree.path,
        isMainWorktree: worktree.isMainWorktree,
      })),
      [
        { path: "/repo", isMainWorktree: true },
        {
          path: "/repo/.git/phantom/worktrees/feature/list",
          isMainWorktree: false,
        },
      ],
    );
  });

  it("falls back to persisted chats when live worktree listing fails", async () => {
    const state = {
      ...createTestState(),
      projects: [createProject()],
      chats: [
        createChat({
          branchName: "main",
          title: "Persisted main",
          worktreeName: "main",
          worktreePath: "/repo",
        }),
      ],
    };
    const { services } = await createHarness(state);
    coreMocks.listWorktrees.mockRejectedValueOnce(new Error("git failed"));

    const worktrees = await services.listProjectWorktrees("proj_1");

    deepStrictEqual(worktrees, [
      {
        name: "main",
        path: "/repo",
        pathToDisplay: "/repo",
        branch: "main",
        isClean: true,
        isMainWorktree: true,
        isManagedByPhantom: false,
        chatId: "chat_1",
        chatStatus: "idle",
        chatTitle: "Persisted main",
      },
    ]);
  });

  it("preserves managed status when returning persisted chats without sync", async () => {
    const worktreePath = "/repo/.git/phantom/worktrees/feature";
    const state = {
      ...createTestState(),
      projects: [createProject()],
      chats: [
        createChat({
          branchName: "feature",
          title: "Persisted feature",
          worktreeName: "feature",
          worktreePath,
        }),
      ],
    };
    const { services } = await createHarness(state);

    const worktrees = await services.listProjectWorktrees("proj_1", {
      sync: false,
    });

    deepStrictEqual(worktrees, [
      {
        name: "feature",
        path: worktreePath,
        pathToDisplay: worktreePath,
        branch: "feature",
        isClean: true,
        isMainWorktree: false,
        isManagedByPhantom: true,
        chatId: "chat_1",
        chatStatus: "idle",
        chatTitle: "Persisted feature",
      },
    ]);
    strictEqual(coreMocks.listWorktrees.mock.calls.length, 0);
  });

  it("imports existing Codex chat history for project worktrees", async () => {
    const state = {
      ...createTestState(),
      projects: [createProject()],
    };
    const store = new ServeStateStore(await createTemporaryDirectory());
    await store.save(state);
    const codex = new FakeCodexBridge();
    const codexHome = await createTemporaryDirectory();
    await writeCodexSession(codexHome, [
      {
        timestamp: "2026-04-25T00:00:00.000Z",
        type: "session_meta",
        payload: {
          id: "019dc000-0000-7000-8000-000000000001",
          timestamp: "2026-04-25T00:00:00.000Z",
          cwd: "/repo/.git/phantom/worktrees/feature/list",
          source: "vscode",
        },
      },
      {
        timestamp: "2026-04-25T00:01:00.000Z",
        type: "event_msg",
        payload: {
          type: "thread_name_updated",
          thread_name: "Existing work",
        },
      },
      {
        timestamp: "2026-04-25T00:02:00.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Please update the page" }],
        },
      },
      {
        timestamp: "2026-04-25T00:03:00.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "I updated the page." }],
        },
      },
    ]);
    const services = new ServeServices({
      codex: codex as unknown as CodexBridge,
      codexHome,
      store,
    });
    coreMocks.listWorktrees.mockResolvedValueOnce({
      ok: true,
      value: {
        worktrees: [
          {
            name: "feature/list",
            path: "/repo/.git/phantom/worktrees/feature/list",
            pathToDisplay: ".git/phantom/worktrees/feature/list",
            branch: "feature/list",
            isClean: true,
          },
        ],
      },
    });

    const worktrees = await services.listProjectWorktrees("proj_1");

    strictEqual(worktrees[0]?.chatTitle, "Existing work");
    strictEqual(worktrees[0]?.chatStatus, "idle");
    const savedState = await store.load();
    strictEqual(savedState.chats.length, 1);
    strictEqual(
      savedState.chats[0]?.codexThreadId,
      "019dc000-0000-7000-8000-000000000001",
    );
    deepStrictEqual(
      savedState.messages.map((message) => [message.role, message.text]),
      [
        ["user", "Please update the page"],
        ["assistant", "I updated the page."],
      ],
    );
  });

  it("preserves local chats that already match imported Codex threads", async () => {
    const threadId = "019dc000-0000-7000-8000-000000000001";
    const worktreePath = "/repo/.git/phantom/worktrees/feature/list";
    const state = {
      ...createTestState(),
      projects: [createProject()],
      chats: [
        createChat({
          id: "chat_local",
          codexThreadId: threadId,
          title: "feature/list",
          worktreeName: "feature/list",
          worktreePath,
          branchName: "feature/list",
          updatedAt: "2026-04-25T00:04:00.000Z",
        }),
      ],
      messages: [
        {
          id: "msg_local",
          chatId: "chat_local",
          role: "user" as const,
          text: "hi",
          createdAt: "2026-04-25T00:04:00.000Z",
        },
      ],
      selectedChatId: "chat_local",
    };
    const store = new ServeStateStore(await createTemporaryDirectory());
    await store.save(state);
    const codex = new FakeCodexBridge();
    const codexHome = await createTemporaryDirectory();
    await writeCodexSession(codexHome, [
      {
        timestamp: "2026-04-25T00:00:00.000Z",
        type: "session_meta",
        payload: {
          id: threadId,
          timestamp: "2026-04-25T00:00:00.000Z",
          cwd: worktreePath,
          source: "vscode",
        },
      },
      {
        timestamp: "2026-04-25T00:01:00.000Z",
        type: "event_msg",
        payload: {
          type: "thread_name_updated",
          thread_name: "hi",
        },
      },
      {
        timestamp: "2026-04-25T00:02:00.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "hi" }],
        },
      },
    ]);
    const services = new ServeServices({
      codex: codex as unknown as CodexBridge,
      codexHome,
      store,
    });
    coreMocks.listWorktrees.mockResolvedValueOnce({
      ok: true,
      value: {
        worktrees: [
          {
            name: "feature/list",
            path: worktreePath,
            pathToDisplay: ".git/phantom/worktrees/feature/list",
            branch: "feature/list",
            isClean: true,
          },
        ],
      },
    });

    const worktrees = await services.listProjectWorktrees("proj_1");

    strictEqual(worktrees[0]?.chatId, "chat_local");
    strictEqual(worktrees[0]?.chatTitle, "feature/list");
    const savedState = await store.load();
    strictEqual(savedState.chats.length, 1);
    strictEqual(savedState.chats[0]?.id, "chat_local");
    strictEqual(savedState.selectedChatId, "chat_local");
    deepStrictEqual(
      savedState.messages.map((message) => [message.chatId, message.text]),
      [["chat_local", "hi"]],
    );
  });

  it("imports distinct Codex threads when a failed local chat exists for the same worktree", async () => {
    const failedThreadId = "019dc000-0000-7000-8000-000000000001";
    const importedThreadId = "019dc000-0000-7000-8000-000000000002";
    const worktreePath = "/repo/.git/phantom/worktrees/feature/list";
    const state = {
      ...createTestState(),
      projects: [createProject()],
      chats: [
        createChat({
          id: "chat_failed",
          codexThreadId: failedThreadId,
          title: "failed",
          status: "failed",
          worktreeName: "feature/list",
          worktreePath,
          branchName: "feature/list",
          updatedAt: "2026-04-25T00:04:00.000Z",
        }),
      ],
      selectedChatId: "chat_failed",
    };
    const store = new ServeStateStore(await createTemporaryDirectory());
    await store.save(state);
    const codex = new FakeCodexBridge();
    const codexHome = await createTemporaryDirectory();
    await writeCodexSession(
      codexHome,
      [
        {
          timestamp: "2026-04-25T00:00:00.000Z",
          type: "session_meta",
          payload: {
            id: importedThreadId,
            timestamp: "2026-04-25T00:00:00.000Z",
            cwd: worktreePath,
            source: "vscode",
          },
        },
        {
          timestamp: "2026-04-25T00:01:00.000Z",
          type: "event_msg",
          payload: {
            type: "thread_name_updated",
            thread_name: "imported",
          },
        },
      ],
      "rollout-2026-04-25T00-00-00-019dc000-0000-7000-8000-000000000002.jsonl",
    );
    const services = new ServeServices({
      codex: codex as unknown as CodexBridge,
      codexHome,
      store,
    });
    coreMocks.listWorktrees.mockResolvedValueOnce({
      ok: true,
      value: {
        worktrees: [
          {
            name: "feature/list",
            path: worktreePath,
            pathToDisplay: ".git/phantom/worktrees/feature/list",
            branch: "feature/list",
            isClean: true,
          },
        ],
      },
    });

    await services.listProjectWorktrees("proj_1");

    const savedState = await store.load();
    deepStrictEqual(
      savedState.chats.map((chat) => [chat.id, chat.codexThreadId]),
      [
        ["chat_failed", failedThreadId],
        [`chat_codex_${importedThreadId}`, importedThreadId],
      ],
    );
  });

  it("uses the latest existing Codex thread after creating a worktree", async () => {
    const state = {
      ...createTestState(),
      projects: [createProject()],
    };
    const store = new ServeStateStore(await createTemporaryDirectory());
    await store.save(state);
    const codex = new FakeCodexBridge();
    const codexHome = await createTemporaryDirectory();
    await writeCodexSession(codexHome, [
      {
        timestamp: "2026-04-25T00:00:00.000Z",
        type: "session_meta",
        payload: {
          id: "019dc000-0000-7000-8000-000000000002",
          timestamp: "2026-04-25T00:00:00.000Z",
          cwd: "/repo/.git/phantom/worktrees/feature",
          source: "vscode",
        },
      },
      {
        timestamp: "2026-04-25T00:01:00.000Z",
        type: "event_msg",
        payload: {
          type: "thread_name_updated",
          thread_name: "Continue feature",
        },
      },
      {
        timestamp: "2026-04-25T00:02:00.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Continue from here" }],
        },
      },
    ]);
    const services = new ServeServices({
      codex: codex as unknown as CodexBridge,
      codexHome,
      store,
    });
    coreMocks.runCreateWorktree.mockResolvedValueOnce({
      ok: true,
      value: {
        name: "feature",
        path: "/repo/.git/phantom/worktrees/feature",
      },
    });

    const chat = await services.createChat("proj_1", { name: "feature" });

    strictEqual(chat.title, "Continue feature");
    strictEqual(chat.codexThreadId, "019dc000-0000-7000-8000-000000000002");
    strictEqual(codex.startThread.mock.calls.length, 0);
    const savedState = await store.load();
    strictEqual(savedState.selectedChatId, chat.id);
    deepStrictEqual(
      savedState.messages.map((message) => [message.role, message.text]),
      [["user", "Continue from here"]],
    );
  });

  it("deduplicates imported chats against current state when creating a worktree", async () => {
    const threadId = "019dc000-0000-7000-8000-000000000002";
    const worktreePath = "/repo/.git/phantom/worktrees/feature";
    const state = {
      ...createTestState(),
      projects: [createProject()],
    };
    const importedChat = createChat({
      id: `chat_codex_${threadId}`,
      codexThreadId: threadId,
      title: "Continue feature",
      worktreeName: "feature",
      worktreePath,
      branchName: "feature",
    });
    const store = new ImportRaceStore(
      await createTemporaryDirectory(),
      (currentState) => ({
        ...currentState,
        chats: [...currentState.chats, importedChat],
        messages: [
          ...currentState.messages,
          {
            id: `${importedChat.id}_msg_0`,
            chatId: importedChat.id,
            role: "user" as const,
            text: "Continue from here",
            createdAt: "2026-04-25T00:02:00.000Z",
          },
        ],
      }),
    );
    await store.save(state);
    const codex = new FakeCodexBridge();
    const codexHome = await createTemporaryDirectory();
    await writeCodexSession(codexHome, [
      {
        timestamp: "2026-04-25T00:00:00.000Z",
        type: "session_meta",
        payload: {
          id: threadId,
          timestamp: "2026-04-25T00:00:00.000Z",
          cwd: worktreePath,
          source: "vscode",
        },
      },
      {
        timestamp: "2026-04-25T00:01:00.000Z",
        type: "event_msg",
        payload: {
          type: "thread_name_updated",
          thread_name: "Continue feature",
        },
      },
      {
        timestamp: "2026-04-25T00:02:00.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Continue from here" }],
        },
      },
    ]);
    const services = new ServeServices({
      codex: codex as unknown as CodexBridge,
      codexHome,
      store,
    });
    coreMocks.runCreateWorktree.mockResolvedValueOnce({
      ok: true,
      value: {
        name: "feature",
        path: worktreePath,
      },
    });

    const chat = await services.createChat("proj_1", { name: "feature" });

    strictEqual(chat.id, importedChat.id);
    const savedState = await store.load();
    strictEqual(
      savedState.chats.filter((candidate) => candidate.id === importedChat.id)
        .length,
      1,
    );
    strictEqual(
      savedState.messages.filter(
        (message) => message.id === `${importedChat.id}_msg_0`,
      ).length,
      1,
    );
    strictEqual(savedState.selectedChatId, importedChat.id);
  });

  it("rejects approval responses from a different chat", async () => {
    const state = {
      ...createTestState(),
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
      ...createTestState(),
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
      ...createTestState(),
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

  it("syncs a project worktree branch with git pull", async () => {
    const state = {
      ...createTestState(),
      projects: [createProject()],
    };
    const { services } = await createHarness(state);
    coreMocks.createContext.mockResolvedValueOnce({
      gitRoot: "/repo",
      worktreesDirectory: "/repo/.git/phantom/worktrees",
      preferences: {},
      config: {},
    });
    coreMocks.listWorktrees.mockResolvedValueOnce({
      ok: true,
      value: {
        worktrees: [
          {
            name: "main",
            path: "/repo",
            pathToDisplay: ".",
            branch: "main",
            isClean: true,
          },
        ],
      },
    });
    gitMocks.getUpstreamBranch.mockResolvedValueOnce("origin/main");
    gitMocks.getRemotes.mockResolvedValueOnce(["origin"]);
    gitMocks.pull.mockResolvedValueOnce({ ok: true, value: undefined });

    const result = await services.syncProjectWorktreeBranch("proj_1", {
      name: "main",
      path: "/repo",
    });

    deepStrictEqual(result, { message: "Synced branch 'main'" });
    deepStrictEqual(gitMocks.getUpstreamBranch.mock.calls[0], [
      { cwd: "/repo" },
    ]);
    deepStrictEqual(gitMocks.pull.mock.calls[0], [
      { cwd: "/repo", remote: "origin", branch: "main" },
    ]);
  });

  it("syncs a project worktree branch with a slash-named upstream remote", async () => {
    const state = {
      ...createTestState(),
      projects: [createProject()],
    };
    const { services } = await createHarness(state);
    coreMocks.createContext.mockResolvedValueOnce({
      gitRoot: "/repo",
      worktreesDirectory: "/repo/.git/phantom/worktrees",
      preferences: {},
      config: {},
    });
    coreMocks.listWorktrees.mockResolvedValueOnce({
      ok: true,
      value: {
        worktrees: [
          {
            name: "feature/sync",
            path: "/repo/.git/phantom/worktrees/feature/sync",
            pathToDisplay: ".git/phantom/worktrees/feature/sync",
            branch: "feature/sync",
            isClean: true,
          },
        ],
      },
    });
    gitMocks.getUpstreamBranch.mockResolvedValueOnce("fork/team/feature/sync");
    gitMocks.getRemotes.mockResolvedValueOnce(["fork", "fork/team"]);
    gitMocks.pull.mockResolvedValueOnce({ ok: true, value: undefined });

    await services.syncProjectWorktreeBranch("proj_1", {
      name: "feature/sync",
      path: "/repo/.git/phantom/worktrees/feature/sync",
    });

    deepStrictEqual(gitMocks.pull.mock.calls[0], [
      {
        cwd: "/repo/.git/phantom/worktrees/feature/sync",
        remote: "fork/team",
        branch: "feature/sync",
      },
    ]);
  });

  it("syncs a project worktree branch with a local upstream", async () => {
    const state = {
      ...createTestState(),
      projects: [createProject()],
    };
    const { services } = await createHarness(state);
    coreMocks.createContext.mockResolvedValueOnce({
      gitRoot: "/repo",
      worktreesDirectory: "/repo/.git/phantom/worktrees",
      preferences: {},
      config: {},
    });
    coreMocks.listWorktrees.mockResolvedValueOnce({
      ok: true,
      value: {
        worktrees: [
          {
            name: "feature/sync",
            path: "/repo/.git/phantom/worktrees/feature/sync",
            pathToDisplay: ".git/phantom/worktrees/feature/sync",
            branch: "feature/sync",
            isClean: true,
          },
        ],
      },
    });
    gitMocks.getUpstreamBranch.mockResolvedValueOnce("main");
    gitMocks.getRemotes.mockResolvedValueOnce([]);
    gitMocks.pull.mockResolvedValueOnce({ ok: true, value: undefined });

    await services.syncProjectWorktreeBranch("proj_1", {
      name: "feature/sync",
      path: "/repo/.git/phantom/worktrees/feature/sync",
    });

    deepStrictEqual(gitMocks.pull.mock.calls[0], [
      {
        cwd: "/repo/.git/phantom/worktrees/feature/sync",
        remote: undefined,
        branch: undefined,
      },
    ]);
  });

  it("syncs a project worktree branch against the remote default branch when no upstream is configured", async () => {
    const state = {
      ...createTestState(),
      projects: [createProject()],
    };
    const { services } = await createHarness(state);
    coreMocks.createContext.mockResolvedValueOnce({
      gitRoot: "/repo",
      worktreesDirectory: "/repo/.git/phantom/worktrees",
      preferences: {},
      config: {},
    });
    coreMocks.listWorktrees.mockResolvedValueOnce({
      ok: true,
      value: {
        worktrees: [
          {
            name: "feature/sync",
            path: "/repo/.git/phantom/worktrees/feature/sync",
            pathToDisplay: ".git/phantom/worktrees/feature/sync",
            branch: "feature/sync",
            isClean: true,
          },
        ],
      },
    });
    gitMocks.getUpstreamBranch.mockResolvedValueOnce(null);
    gitMocks.getRemotes.mockResolvedValueOnce(["upstream"]);
    gitMocks.getRemoteDefaultBranch.mockResolvedValueOnce("trunk");
    gitMocks.pull.mockResolvedValueOnce({ ok: true, value: undefined });

    await services.syncProjectWorktreeBranch("proj_1", {
      name: "feature/sync",
      path: "/repo/.git/phantom/worktrees/feature/sync",
    });

    deepStrictEqual(gitMocks.pull.mock.calls[0], [
      {
        cwd: "/repo/.git/phantom/worktrees/feature/sync",
        remote: "upstream",
        branch: "trunk",
      },
    ]);
  });

  it.each([
    {
      description: "running",
      chat: { status: "running" as const },
    },
    {
      description: "waiting for approval",
      chat: { status: "waitingForApproval" as const },
    },
    {
      description: "active turn",
      chat: { activeTurnId: "turn_1" },
    },
    {
      description: "pending turn",
      chat: {},
      markPending: true,
    },
  ])("does not sync a worktree with a $description chat", async (scenario) => {
    const worktreePath = "/repo/.git/phantom/worktrees/worktree";
    const state = {
      ...createTestState(),
      projects: [createProject()],
      chats: [
        createChat({
          ...scenario.chat,
          worktreeName: "worktree",
          worktreePath,
        }),
      ],
    };
    const { services } = await createHarness(state);
    if (scenario.markPending) {
      (
        services as unknown as { pendingChatTurns: Set<string> }
      ).pendingChatTurns.add("chat_1");
    }
    coreMocks.createContext.mockResolvedValueOnce({
      gitRoot: "/repo",
      worktreesDirectory: "/repo/.git/phantom/worktrees",
      preferences: {},
      config: {},
    });
    coreMocks.listWorktrees.mockResolvedValueOnce({
      ok: true,
      value: {
        worktrees: [
          {
            name: "worktree",
            path: worktreePath,
            pathToDisplay: ".git/phantom/worktrees/worktree",
            branch: "worktree",
            isClean: true,
          },
        ],
      },
    });

    await rejects(
      services.syncProjectWorktreeBranch("proj_1", { name: "worktree" }),
      /has an active chat/,
    );

    strictEqual(gitMocks.pull.mock.calls.length, 0);
  });

  it("deletes a project worktree and removes its local chat history", async () => {
    const state = {
      ...createTestState(),
      projects: [createProject()],
      chats: [
        createChat({
          id: "chat_feature",
          worktreeName: "feature",
          worktreePath: "/repo/.git/phantom/worktrees/feature",
          branchName: "feature",
        }),
        createChat({
          id: "chat_other",
          worktreeName: "other",
          worktreePath: "/repo/.git/phantom/worktrees/other",
          branchName: "other",
        }),
      ],
      messages: [
        {
          id: "msg_feature",
          chatId: "chat_feature",
          role: "user" as const,
          text: "remove me",
          createdAt: timestamp,
        },
        {
          id: "msg_other",
          chatId: "chat_other",
          role: "user" as const,
          text: "keep me",
          createdAt: timestamp,
        },
      ],
      selectedChatId: "chat_feature",
    };
    const { services, store } = await createHarness(state);
    coreMocks.createContext.mockResolvedValueOnce({
      gitRoot: "/repo",
      worktreesDirectory: "/repo/.git/phantom/worktrees",
      preferences: { keepBranch: true },
      config: { preDelete: { commands: ["pnpm stop"] } },
    });
    coreMocks.listWorktrees.mockResolvedValueOnce({
      ok: true,
      value: {
        worktrees: [
          {
            name: "feature",
            path: "/repo/.git/phantom/worktrees/feature",
            pathToDisplay: ".git/phantom/worktrees/feature",
            branch: "feature",
            isClean: true,
          },
        ],
      },
    });
    coreMocks.deleteWorktree.mockResolvedValueOnce({
      ok: true,
      value: { message: "Deleted worktree 'feature'" },
    });

    const result = await services.deleteProjectWorktree("proj_1", {
      name: "feature",
      force: true,
    });

    deepStrictEqual(result, { message: "Deleted worktree 'feature'" });
    deepStrictEqual(coreMocks.deleteWorktree.mock.calls[0], [
      "/repo",
      "/repo/.git/phantom/worktrees",
      "feature",
      {
        force: true,
        keepBranch: true,
        path: "/repo/.git/phantom/worktrees/feature",
      },
      ["pnpm stop"],
    ]);
    const savedState = await store.load();
    deepStrictEqual(
      savedState.chats.map((chat) => chat.id),
      ["chat_other"],
    );
    deepStrictEqual(
      savedState.messages.map((message) => message.id),
      ["msg_other"],
    );
    strictEqual(savedState.selectedChatId, null);
  });

  it("deletes persisted chats matched by worktree path when names drift", async () => {
    const worktreePath = "/repo/.git/phantom/worktrees/renamed";
    const state = {
      ...createTestState(),
      projects: [createProject()],
      chats: [
        createChat({
          id: "chat_renamed",
          worktreeName: "old-name",
          worktreePath,
          branchName: "old-name",
        }),
      ],
      messages: [
        {
          id: "msg_renamed",
          chatId: "chat_renamed",
          role: "user" as const,
          text: "remove me too",
          createdAt: timestamp,
        },
      ],
      selectedChatId: "chat_renamed",
    };
    const { services, store } = await createHarness(state);
    coreMocks.createContext.mockResolvedValueOnce({
      gitRoot: "/repo",
      worktreesDirectory: "/repo/.git/phantom/worktrees",
      preferences: {},
      config: {},
    });
    coreMocks.listWorktrees.mockResolvedValueOnce({
      ok: true,
      value: {
        worktrees: [
          {
            name: "renamed",
            path: worktreePath,
            pathToDisplay: ".git/phantom/worktrees/renamed",
            branch: "renamed",
            isClean: true,
          },
        ],
      },
    });
    coreMocks.deleteWorktree.mockResolvedValueOnce({
      ok: true,
      value: { message: "Deleted worktree 'renamed'" },
    });

    await services.deleteProjectWorktree("proj_1", { name: "renamed" });

    const savedState = await store.load();
    deepStrictEqual(savedState.chats, []);
    deepStrictEqual(savedState.messages, []);
    strictEqual(savedState.selectedChatId, null);
  });

  it("rejects deleting worktrees outside the managed Phantom directory", async () => {
    const state = {
      ...createTestState(),
      projects: [createProject()],
    };
    const { services } = await createHarness(state);
    coreMocks.createContext.mockResolvedValueOnce({
      gitRoot: "/repo",
      worktreesDirectory: "/repo/.git/phantom/worktrees",
      preferences: {},
      config: {},
    });
    coreMocks.listWorktrees.mockResolvedValueOnce({
      ok: true,
      value: {
        worktrees: [
          {
            name: "feature",
            path: "/repo/other-worktree",
            pathToDisplay: "other-worktree",
            branch: "feature",
            isClean: true,
          },
          {
            name: "feature",
            path: "/repo/.git/phantom/worktrees/feature",
            pathToDisplay: ".git/phantom/worktrees/feature",
            branch: "feature",
            isClean: true,
          },
        ],
      },
    });

    await rejects(
      services.deleteProjectWorktree("proj_1", {
        name: "feature",
        path: "/repo/other-worktree",
      }),
      /not managed by Phantom/,
    );

    strictEqual(coreMocks.deleteWorktree.mock.calls.length, 0);
  });

  it("deletes and cleans up only the selected worktree path when names collide", async () => {
    const targetPath = "/repo/.git/phantom/worktrees/first";
    const otherPath = "/repo/.git/phantom/worktrees/second";
    const state = {
      ...createTestState(),
      projects: [createProject()],
      chats: [
        createChat({
          id: "chat_target",
          branchName: "abc1234",
          worktreeName: "abc1234",
          worktreePath: targetPath,
        }),
        createChat({
          id: "chat_other",
          branchName: "abc1234",
          worktreeName: "abc1234",
          worktreePath: otherPath,
        }),
      ],
      messages: [
        {
          id: "msg_target",
          chatId: "chat_target",
          role: "user" as const,
          text: "remove me",
          createdAt: timestamp,
        },
        {
          id: "msg_other",
          chatId: "chat_other",
          role: "user" as const,
          text: "keep me",
          createdAt: timestamp,
        },
      ],
      selectedChatId: "chat_target",
    };
    const { services, store } = await createHarness(state);
    coreMocks.createContext.mockResolvedValueOnce({
      gitRoot: "/repo",
      worktreesDirectory: "/repo/.git/phantom/worktrees",
      preferences: {},
      config: {},
    });
    coreMocks.listWorktrees.mockResolvedValueOnce({
      ok: true,
      value: {
        worktrees: [
          {
            name: "abc1234",
            path: targetPath,
            pathToDisplay: ".git/phantom/worktrees/first",
            branch: "abc1234",
            isClean: true,
          },
          {
            name: "abc1234",
            path: otherPath,
            pathToDisplay: ".git/phantom/worktrees/second",
            branch: "abc1234",
            isClean: true,
          },
        ],
      },
    });
    coreMocks.deleteWorktree.mockResolvedValueOnce({
      ok: true,
      value: { message: "Deleted worktree 'abc1234'" },
    });

    await services.deleteProjectWorktree("proj_1", {
      name: "abc1234",
      path: targetPath,
    });

    deepStrictEqual(coreMocks.deleteWorktree.mock.calls[0], [
      "/repo",
      "/repo/.git/phantom/worktrees",
      "abc1234",
      { force: undefined, keepBranch: false, path: targetPath },
      undefined,
    ]);
    const savedState = await store.load();
    deepStrictEqual(
      savedState.chats.map((chat) => chat.id),
      ["chat_other"],
    );
    deepStrictEqual(
      savedState.messages.map((message) => message.id),
      ["msg_other"],
    );
    strictEqual(savedState.selectedChatId, null);
  });

  it("does not delete a worktree with an active chat", async () => {
    const worktreePath = "/repo/.git/phantom/worktrees/worktree";
    const state = {
      ...createTestState(),
      projects: [createProject()],
      chats: [
        createChat({
          branchName: "old-name",
          status: "running",
          activeTurnId: "turn_1",
          worktreeName: "old-name",
          worktreePath,
        }),
      ],
    };
    const { services } = await createHarness(state);
    coreMocks.createContext.mockResolvedValueOnce({
      gitRoot: "/repo",
      worktreesDirectory: "/repo/.git/phantom/worktrees",
      preferences: {},
      config: {},
    });
    coreMocks.listWorktrees.mockResolvedValueOnce({
      ok: true,
      value: {
        worktrees: [
          {
            name: "worktree",
            path: worktreePath,
            pathToDisplay: ".git/phantom/worktrees/worktree",
            branch: "worktree",
            isClean: true,
          },
        ],
      },
    });

    await rejects(
      services.deleteProjectWorktree("proj_1", { name: "worktree" }),
      /has an active chat/,
    );

    strictEqual(coreMocks.deleteWorktree.mock.calls.length, 0);
  });

  it("does not delete a worktree while a chat is starting a turn", async () => {
    const worktreePath = "/repo/.git/phantom/worktrees/worktree";
    const state = {
      ...createTestState(),
      projects: [createProject()],
      chats: [createChat({ worktreePath })],
    };
    const { codex, services } = await createHarness(state);
    let resolveStartTurn: ((value: unknown) => void) | undefined;
    codex.resumeThread.mockResolvedValueOnce({});
    codex.startTurn.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveStartTurn = resolve;
        }),
    );

    const send = services.sendMessage("chat_1", { text: "start work" });
    await vi.waitFor(() => {
      strictEqual(codex.startTurn.mock.calls.length, 1);
    });

    coreMocks.createContext.mockResolvedValueOnce({
      gitRoot: "/repo",
      worktreesDirectory: "/repo/.git/phantom/worktrees",
      preferences: {},
      config: {},
    });
    coreMocks.listWorktrees.mockResolvedValueOnce({
      ok: true,
      value: {
        worktrees: [
          {
            name: "worktree",
            path: worktreePath,
            pathToDisplay: ".git/phantom/worktrees/worktree",
            branch: "worktree",
            isClean: true,
          },
        ],
      },
    });

    await rejects(
      services.deleteProjectWorktree("proj_1", { name: "worktree" }),
      /has an active chat/,
    );

    strictEqual(coreMocks.deleteWorktree.mock.calls.length, 0);
    if (!resolveStartTurn) {
      throw new Error("startTurn was not invoked");
    }
    resolveStartTurn({ turn: { id: "turn_1" } });
    await send;
  });

  it("skips non-directory Codex history roots when creating a worktree", async () => {
    const state = {
      ...createTestState(),
      projects: [createProject()],
    };
    const store = new ServeStateStore(await createTemporaryDirectory());
    await store.save(state);
    const codex = new FakeCodexBridge();
    const codexHome = await createTemporaryDirectory();
    await writeFile(join(codexHome, "sessions"), "not a directory");
    const services = new ServeServices({
      codex: codex as unknown as CodexBridge,
      codexHome,
      store,
    });
    coreMocks.runCreateWorktree.mockResolvedValueOnce({
      ok: true,
      value: {
        name: "feature",
        path: "/repo/.git/phantom/worktrees/feature",
      },
    });
    codex.startThread.mockResolvedValueOnce({ thread: { id: "thread_1" } });

    const chat = await services.createChat("proj_1", { name: "feature" });

    strictEqual(chat.codexThreadId, "thread_1");
    strictEqual(coreMocks.removeWorktree.mock.calls.length, 0);
    strictEqual(coreMocks.deleteBranch.mock.calls.length, 0);
    strictEqual((await store.load()).chats.length, 1);
  });

  it("rolls back a created worktree when Codex omits the thread id", async () => {
    const state = {
      ...createTestState(),
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
      ...createTestState(),
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

  it("passes selected model, effort, files, and skills to Codex turns", async () => {
    const worktreePath = await createTemporaryDirectory();
    await mkdir(join(worktreePath, "src"));
    const filePath = join(worktreePath, "src/index.ts");
    await writeFile(filePath, "export {};\n");
    const state = {
      ...createTestState(),
      projects: [createProject({ rootPath: worktreePath })],
      chats: [createChat({ worktreePath })],
    };
    const { codex, services } = await createHarness(state);
    codex.resumeThread.mockResolvedValueOnce({});
    codex.listSkills.mockResolvedValueOnce({
      skills: [{ name: "review", path: "/skills/review/SKILL.md" }],
    });
    codex.startTurn.mockResolvedValueOnce({ turn: { id: "turn_1" } });

    await services.sendMessage("chat_1", {
      effort: "high",
      files: [
        {
          name: "src/index.ts",
          path: filePath,
        },
      ],
      model: "gpt-5.2",
      skills: [{ name: "review", path: "/skills/review/SKILL.md" }],
      text: "please edit",
    });

    deepStrictEqual(codex.startTurn.mock.calls[0], [
      "thread_1",
      "please edit",
      worktreePath,
      {
        effort: "high",
        files: [
          {
            name: "src/index.ts",
            path: filePath,
          },
        ],
        model: "gpt-5.2",
        skills: [{ name: "review", path: "/skills/review/SKILL.md" }],
      },
    ]);
  });

  it("rejects file context paths outside the chat worktree", async () => {
    const worktreePath = await createTemporaryDirectory();
    const outsidePath = join(await createTemporaryDirectory(), "secret.txt");
    await writeFile(outsidePath, "secret\n");
    const state = {
      ...createTestState(),
      projects: [createProject({ rootPath: worktreePath })],
      chats: [createChat({ worktreePath })],
    };
    const { codex, services } = await createHarness(state);

    await rejects(
      services.sendMessage("chat_1", {
        files: [{ name: "secret.txt", path: outsidePath }],
        text: "please read",
      }),
      /File context path must be within the chat worktree/,
    );

    strictEqual(codex.startTurn.mock.calls.length, 0);
  });

  it("rejects file context paths that resolve to directories", async () => {
    const worktreePath = await createTemporaryDirectory();
    const directoryPath = join(worktreePath, "src");
    await mkdir(directoryPath);
    const state = {
      ...createTestState(),
      projects: [createProject({ rootPath: worktreePath })],
      chats: [createChat({ worktreePath })],
    };
    const { codex, services } = await createHarness(state);

    await rejects(
      services.sendMessage("chat_1", {
        files: [{ name: "src", path: directoryPath }],
        text: "please read",
      }),
      /File context path is not a file/,
    );

    strictEqual(codex.startTurn.mock.calls.length, 0);
  });

  it("rejects file context symlinks that resolve outside the chat worktree", async () => {
    const worktreePath = await createTemporaryDirectory();
    const outsidePath = join(await createTemporaryDirectory(), "secret.txt");
    await writeFile(outsidePath, "secret\n");
    const linkPath = join(worktreePath, "secret.txt");
    await symlink(outsidePath, linkPath);
    const state = {
      ...createTestState(),
      projects: [createProject({ rootPath: worktreePath })],
      chats: [createChat({ worktreePath })],
    };
    const { codex, services } = await createHarness(state);

    await rejects(
      services.sendMessage("chat_1", {
        files: [{ name: "secret.txt", path: linkPath }],
        text: "please read",
      }),
      /File context path must resolve within the chat worktree/,
    );

    strictEqual(codex.startTurn.mock.calls.length, 0);
  });

  it("rejects skill context paths that are unavailable for the chat cwd", async () => {
    const state = {
      ...createTestState(),
      projects: [createProject()],
      chats: [createChat()],
    };
    const { codex, services } = await createHarness(state);
    codex.listSkills.mockResolvedValueOnce({ skills: [] });

    await rejects(
      services.sendMessage("chat_1", {
        skills: [{ name: "review", path: "/skills/review/SKILL.md" }],
        text: "please review",
      }),
      /Skill context path is not available/,
    );

    strictEqual(codex.startTurn.mock.calls.length, 0);
  });

  it("filters fuzzy search results to file matches", async () => {
    const state = {
      ...createTestState(),
      projects: [createProject()],
      chats: [createChat()],
    };
    const { codex, services } = await createHarness(state);
    codex.searchFiles.mockResolvedValueOnce({
      files: [
        { root: "/repo", path: "src", match_type: "dir" },
        { root: "/repo", path: "src/index.ts", match_type: "file" },
      ],
    });

    deepStrictEqual(await services.searchFiles("chat_1", "src"), [
      {
        name: "index.ts",
        path: "/repo/src/index.ts",
        relativePath: "src/index.ts",
        root: "/repo",
        score: 0,
      },
    ]);
  });

  it("resets transient chat state after the Codex app-server exits", async () => {
    const state = {
      ...createTestState(),
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
      ...createTestState(),
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
      ...createTestState(),
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
      ...createTestState(),
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
      ...createTestState(),
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
      ...createTestState(),
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
      ...createTestState(),
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
      ...createTestState(),
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
      ...createTestState(),
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
      ...createTestState(),
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
      ...createTestState(),
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
      ...createTestState(),
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
      ...createTestState(),
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
      ...createTestState(),
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
      ...createTestState(),
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
      ...createTestState(),
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
