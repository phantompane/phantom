import { deepStrictEqual, rejects, strictEqual } from "node:assert";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it, vi } from "vitest";
import { WorktreeAlreadyExistsError } from "@phantompane/core";
import type { CodexBridge, CodexMessage } from "@phantompane/codex";
import { ServeStateStore } from "@phantompane/state";
import type { ChatRecord, ProjectRecord, ServeState } from "@phantompane/state";
import { ServeServices } from "./services";

const coreMocks = vi.hoisted(() => ({
  WorktreeAlreadyExistsError: class WorktreeAlreadyExistsError extends Error {
    constructor(name: string) {
      super(`Worktree '${name}' already exists`);
      this.name = "WorktreeAlreadyExistsError";
    }
  },
  createContext: vi.fn(),
  deleteBranch: vi.fn(),
  deleteWorktree: vi.fn(),
  listWorktrees: vi.fn(),
  removeWorktree: vi.fn(),
  runCreateWorktree: vi.fn(),
}));

const gitMocks = vi.hoisted(() => ({
  branchExists: vi.fn(),
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
  readonly exec = vi.fn();
  readonly interruptTurn = vi.fn();
  readonly listThreads = vi.fn();
  readonly listModels = vi.fn();
  readonly listSkills = vi.fn();
  readonly readThread = vi.fn();
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
  vi.resetAllMocks();
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
    queuedMessages: [],
    selectedProjectId: null,
    selectedChatId: null,
    ...overrides,
  };
}

async function createHarness(state: ServeState): Promise<{
  codex: FakeCodexBridge;
  codexHome: string;
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
  return { codex, codexHome, services, store };
}

function markChatActiveInCurrentProcess(
  services: ServeServices,
  chatId: string,
): void {
  (
    services as unknown as { activeTurnChatIds: Set<string> }
  ).activeTurnChatIds.add(chatId);
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

describe("ServeServices", () => {
  it("lists project worktrees with phantom list data without creating chat records", async () => {
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
        chatId: worktree.chatId,
        chatStatus: worktree.chatStatus,
      })),
      [
        {
          name: "main",
          path: "/repo",
          pathToDisplay: ".",
          isClean: true,
          isMainWorktree: true,
          chatId: null,
          chatStatus: null,
        },
        {
          name: "feature/list",
          path: "/repo/.git/phantom/worktrees/feature/list",
          pathToDisplay: ".git/phantom/worktrees/feature/list",
          isClean: false,
          isMainWorktree: false,
          chatId: null,
          chatStatus: null,
        },
      ],
    );
    strictEqual(
      worktrees.every((worktree) => !worktree.chatId),
      true,
    );

    const savedState = await store.load();
    deepStrictEqual(savedState.chats, []);
  });

  it("does not persist state when worktree sync has no changes", async () => {
    const state = {
      ...createTestState(),
      projects: [createProject()],
      chats: [createChat({ worktreeName: "main", worktreePath: "/repo" })],
    };
    const { services, store } = await createHarness(state);
    const saveSpy = vi.spyOn(store, "save");
    coreMocks.listWorktrees
      .mockResolvedValueOnce({
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
      })
      .mockResolvedValueOnce({
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

  it("removes persisted chats for worktrees missing from a live sync", async () => {
    const staleWorktreePath = "/repo/.git/phantom/worktrees/deleted";
    const state = {
      ...createTestState(),
      projects: [createProject()],
      chats: [
        createChat({ worktreeName: "main", worktreePath: "/repo" }),
        createChat({
          id: "chat_stale",
          branchName: "deleted",
          title: "Deleted worktree",
          worktreeName: "deleted",
          worktreePath: staleWorktreePath,
        }),
      ],
      messages: [
        {
          id: "msg_stale",
          chatId: "chat_stale",
          role: "user" as const,
          text: "stale",
          createdAt: timestamp,
        },
      ],
      selectedChatId: "chat_stale",
    };
    const { services, store } = await createHarness(state);
    coreMocks.listWorktrees
      .mockResolvedValueOnce({
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
      })
      .mockResolvedValueOnce({
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
    await services.listChats("proj_1");

    deepStrictEqual(
      worktrees.map((worktree) => worktree.path),
      ["/repo"],
    );
    const savedState = await store.load();
    deepStrictEqual(
      savedState.chats.map((chat) => chat.id),
      ["chat_1"],
    );
    deepStrictEqual(savedState.messages, []);
    strictEqual(savedState.selectedChatId, null);
  });

  it("does not prune persisted chats when a live sync omits the main worktree", async () => {
    const featureWorktreePath = "/repo/.git/phantom/worktrees/feature";
    const state = {
      ...createTestState(),
      projects: [createProject()],
      chats: [
        createChat({ worktreeName: "main", worktreePath: "/repo" }),
        createChat({
          id: "chat_feature",
          branchName: "feature",
          title: "Feature",
          worktreeName: "feature",
          worktreePath: featureWorktreePath,
        }),
      ],
    };
    const { services, store } = await createHarness(state);
    coreMocks.listWorktrees
      .mockResolvedValueOnce({
        ok: true,
        value: {
          worktrees: [
            {
              name: "feature",
              path: featureWorktreePath,
              pathToDisplay: ".git/phantom/worktrees/feature",
              branch: "feature",
              isClean: true,
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        value: {
          worktrees: [
            {
              name: "feature",
              path: featureWorktreePath,
              pathToDisplay: ".git/phantom/worktrees/feature",
              branch: "feature",
              isClean: true,
            },
          ],
        },
      });

    await services.listChats("proj_1");

    const savedState = await store.load();
    deepStrictEqual(
      savedState.chats.map((chat) => chat.id),
      ["chat_1", "chat_feature"],
    );
  });

  it("does not prune chats for worktrees that are known but hidden from display", async () => {
    const prunableWorktreePath = "/repo/.git/phantom/worktrees/prunable";
    const state = {
      ...createTestState(),
      projects: [createProject()],
      chats: [
        createChat({ worktreeName: "main", worktreePath: "/repo" }),
        createChat({
          id: "chat_prunable",
          branchName: "prunable",
          title: "Temporarily unavailable",
          worktreeName: "prunable",
          worktreePath: prunableWorktreePath,
        }),
      ],
      messages: [
        {
          id: "msg_prunable",
          chatId: "chat_prunable",
          role: "user" as const,
          text: "keep this too",
          createdAt: timestamp,
        },
      ],
    };
    const { services, store } = await createHarness(state);
    coreMocks.listWorktrees
      .mockResolvedValueOnce({
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
      })
      .mockResolvedValueOnce({
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
              name: "prunable",
              path: prunableWorktreePath,
              pathToDisplay: ".git/phantom/worktrees/prunable",
              branch: "prunable",
              isClean: true,
            },
          ],
        },
      });

    const worktrees = await services.listProjectWorktrees("proj_1");

    deepStrictEqual(
      worktrees.map((worktree) => worktree.path),
      ["/repo"],
    );
    const savedState = await store.load();
    deepStrictEqual(
      savedState.chats.map((chat) => chat.id),
      ["chat_1", "chat_prunable"],
    );
    deepStrictEqual(
      savedState.messages.map((message) => message.id),
      ["msg_prunable"],
    );
  });

  it("does not prune active chats for worktrees missing from a live sync", async () => {
    const staleWorktreePath = "/repo/.git/phantom/worktrees/running";
    const state = {
      ...createTestState(),
      projects: [createProject()],
      chats: [
        createChat({ worktreeName: "main", worktreePath: "/repo" }),
        createChat({
          id: "chat_running",
          activeTurnId: "turn_1",
          branchName: "running",
          status: "running",
          title: "Running worktree",
          worktreeName: "running",
          worktreePath: staleWorktreePath,
        }),
      ],
      messages: [
        {
          id: "msg_running",
          chatId: "chat_running",
          role: "user" as const,
          text: "keep this",
          createdAt: timestamp,
        },
      ],
    };
    const { services, store } = await createHarness(state);
    markChatActiveInCurrentProcess(services, "chat_running");
    coreMocks.listWorktrees
      .mockResolvedValueOnce({
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
      })
      .mockResolvedValueOnce({
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

    await services.listChats("proj_1");

    const savedState = await store.load();
    deepStrictEqual(
      savedState.chats.map((chat) => chat.id),
      ["chat_1", "chat_running"],
    );
    deepStrictEqual(
      savedState.messages.map((message) => message.id),
      ["msg_running"],
    );
  });

  it("does not prune a missing-worktree chat that becomes active during sync", async () => {
    const staleWorktreePath = "/repo/.git/phantom/worktrees/running";
    const state = {
      ...createTestState(),
      projects: [createProject()],
      chats: [
        createChat({ worktreeName: "main", worktreePath: "/repo" }),
        createChat({
          id: "chat_running",
          branchName: "running",
          title: "Running worktree",
          worktreeName: "running",
          worktreePath: staleWorktreePath,
        }),
      ],
      messages: [
        {
          id: "msg_running",
          chatId: "chat_running",
          role: "user" as const,
          text: "keep this",
          createdAt: timestamp,
        },
      ],
    };
    const store = new ImportRaceStore(
      await createTemporaryDirectory(),
      (currentState) => ({
        ...currentState,
        chats: currentState.chats.map((chat) =>
          chat.id === "chat_running"
            ? {
                ...chat,
                activeTurnId: "turn_1",
                status: "running",
              }
            : chat,
        ),
      }),
    );
    await store.save(state);
    const codex = new FakeCodexBridge();
    const services = new ServeServices({
      codex: codex as unknown as CodexBridge,
      codexHome: await createTemporaryDirectory(),
      store,
    });
    coreMocks.listWorktrees
      .mockResolvedValueOnce({
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
      })
      .mockResolvedValueOnce({
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

    await services.listChats("proj_1");

    const savedState = await store.load();
    deepStrictEqual(
      savedState.chats.map((chat) => [chat.id, chat.status]),
      [
        ["chat_1", "idle"],
        ["chat_running", "running"],
      ],
    );
    deepStrictEqual(
      savedState.messages.map((message) => message.id),
      ["msg_running"],
    );
  });

  it("does not prune chats created after the live worktree snapshot", async () => {
    const staleWorktreePath = "/repo/.git/phantom/worktrees/deleted";
    const concurrentWorktreePath = "/repo/.git/phantom/worktrees/concurrent";
    const state = {
      ...createTestState(),
      projects: [createProject()],
      chats: [
        createChat({ worktreeName: "main", worktreePath: "/repo" }),
        createChat({
          id: "chat_stale",
          branchName: "deleted",
          title: "Deleted worktree",
          worktreeName: "deleted",
          worktreePath: staleWorktreePath,
        }),
      ],
    };
    const store = new ImportRaceStore(
      await createTemporaryDirectory(),
      (currentState) => ({
        ...currentState,
        chats: [
          ...currentState.chats,
          createChat({
            id: "chat_concurrent",
            branchName: "concurrent",
            title: "Concurrent worktree",
            worktreeName: "concurrent",
            worktreePath: concurrentWorktreePath,
          }),
        ],
      }),
    );
    await store.save(state);
    const codex = new FakeCodexBridge();
    const services = new ServeServices({
      codex: codex as unknown as CodexBridge,
      codexHome: await createTemporaryDirectory(),
      store,
    });
    coreMocks.listWorktrees
      .mockResolvedValueOnce({
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
      })
      .mockResolvedValueOnce({
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

    await services.listChats("proj_1");

    const savedState = await store.load();
    deepStrictEqual(
      savedState.chats.map((chat) => chat.id),
      ["chat_1", "chat_concurrent"],
    );
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

    const worktrees = await services.listProjectWorktrees("proj_1");

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
    strictEqual(coreMocks.listWorktrees.mock.calls.length, 1);
  });

  it("resets stale transient chat state when listing chats", async () => {
    const state = {
      ...createTestState(),
      projects: [createProject()],
      chats: [createChat({ status: "running", activeTurnId: "turn_stale" })],
    };
    const { services, store } = await createHarness(state);

    const chats = await services.listChats("proj_1");

    strictEqual(chats[0]?.status, "idle");
    strictEqual(chats[0]?.activeTurnId, null);
    const savedState = await store.load();
    strictEqual(savedState.chats[0]?.status, "idle");
    strictEqual(savedState.chats[0]?.activeTurnId, null);
  });

  it("syncs Codex thread metadata for project chats and reads messages lazily", async () => {
    const threadId = "019dc000-0000-7000-8000-000000000001";
    const worktreePath = "/repo/.git/phantom/worktrees/feature/list";
    const state = {
      ...createTestState(),
      projects: [createProject()],
    };
    const store = new ServeStateStore(await createTemporaryDirectory());
    await store.save(state);
    const codex = new FakeCodexBridge();
    const services = new ServeServices({
      codex: codex as unknown as CodexBridge,
      store,
    });
    coreMocks.listWorktrees.mockResolvedValue({
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
    codex.listThreads.mockResolvedValueOnce({
      threads: [
        {
          id: threadId,
          cwd: worktreePath,
          title: "Existing work",
          createdAt: "2026-04-25T00:00:00.000Z",
          updatedAt: "2026-04-25T00:03:00.000Z",
        },
      ],
    });
    codex.readThread.mockResolvedValueOnce({
      thread: {
        turns: [
          {
            id: "turn_1",
            createdAt: "2026-04-25T00:02:00.000Z",
            items: [
              { type: "userMessage", text: "Please update the page" },
              { type: "agentMessage", text: "I updated the page." },
            ],
          },
        ],
      },
    });

    const chats = await services.listChats("proj_1");
    const worktrees = await services.listProjectWorktrees("proj_1");
    const messages = await services.getMessages(chats[0]!.id);

    deepStrictEqual(codex.listThreads.mock.calls[0]?.[0], {
      archived: false,
      cursor: null,
      cwd: [worktreePath],
      limit: 100,
      sourceKinds: ["cli", "vscode", "appServer"],
      sortDirection: "desc",
      sortKey: "updated_at",
      useStateDbOnly: true,
    });
    strictEqual(worktrees[0]?.chatTitle, "Existing work");
    strictEqual(worktrees[0]?.chatStatus, "idle");
    strictEqual(chats[0]?.codexThreadId, threadId);
    deepStrictEqual(
      messages.map((message) => [message.role, message.text]),
      [
        ["user", "Please update the page"],
        ["assistant", "I updated the page."],
      ],
    );
    const savedState = await store.load();
    strictEqual(savedState.chats.length, 1);
    deepStrictEqual(savedState.messages, []);
  });

  it("keeps duplicate local messages that have not appeared in thread history yet", async () => {
    const state = {
      ...createTestState(),
      projects: [createProject()],
      chats: [createChat()],
      messages: [
        {
          id: "msg_imported_duplicate",
          chatId: "chat_1",
          role: "user" as const,
          text: "repeat",
          createdAt: "2026-04-25T00:00:00.000Z",
        },
        {
          id: "msg_pending_duplicate",
          chatId: "chat_1",
          role: "user" as const,
          text: "repeat",
          createdAt: "2026-04-25T00:01:00.000Z",
        },
      ],
    };
    const { codex, services } = await createHarness(state);
    codex.readThread.mockResolvedValueOnce({
      thread: {
        turns: [
          {
            id: "turn_1",
            createdAt: "2026-04-25T00:00:00.000Z",
            items: [{ type: "userMessage", text: "repeat" }],
          },
        ],
      },
    });

    const messages = await services.getMessages("chat_1");

    deepStrictEqual(
      messages.map((message) => [message.id, message.role, message.text]),
      [
        ["chat_1_codex_turn_1_0", "user", "repeat"],
        ["msg_pending_duplicate", "user", "repeat"],
      ],
    );
  });

  it("keeps a repeated pending message when only an older Codex message matches", async () => {
    const state = {
      ...createTestState(),
      projects: [createProject()],
      chats: [createChat()],
      messages: [
        {
          id: "msg_pending_retry",
          chatId: "chat_1",
          role: "user" as const,
          text: "retry",
          createdAt: "2026-04-25T00:01:00.000Z",
        },
      ],
    };
    const { codex, services } = await createHarness(state);
    codex.readThread.mockResolvedValueOnce({
      thread: {
        turns: [
          {
            id: "turn_1",
            createdAt: "2026-04-25T00:00:00.000Z",
            items: [{ type: "userMessage", text: "retry" }],
          },
        ],
      },
    });

    const messages = await services.getMessages("chat_1");

    deepStrictEqual(
      messages.map((message) => [message.id, message.role, message.text]),
      [
        ["chat_1_codex_turn_1_0", "user", "retry"],
        ["msg_pending_retry", "user", "retry"],
      ],
    );
  });

  it("deduplicates a local message once a matching newer Codex message exists", async () => {
    const state = {
      ...createTestState(),
      projects: [createProject()],
      chats: [createChat()],
      messages: [
        {
          id: "msg_materialized_retry",
          chatId: "chat_1",
          role: "user" as const,
          text: "retry",
          createdAt: "2026-04-25T00:01:00.000Z",
        },
      ],
    };
    const { codex, services } = await createHarness(state);
    codex.readThread.mockResolvedValueOnce({
      thread: {
        turns: [
          {
            id: "turn_1",
            createdAt: "2026-04-25T00:02:00.000Z",
            items: [{ type: "userMessage", text: "retry" }],
          },
        ],
      },
    });

    const messages = await services.getMessages("chat_1");

    deepStrictEqual(
      messages.map((message) => [message.id, message.role, message.text]),
      [["chat_1_codex_turn_1_0", "user", "retry"]],
    );
  });

  it("deduplicates live assistant deltas when Codex history uses different item ids", async () => {
    const state = {
      ...createTestState(),
      projects: [createProject()],
      chats: [createChat()],
      messages: [
        {
          id: "msg_live_delta",
          chatId: "chat_1",
          role: "assistant" as const,
          text: "I updated the page.",
          eventType: "item/agentMessage/delta",
          itemId: "msg_live_item_id",
          createdAt: "2026-04-25T00:01:00.000Z",
        },
      ],
    };
    const { codex, services } = await createHarness(state);
    codex.readThread.mockResolvedValueOnce({
      thread: {
        turns: [
          {
            id: "turn_1",
            createdAt: "2026-04-25T00:02:00.000Z",
            items: [
              {
                id: "item-2",
                type: "assistantMessage",
                text: "I updated the page.",
              },
            ],
          },
        ],
      },
    });

    const messages = await services.getMessages("chat_1");

    deepStrictEqual(
      messages.map((message) => [
        message.id,
        message.role,
        message.text,
        message.eventType,
      ]),
      [
        [
          "chat_1_codex_turn_1_0",
          "assistant",
          "I updated the page.",
          undefined,
        ],
      ],
    );
  });

  it("keeps fuller live assistant delta text while same-item Codex history is stale", async () => {
    const state = {
      ...createTestState(),
      projects: [createProject()],
      chats: [createChat()],
      messages: [
        {
          id: "msg_live_delta",
          chatId: "chat_1",
          role: "assistant" as const,
          text: "hello world",
          eventType: "item/agentMessage/delta",
          itemId: "item-2",
          createdAt: "2026-04-25T00:01:00.000Z",
        },
      ],
    };
    const { codex, services } = await createHarness(state);
    codex.readThread.mockResolvedValueOnce({
      thread: {
        turns: [
          {
            id: "turn_1",
            createdAt: "2026-04-25T00:02:00.000Z",
            items: [
              {
                id: "item-2",
                type: "assistantMessage",
                text: "hello",
              },
            ],
          },
        ],
      },
    });

    const messages = await services.getMessages("chat_1");

    deepStrictEqual(
      messages.map((message) => [
        message.id,
        message.role,
        message.text,
        message.eventType,
      ]),
      [
        [
          "msg_live_delta",
          "assistant",
          "hello world",
          "item/agentMessage/delta",
        ],
      ],
    );
  });

  it("keeps older live assistant deltas when a later turn repeats the same text", async () => {
    const state = {
      ...createTestState(),
      projects: [createProject()],
      chats: [createChat()],
      messages: [
        {
          id: "msg_old_live_delta",
          chatId: "chat_1",
          role: "assistant" as const,
          text: "repeat",
          eventType: "item/agentMessage/delta",
          itemId: "msg_old_live_item",
          createdAt: "2026-04-25T00:01:00.000Z",
        },
        {
          id: "msg_later_user",
          chatId: "chat_1",
          role: "user" as const,
          text: "next",
          createdAt: "2026-04-25T00:02:00.000Z",
        },
      ],
    };
    const { codex, services } = await createHarness(state);
    codex.readThread.mockResolvedValueOnce({
      thread: {
        turns: [
          {
            id: "turn_2",
            createdAt: "2026-04-25T00:03:00.000Z",
            input: [{ text: "next" }],
            items: [
              {
                id: "item-9",
                type: "assistantMessage",
                text: "repeat",
              },
            ],
          },
        ],
      },
    });

    const messages = await services.getMessages("chat_1");

    deepStrictEqual(
      messages.map((message) => [
        message.id,
        message.role,
        message.text,
        message.eventType,
      ]),
      [
        [
          "msg_old_live_delta",
          "assistant",
          "repeat",
          "item/agentMessage/delta",
        ],
        ["chat_1_codex_turn_2_0", "user", "next", undefined],
        ["chat_1_codex_turn_2_1", "assistant", "repeat", undefined],
      ],
    );
  });

  it("deduplicates older live assistant deltas before a later repeated response", async () => {
    const state = {
      ...createTestState(),
      projects: [createProject()],
      chats: [createChat()],
      messages: [
        {
          id: "msg_old_live_delta",
          chatId: "chat_1",
          role: "assistant" as const,
          text: "repeat",
          eventType: "item/agentMessage/delta",
          itemId: "msg_old_live_item",
          createdAt: "2026-04-25T00:01:00.000Z",
        },
        {
          id: "msg_later_user",
          chatId: "chat_1",
          role: "user" as const,
          text: "next",
          createdAt: "2026-04-25T00:02:00.000Z",
        },
      ],
    };
    const { codex, services } = await createHarness(state);
    codex.readThread.mockResolvedValueOnce({
      thread: {
        turns: [
          {
            id: "turn_1",
            createdAt: "2026-04-25T00:03:00.000Z",
            items: [
              {
                id: "item-2",
                type: "assistantMessage",
                text: "repeat",
              },
            ],
          },
          {
            id: "turn_2",
            createdAt: "2026-04-25T00:04:00.000Z",
            input: [{ text: "next" }],
            items: [
              {
                id: "item-9",
                type: "assistantMessage",
                text: "repeat",
              },
            ],
          },
        ],
      },
    });

    const messages = await services.getMessages("chat_1");

    deepStrictEqual(
      messages.map((message) => [
        message.id,
        message.role,
        message.text,
        message.eventType,
      ]),
      [
        ["chat_1_codex_turn_1_0", "assistant", "repeat", undefined],
        ["chat_1_codex_turn_2_0", "user", "next", undefined],
        ["chat_1_codex_turn_2_1", "assistant", "repeat", undefined],
      ],
    );
  });

  it("deduplicates live assistant deltas when a later queued message exists", async () => {
    const state = {
      ...createTestState(),
      projects: [createProject()],
      chats: [createChat()],
      messages: [
        {
          id: "msg_live_delta",
          chatId: "chat_1",
          role: "assistant" as const,
          text: "done",
          eventType: "item/agentMessage/delta",
          itemId: "msg_live_item",
          createdAt: "2026-04-25T00:01:00.000Z",
        },
        {
          id: "msg_queued",
          chatId: "chat_1",
          role: "user" as const,
          text: "next",
          eventType: "chat.message.queued",
          createdAt: "2026-04-25T00:02:00.000Z",
        },
      ],
    };
    const { codex, services } = await createHarness(state);
    codex.readThread.mockResolvedValueOnce({
      thread: {
        turns: [
          {
            id: "turn_1",
            createdAt: "2026-04-25T00:03:00.000Z",
            items: [
              {
                id: "item-2",
                type: "assistantMessage",
                text: "done",
              },
            ],
          },
        ],
      },
    });

    const messages = await services.getMessages("chat_1");

    deepStrictEqual(
      messages.map((message) => [
        message.id,
        message.role,
        message.text,
        message.eventType,
      ]),
      [
        ["chat_1_codex_turn_1_0", "assistant", "done", undefined],
        ["msg_queued", "user", "next", "chat.message.queued"],
      ],
    );
  });

  it("places live assistant deltas after history and before steered and queued pending messages", async () => {
    const state = {
      ...createTestState(),
      projects: [createProject()],
      chats: [createChat()],
      messages: [
        {
          id: "msg_user",
          chatId: "chat_1",
          role: "user" as const,
          text: "start",
          createdAt: "2026-04-25T00:01:00.000Z",
        },
        {
          id: "msg_live_delta",
          chatId: "chat_1",
          role: "assistant" as const,
          text: "working",
          eventType: "item/agentMessage/delta",
          itemId: "item_live",
          createdAt: "2026-04-25T00:02:00.000Z",
        },
        {
          id: "msg_queued",
          chatId: "chat_1",
          role: "user" as const,
          text: "next queued",
          eventType: "chat.message.queued",
          createdAt: "2026-04-25T00:03:00.000Z",
        },
        {
          id: "msg_steered",
          chatId: "chat_1",
          role: "user" as const,
          text: "adjust now",
          eventType: "chat.message.steered",
          itemId: "turn_1",
          createdAt: "2026-04-25T00:04:00.000Z",
        },
      ],
    };
    const { codex, services } = await createHarness(state);
    codex.readThread.mockResolvedValueOnce({
      thread: {
        turns: [
          {
            id: "turn_1",
            input: [{ text: "start" }],
          },
        ],
      },
    });

    const messages = await services.getMessages("chat_1");

    deepStrictEqual(
      messages.map((message) => [
        message.id,
        message.role,
        message.text,
        message.eventType,
      ]),
      [
        ["chat_1_codex_turn_1_0", "user", "start", undefined],
        ["msg_live_delta", "assistant", "working", "item/agentMessage/delta"],
        ["msg_steered", "user", "adjust now", "chat.message.steered"],
        ["msg_queued", "user", "next queued", "chat.message.queued"],
      ],
    );
  });

  it("places live assistant deltas before the matching repeated steered Codex item", async () => {
    const state = {
      ...createTestState(),
      projects: [createProject()],
      chats: [createChat()],
      messages: [
        {
          id: "msg_live_delta",
          chatId: "chat_1",
          role: "assistant" as const,
          text: "streaming",
          eventType: "item/agentMessage/delta",
          itemId: "item_live",
          createdAt: "2026-04-25T00:01:00.000Z",
        },
        {
          id: "msg_steered",
          chatId: "chat_1",
          role: "user" as const,
          text: "repeat",
          eventType: "chat.message.steered",
          itemId: "turn_1",
          createdAt: "2026-04-25T00:02:00.000Z",
        },
      ],
    };
    const { codex, services } = await createHarness(state);
    codex.readThread.mockResolvedValueOnce({
      thread: {
        turns: [
          {
            id: "turn_1",
            createdAt: "2026-04-25T00:00:00.000Z",
            input: [{ text: "repeat" }],
            items: [
              { type: "userMessage", text: "repeat" },
              { type: "assistantMessage", text: "between repeats" },
              { type: "userMessage", text: "repeat" },
            ],
          },
        ],
      },
    });

    const messages = await services.getMessages("chat_1");

    deepStrictEqual(
      messages.map((message) => [
        message.id,
        message.role,
        message.text,
        message.eventType,
      ]),
      [
        ["chat_1_codex_turn_1_0", "user", "repeat", undefined],
        ["chat_1_codex_turn_1_1", "user", "repeat", undefined],
        ["chat_1_codex_turn_1_2", "assistant", "between repeats", undefined],
        ["msg_live_delta", "assistant", "streaming", "item/agentMessage/delta"],
        ["chat_1_codex_turn_1_3", "user", "repeat", undefined],
      ],
    );
  });

  it("uses the later repeated steered occurrence as the live assistant delta boundary", async () => {
    const state = {
      ...createTestState(),
      projects: [createProject()],
      chats: [createChat()],
      messages: [
        {
          id: "msg_steered_1",
          chatId: "chat_1",
          role: "user" as const,
          text: "repeat",
          eventType: "chat.message.steered",
          itemId: "turn_1",
          createdAt: "2026-04-25T00:01:00.000Z",
        },
        {
          id: "msg_live_delta",
          chatId: "chat_1",
          role: "assistant" as const,
          text: "streaming",
          eventType: "item/agentMessage/delta",
          itemId: "item_live",
          createdAt: "2026-04-25T00:02:00.000Z",
        },
        {
          id: "msg_steered_2",
          chatId: "chat_1",
          role: "user" as const,
          text: "repeat",
          eventType: "chat.message.steered",
          itemId: "turn_1",
          createdAt: "2026-04-25T00:03:00.000Z",
        },
      ],
    };
    const { codex, services } = await createHarness(state);
    codex.readThread.mockResolvedValueOnce({
      thread: {
        turns: [
          {
            id: "turn_1",
            createdAt: "2026-04-25T00:00:00.000Z",
            input: [{ text: "repeat" }],
            items: [
              { type: "userMessage", text: "repeat" },
              { type: "assistantMessage", text: "between repeats" },
              { type: "userMessage", text: "repeat" },
            ],
          },
        ],
      },
    });

    const messages = await services.getMessages("chat_1");

    deepStrictEqual(
      messages.map((message) => [
        message.id,
        message.role,
        message.text,
        message.eventType,
      ]),
      [
        ["chat_1_codex_turn_1_0", "user", "repeat", undefined],
        ["chat_1_codex_turn_1_1", "user", "repeat", undefined],
        ["chat_1_codex_turn_1_2", "assistant", "between repeats", undefined],
        ["msg_live_delta", "assistant", "streaming", "item/agentMessage/delta"],
        ["chat_1_codex_turn_1_3", "user", "repeat", undefined],
      ],
    );
  });

  it("keeps live assistant deltas after history when a repeated steered boundary is still pending", async () => {
    const state = {
      ...createTestState(),
      projects: [createProject()],
      chats: [createChat()],
      messages: [
        {
          id: "msg_steered_1",
          chatId: "chat_1",
          role: "user" as const,
          text: "repeat",
          eventType: "chat.message.steered",
          itemId: "turn_1",
          createdAt: "2026-04-25T00:01:00.000Z",
        },
        {
          id: "msg_steered_2",
          chatId: "chat_1",
          role: "user" as const,
          text: "repeat",
          eventType: "chat.message.steered",
          itemId: "turn_1",
          createdAt: "2026-04-25T00:02:00.000Z",
        },
        {
          id: "msg_live_delta",
          chatId: "chat_1",
          role: "assistant" as const,
          text: "streaming",
          eventType: "item/agentMessage/delta",
          itemId: "item_live",
          createdAt: "2026-04-25T00:03:00.000Z",
        },
        {
          id: "msg_steered_3",
          chatId: "chat_1",
          role: "user" as const,
          text: "repeat",
          eventType: "chat.message.steered",
          itemId: "turn_1",
          createdAt: "2026-04-25T00:04:00.000Z",
        },
      ],
    };
    const { codex, services } = await createHarness(state);
    codex.readThread.mockResolvedValueOnce({
      thread: {
        turns: [
          {
            id: "turn_1",
            createdAt: "2026-04-25T00:00:00.000Z",
            input: [{ text: "repeat" }],
            items: [
              { type: "userMessage", text: "repeat" },
              { type: "assistantMessage", text: "between repeats" },
              { type: "userMessage", text: "repeat" },
            ],
          },
        ],
      },
    });

    const messages = await services.getMessages("chat_1");

    deepStrictEqual(
      messages.map((message) => [
        message.id,
        message.role,
        message.text,
        message.eventType,
      ]),
      [
        ["chat_1_codex_turn_1_0", "user", "repeat", undefined],
        ["chat_1_codex_turn_1_1", "user", "repeat", undefined],
        ["chat_1_codex_turn_1_2", "assistant", "between repeats", undefined],
        ["chat_1_codex_turn_1_3", "user", "repeat", undefined],
        ["msg_live_delta", "assistant", "streaming", "item/agentMessage/delta"],
        ["msg_steered_3", "user", "repeat", "chat.message.steered"],
      ],
    );
  });

  it("keeps older live assistant deltas when a later steer repeats the same text", async () => {
    const state = {
      ...createTestState(),
      projects: [createProject()],
      chats: [createChat()],
      messages: [
        {
          id: "msg_old_live_delta",
          chatId: "chat_1",
          role: "assistant" as const,
          text: "repeat",
          eventType: "item/agentMessage/delta",
          itemId: "msg_old_live_item",
          createdAt: "2026-04-25T00:01:00.000Z",
        },
        {
          id: "msg_steered",
          chatId: "chat_1",
          role: "user" as const,
          text: "adjust",
          eventType: "chat.message.steered",
          itemId: "turn_1",
          createdAt: "2026-04-25T00:02:00.000Z",
        },
      ],
    };
    const { codex, services } = await createHarness(state);
    codex.readThread.mockResolvedValueOnce({
      thread: {
        turns: [
          {
            id: "turn_1",
            createdAt: "2026-04-25T00:03:00.000Z",
            items: [
              {
                id: "item-8",
                type: "userMessage",
                text: "adjust",
              },
              {
                id: "item-9",
                type: "assistantMessage",
                text: "repeat",
              },
            ],
          },
        ],
      },
    });

    const messages = await services.getMessages("chat_1");

    deepStrictEqual(
      messages.map((message) => [
        message.id,
        message.role,
        message.text,
        message.eventType,
      ]),
      [
        [
          "msg_old_live_delta",
          "assistant",
          "repeat",
          "item/agentMessage/delta",
        ],
        ["chat_1_codex_turn_1_0", "user", "adjust", undefined],
        ["chat_1_codex_turn_1_1", "assistant", "repeat", undefined],
      ],
    );
  });

  it("uses the local timestamp for a consumed steered message", async () => {
    const state = {
      ...createTestState(),
      projects: [createProject()],
      chats: [createChat()],
      messages: [
        {
          id: "msg_steered",
          chatId: "chat_1",
          role: "user" as const,
          text: "adjust course",
          eventType: "chat.message.steered",
          itemId: "turn_1",
          createdAt: "2026-04-25T00:01:00.000Z",
        },
      ],
    };
    const { codex, services } = await createHarness(state);
    codex.readThread.mockResolvedValueOnce({
      thread: {
        turns: [
          {
            id: "turn_1",
            createdAt: "2026-04-25T00:00:00.000Z",
            input: [{ text: "start" }],
            items: [{ type: "userMessage", text: "adjust course" }],
          },
        ],
      },
    });

    const messages = await services.getMessages("chat_1");

    deepStrictEqual(
      messages.map((message) => [
        message.id,
        message.role,
        message.text,
        message.eventType,
        message.createdAt,
      ]),
      [
        [
          "chat_1_codex_turn_1_0",
          "user",
          "start",
          undefined,
          "2026-04-25T00:00:00.000Z",
        ],
        [
          "chat_1_codex_turn_1_1",
          "user",
          "adjust course",
          undefined,
          "2026-04-25T00:01:00.000Z",
        ],
      ],
    );
  });

  it("clears stale steered state when thread history cannot be read after the turn ends", async () => {
    const state = {
      ...createTestState(),
      projects: [createProject()],
      chats: [createChat({ status: "idle", activeTurnId: null })],
      messages: [
        {
          id: "msg_steered",
          chatId: "chat_1",
          role: "user" as const,
          text: "adjust course",
          eventType: "chat.message.steered",
          itemId: "turn_1",
          createdAt: "2026-04-25T00:01:00.000Z",
        },
      ],
    };
    const { codex, services } = await createHarness(state);
    codex.readThread.mockRejectedValueOnce(new Error("read failed"));

    const messages = await services.getMessages("chat_1");

    deepStrictEqual(
      messages.map((message) => [message.id, message.text, message.eventType]),
      [["msg_steered", "adjust course", undefined]],
    );
  });

  it("clears stale steered state when thread history has no messages after the turn ends", async () => {
    const state = {
      ...createTestState(),
      projects: [createProject()],
      chats: [createChat({ status: "idle", activeTurnId: null })],
      messages: [
        {
          id: "msg_steered",
          chatId: "chat_1",
          role: "user" as const,
          text: "adjust course",
          eventType: "chat.message.steered",
          itemId: "turn_1",
          createdAt: "2026-04-25T00:01:00.000Z",
        },
      ],
    };
    const { codex, services } = await createHarness(state);
    codex.readThread.mockResolvedValueOnce({ thread: { turns: [] } });

    const messages = await services.getMessages("chat_1");

    deepStrictEqual(
      messages.map((message) => [message.id, message.text, message.eventType]),
      [["msg_steered", "adjust course", undefined]],
    );
  });

  it("keeps queued messages local after matching Codex history", async () => {
    const state = {
      ...createTestState(),
      projects: [createProject()],
      chats: [createChat()],
      messages: [
        {
          id: "msg_queued",
          chatId: "chat_1",
          role: "user" as const,
          text: "repeat",
          eventType: "chat.message.queued",
          createdAt: "2026-04-25T00:01:00.000Z",
        },
      ],
      queuedMessages: [
        {
          id: "queue_1",
          chatId: "chat_1",
          messageId: "msg_queued",
          text: "repeat",
          createdAt: "2026-04-25T00:01:00.000Z",
        },
      ],
    };
    const { codex, services } = await createHarness(state);
    codex.readThread.mockResolvedValueOnce({
      thread: {
        turns: [
          {
            id: "turn_1",
            createdAt: "2026-04-25T00:02:00.000Z",
            items: [{ type: "userMessage", text: "repeat" }],
          },
        ],
      },
    });

    const messages = await services.getMessages("chat_1");

    deepStrictEqual(
      messages.map((message) => [
        message.id,
        message.role,
        message.text,
        message.eventType,
      ]),
      [
        ["chat_1_codex_turn_1_0", "user", "repeat", undefined],
        ["msg_queued", "user", "repeat", "chat.message.queued"],
      ],
    );
  });

  it("matches a consumed steered message to the later Codex item", async () => {
    const state = {
      ...createTestState(),
      projects: [createProject()],
      chats: [createChat()],
      messages: [
        {
          id: "msg_steered_repeat",
          chatId: "chat_1",
          role: "user" as const,
          text: "repeat",
          eventType: "chat.message.steered",
          itemId: "turn_1",
          createdAt: "2026-04-25T00:01:00.000Z",
        },
      ],
    };
    const { codex, services } = await createHarness(state);
    codex.readThread.mockResolvedValueOnce({
      thread: {
        turns: [
          {
            id: "turn_1",
            createdAt: "2026-04-25T00:00:00.000Z",
            input: [{ text: "repeat" }],
            items: [{ type: "userMessage", text: "repeat" }],
          },
        ],
      },
    });

    const messages = await services.getMessages("chat_1");

    deepStrictEqual(
      messages.map((message) => [
        message.id,
        message.role,
        message.text,
        message.eventType,
        message.createdAt,
      ]),
      [
        [
          "chat_1_codex_turn_1_0",
          "user",
          "repeat",
          undefined,
          "2026-04-25T00:00:00.000Z",
        ],
        [
          "chat_1_codex_turn_1_1",
          "user",
          "repeat",
          undefined,
          "2026-04-25T00:01:00.000Z",
        ],
      ],
    );
  });

  it("preserves repeated same-text steered message order", async () => {
    const state = {
      ...createTestState(),
      projects: [createProject()],
      chats: [createChat()],
      messages: [
        {
          id: "msg_steered_repeat_1",
          chatId: "chat_1",
          role: "user" as const,
          text: "repeat",
          eventType: "chat.message.steered",
          itemId: "turn_1",
          createdAt: "2026-04-25T00:01:00.000Z",
        },
        {
          id: "msg_steered_repeat_2",
          chatId: "chat_1",
          role: "user" as const,
          text: "repeat",
          eventType: "chat.message.steered",
          itemId: "turn_1",
          createdAt: "2026-04-25T00:02:00.000Z",
        },
      ],
    };
    const { codex, services } = await createHarness(state);
    codex.readThread.mockResolvedValueOnce({
      thread: {
        turns: [
          {
            id: "turn_1",
            createdAt: "2026-04-25T00:00:00.000Z",
            input: [{ text: "repeat" }],
            items: [
              { type: "userMessage", text: "repeat" },
              { type: "userMessage", text: "repeat" },
            ],
          },
        ],
      },
    });

    const messages = await services.getMessages("chat_1");

    deepStrictEqual(
      messages.map((message) => [
        message.id,
        message.role,
        message.text,
        message.eventType,
        message.createdAt,
      ]),
      [
        [
          "chat_1_codex_turn_1_0",
          "user",
          "repeat",
          undefined,
          "2026-04-25T00:00:00.000Z",
        ],
        [
          "chat_1_codex_turn_1_1",
          "user",
          "repeat",
          undefined,
          "2026-04-25T00:01:00.000Z",
        ],
        [
          "chat_1_codex_turn_1_2",
          "user",
          "repeat",
          undefined,
          "2026-04-25T00:02:00.000Z",
        ],
      ],
    );
  });

  it("does not match a steered message to repeated initial Codex input", async () => {
    const state = {
      ...createTestState(),
      projects: [createProject()],
      chats: [createChat()],
      messages: [
        {
          id: "msg_steered_after_inputs",
          chatId: "chat_1",
          role: "user" as const,
          text: "repeat",
          eventType: "chat.message.steered",
          itemId: "turn_1",
          createdAt: "2026-04-25T00:01:00.000Z",
        },
      ],
    };
    const { codex, services } = await createHarness(state);
    codex.readThread.mockResolvedValueOnce({
      thread: {
        turns: [
          {
            id: "turn_1",
            createdAt: "2026-04-25T00:00:00.000Z",
            input: [{ text: "repeat" }, { text: "repeat" }],
            items: [{ type: "userMessage", text: "repeat" }],
          },
        ],
      },
    });

    const messages = await services.getMessages("chat_1");

    deepStrictEqual(
      messages.map((message) => [
        message.id,
        message.role,
        message.text,
        message.eventType,
        message.createdAt,
        "codexItemSource" in message,
        "codexOrder" in message,
        "mergeSortBucket" in message,
        "mergeSortIndex" in message,
      ]),
      [
        [
          "chat_1_codex_turn_1_0",
          "user",
          "repeat",
          undefined,
          "2026-04-25T00:00:00.000Z",
          false,
          false,
          false,
          false,
        ],
        [
          "chat_1_codex_turn_1_1",
          "user",
          "repeat",
          undefined,
          "2026-04-25T00:00:00.000Z",
          false,
          false,
          false,
          false,
        ],
        [
          "chat_1_codex_turn_1_2",
          "user",
          "repeat",
          undefined,
          "2026-04-25T00:01:00.000Z",
          false,
          false,
          false,
          false,
        ],
      ],
    );
  });

  it("matches a steered Codex item when a turn has no input records", async () => {
    const state = {
      ...createTestState(),
      projects: [createProject()],
      chats: [createChat()],
      messages: [
        {
          id: "msg_steered_without_input",
          chatId: "chat_1",
          role: "user" as const,
          text: "repeat",
          eventType: "chat.message.steered",
          itemId: "turn_1",
          createdAt: "2026-04-25T00:01:00.000Z",
        },
      ],
    };
    const { codex, services } = await createHarness(state);
    codex.readThread.mockResolvedValueOnce({
      thread: {
        turns: [
          {
            id: "turn_1",
            createdAt: "2026-04-25T00:00:00.000Z",
            items: [{ type: "userMessage", text: "repeat" }],
          },
          {
            id: "turn_2",
            createdAt: "2026-04-25T00:03:00.000Z",
            items: [{ type: "userMessage", text: "repeat" }],
          },
        ],
      },
    });

    const messages = await services.getMessages("chat_1");

    deepStrictEqual(
      messages.map((message) => [
        message.id,
        message.role,
        message.text,
        message.eventType,
        message.createdAt,
      ]),
      [
        [
          "chat_1_codex_turn_1_0",
          "user",
          "repeat",
          undefined,
          "2026-04-25T00:01:00.000Z",
        ],
        [
          "chat_1_codex_turn_2_0",
          "user",
          "repeat",
          undefined,
          "2026-04-25T00:03:00.000Z",
        ],
      ],
    );
  });

  it("does not match a steered message to the first same-text item when a turn has no input records", async () => {
    const state = {
      ...createTestState(),
      projects: [createProject()],
      chats: [createChat()],
      messages: [
        {
          id: "msg_steered_without_input_repeat",
          chatId: "chat_1",
          role: "user" as const,
          text: "repeat",
          eventType: "chat.message.steered",
          itemId: "turn_1",
          createdAt: "2026-04-25T00:01:00.000Z",
        },
      ],
    };
    const { codex, services } = await createHarness(state);
    codex.readThread.mockResolvedValueOnce({
      thread: {
        turns: [
          {
            id: "turn_1",
            createdAt: "2026-04-25T00:00:00.000Z",
            items: [
              { type: "userMessage", text: "repeat" },
              { type: "userMessage", text: "repeat" },
            ],
          },
        ],
      },
    });

    const messages = await services.getMessages("chat_1");

    deepStrictEqual(
      messages.map((message) => [
        message.id,
        message.role,
        message.text,
        message.eventType,
        message.createdAt,
      ]),
      [
        [
          "chat_1_codex_turn_1_0",
          "user",
          "repeat",
          undefined,
          "2026-04-25T00:00:00.000Z",
        ],
        [
          "chat_1_codex_turn_1_1",
          "user",
          "repeat",
          undefined,
          "2026-04-25T00:01:00.000Z",
        ],
      ],
    );
  });

  it("preserves repeated same-text steered order when a turn has no input records", async () => {
    const state = {
      ...createTestState(),
      projects: [createProject()],
      chats: [createChat()],
      messages: [
        {
          id: "msg_steered_without_input_1",
          chatId: "chat_1",
          role: "user" as const,
          text: "repeat",
          eventType: "chat.message.steered",
          itemId: "turn_1",
          createdAt: "2026-04-25T00:01:00.000Z",
        },
        {
          id: "msg_steered_without_input_2",
          chatId: "chat_1",
          role: "user" as const,
          text: "repeat",
          eventType: "chat.message.steered",
          itemId: "turn_1",
          createdAt: "2026-04-25T00:02:00.000Z",
        },
      ],
    };
    const { codex, services } = await createHarness(state);
    codex.readThread.mockResolvedValueOnce({
      thread: {
        turns: [
          {
            id: "turn_1",
            createdAt: "2026-04-25T00:00:00.000Z",
            items: [
              { type: "userMessage", text: "repeat" },
              { type: "userMessage", text: "repeat" },
            ],
          },
        ],
      },
    });

    const messages = await services.getMessages("chat_1");

    deepStrictEqual(
      messages.map((message) => [
        message.id,
        message.role,
        message.text,
        message.eventType,
        message.createdAt,
      ]),
      [
        [
          "chat_1_codex_turn_1_0",
          "user",
          "repeat",
          undefined,
          "2026-04-25T00:01:00.000Z",
        ],
        [
          "chat_1_codex_turn_1_1",
          "user",
          "repeat",
          undefined,
          "2026-04-25T00:02:00.000Z",
        ],
      ],
    );
  });

  it("keeps Codex item order when a consumed steered message uses the local timestamp", async () => {
    const state = {
      ...createTestState(),
      projects: [createProject()],
      chats: [createChat()],
      messages: [
        {
          id: "msg_steered_before_assistant",
          chatId: "chat_1",
          role: "user" as const,
          text: "adjust course",
          eventType: "chat.message.steered",
          itemId: "turn_1",
          createdAt: "2026-04-25T00:01:00.000Z",
        },
      ],
    };
    const { codex, services } = await createHarness(state);
    codex.readThread.mockResolvedValueOnce({
      thread: {
        turns: [
          {
            id: "turn_1",
            createdAt: "2026-04-25T00:00:00.000Z",
            input: [{ text: "start" }],
            items: [
              { type: "userMessage", text: "adjust course" },
              { type: "assistantMessage", text: "done" },
            ],
          },
        ],
      },
    });

    const messages = await services.getMessages("chat_1");

    deepStrictEqual(
      messages.map((message) => [
        message.id,
        message.role,
        message.text,
        message.eventType,
        message.createdAt,
      ]),
      [
        [
          "chat_1_codex_turn_1_0",
          "user",
          "start",
          undefined,
          "2026-04-25T00:00:00.000Z",
        ],
        [
          "chat_1_codex_turn_1_1",
          "user",
          "adjust course",
          undefined,
          "2026-04-25T00:01:00.000Z",
        ],
        [
          "chat_1_codex_turn_1_2",
          "assistant",
          "done",
          undefined,
          "2026-04-25T00:00:00.000Z",
        ],
      ],
    );
  });

  it("preserves local chats that already match Codex threads", async () => {
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
    const services = new ServeServices({
      codex: codex as unknown as CodexBridge,
      store,
    });
    coreMocks.listWorktrees.mockResolvedValue({
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
    codex.listThreads.mockResolvedValueOnce({
      threads: [
        {
          id: threadId,
          cwd: worktreePath,
          title: "feature/list",
          createdAt: "2026-04-25T00:00:00.000Z",
          updatedAt: "2026-04-25T00:02:00.000Z",
        },
      ],
    });

    await services.listChats("proj_1");
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

  it("preserves queued chats when syncing Codex thread metadata", async () => {
    const worktreePath = "/repo/.git/phantom/worktrees/worktree";
    const state = {
      ...createTestState(),
      projects: [createProject()],
      chats: [
        createChat({
          codexThreadId: null,
          worktreeName: "worktree",
          worktreePath,
          branchName: "worktree",
        }),
      ],
      messages: [
        {
          id: "msg_queued",
          chatId: "chat_1",
          role: "user" as const,
          text: "queued while pending",
          eventType: "chat.message.queued",
          createdAt: timestamp,
        },
      ],
      queuedMessages: [
        {
          id: "queue_1",
          chatId: "chat_1",
          messageId: "msg_queued",
          text: "queued while pending",
          createdAt: timestamp,
        },
      ],
      selectedChatId: "chat_1",
    };
    const { codex, services, store } = await createHarness(state);
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
    codex.listThreads.mockResolvedValueOnce({ threads: [] });

    const chats = await services.listChats("proj_1");

    strictEqual(chats[0]?.id, "chat_1");
    const savedState = await store.load();
    strictEqual(savedState.chats.length, 1);
    strictEqual(savedState.chats[0]?.id, "chat_1");
    strictEqual(savedState.chats[0]?.codexThreadId, null);
    strictEqual(savedState.queuedMessages[0]?.text, "queued while pending");
    strictEqual(savedState.messages[0]?.text, "queued while pending");
    strictEqual(savedState.selectedChatId, "chat_1");
  });

  it("adds distinct Codex threads when a failed local chat exists for the same worktree", async () => {
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
    const services = new ServeServices({
      codex: codex as unknown as CodexBridge,
      store,
    });
    coreMocks.listWorktrees.mockResolvedValue({
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
    codex.listThreads.mockResolvedValueOnce({
      threads: [
        {
          id: importedThreadId,
          cwd: worktreePath,
          title: "imported",
          createdAt: "2026-04-25T00:00:00.000Z",
          updatedAt: "2026-04-25T00:01:00.000Z",
        },
      ],
    });

    await services.listChats("proj_1");

    const savedState = await store.load();
    deepStrictEqual(
      savedState.chats.map((chat) => [chat.id, chat.codexThreadId]),
      [
        ["chat_failed", failedThreadId],
        [`chat_codex_${importedThreadId}`, importedThreadId],
      ],
    );
  });

  it("starts a Codex thread after creating a worktree", async () => {
    const state = {
      ...createTestState(),
      projects: [createProject()],
    };
    const store = new ServeStateStore(await createTemporaryDirectory());
    await store.save(state);
    const codex = new FakeCodexBridge();
    const services = new ServeServices({
      codex: codex as unknown as CodexBridge,
      store,
    });
    coreMocks.runCreateWorktree.mockResolvedValueOnce({
      ok: true,
      value: {
        name: "feature",
        path: "/repo/.git/phantom/worktrees/feature",
      },
    });
    codex.startThread.mockResolvedValueOnce({ thread: { id: "thread_new" } });

    const chat = await services.createChat("proj_1", { name: "feature" });

    strictEqual(chat.title, "feature");
    strictEqual(chat.codexThreadId, "thread_new");
    deepStrictEqual(codex.startThread.mock.calls[0], [
      "/repo/.git/phantom/worktrees/feature",
    ]);
    const savedState = await store.load();
    strictEqual(savedState.selectedChatId, chat.id);
    deepStrictEqual(savedState.messages, []);
  });

  it("starts a new Codex thread in an existing worktree", async () => {
    const state = {
      ...createTestState(),
      projects: [createProject()],
    };
    const store = new ServeStateStore(await createTemporaryDirectory());
    await store.save(state);
    const codex = new FakeCodexBridge();
    const services = new ServeServices({
      codex: codex as unknown as CodexBridge,
      store,
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
    codex.startThread.mockResolvedValueOnce({ thread: { id: "thread_new" } });

    const chat = await services.createChat("proj_1", {
      worktreeName: "feature",
      worktreePath: "/repo/.git/phantom/worktrees/feature",
    });

    strictEqual(coreMocks.runCreateWorktree.mock.calls.length, 0);
    deepStrictEqual(coreMocks.listWorktrees.mock.calls[0], [
      "/repo",
      { includePrunable: false },
    ]);
    deepStrictEqual(codex.startThread.mock.calls[0], [
      "/repo/.git/phantom/worktrees/feature",
    ]);
    strictEqual(chat.worktreeName, "feature");
    strictEqual(chat.worktreePath, "/repo/.git/phantom/worktrees/feature");
    strictEqual(chat.branchName, "feature");
    strictEqual(chat.codexThreadId, "thread_new");
    const savedState = await store.load();
    strictEqual(savedState.selectedChatId, chat.id);
    deepStrictEqual(
      savedState.chats.map((candidate) => candidate.id),
      [chat.id],
    );
  });

  it("rejects partial existing-worktree chat creation input", async () => {
    const state = {
      ...createTestState(),
      projects: [createProject()],
    };
    const { codex, services } = await createHarness(state);

    await rejects(
      services.createChat("proj_1", {
        worktreeName: "feature",
      }),
      /Worktree path is required/,
    );

    strictEqual(coreMocks.runCreateWorktree.mock.calls.length, 0);
    strictEqual(coreMocks.listWorktrees.mock.calls.length, 0);
    strictEqual(codex.startThread.mock.calls.length, 0);
  });

  it("infers the worktree name from an initial message with codex exec", async () => {
    const state = {
      ...createTestState(),
      projects: [createProject()],
    };
    const store = new ServeStateStore(await createTemporaryDirectory());
    await store.save(state);
    const codex = new FakeCodexBridge();
    const services = new ServeServices({
      codex: codex as unknown as CodexBridge,
      store,
    });
    codex.exec.mockResolvedValueOnce("Fix/sidebar-new-chat\n");
    gitMocks.branchExists.mockResolvedValueOnce({ ok: true, value: false });
    coreMocks.runCreateWorktree.mockResolvedValueOnce({
      ok: true,
      value: {
        name: "fix/sidebar-new-chat",
        path: "/repo/.git/phantom/worktrees/fix/sidebar-new-chat",
      },
    });
    codex.startThread.mockResolvedValueOnce({ thread: { id: "thread_new" } });

    const chat = await services.createChat("proj_1", {
      initialMessage: "プロジェクトクリック時に新規チャットへ切り替えて",
    });

    strictEqual(chat.worktreeName, "fix/sidebar-new-chat");
    strictEqual(
      coreMocks.runCreateWorktree.mock.calls[0][0].name,
      "fix/sidebar-new-chat",
    );
    deepStrictEqual(codex.exec.mock.calls[0][1], {
      cwd: "/repo",
      model: "gpt-5.4-mini",
    });
  });

  it("falls back to generated worktree names when the inferred branch name is invalid", async () => {
    const state = {
      ...createTestState(),
      projects: [createProject()],
    };
    const store = new ServeStateStore(await createTemporaryDirectory());
    await store.save(state);
    const codex = new FakeCodexBridge();
    const services = new ServeServices({
      codex: codex as unknown as CodexBridge,
      store,
    });
    codex.exec.mockResolvedValueOnce("fix/sidebar.lock");
    coreMocks.runCreateWorktree.mockResolvedValueOnce({
      ok: true,
      value: {
        name: "generated-name",
        path: "/repo/.git/phantom/worktrees/generated-name",
      },
    });
    codex.startThread.mockResolvedValueOnce({ thread: { id: "thread_new" } });

    const chat = await services.createChat("proj_1", {
      initialMessage: "Fix the sidebar behavior",
    });

    strictEqual(chat.worktreeName, "generated-name");
    strictEqual(coreMocks.runCreateWorktree.mock.calls[0][0].name, undefined);
  });

  it("falls back to generated worktree names when the inferred name already exists", async () => {
    const state = {
      ...createTestState(),
      projects: [createProject()],
    };
    const store = new ServeStateStore(await createTemporaryDirectory());
    await store.save(state);
    const codex = new FakeCodexBridge();
    const services = new ServeServices({
      codex: codex as unknown as CodexBridge,
      store,
    });
    codex.exec.mockResolvedValueOnce("fix/sidebar");
    gitMocks.branchExists.mockResolvedValueOnce({ ok: true, value: false });
    coreMocks.runCreateWorktree
      .mockResolvedValueOnce({
        ok: false,
        error: new WorktreeAlreadyExistsError("fix/sidebar"),
      })
      .mockResolvedValueOnce({
        ok: true,
        value: {
          name: "generated-name",
          path: "/repo/.git/phantom/worktrees/generated-name",
        },
      });
    codex.startThread.mockResolvedValueOnce({ thread: { id: "thread_new" } });

    const chat = await services.createChat("proj_1", {
      initialMessage: "Fix the sidebar behavior",
    });

    strictEqual(chat.worktreeName, "generated-name");
    strictEqual(
      coreMocks.runCreateWorktree.mock.calls[0][0].name,
      "fix/sidebar",
    );
    strictEqual(coreMocks.runCreateWorktree.mock.calls[1][0].name, undefined);
  });

  it("falls back to generated worktree names when the inferred branch already exists", async () => {
    const state = {
      ...createTestState(),
      projects: [createProject()],
    };
    const store = new ServeStateStore(await createTemporaryDirectory());
    await store.save(state);
    const codex = new FakeCodexBridge();
    const services = new ServeServices({
      codex: codex as unknown as CodexBridge,
      store,
    });
    codex.exec.mockResolvedValueOnce("fix/sidebar");
    gitMocks.branchExists.mockResolvedValueOnce({ ok: true, value: true });
    coreMocks.runCreateWorktree.mockResolvedValueOnce({
      ok: true,
      value: {
        name: "generated-name",
        path: "/repo/.git/phantom/worktrees/generated-name",
      },
    });
    codex.startThread.mockResolvedValueOnce({ thread: { id: "thread_new" } });

    const chat = await services.createChat("proj_1", {
      initialMessage: "Fix the sidebar behavior",
    });

    strictEqual(chat.worktreeName, "generated-name");
    strictEqual(coreMocks.runCreateWorktree.mock.calls[0][0].name, undefined);
  });

  it("falls back to generated worktree names when name inference fails", async () => {
    const state = {
      ...createTestState(),
      projects: [createProject()],
    };
    const store = new ServeStateStore(await createTemporaryDirectory());
    await store.save(state);
    const codex = new FakeCodexBridge();
    const services = new ServeServices({
      codex: codex as unknown as CodexBridge,
      store,
    });
    codex.exec.mockRejectedValueOnce(new Error("Codex exec timed out"));
    coreMocks.runCreateWorktree.mockResolvedValueOnce({
      ok: true,
      value: {
        name: "generated-name",
        path: "/repo/.git/phantom/worktrees/generated-name",
      },
    });
    codex.startThread.mockResolvedValueOnce({ thread: { id: "thread_new" } });

    const chat = await services.createChat("proj_1", {
      initialMessage: "Fix the sidebar behavior",
    });

    strictEqual(chat.worktreeName, "generated-name");
    strictEqual(coreMocks.runCreateWorktree.mock.calls[0][0].name, undefined);
  });

  it("stores a newly created chat without importing existing history", async () => {
    const worktreePath = "/repo/.git/phantom/worktrees/feature";
    const state = {
      ...createTestState(),
      projects: [createProject()],
    };
    const store = new ImportRaceStore(
      await createTemporaryDirectory(),
      (currentState) => ({
        ...currentState,
        chats: [
          ...currentState.chats,
          createChat({
            id: "chat_concurrent",
            codexThreadId: "thread_concurrent",
            title: "Concurrent feature",
            worktreeName: "feature",
            worktreePath,
            branchName: "feature",
          }),
        ],
      }),
    );
    await store.save(state);
    const codex = new FakeCodexBridge();
    const services = new ServeServices({
      codex: codex as unknown as CodexBridge,
      store,
    });
    coreMocks.runCreateWorktree.mockResolvedValueOnce({
      ok: true,
      value: {
        name: "feature",
        path: worktreePath,
      },
    });
    codex.startThread.mockResolvedValueOnce({ thread: { id: "thread_new" } });

    const chat = await services.createChat("proj_1", { name: "feature" });

    strictEqual(chat.codexThreadId, "thread_new");
    const savedState = await store.load();
    deepStrictEqual(
      savedState.chats.map((candidate) => candidate.codexThreadId),
      ["thread_concurrent", "thread_new"],
    );
    strictEqual(savedState.selectedChatId, chat.id);
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

  it("keeps a worktree busy until all overlapping syncs finish", async () => {
    const worktreePath = "/repo/.git/phantom/worktrees/worktree";
    const state = {
      ...createTestState(),
      projects: [createProject()],
      chats: [
        createChat({
          worktreeName: "worktree",
          worktreePath,
        }),
      ],
    };
    const { codex, services } = await createHarness(state);
    coreMocks.createContext.mockResolvedValue({
      gitRoot: "/repo",
      worktreesDirectory: "/repo/.git/phantom/worktrees",
      preferences: {},
      config: {},
    });
    coreMocks.listWorktrees.mockResolvedValue({
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
    gitMocks.getUpstreamBranch.mockResolvedValue("origin/worktree");
    gitMocks.getRemotes.mockResolvedValue(["origin"]);
    const resolvePulls: Array<() => void> = [];
    gitMocks.pull.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvePulls.push(() => resolve({ ok: true, value: undefined }));
        }),
    );

    const firstSync = services.syncProjectWorktreeBranch("proj_1", {
      name: "worktree",
    });
    await vi.waitFor(() => {
      strictEqual(gitMocks.pull.mock.calls.length, 1);
    });
    const secondSync = services.syncProjectWorktreeBranch("proj_1", {
      name: "worktree",
    });
    await vi.waitFor(() => {
      strictEqual(gitMocks.pull.mock.calls.length, 2);
    });

    resolvePulls[0]!();
    await firstSync;

    await rejects(
      services.sendMessage("chat_1", { text: "during second sync" }),
      /busy/,
    );
    strictEqual(codex.startTurn.mock.calls.length, 0);

    resolvePulls[1]!();
    await secondSync;
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
    {
      description: "queued message",
      chat: {},
      hasQueuedMessage: true,
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
      queuedMessages: scenario.hasQueuedMessage
        ? [
            {
              id: "queue_1",
              chatId: "chat_1",
              messageId: "msg_queued",
              text: "queued before sync",
              createdAt: timestamp,
            },
          ]
        : [],
    };
    const { services } = await createHarness(state);
    if (scenario.markPending) {
      (
        services as unknown as { pendingChatTurns: Set<string> }
      ).pendingChatTurns.add("chat_1");
    } else if (!scenario.hasQueuedMessage) {
      markChatActiveInCurrentProcess(services, "chat_1");
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

  it("does not sync when a queued message appears after sync starts", async () => {
    const worktreePath = "/repo/.git/phantom/worktrees/worktree";
    const state = {
      ...createTestState(),
      projects: [createProject()],
      chats: [
        createChat({
          worktreeName: "worktree",
          worktreePath,
        }),
      ],
    };
    const { services, store } = await createHarness(state);
    coreMocks.createContext.mockResolvedValueOnce({
      gitRoot: "/repo",
      worktreesDirectory: "/repo/.git/phantom/worktrees",
      preferences: {},
      config: {},
    });
    coreMocks.listWorktrees.mockImplementationOnce(async () => {
      await store.update((currentState) => ({
        ...currentState,
        messages: [
          ...currentState.messages,
          {
            id: "msg_queued",
            chatId: "chat_1",
            role: "user" as const,
            text: "queued during sync",
            eventType: "chat.message.queued",
            createdAt: timestamp,
          },
        ],
        queuedMessages: [
          ...currentState.queuedMessages,
          {
            id: "queue_1",
            chatId: "chat_1",
            messageId: "msg_queued",
            text: "queued during sync",
            createdAt: timestamp,
          },
        ],
      }));
      return {
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
      };
    });

    await rejects(
      services.syncProjectWorktreeBranch("proj_1", { name: "worktree" }),
      /has an active chat/,
    );

    strictEqual(gitMocks.pull.mock.calls.length, 0);
    strictEqual(
      (await store.load()).queuedMessages[0]?.text,
      "queued during sync",
    );
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

  it("does not let stale transient chat state block worktree deletion", async () => {
    const worktreePath = "/repo/.git/phantom/worktrees/worktree";
    const state = {
      ...createTestState(),
      projects: [createProject()],
      chats: [
        createChat({
          branchName: "worktree",
          status: "running",
          activeTurnId: "turn_stale",
          worktreeName: "worktree",
          worktreePath,
        }),
      ],
      messages: [
        {
          id: "msg_stale",
          chatId: "chat_1",
          role: "event" as const,
          text: "turn started",
          createdAt: timestamp,
        },
      ],
      selectedChatId: "chat_1",
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
            name: "worktree",
            path: worktreePath,
            pathToDisplay: ".git/phantom/worktrees/worktree",
            branch: "worktree",
            isClean: true,
          },
        ],
      },
    });
    coreMocks.deleteWorktree.mockResolvedValueOnce({
      ok: true,
      value: { message: "Deleted worktree 'worktree'" },
    });

    const result = await services.deleteProjectWorktree("proj_1", {
      name: "worktree",
    });

    deepStrictEqual(result, { message: "Deleted worktree 'worktree'" });
    deepStrictEqual(coreMocks.deleteWorktree.mock.calls[0], [
      "/repo",
      "/repo/.git/phantom/worktrees",
      "worktree",
      { force: undefined, keepBranch: false, path: worktreePath },
      undefined,
    ]);
    const savedState = await store.load();
    deepStrictEqual(savedState.chats, []);
    deepStrictEqual(savedState.messages, []);
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
    markChatActiveInCurrentProcess(services, "chat_1");
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

  it("does not delete a worktree with queued messages", async () => {
    const worktreePath = "/repo/.git/phantom/worktrees/worktree";
    const state = {
      ...createTestState(),
      projects: [createProject()],
      chats: [
        createChat({
          branchName: "old-name",
          worktreeName: "old-name",
          worktreePath,
        }),
      ],
      queuedMessages: [
        {
          id: "queue_1",
          chatId: "chat_1",
          messageId: "msg_queued",
          text: "queued before delete",
          createdAt: timestamp,
        },
      ],
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
    strictEqual(
      (await store.load()).queuedMessages[0]?.text,
      "queued before delete",
    );
  });

  it("does not delete when a queued message appears after delete starts", async () => {
    const worktreePath = "/repo/.git/phantom/worktrees/worktree";
    const state = {
      ...createTestState(),
      projects: [createProject()],
      chats: [
        createChat({
          branchName: "old-name",
          worktreeName: "old-name",
          worktreePath,
        }),
      ],
    };
    const { services, store } = await createHarness(state);
    coreMocks.createContext.mockResolvedValueOnce({
      gitRoot: "/repo",
      worktreesDirectory: "/repo/.git/phantom/worktrees",
      preferences: {},
      config: {},
    });
    coreMocks.listWorktrees.mockImplementationOnce(async () => {
      await store.update((currentState) => ({
        ...currentState,
        messages: [
          ...currentState.messages,
          {
            id: "msg_queued",
            chatId: "chat_1",
            role: "user" as const,
            text: "queued during delete",
            eventType: "chat.message.queued",
            createdAt: timestamp,
          },
        ],
        queuedMessages: [
          ...currentState.queuedMessages,
          {
            id: "queue_1",
            chatId: "chat_1",
            messageId: "msg_queued",
            text: "queued during delete",
            createdAt: timestamp,
          },
        ],
      }));
      return {
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
      };
    });

    await rejects(
      services.deleteProjectWorktree("proj_1", { name: "worktree" }),
      /has an active chat/,
    );

    strictEqual(coreMocks.deleteWorktree.mock.calls.length, 0);
    strictEqual(
      (await store.load()).queuedMessages[0]?.text,
      "queued during delete",
    );
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
    markChatActiveInCurrentProcess(services, "chat_1");

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

  it("marks messages that steer an active turn", async () => {
    const state = {
      ...createTestState(),
      projects: [createProject()],
      chats: [createChat({ status: "running", activeTurnId: "turn_1" })],
    };
    const { codex, services, store } = await createHarness(state);
    markChatActiveInCurrentProcess(services, "chat_1");
    codex.resumeThread.mockResolvedValueOnce({});

    await services.steerMessage("chat_1", { text: "adjust course" });

    const savedState = await store.load();
    strictEqual(savedState.messages[0]?.text, "adjust course");
    strictEqual(savedState.messages[0]?.eventType, "chat.message.steered");
    strictEqual(savedState.messages[0]?.itemId, "turn_1");
    strictEqual(savedState.chats[0]?.status, "running");
    strictEqual(savedState.chats[0]?.activeTurnId, "turn_1");
    deepStrictEqual(codex.steerTurn.mock.calls[0], [
      "thread_1",
      "turn_1",
      "adjust course",
    ]);
    strictEqual(codex.startTurn.mock.calls.length, 0);
  });

  it("keeps a running chat active when steering fails", async () => {
    const state = {
      ...createTestState(),
      projects: [createProject()],
      chats: [createChat({ status: "running", activeTurnId: "turn_1" })],
    };
    const { codex, services, store } = await createHarness(state);
    markChatActiveInCurrentProcess(services, "chat_1");
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

  it("deletes queued messages before they are sent", async () => {
    const state = {
      ...createTestState(),
      projects: [createProject()],
      chats: [createChat({ status: "running", activeTurnId: "turn_1" })],
      messages: [
        {
          id: "msg_queued",
          chatId: "chat_1",
          role: "user" as const,
          text: "queued draft",
          eventType: "chat.message.queued",
          createdAt: timestamp,
        },
      ],
      queuedMessages: [
        {
          id: "queue_1",
          chatId: "chat_1",
          messageId: "msg_queued",
          text: "queued draft",
          createdAt: timestamp,
        },
      ],
    };
    const { services, store } = await createHarness(state);
    const emitSpy = vi.spyOn(services.eventHub, "emit");

    const result = await services.deletePendingMessage("chat_1", "msg_queued");

    strictEqual(result.message.text, "queued draft");
    strictEqual(result.queuedMessage.text, "queued draft");
    const savedState = await store.load();
    strictEqual(savedState.messages.length, 0);
    strictEqual(savedState.queuedMessages.length, 0);
    strictEqual(
      emitSpy.mock.calls.some((call) => call[0] === "chat.message.deleted"),
      true,
    );
  });

  it("restores deleted pending messages without submitting them while the chat is blocked", async () => {
    const state = {
      ...createTestState(),
      projects: [createProject()],
      chats: [createChat({ status: "running", activeTurnId: "turn_1" })],
      messages: [],
      queuedMessages: [],
    };
    const { codex, services, store } = await createHarness(state);
    markChatActiveInCurrentProcess(services, "chat_1");
    const emitSpy = vi.spyOn(services.eventHub, "emit");

    const result = await services.restorePendingMessage("chat_1", {
      message: {
        id: "msg_queued",
        chatId: "chat_1",
        role: "user",
        text: "queued draft",
        eventType: "chat.message.queued",
        createdAt: timestamp,
      },
      messageIndex: 0,
      queuedMessage: {
        id: "queue_1",
        chatId: "chat_1",
        messageId: "msg_queued",
        text: "queued draft",
        model: "gpt-5.2",
        createdAt: timestamp,
      },
      queuedMessageIndex: 0,
    });

    strictEqual(result.queuedMessage.model, "gpt-5.2");
    const savedState = await store.load();
    strictEqual(savedState.messages.length, 1);
    strictEqual(savedState.queuedMessages.length, 1);
    strictEqual(codex.startTurn.mock.calls.length, 0);
    strictEqual(
      emitSpy.mock.calls.some((call) => call[0] === "chat.message.created"),
      true,
    );
  });

  it("restarts queued drain after restoring a pending message into an idle chat", async () => {
    const state = {
      ...createTestState(),
      projects: [createProject()],
      chats: [createChat({ status: "idle", activeTurnId: null })],
      messages: [],
      queuedMessages: [],
    };
    const { codex, services, store } = await createHarness(state);
    codex.startTurn.mockResolvedValueOnce({ turn: { id: "turn_2" } });

    await services.restorePendingMessage("chat_1", {
      message: {
        id: "msg_queued",
        chatId: "chat_1",
        role: "user",
        text: "queued draft",
        eventType: "chat.message.queued",
        createdAt: timestamp,
      },
      messageIndex: 0,
      queuedMessage: {
        id: "queue_1",
        chatId: "chat_1",
        messageId: "msg_queued",
        text: "queued draft",
        createdAt: timestamp,
      },
      queuedMessageIndex: 0,
    });

    const savedState = await store.load();
    strictEqual(savedState.queuedMessages.length, 0);
    strictEqual(savedState.messages[0]?.eventType, undefined);
    deepStrictEqual(codex.startTurn.mock.calls[0], [
      "thread_1",
      "queued draft",
      "/repo/.git/phantom/worktrees/worktree",
    ]);
  });

  it("restores deleted pending messages to their original queue order", async () => {
    const state = {
      ...createTestState(),
      projects: [createProject()],
      chats: [createChat({ status: "running", activeTurnId: "turn_1" })],
      messages: [
        {
          id: "msg_later",
          chatId: "chat_1",
          role: "user" as const,
          text: "later queued draft",
          eventType: "chat.message.queued",
          createdAt: timestamp,
        },
      ],
      queuedMessages: [
        {
          id: "queue_later",
          chatId: "chat_1",
          messageId: "msg_later",
          text: "later queued draft",
          createdAt: timestamp,
        },
      ],
    };
    const { services, store } = await createHarness(state);
    markChatActiveInCurrentProcess(services, "chat_1");

    await services.restorePendingMessage("chat_1", {
      message: {
        id: "msg_earlier",
        chatId: "chat_1",
        role: "user",
        text: "earlier queued draft",
        eventType: "chat.message.queued",
        createdAt: timestamp,
      },
      messageIndex: 0,
      queuedMessage: {
        id: "queue_earlier",
        chatId: "chat_1",
        messageId: "msg_earlier",
        text: "earlier queued draft",
        createdAt: timestamp,
      },
      queuedMessageIndex: 0,
    });

    const savedState = await store.load();
    deepStrictEqual(
      savedState.queuedMessages.map((message) => message.id),
      ["queue_earlier", "queue_later"],
    );
    deepStrictEqual(
      savedState.messages.map((message) => message.id),
      ["msg_earlier", "msg_later"],
    );
  });

  it("does not delete steered messages after they are sent to Codex", async () => {
    const state = {
      ...createTestState(),
      projects: [createProject()],
      chats: [createChat({ status: "running", activeTurnId: "turn_1" })],
      messages: [
        {
          id: "msg_steered",
          chatId: "chat_1",
          role: "user" as const,
          text: "steered draft",
          eventType: "chat.message.steered",
          itemId: "turn_1",
          createdAt: timestamp,
        },
      ],
    };
    const { services, store } = await createHarness(state);

    await rejects(
      services.deletePendingMessage("chat_1", "msg_steered"),
      /Message is not pending/,
    );

    strictEqual((await store.load()).messages.length, 1);
  });

  it("does not delete messages after pending delivery completes", async () => {
    const state = {
      ...createTestState(),
      projects: [createProject()],
      chats: [createChat({ status: "running", activeTurnId: "turn_1" })],
      messages: [
        {
          id: "msg_sent",
          chatId: "chat_1",
          role: "user" as const,
          text: "already sent",
          createdAt: timestamp,
        },
      ],
    };
    const { services, store } = await createHarness(state);

    await rejects(
      services.deletePendingMessage("chat_1", "msg_sent"),
      /Message is not pending/,
    );

    strictEqual((await store.load()).messages.length, 1);
  });

  it("does not delete queued messages once promotion starts", async () => {
    const state = {
      ...createTestState(),
      projects: [createProject()],
      chats: [createChat({ status: "running", activeTurnId: "turn_1" })],
      messages: [
        {
          id: "msg_queued",
          chatId: "chat_1",
          role: "user" as const,
          text: "promoting",
          eventType: "chat.message.queued",
          createdAt: timestamp,
        },
      ],
    };
    const { services, store } = await createHarness(state);

    await rejects(
      services.deletePendingMessage("chat_1", "msg_queued"),
      /Queued message is already being sent/,
    );

    strictEqual((await store.load()).messages.length, 1);
  });

  it("does not delete queued messages after drain claims them", async () => {
    const state = {
      ...createTestState(),
      projects: [createProject()],
      chats: [createChat({ status: "running", activeTurnId: "turn_1" })],
      messages: [
        {
          id: "msg_queued",
          chatId: "chat_1",
          role: "user" as const,
          text: "promoting with context",
          eventType: "chat.message.queued",
          createdAt: timestamp,
        },
      ],
      queuedMessages: [
        {
          id: "queue_1",
          chatId: "chat_1",
          messageId: "msg_queued",
          text: "promoting with context",
          skills: [{ name: "review", path: "/skills/review/SKILL.md" }],
          createdAt: timestamp,
        },
      ],
    };
    const { codex, services, store } = await createHarness(state);
    markChatActiveInCurrentProcess(services, "chat_1");
    let resolveSkills!: (value: unknown) => void;
    codex.listSkills.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSkills = resolve;
        }),
    );
    codex.resumeThread.mockResolvedValueOnce({});
    codex.startTurn.mockResolvedValueOnce({ turn: { id: "turn_2" } });

    codex.emitNotification({
      method: "turn/completed",
      params: {
        threadId: "thread_1",
        turn: { id: "turn_1", status: "completed" },
      },
    });

    await vi.waitFor(async () => {
      strictEqual(codex.listSkills.mock.calls.length, 1);
      const savedState = await store.load();
      strictEqual(savedState.queuedMessages.length, 0);
      strictEqual(savedState.messages[0]?.eventType, undefined);
    });
    await rejects(
      services.deletePendingMessage("chat_1", "msg_queued"),
      /Message is not pending/,
    );
    await services.sendMessage("chat_1", { text: "new during claimed drain" });
    let savedState = await store.load();
    strictEqual(savedState.queuedMessages.length, 1);
    strictEqual(savedState.queuedMessages[0]?.text, "new during claimed drain");
    strictEqual(codex.startTurn.mock.calls.length, 0);

    resolveSkills({
      skills: [
        {
          enabled: true,
          name: "review",
          path: "/skills/review/SKILL.md",
        },
      ],
    });
    await vi.waitFor(() => {
      strictEqual(codex.startTurn.mock.calls.length, 1);
    });
    savedState = await store.load();
    strictEqual(savedState.queuedMessages.length, 1);
  });

  it("re-runs queued drain after enqueueing during an active drain that fails", async () => {
    const state = {
      ...createTestState(),
      projects: [createProject()],
      chats: [createChat({ status: "running", activeTurnId: "turn_1" })],
      messages: [
        {
          id: "msg_queued",
          chatId: "chat_1",
          role: "user" as const,
          text: "promoting with context",
          eventType: "chat.message.queued",
          createdAt: timestamp,
        },
      ],
      queuedMessages: [
        {
          id: "queue_1",
          chatId: "chat_1",
          messageId: "msg_queued",
          text: "promoting with context",
          skills: [{ name: "review", path: "/skills/review/SKILL.md" }],
          createdAt: timestamp,
        },
      ],
    };
    const { codex, services, store } = await createHarness(state);
    markChatActiveInCurrentProcess(services, "chat_1");
    let rejectSkills!: (reason: unknown) => void;
    codex.listSkills.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          rejectSkills = reject;
        }),
    );
    codex.startTurn.mockResolvedValueOnce({ turn: { id: "turn_3" } });
    codex.resumeThread.mockResolvedValue({});

    codex.emitNotification({
      method: "turn/completed",
      params: {
        threadId: "thread_1",
        turn: { id: "turn_1", status: "completed" },
      },
    });

    await vi.waitFor(async () => {
      strictEqual(codex.listSkills.mock.calls.length, 1);
      const savedState = await store.load();
      strictEqual(savedState.queuedMessages.length, 0);
    });
    await services.sendMessage("chat_1", { text: "new during claimed drain" });

    rejectSkills(new Error("skills failed"));
    await vi.waitFor(
      () => {
        strictEqual(codex.startTurn.mock.calls.length, 1);
      },
      { timeout: 3000 },
    );
    const savedState = await store.load();
    strictEqual(savedState.queuedMessages.length, 0);
    deepStrictEqual(
      codex.startTurn.mock.calls.map((call) => call[1]),
      ["new during claimed drain"],
    );
  });

  it("queues a message while a chat is running and starts it after the active turn completes", async () => {
    const state = {
      ...createTestState(),
      projects: [createProject()],
      chats: [createChat({ status: "running", activeTurnId: "turn_1" })],
    };
    const { codex, services, store } = await createHarness(state);
    markChatActiveInCurrentProcess(services, "chat_1");
    codex.resumeThread.mockResolvedValueOnce({});
    codex.startTurn.mockResolvedValueOnce({ turn: { id: "turn_2" } });

    await services.queueMessage("chat_1", { text: "follow up next" });

    let savedState = await store.load();
    strictEqual(savedState.messages[0]?.text, "follow up next");
    strictEqual(savedState.queuedMessages[0]?.text, "follow up next");
    strictEqual(savedState.chats[0]?.status, "running");
    strictEqual(savedState.chats[0]?.activeTurnId, "turn_1");
    strictEqual(codex.startTurn.mock.calls.length, 0);
    strictEqual(codex.steerTurn.mock.calls.length, 0);

    codex.emitNotification({
      method: "turn/completed",
      params: {
        threadId: "thread_1",
        turn: { id: "turn_1", status: "completed" },
      },
    });

    await vi.waitFor(() => {
      strictEqual(codex.startTurn.mock.calls.length, 1);
    });
    deepStrictEqual(codex.startTurn.mock.calls[0], [
      "thread_1",
      "follow up next",
      "/repo/.git/phantom/worktrees/worktree",
    ]);
    savedState = await store.load();
    strictEqual(savedState.queuedMessages.length, 0);
    strictEqual(savedState.chats[0]?.status, "running");
    strictEqual(savedState.chats[0]?.activeTurnId, "turn_2");
    deepStrictEqual(
      savedState.messages
        .filter((message) => message.role === "user")
        .map((message) => message.text),
      ["follow up next"],
    );
  });

  it("starts immediately when an active turn completes before the queue update is serialized", async () => {
    const state = {
      ...createTestState(),
      projects: [createProject()],
      chats: [createChat({ status: "running", activeTurnId: "turn_1" })],
    };
    const store = new ImportRaceStore(
      await createTemporaryDirectory(),
      (currentState) => ({
        ...currentState,
        chats: currentState.chats.map((chat) =>
          chat.id === "chat_1"
            ? { ...chat, status: "idle", activeTurnId: null }
            : chat,
        ),
      }),
    );
    await store.save(state);
    const codex = new FakeCodexBridge();
    const services = new ServeServices({
      codex: codex as unknown as CodexBridge,
      codexHome: await createTemporaryDirectory(),
      store,
    });
    markChatActiveInCurrentProcess(services, "chat_1");
    codex.resumeThread.mockResolvedValueOnce({});
    codex.startTurn.mockResolvedValueOnce({ turn: { id: "turn_2" } });

    await services.queueMessage("chat_1", { text: "race follow up" });

    const savedState = await store.load();
    strictEqual(savedState.queuedMessages.length, 0);
    strictEqual(savedState.chats[0]?.status, "running");
    strictEqual(savedState.chats[0]?.activeTurnId, "turn_2");
    deepStrictEqual(
      savedState.messages
        .filter((message) => message.role === "user")
        .map((message) => message.text),
      ["race follow up"],
    );
    deepStrictEqual(codex.startTurn.mock.calls[0], [
      "thread_1",
      "race follow up",
      "/repo/.git/phantom/worktrees/worktree",
    ]);
  });

  it("queues messages while a new turn is pending but not yet persisted as running", async () => {
    const state = {
      ...createTestState(),
      projects: [createProject()],
      chats: [createChat({ status: "idle", activeTurnId: null })],
    };
    const { codex, services, store } = await createHarness(state);
    (
      services as unknown as { pendingChatTurns: Set<string> }
    ).pendingChatTurns.add("chat_1");

    await services.queueMessage("chat_1", { text: "during pending start" });

    const savedState = await store.load();
    strictEqual(savedState.messages[0]?.text, "during pending start");
    strictEqual(savedState.queuedMessages[0]?.text, "during pending start");
    strictEqual(savedState.chats[0]?.status, "idle");
    strictEqual(codex.startTurn.mock.calls.length, 0);
    strictEqual(codex.steerTurn.mock.calls.length, 0);
  });

  it("queues messages while a new turn is normalizing context before starting", async () => {
    const state = {
      ...createTestState(),
      projects: [createProject()],
      chats: [createChat({ status: "idle", activeTurnId: null })],
    };
    const { codex, services, store } = await createHarness(state);
    let resolveSkills!: (value: unknown) => void;
    codex.listSkills.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSkills = resolve;
        }),
    );
    codex.resumeThread.mockResolvedValueOnce({});
    codex.startTurn.mockResolvedValueOnce({ turn: { id: "turn_1" } });

    const firstSend = services.sendMessage("chat_1", {
      skills: [{ name: "review", path: "/skills/review/SKILL.md" }],
      text: "start with skill",
    });
    await vi.waitFor(() => {
      strictEqual(codex.listSkills.mock.calls.length, 1);
    });

    await services.queueMessage("chat_1", {
      text: "queued during context normalization",
    });

    let savedState = await store.load();
    strictEqual(
      savedState.queuedMessages[0]?.text,
      "queued during context normalization",
    );
    strictEqual(codex.startTurn.mock.calls.length, 0);

    resolveSkills({
      skills: [
        {
          enabled: true,
          name: "review",
          path: "/skills/review/SKILL.md",
        },
      ],
    });
    await firstSend;

    savedState = await store.load();
    strictEqual(savedState.queuedMessages.length, 1);
    strictEqual(savedState.chats[0]?.status, "running");
    strictEqual(savedState.chats[0]?.activeTurnId, "turn_1");
    strictEqual(codex.startTurn.mock.calls.length, 1);
  });

  it("drains queued messages when a pending new turn fails during context normalization", async () => {
    const state = {
      ...createTestState(),
      projects: [createProject()],
      chats: [createChat({ status: "idle", activeTurnId: null })],
    };
    const { codex, services, store } = await createHarness(state);
    let rejectSkills!: (error: Error) => void;
    codex.listSkills.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          rejectSkills = reject;
        }),
    );
    codex.resumeThread.mockResolvedValueOnce({});
    codex.startTurn.mockResolvedValueOnce({ turn: { id: "turn_1" } });

    const firstSend = services.sendMessage("chat_1", {
      skills: [{ name: "review", path: "/skills/review/SKILL.md" }],
      text: "start with invalid skill context",
    });
    await vi.waitFor(() => {
      strictEqual(codex.listSkills.mock.calls.length, 1);
    });

    await services.queueMessage("chat_1", {
      text: "queued after failed normalization",
    });
    rejectSkills(new Error("skills unavailable"));
    await rejects(firstSend, /skills unavailable/);

    await vi.waitFor(() => {
      strictEqual(codex.startTurn.mock.calls.length, 1);
    });
    const savedState = await store.load();
    strictEqual(savedState.queuedMessages.length, 0);
    strictEqual(savedState.chats[0]?.status, "running");
    strictEqual(savedState.chats[0]?.activeTurnId, "turn_1");
    deepStrictEqual(
      savedState.messages
        .filter((message) => message.role === "user")
        .map((message) => message.text),
      ["queued after failed normalization"],
    );
  });

  it("keeps queued messages when a pending new turn fails after starting", async () => {
    const state = {
      ...createTestState(),
      projects: [createProject()],
      chats: [createChat({ status: "idle", activeTurnId: null })],
    };
    const { codex, services, store } = await createHarness(state);
    let rejectStart!: (error: Error) => void;
    codex.resumeThread.mockResolvedValueOnce({});
    codex.startTurn.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          rejectStart = reject;
        }),
    );

    const firstSend = services.sendMessage("chat_1", {
      text: "start but fail",
    });
    await vi.waitFor(() => {
      strictEqual(codex.startTurn.mock.calls.length, 1);
    });

    await services.queueMessage("chat_1", {
      text: "queued after rejected start",
    });
    rejectStart(new Error("Codex rejected the turn"));
    await rejects(firstSend, /Codex rejected the turn/);

    const savedState = await store.load();
    strictEqual(savedState.queuedMessages.length, 1);
    strictEqual(
      savedState.queuedMessages[0]?.text,
      "queued after rejected start",
    );
    deepStrictEqual(
      savedState.messages
        .filter((message) => message.role === "user")
        .map((message) => message.text),
      ["queued after rejected start"],
    );
    strictEqual(savedState.messages[0]?.eventType, "chat.message.queued");
    strictEqual(savedState.chats[0]?.status, "failed");
    strictEqual(savedState.chats[0]?.activeTurnId, null);
  });

  it("continues draining when a queued turn completes before buffered events flush", async () => {
    const state = {
      ...createTestState(),
      projects: [createProject()],
      chats: [createChat({ status: "running", activeTurnId: "turn_1" })],
    };
    const { codex, services, store } = await createHarness(state);
    markChatActiveInCurrentProcess(services, "chat_1");
    codex.resumeThread.mockResolvedValueOnce({});
    codex.startTurn
      .mockImplementationOnce(async () => {
        codex.emitNotification({
          method: "turn/completed",
          params: {
            threadId: "thread_1",
            turn: { id: "turn_2", status: "completed" },
          },
        });
        return { turn: { id: "turn_2" } };
      })
      .mockResolvedValueOnce({ turn: { id: "turn_3" } });

    await services.queueMessage("chat_1", { text: "first queued" });
    await services.queueMessage("chat_1", { text: "second queued" });

    codex.emitNotification({
      method: "turn/completed",
      params: {
        threadId: "thread_1",
        turn: { id: "turn_1", status: "completed" },
      },
    });

    await vi.waitFor(() => {
      strictEqual(codex.startTurn.mock.calls.length, 2);
    });
    strictEqual((await store.load()).queuedMessages.length, 0);
    strictEqual(codex.startTurn.mock.calls[0]?.[1], "first queued");
    strictEqual(codex.startTurn.mock.calls[1]?.[1], "second queued");
  });

  it("serializes overlapping queued drains without reporting contention", async () => {
    const state = {
      ...createTestState(),
      projects: [createProject()],
      chats: [createChat({ status: "idle", activeTurnId: null })],
      messages: [
        {
          id: "msg_queued",
          chatId: "chat_1",
          role: "user" as const,
          text: "queued once",
          eventType: "chat.message.queued",
          createdAt: timestamp,
        },
      ],
      queuedMessages: [
        {
          id: "queue_1",
          chatId: "chat_1",
          messageId: "msg_queued",
          text: "queued once",
          createdAt: timestamp,
        },
      ],
    };
    const { codex, services, store } = await createHarness(state);
    const emitSpy = vi.spyOn(services.eventHub, "emit");
    codex.resumeThread.mockResolvedValueOnce({});
    let resolveStart!: (value: { turn: { id: string } }) => void;
    codex.startTurn.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveStart = resolve;
        }),
    );
    const drainQueuedMessagesAndReport = (
      services as unknown as {
        drainQueuedMessagesAndReport(chatId: string): Promise<void>;
      }
    ).drainQueuedMessagesAndReport.bind(services);

    const firstDrain = drainQueuedMessagesAndReport("chat_1");
    await vi.waitFor(() => {
      strictEqual(codex.startTurn.mock.calls.length, 1);
    });
    const secondDrain = drainQueuedMessagesAndReport("chat_1");

    await secondDrain;
    resolveStart({ turn: { id: "turn_2" } });
    await firstDrain;

    const savedState = await store.load();
    strictEqual(codex.startTurn.mock.calls.length, 1);
    strictEqual(savedState.queuedMessages.length, 0);
    strictEqual(
      savedState.messages.some((message) => message.role === "error"),
      false,
    );
    strictEqual(
      emitSpy.mock.calls.some((call) => call[0] === "agent.error"),
      false,
    );
  });

  it("removes queued records when queued turn promotion fails", async () => {
    const state = {
      ...createTestState(),
      projects: [createProject()],
      chats: [createChat({ status: "running", activeTurnId: "turn_1" })],
      messages: [
        {
          id: "msg_queued",
          chatId: "chat_1",
          role: "user" as const,
          text: "queued failure",
          eventType: "chat.message.queued",
          createdAt: timestamp,
        },
      ],
      queuedMessages: [
        {
          id: "queue_1",
          chatId: "chat_1",
          messageId: "msg_queued",
          text: "queued failure",
          createdAt: timestamp,
        },
      ],
    };
    const { codex, services, store } = await createHarness(state);
    markChatActiveInCurrentProcess(services, "chat_1");
    const emitSpy = vi.spyOn(services.eventHub, "emit");
    codex.resumeThread.mockResolvedValueOnce({});
    codex.startTurn.mockRejectedValueOnce(new Error("queued start failed"));

    codex.emitNotification({
      method: "turn/completed",
      params: {
        threadId: "thread_1",
        turn: { id: "turn_1", status: "completed" },
      },
    });

    await vi.waitFor(() => {
      strictEqual(
        emitSpy.mock.calls.some((call) => call[0] === "agent.error"),
        true,
      );
    });
    const savedState = await store.load();
    strictEqual(savedState.queuedMessages.length, 0);
    strictEqual(savedState.messages[0]?.text, "queued failure");
    strictEqual(savedState.messages.at(-1)?.role, "error");
    strictEqual(savedState.messages.at(-1)?.text, "queued start failed");
    strictEqual(savedState.chats[0]?.status, "failed");
    strictEqual(savedState.chats[0]?.activeTurnId, null);
  });

  it("removes queued records when queued turn context normalization fails", async () => {
    const state = {
      ...createTestState(),
      projects: [createProject()],
      chats: [createChat({ status: "running", activeTurnId: "turn_1" })],
      messages: [
        {
          id: "msg_queued",
          chatId: "chat_1",
          role: "user" as const,
          text: "queued invalid context",
          eventType: "chat.message.queued",
          createdAt: timestamp,
        },
      ],
      queuedMessages: [
        {
          id: "queue_1",
          chatId: "chat_1",
          messageId: "msg_queued",
          text: "queued invalid context",
          skills: [{ name: "review", path: "/skills/review/SKILL.md" }],
          createdAt: timestamp,
        },
      ],
    };
    const { codex, services, store } = await createHarness(state);
    markChatActiveInCurrentProcess(services, "chat_1");
    const emitSpy = vi.spyOn(services.eventHub, "emit");
    codex.listSkills.mockResolvedValueOnce({ skills: [] });

    codex.emitNotification({
      method: "turn/completed",
      params: {
        threadId: "thread_1",
        turn: { id: "turn_1", status: "completed" },
      },
    });

    await vi.waitFor(async () => {
      const savedState = await store.load();
      strictEqual(savedState.queuedMessages.length, 0);
      strictEqual(
        emitSpy.mock.calls.some((call) => call[0] === "agent.error"),
        true,
      );
    });
    const savedState = await store.load();
    strictEqual(codex.startTurn.mock.calls.length, 0);
    strictEqual(savedState.messages[0]?.text, "queued invalid context");
    strictEqual(savedState.messages[0]?.eventType, undefined);
    strictEqual(savedState.messages.at(-1)?.role, "error");
    strictEqual(
      savedState.messages.at(-1)?.text,
      "Skill context path is not available: /skills/review/SKILL.md",
    );
    strictEqual(savedState.chats[0]?.status, "idle");
    strictEqual(savedState.chats[0]?.activeTurnId, null);
  });

  it("removes stale queued records and reports when the queued message is missing", async () => {
    const state = {
      ...createTestState(),
      projects: [createProject()],
      chats: [createChat({ status: "running", activeTurnId: "turn_1" })],
      queuedMessages: [
        {
          id: "queue_1",
          chatId: "chat_1",
          messageId: "msg_missing",
          text: "missing queued message",
          createdAt: timestamp,
        },
      ],
    };
    const { codex, services, store } = await createHarness(state);
    markChatActiveInCurrentProcess(services, "chat_1");
    const emitSpy = vi.spyOn(services.eventHub, "emit");

    codex.emitNotification({
      method: "turn/completed",
      params: {
        threadId: "thread_1",
        turn: { id: "turn_1", status: "completed" },
      },
    });

    await vi.waitFor(() => {
      strictEqual(
        emitSpy.mock.calls.some((call) => call[0] === "agent.error"),
        true,
      );
    });
    const savedState = await store.load();
    strictEqual(savedState.queuedMessages.length, 0);
    strictEqual(savedState.messages.at(-1)?.role, "error");
    strictEqual(
      savedState.messages.at(-1)?.text,
      "Queued message was not found",
    );
    strictEqual(codex.startTurn.mock.calls.length, 0);
  });

  it("starts existing queued messages before new sends on inactive chats", async () => {
    const state = {
      ...createTestState(),
      projects: [createProject()],
      chats: [createChat({ status: "failed", activeTurnId: null })],
      messages: [
        {
          id: "msg_queued",
          chatId: "chat_1",
          role: "user" as const,
          text: "queued first",
          eventType: "chat.message.queued",
          createdAt: timestamp,
        },
      ],
      queuedMessages: [
        {
          id: "queue_1",
          chatId: "chat_1",
          messageId: "msg_queued",
          text: "queued first",
          createdAt: timestamp,
        },
      ],
    };
    const { codex, services, store } = await createHarness(state);
    codex.resumeThread.mockResolvedValueOnce({});
    codex.startTurn.mockResolvedValueOnce({ turn: { id: "turn_2" } });

    await services.sendMessage("chat_1", { text: "new after queue" });

    const savedState = await store.load();
    strictEqual(codex.startTurn.mock.calls[0]?.[1], "queued first");
    strictEqual(savedState.chats[0]?.status, "running");
    strictEqual(savedState.chats[0]?.activeTurnId, "turn_2");
    deepStrictEqual(
      savedState.messages
        .filter((message) => message.role === "user")
        .map((message) => [message.text, message.eventType]),
      [
        ["queued first", undefined],
        ["new after queue", "chat.message.queued"],
      ],
    );
    strictEqual(savedState.queuedMessages.length, 1);
    strictEqual(savedState.queuedMessages[0]?.text, "new after queue");
  });

  it("drains queued messages one turn at a time", async () => {
    const state = {
      ...createTestState(),
      projects: [createProject()],
      chats: [createChat({ status: "running", activeTurnId: "turn_1" })],
    };
    const { codex, services, store } = await createHarness(state);
    markChatActiveInCurrentProcess(services, "chat_1");
    codex.resumeThread.mockResolvedValueOnce({});
    codex.startTurn
      .mockResolvedValueOnce({ turn: { id: "turn_2" } })
      .mockResolvedValueOnce({ turn: { id: "turn_3" } });

    await services.queueMessage("chat_1", { text: "first queued" });
    await services.queueMessage("chat_1", { text: "second queued" });

    codex.emitNotification({
      method: "turn/completed",
      params: {
        threadId: "thread_1",
        turn: { id: "turn_1", status: "completed" },
      },
    });

    await vi.waitFor(() => {
      strictEqual(codex.startTurn.mock.calls.length, 1);
    });
    strictEqual((await store.load()).queuedMessages.length, 1);
    strictEqual(codex.startTurn.mock.calls[0]?.[1], "first queued");

    codex.emitNotification({
      method: "turn/completed",
      params: {
        threadId: "thread_1",
        turn: { id: "turn_2", status: "completed" },
      },
    });

    await vi.waitFor(() => {
      strictEqual(codex.startTurn.mock.calls.length, 2);
    });
    strictEqual((await store.load()).queuedMessages.length, 0);
    strictEqual(codex.startTurn.mock.calls[1]?.[1], "second queued");
  });

  it("queues messages while the chat is waiting for approval", async () => {
    const state = {
      ...createTestState(),
      projects: [createProject()],
      chats: [
        createChat({ status: "waitingForApproval", activeTurnId: "turn_1" }),
      ],
    };
    const { codex, services, store } = await createHarness(state);
    markChatActiveInCurrentProcess(services, "chat_1");

    await services.queueMessage("chat_1", { text: "after approval" });

    const savedState = await store.load();
    strictEqual(savedState.messages[0]?.text, "after approval");
    strictEqual(savedState.queuedMessages[0]?.text, "after approval");
    strictEqual(savedState.chats[0]?.status, "waitingForApproval");
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
