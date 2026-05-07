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
  githubCheckout: vi.fn(),
  listGitHubCheckoutTargets: vi.fn(),
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
const validPngBytes = new Uint8Array([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0,
  0, 0, 1, 8, 4, 0, 0, 0, 181, 28, 12, 2, 0, 0, 0, 11, 73, 68, 65, 84, 120, 218,
  99, 252, 255, 31, 0, 3, 3, 2, 0, 239, 162, 167, 91, 0, 0, 0, 0, 73, 69, 78,
  68, 174, 66, 96, 130,
]);
const validInterlacedPngBytes = new Uint8Array([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0,
  0, 0, 1, 8, 2, 0, 0, 1, 231, 112, 99, 72, 0, 0, 0, 12, 73, 68, 65, 84, 120,
  156, 99, 96, 96, 96, 0, 0, 0, 4, 0, 1, 246, 23, 56, 85, 0, 0, 0, 0, 73, 69,
  78, 68, 174, 66, 96, 130,
]);

class FakeCodexBridge {
  readonly notificationHandlers: Array<(message: CodexMessage) => void> = [];
  readonly processExitHandlers: Array<(error: Error) => void> = [];
  readonly serverRequestHandlers: Array<(message: CodexMessage) => void> = [];
  readonly archiveThread = vi.fn();
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
  readonly unarchiveThread = vi.fn();

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

async function createHarness(
  state: ServeState,
  options: { attachmentDir?: string } = {},
): Promise<{
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
    attachmentDir: options.attachmentDir,
    codex: codex as unknown as CodexBridge,
    codexHome,
    store,
  });
  return { codex, codexHome, services, store };
}

function getEmittedCodexParams(
  calls: Array<[string, unknown, ...unknown[]]>,
  eventType: string,
  method: string,
  itemType?: string,
): Record<string, unknown> | undefined {
  const call = calls.find(([type, data]) => {
    const message = data as CodexMessage;
    if (type !== eventType || message.method !== method) {
      return false;
    }
    if (!itemType) {
      return true;
    }
    const params = message.params as { item?: { type?: unknown } } | undefined;
    return params?.item?.type === itemType;
  });
  return (call?.[1] as CodexMessage | undefined)?.params as
    | Record<string, unknown>
    | undefined;
}

function markChatActiveInCurrentProcess(
  services: ServeServices,
  chatId: string,
): void {
  (
    services as unknown as { activeTurnChatIds: Set<string> }
  ).activeTurnChatIds.add(chatId);
}

function markChatDrainingQueuedMessages(
  services: ServeServices,
  chatId: string,
): void {
  (
    services as unknown as { drainingQueuedMessageChatIds: Set<string> }
  ).drainingQueuedMessageChatIds.add(chatId);
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
  it("strips hidden rich event bodies from existing state on service access", async () => {
    const state = {
      ...createTestState(),
      projects: [createProject()],
      chats: [createChat()],
      messages: [
        {
          id: "msg_command",
          chatId: "chat_1",
          role: "event" as const,
          text: "large command output",
          eventType: "item/commandExecution/outputDelta",
          eventData: {
            command: "pnpm test",
            text: "large command output",
          },
          createdAt: timestamp,
        },
        {
          id: "msg_diff",
          chatId: "chat_1",
          role: "event" as const,
          text: "Diff updated: 1 file",
          eventType: "turn/diff/updated",
          eventData: {
            diff: "large diff",
            files: ["src/app.ts"],
            hasDiff: true,
          },
          createdAt: timestamp,
        },
        {
          id: "msg_patch",
          chatId: "chat_1",
          role: "event" as const,
          text: "File patch updated: 1 file",
          eventType: "item/fileChange/patchUpdated",
          eventData: {
            changes: [
              {
                diff: "large patch",
                kind: "modify",
                path: "src/app.ts",
              },
            ],
          },
          createdAt: timestamp,
        },
      ],
    };
    const { services, store } = await createHarness(state);

    await services.listProjects();

    const savedState = await store.load();
    deepStrictEqual(
      savedState.messages.map((message) => ({
        eventData: message.eventData,
        text: message.text,
      })),
      [
        {
          eventData: {
            command: "pnpm test",
          },
          text: "",
        },
        {
          eventData: {
            files: ["src/app.ts"],
            hasDiff: true,
          },
          text: "Diff updated: 1 file",
        },
        {
          eventData: {
            changes: [
              {
                kind: "modify",
                path: "src/app.ts",
              },
            ],
          },
          text: "File patch updated: 1 file",
        },
      ],
    );
  });

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

  it("does not remove a project with an active chat", async () => {
    const state = {
      ...createTestState(),
      projects: [createProject()],
      chats: [
        createChat({
          status: "running",
          activeTurnId: "turn_1",
        }),
      ],
      selectedProjectId: "proj_1",
      selectedChatId: "chat_1",
    };
    const { services, store } = await createHarness(state);
    markChatActiveInCurrentProcess(services, "chat_1");

    await rejects(
      services.removeProject("proj_1"),
      /running, approval, or queued chats/,
    );

    const savedState = await store.load();
    strictEqual(savedState.projects.length, 1);
    strictEqual(savedState.chats.length, 1);
    strictEqual(savedState.selectedProjectId, "proj_1");
    strictEqual(savedState.selectedChatId, "chat_1");
  });

  it("does not remove a project with queued messages", async () => {
    const state = {
      ...createTestState(),
      projects: [createProject()],
      chats: [createChat()],
      messages: [
        {
          id: "msg_queued",
          chatId: "chat_1",
          role: "user" as const,
          text: "queued draft",
          createdAt: timestamp,
          eventType: "chat.message.queued" as const,
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

    await rejects(
      services.removeProject("proj_1"),
      /running, approval, or queued chats/,
    );

    const savedState = await store.load();
    strictEqual(savedState.projects.length, 1);
    strictEqual(savedState.chats.length, 1);
    strictEqual(savedState.queuedMessages.length, 1);
  });

  it("does not remove a project while queued messages are draining", async () => {
    const state = {
      ...createTestState(),
      projects: [createProject()],
      chats: [createChat()],
      selectedProjectId: "proj_1",
      selectedChatId: "chat_1",
    };
    const { services, store } = await createHarness(state);
    markChatDrainingQueuedMessages(services, "chat_1");

    await rejects(
      services.removeProject("proj_1"),
      /running, approval, or queued chats/,
    );

    const savedState = await store.load();
    strictEqual(savedState.projects.length, 1);
    strictEqual(savedState.chats.length, 1);
    strictEqual(savedState.selectedProjectId, "proj_1");
    strictEqual(savedState.selectedChatId, "chat_1");
  });

  it("does not let stale transient chat state block project removal", async () => {
    const state = {
      ...createTestState(),
      projects: [createProject()],
      chats: [
        createChat({
          status: "running",
          activeTurnId: "turn_stale",
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
      selectedProjectId: "proj_1",
      selectedChatId: "chat_1",
    };
    const { services, store } = await createHarness(state);

    await services.removeProject("proj_1");

    const savedState = await store.load();
    deepStrictEqual(savedState.projects, []);
    deepStrictEqual(savedState.chats, []);
    deepStrictEqual(savedState.messages, []);
    strictEqual(savedState.selectedProjectId, null);
    strictEqual(savedState.selectedChatId, null);
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

  it("annotates project chats with queued message state", async () => {
    const state = {
      ...createTestState(),
      projects: [createProject()],
      chats: [createChat()],
      messages: [
        {
          id: "msg_queued",
          chatId: "chat_1",
          role: "user" as const,
          text: "queued draft",
          createdAt: timestamp,
          eventType: "chat.message.queued" as const,
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
    const { services } = await createHarness(state);
    markChatDrainingQueuedMessages(services, "chat_1");

    const chats = await services.listChats("proj_1");

    strictEqual(chats[0]?.hasQueuedMessages, true);
    strictEqual(chats[0]?.isDrainingQueuedMessages, true);
  });

  it("annotates a selected chat with queued message state", async () => {
    const state = {
      ...createTestState(),
      projects: [createProject()],
      chats: [createChat()],
      messages: [
        {
          id: "msg_queued",
          chatId: "chat_1",
          role: "user" as const,
          text: "queued draft",
          createdAt: timestamp,
          eventType: "chat.message.queued" as const,
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
    const { services } = await createHarness(state);
    markChatDrainingQueuedMessages(services, "chat_1");

    const chat = await services.getChat("chat_1");

    strictEqual(chat.hasQueuedMessages, true);
    strictEqual(chat.isDrainingQueuedMessages, true);
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

  it("syncs Codex archived thread state when syncing metadata", async () => {
    const threadId = "019dc000-0000-7000-8000-000000000001";
    const worktreePath = "/repo/.git/phantom/worktrees/feature/list";
    const { codex, services, store } = await createHarness({
      ...createTestState(),
      projects: [createProject()],
      chats: [
        createChat({
          codexThreadId: threadId,
          status: "idle",
          worktreeName: "feature/list",
          worktreePath,
        }),
      ],
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
    codex.listThreads.mockResolvedValueOnce({ threads: [] });
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

    const chats = await services.listChats("proj_1");

    strictEqual(chats[0]?.status, "archived");
    strictEqual((await store.load()).chats[0]?.status, "archived");
    strictEqual(codex.listThreads.mock.calls[0]?.[0]?.archived, false);
    strictEqual(codex.listThreads.mock.calls[1]?.[0]?.archived, true);
  });

  it("rejects unsafe Codex archived metadata and restores Codex", async () => {
    const threadId = "019dc000-0000-7000-8000-000000000001";
    const worktreePath = "/repo/.git/phantom/worktrees/feature/list";
    const { codex, services, store } = await createHarness({
      ...createTestState(),
      projects: [createProject()],
      chats: [
        createChat({
          activeTurnId: "turn_1",
          codexThreadId: threadId,
          status: "running",
          worktreeName: "feature/list",
          worktreePath,
        }),
      ],
    });
    markChatActiveInCurrentProcess(services, "chat_1");
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
    codex.listThreads.mockResolvedValueOnce({ threads: [] });
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

    const chats = await services.listChats("proj_1");
    const savedChat = (await store.load()).chats[0];

    strictEqual(chats[0]?.status, "running");
    strictEqual(chats[0]?.activeTurnId, "turn_1");
    strictEqual(savedChat?.status, "running");
    strictEqual(savedChat?.activeTurnId, "turn_1");
    deepStrictEqual(codex.unarchiveThread.mock.calls, [[threadId]]);
  });

  it("rejects Codex archived metadata while local messages are queued", async () => {
    const threadId = "019dc000-0000-7000-8000-000000000001";
    const worktreePath = "/repo/.git/phantom/worktrees/feature/list";
    const { codex, services, store } = await createHarness({
      ...createTestState(),
      projects: [createProject()],
      chats: [
        createChat({
          codexThreadId: threadId,
          worktreeName: "feature/list",
          worktreePath,
        }),
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
    codex.listThreads.mockResolvedValueOnce({ threads: [] });
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

    const chats = await services.listChats("proj_1");
    const savedState = await store.load();

    strictEqual(chats[0]?.status, "idle");
    strictEqual(savedState.chats[0]?.status, "idle");
    strictEqual(savedState.queuedMessages.length, 1);
    deepStrictEqual(codex.unarchiveThread.mock.calls, [[threadId]]);
  });

  it("syncs Codex unarchived thread state when syncing metadata", async () => {
    const threadId = "019dc000-0000-7000-8000-000000000001";
    const worktreePath = "/repo/.git/phantom/worktrees/feature/list";
    const { codex, services, store } = await createHarness({
      ...createTestState(),
      projects: [createProject()],
      chats: [
        createChat({
          codexThreadId: threadId,
          status: "archived",
          worktreeName: "feature/list",
          worktreePath,
        }),
      ],
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
    codex.listThreads.mockResolvedValueOnce({ threads: [] });

    const chats = await services.listChats("proj_1");

    strictEqual(chats[0]?.status, "idle");
    strictEqual((await store.load()).chats[0]?.status, "idle");
  });

  it("archives and restores idle chats", async () => {
    const { codex, services, store } = await createHarness({
      ...createTestState(),
      projects: [createProject()],
      chats: [createChat()],
    });

    const archivedChat = await services.setChatArchived("chat_1", true);
    const restoredChat = await services.setChatArchived("chat_1", false);

    strictEqual(archivedChat.status, "archived");
    strictEqual(archivedChat.activeTurnId, null);
    strictEqual(restoredChat.status, "idle");
    strictEqual((await store.load()).chats[0]?.status, "idle");
    deepStrictEqual(codex.archiveThread.mock.calls, [["thread_1"]]);
    deepStrictEqual(codex.unarchiveThread.mock.calls, [["thread_1"]]);
  });

  it("archives local chats without Codex threads locally", async () => {
    const { codex, services, store } = await createHarness({
      ...createTestState(),
      projects: [createProject()],
      chats: [createChat({ codexThreadId: null })],
    });

    const archivedChat = await services.setChatArchived("chat_1", true);

    strictEqual(archivedChat.status, "archived");
    strictEqual((await store.load()).chats[0]?.status, "archived");
    strictEqual(codex.archiveThread.mock.calls.length, 0);
    strictEqual(codex.unarchiveThread.mock.calls.length, 0);
  });

  it("does not update local archive state when Codex archive fails", async () => {
    const { codex, services, store } = await createHarness({
      ...createTestState(),
      projects: [createProject()],
      chats: [createChat()],
    });
    codex.archiveThread.mockRejectedValueOnce(new Error("archive failed"));

    await rejects(services.setChatArchived("chat_1", true), /archive failed/);

    strictEqual((await store.load()).chats[0]?.status, "idle");
  });

  it("blocks messages while Codex archive is in progress", async () => {
    const { codex, services, store } = await createHarness({
      ...createTestState(),
      projects: [createProject()],
      chats: [createChat()],
    });
    let resolveArchive!: () => void;
    const archivePromise = new Promise<void>((resolve) => {
      resolveArchive = resolve;
    });
    codex.archiveThread.mockReturnValueOnce(archivePromise);

    const archive = services.setChatArchived("chat_1", true);
    await vi.waitFor(() => {
      strictEqual(codex.archiveThread.mock.calls.length, 1);
    });

    await rejects(
      services.sendMessage("chat_1", { text: "racing message" }),
      /archive state is already changing/,
    );

    resolveArchive();
    const archivedChat = await archive;
    const savedState = await store.load();
    strictEqual(archivedChat.status, "archived");
    strictEqual(savedState.chats[0]?.status, "archived");
    strictEqual(savedState.messages.length, 0);
    strictEqual(savedState.queuedMessages.length, 0);
  });

  it("ignores turn state changes while Codex archive is in progress", async () => {
    const { codex, services, store } = await createHarness({
      ...createTestState(),
      projects: [createProject()],
      chats: [createChat()],
    });
    const emitSpy = vi.spyOn(services.eventHub, "emit");
    let resolveArchive!: () => void;
    const archivePromise = new Promise<void>((resolve) => {
      resolveArchive = resolve;
    });
    codex.archiveThread.mockReturnValueOnce(archivePromise);

    const archive = services.setChatArchived("chat_1", true);
    await vi.waitFor(() => {
      strictEqual(codex.archiveThread.mock.calls.length, 1);
    });

    codex.emitNotification({
      method: "turn/started",
      params: {
        threadId: "thread_1",
        turn: { id: "turn_1" },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    resolveArchive();
    const archivedChat = await archive;
    const savedState = await store.load();
    strictEqual(archivedChat.status, "archived");
    strictEqual(savedState.chats[0]?.status, "archived");
    strictEqual(savedState.chats[0]?.activeTurnId, null);
    strictEqual(
      emitSpy.mock.calls.some((call) => call[0] === "agent.turn.started"),
      false,
    );
  });

  it("does not alter non-archived chats when restore is requested", async () => {
    const { services, store } = await createHarness({
      ...createTestState(),
      projects: [createProject()],
      chats: [
        createChat({
          activeTurnId: "turn_1",
          status: "running",
        }),
      ],
    });
    markChatActiveInCurrentProcess(services, "chat_1");

    const restoredChat = await services.setChatArchived("chat_1", false);
    const savedChat = (await store.load()).chats[0];

    strictEqual(restoredChat.status, "running");
    strictEqual(restoredChat.activeTurnId, "turn_1");
    strictEqual(savedChat?.status, "running");
    strictEqual(savedChat?.activeTurnId, "turn_1");
  });

  it("rejects archiving active chats and sending messages to archived chats", async () => {
    const { services } = await createHarness({
      ...createTestState(),
      projects: [createProject()],
      chats: [createChat({ activeTurnId: "turn_1", status: "running" })],
    });
    markChatActiveInCurrentProcess(services, "chat_1");

    await rejects(
      services.setChatArchived("chat_1", true),
      /Cannot archive a chat/,
    );

    const { services: inProcessServices } = await createHarness({
      ...createTestState(),
      projects: [createProject()],
      chats: [createChat()],
    });
    markChatActiveInCurrentProcess(inProcessServices, "chat_1");
    await rejects(
      inProcessServices.setChatArchived("chat_1", true),
      /Cannot archive a chat/,
    );

    const { services: queuedServices } = await createHarness({
      ...createTestState(),
      projects: [createProject()],
      chats: [createChat()],
      queuedMessages: [
        {
          id: "queue_1",
          chatId: "chat_1",
          messageId: "msg_queued",
          text: "queued draft",
          createdAt: timestamp,
        },
      ],
    });
    await rejects(
      queuedServices.setChatArchived("chat_1", true),
      /Cannot archive a chat with pending messages/,
    );

    const { services: drainingServices } = await createHarness({
      ...createTestState(),
      projects: [createProject()],
      chats: [createChat()],
    });
    markChatDrainingQueuedMessages(drainingServices, "chat_1");
    await rejects(
      drainingServices.setChatArchived("chat_1", true),
      /Cannot archive a chat while queued messages are sending/,
    );

    const { services: archivedServices } = await createHarness({
      ...createTestState(),
      projects: [createProject()],
      chats: [createChat({ status: "archived" })],
    });
    await rejects(
      archivedServices.sendMessage("chat_1", { text: "continue" }),
      /Archived chats must be restored/,
    );
  });

  it("ignores live Codex state changes for archived chats", async () => {
    const { codex, services, store } = await createHarness({
      ...createTestState(),
      projects: [createProject()],
      chats: [createChat({ status: "archived" })],
    });
    const emitSpy = vi.spyOn(services.eventHub, "emit");

    codex.emitNotification({
      method: "turn/started",
      params: {
        threadId: "thread_1",
        turn: { id: "turn_1" },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const savedState = await store.load();
    strictEqual(savedState.chats[0]?.status, "archived");
    strictEqual(savedState.chats[0]?.activeTurnId, null);
    strictEqual(
      emitSpy.mock.calls.some((call) => call[0] === "agent.turn.started"),
      false,
    );
  });

  it("syncs live Codex archive notifications", async () => {
    const { codex, store } = await createHarness({
      ...createTestState(),
      projects: [createProject()],
      chats: [createChat()],
    });

    codex.emitNotification({
      method: "thread/archived",
      params: { threadId: "thread_1" },
    });
    await vi.waitFor(async () => {
      strictEqual((await store.load()).chats[0]?.status, "archived");
    });

    codex.emitNotification({
      method: "thread/unarchived",
      params: { threadId: "thread_1" },
    });
    await vi.waitFor(async () => {
      strictEqual((await store.load()).chats[0]?.status, "idle");
    });
  });

  it("rejects unsafe live Codex archive notifications and restores Codex", async () => {
    const { codex, services, store } = await createHarness({
      ...createTestState(),
      projects: [createProject()],
      chats: [createChat({ activeTurnId: "turn_1", status: "running" })],
    });
    markChatActiveInCurrentProcess(services, "chat_1");
    const emitSpy = vi.spyOn(services.eventHub, "emit");

    codex.emitNotification({
      method: "thread/archived",
      params: { threadId: "thread_1" },
    });

    await vi.waitFor(() => {
      strictEqual(codex.unarchiveThread.mock.calls.length, 1);
    });
    const savedChat = (await store.load()).chats[0];
    strictEqual(savedChat?.status, "running");
    strictEqual(savedChat?.activeTurnId, "turn_1");
    deepStrictEqual(codex.unarchiveThread.mock.calls, [["thread_1"]]);
    strictEqual(
      emitSpy.mock.calls.some((call) => call[0] === "agent.event"),
      false,
    );
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

  it("preserves local attachment metadata when Codex thread history matches a sent user message", async () => {
    const attachment = {
      name: "screenshot.png",
      path: "/tmp/phantom-attachments/chat_1/screenshot.png",
      mimeType: "image/png",
      size: 68,
    };
    const state = {
      ...createTestState(),
      projects: [createProject()],
      chats: [createChat()],
      messages: [
        {
          id: "msg_with_attachment",
          chatId: "chat_1",
          role: "user" as const,
          text: "inspect this",
          attachments: [attachment],
          createdAt: "2026-04-25T00:00:00.000Z",
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
            items: [{ type: "userMessage", text: "inspect this" }],
          },
        ],
      },
    });

    const messages = await services.getMessages("chat_1");

    deepStrictEqual(
      messages.map((message) => ({
        attachments: message.attachments,
        id: message.id,
        role: message.role,
        text: message.text,
      })),
      [
        {
          attachments: [attachment],
          id: "chat_1_codex_turn_1_0",
          role: "user",
          text: "inspect this",
        },
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

  it("keeps a repeated pending message when only fallback-timestamp Codex history matches", async () => {
    const state = {
      ...createTestState(),
      projects: [createProject()],
      chats: [createChat({ status: "running", activeTurnId: "turn_current" })],
      messages: [
        {
          id: "msg_pending_retry",
          chatId: "chat_1",
          role: "user" as const,
          text: "retry",
          createdAt: "2026-04-25T00:01:00.000Z",
        },
        {
          id: "msg_command_event",
          chatId: "chat_1",
          role: "event" as const,
          text: "pnpm test",
          eventType: "item/commandExecution/outputDelta",
          itemId: "cmd_1",
          createdAt: "2026-04-25T00:02:00.000Z",
        },
      ],
    };
    const { codex, services } = await createHarness(state);
    codex.readThread.mockResolvedValueOnce({
      thread: {
        turns: [
          {
            id: "turn_old",
            items: [{ type: "userMessage", text: "retry" }],
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
        ["chat_1_codex_turn_old_0", "user", "retry", undefined],
        ["msg_pending_retry", "user", "retry", undefined],
        ["msg_command_event", "event", "", "item/commandExecution/outputDelta"],
      ],
    );
  });

  it("deduplicates local messages when fallback-timestamp Codex history has the completed transcript", async () => {
    const state = {
      ...createTestState(),
      projects: [createProject()],
      chats: [createChat({ status: "idle", activeTurnId: null })],
      messages: [
        {
          id: "msg_user",
          chatId: "chat_1",
          role: "user" as const,
          text: "fix archive state",
          createdAt: "2026-04-25T00:01:00.000Z",
        },
        {
          id: "msg_started",
          chatId: "chat_1",
          role: "event" as const,
          text: "item/started: agentMessage",
          eventType: "item/started",
          createdAt: "2026-04-25T00:01:01.000Z",
        },
        {
          id: "msg_assistant",
          chatId: "chat_1",
          role: "assistant" as const,
          text: "Archive state is synchronized.",
          eventType: "item/agentMessage/delta",
          itemId: "agent_msg_1",
          createdAt: "2026-04-25T00:01:02.000Z",
        },
      ],
    };
    const { codex, services } = await createHarness(state);
    codex.readThread.mockResolvedValueOnce({
      thread: {
        turns: [
          {
            id: "turn_1",
            items: [
              { type: "userMessage", text: "fix archive state" },
              { type: "agentMessage", text: "Archive state is synchronized." },
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
        ["chat_1_codex_turn_1_0", "user", "fix archive state", undefined],
        ["msg_started", "event", "item/started: agentMessage", "item/started"],
        [
          "chat_1_codex_turn_1_1",
          "assistant",
          "Archive state is synchronized.",
          undefined,
        ],
      ],
    );
  });

  it("treats missing active turn id as inactive for fallback transcript deduplication", async () => {
    const chatWithoutActiveTurnId = createChat({ status: "idle" });
    delete (chatWithoutActiveTurnId as Partial<typeof chatWithoutActiveTurnId>)
      .activeTurnId;
    const state = {
      ...createTestState(),
      projects: [createProject()],
      chats: [chatWithoutActiveTurnId],
      messages: [
        {
          id: "msg_user",
          chatId: "chat_1",
          role: "user" as const,
          text: "legacy request",
          createdAt: "2026-04-25T00:01:00.000Z",
        },
        {
          id: "msg_assistant",
          chatId: "chat_1",
          role: "assistant" as const,
          text: "legacy response",
          eventType: "item/agentMessage/delta",
          itemId: "agent_msg_1",
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
            items: [
              { type: "userMessage", text: "legacy request" },
              { type: "agentMessage", text: "legacy response" },
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
        ["chat_1_codex_turn_1_0", "user", "legacy request", undefined],
        ["chat_1_codex_turn_1_1", "assistant", "legacy response", undefined],
      ],
    );
  });

  it("deduplicates later fallback transcript after older fallback turns without local copies", async () => {
    const state = {
      ...createTestState(),
      projects: [createProject()],
      chats: [createChat({ status: "idle", activeTurnId: null })],
      messages: [
        {
          id: "msg_user",
          chatId: "chat_1",
          role: "user" as const,
          text: "recent request",
          createdAt: "2026-04-25T00:01:00.000Z",
        },
        {
          id: "msg_assistant",
          chatId: "chat_1",
          role: "assistant" as const,
          text: "recent response",
          eventType: "item/agentMessage/delta",
          itemId: "agent_msg_1",
          createdAt: "2026-04-25T00:02:00.000Z",
        },
      ],
    };
    const { codex, services } = await createHarness(state);
    codex.readThread.mockResolvedValueOnce({
      thread: {
        turns: [
          {
            id: "turn_missing",
            items: [
              { type: "userMessage", text: "missing request" },
              { type: "agentMessage", text: "missing response" },
            ],
          },
          {
            id: "turn_recent",
            items: [
              { type: "userMessage", text: "recent request" },
              { type: "agentMessage", text: "recent response" },
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
        ["chat_1_codex_turn_missing_0", "user", "missing request", undefined],
        [
          "chat_1_codex_turn_missing_1",
          "assistant",
          "missing response",
          undefined,
        ],
        ["chat_1_codex_turn_recent_0", "user", "recent request", undefined],
        [
          "chat_1_codex_turn_recent_1",
          "assistant",
          "recent response",
          undefined,
        ],
      ],
    );
  });

  it("matches repeated fallback transcripts to the latest matching Codex turn", async () => {
    const state = {
      ...createTestState(),
      projects: [createProject()],
      chats: [createChat({ status: "idle", activeTurnId: null })],
      messages: [
        {
          id: "msg_user",
          chatId: "chat_1",
          role: "user" as const,
          text: "repeat request",
          createdAt: "2026-04-25T00:01:00.000Z",
        },
        {
          id: "msg_event",
          chatId: "chat_1",
          role: "event" as const,
          text: "item/started: agentMessage",
          eventType: "item/started",
          createdAt: "2026-04-25T00:01:01.000Z",
        },
        {
          id: "msg_assistant",
          chatId: "chat_1",
          role: "assistant" as const,
          text: "repeat response",
          eventType: "item/agentMessage/delta",
          itemId: "agent_msg_1",
          createdAt: "2026-04-25T00:02:00.000Z",
        },
      ],
    };
    const { codex, services } = await createHarness(state);
    codex.readThread.mockResolvedValueOnce({
      thread: {
        turns: [
          {
            id: "turn_old",
            items: [
              { type: "userMessage", text: "repeat request" },
              { type: "agentMessage", text: "repeat response" },
            ],
          },
          {
            id: "turn_new",
            items: [
              { type: "userMessage", text: "repeat request" },
              { type: "agentMessage", text: "repeat response" },
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
        ["chat_1_codex_turn_old_0", "user", "repeat request", undefined],
        ["chat_1_codex_turn_old_1", "assistant", "repeat response", undefined],
        ["chat_1_codex_turn_new_0", "user", "repeat request", undefined],
        ["msg_event", "event", "item/started: agentMessage", "item/started"],
        ["chat_1_codex_turn_new_1", "assistant", "repeat response", undefined],
      ],
    );
  });

  it("deduplicates older fallback-timestamp transcripts while a newer turn is running", async () => {
    const state = {
      ...createTestState(),
      projects: [createProject()],
      chats: [createChat({ status: "running", activeTurnId: "turn_2" })],
      messages: [
        {
          id: "msg_old_user",
          chatId: "chat_1",
          role: "user" as const,
          text: "old request",
          createdAt: "2026-04-25T00:01:00.000Z",
        },
        {
          id: "msg_old_assistant",
          chatId: "chat_1",
          role: "assistant" as const,
          text: "old response",
          eventType: "item/agentMessage/delta",
          itemId: "old_agent_msg",
          createdAt: "2026-04-25T00:02:00.000Z",
        },
        {
          id: "msg_current_user",
          chatId: "chat_1",
          role: "user" as const,
          text: "new request",
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
            items: [
              { type: "userMessage", text: "old request" },
              { type: "agentMessage", text: "old response" },
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
        ["chat_1_codex_turn_1_0", "user", "old request", undefined],
        ["chat_1_codex_turn_1_1", "assistant", "old response", undefined],
        ["msg_current_user", "user", "new request", undefined],
      ],
    );
  });

  it("keeps repeated active local turn when older fallback history has the same transcript", async () => {
    const state = {
      ...createTestState(),
      projects: [createProject()],
      chats: [createChat({ status: "running", activeTurnId: "turn_current" })],
      messages: [
        {
          id: "msg_current_user",
          chatId: "chat_1",
          role: "user" as const,
          text: "repeat request",
          createdAt: "2026-04-25T00:01:00.000Z",
        },
        {
          id: "msg_current_assistant",
          chatId: "chat_1",
          role: "assistant" as const,
          text: "repeat response",
          eventType: "item/agentMessage/delta",
          itemId: "current_agent_msg",
          createdAt: "2026-04-25T00:02:00.000Z",
        },
      ],
    };
    const { codex, services } = await createHarness(state);
    markChatActiveInCurrentProcess(services, "chat_1");
    codex.readThread.mockResolvedValueOnce({
      thread: {
        turns: [
          {
            id: "turn_old",
            items: [
              { type: "userMessage", text: "repeat request" },
              { type: "agentMessage", text: "repeat response" },
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
        ["chat_1_codex_turn_old_0", "user", "repeat request", undefined],
        ["chat_1_codex_turn_old_1", "assistant", "repeat response", undefined],
        ["msg_current_user", "user", "repeat request", undefined],
        [
          "msg_current_assistant",
          "assistant",
          "repeat response",
          "item/agentMessage/delta",
        ],
      ],
    );
  });

  it("deduplicates active local turn when Codex history includes the active turn", async () => {
    const state = {
      ...createTestState(),
      projects: [createProject()],
      chats: [createChat({ status: "running", activeTurnId: "turn_current" })],
      messages: [
        {
          id: "msg_current_user",
          chatId: "chat_1",
          role: "user" as const,
          text: "active request",
          createdAt: "2026-04-25T00:01:00.000Z",
        },
        {
          id: "msg_current_assistant",
          chatId: "chat_1",
          role: "assistant" as const,
          text: "active response",
          eventType: "item/agentMessage/delta",
          itemId: "current_agent_msg",
          createdAt: "2026-04-25T00:02:00.000Z",
        },
      ],
    };
    const { codex, services } = await createHarness(state);
    markChatActiveInCurrentProcess(services, "chat_1");
    codex.readThread.mockResolvedValueOnce({
      thread: {
        turns: [
          {
            id: "turn_current",
            items: [
              { type: "userMessage", text: "active request" },
              { type: "agentMessage", text: "active response" },
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
        ["chat_1_codex_turn_current_0", "user", "active request", undefined],
        [
          "chat_1_codex_turn_current_1",
          "assistant",
          "active response",
          undefined,
        ],
      ],
    );
  });

  it("does not deduplicate a fallback transcript across intervening local user messages", async () => {
    const state = {
      ...createTestState(),
      projects: [createProject()],
      chats: [createChat({ status: "idle", activeTurnId: null })],
      messages: [
        {
          id: "msg_user_1",
          chatId: "chat_1",
          role: "user" as const,
          text: "request A",
          createdAt: "2026-04-25T00:01:00.000Z",
        },
        {
          id: "msg_user_2",
          chatId: "chat_1",
          role: "user" as const,
          text: "request B",
          createdAt: "2026-04-25T00:02:00.000Z",
        },
        {
          id: "msg_assistant",
          chatId: "chat_1",
          role: "assistant" as const,
          text: "done",
          eventType: "item/agentMessage/delta",
          itemId: "agent_msg_1",
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
            items: [
              { type: "userMessage", text: "request A" },
              { type: "agentMessage", text: "done" },
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
        ["chat_1_codex_turn_1_0", "user", "request A", undefined],
        ["chat_1_codex_turn_1_1", "assistant", "done", undefined],
        ["msg_user_1", "user", "request A", undefined],
        ["msg_user_2", "user", "request B", undefined],
        ["msg_assistant", "assistant", "done", "item/agentMessage/delta"],
      ],
    );
  });

  it("does not trust fallback-timestamp Codex history after stale active turn reset", async () => {
    const state = {
      ...createTestState(),
      projects: [createProject()],
      chats: [createChat({ status: "running", activeTurnId: "turn_1" })],
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

  it("does not restore stale active turns from local steered messages", async () => {
    const state = {
      ...createTestState(),
      projects: [createProject()],
      chats: [createChat({ status: "running", activeTurnId: "turn_1" })],
      messages: [
        {
          id: "msg_stale_steered",
          chatId: "chat_1",
          role: "user" as const,
          text: "retry",
          eventType: "chat.message.steered",
          itemId: "turn_1",
          createdAt: "2026-04-25T00:01:00.000Z",
        },
      ],
    };
    const { codex, services, store } = await createHarness(state);
    codex.readThread.mockResolvedValue({
      thread: {
        turns: [
          {
            id: "turn_1",
            input: [{ text: "retry" }],
          },
        ],
      },
    });

    const messages = await services.getMessages("chat_1");
    const repeatedMessages = await services.getMessages("chat_1");
    const savedState = await store.load();

    deepStrictEqual(
      messages.map((message) => [
        message.id,
        message.role,
        message.text,
        message.eventType,
      ]),
      [
        ["chat_1_codex_turn_1_0", "user", "retry", undefined],
        ["msg_stale_steered", "user", "retry", undefined],
      ],
    );
    deepStrictEqual(
      repeatedMessages.map((message) => [
        message.id,
        message.role,
        message.text,
        message.eventType,
      ]),
      [
        ["chat_1_codex_turn_1_0", "user", "retry", undefined],
        ["msg_stale_steered", "user", "retry", undefined],
      ],
    );
    strictEqual(savedState.messages[0]?.eventType, undefined);
  });

  it("keeps live assistant deltas after fallback-timestamp Codex history when the later user is retained", async () => {
    const state = {
      ...createTestState(),
      projects: [createProject()],
      chats: [createChat()],
      messages: [
        {
          id: "msg_live_assistant",
          chatId: "chat_1",
          role: "assistant" as const,
          text: "still working",
          eventType: "item/agentMessage/delta",
          itemId: "assistant_1",
          createdAt: "2026-04-25T00:00:01.000Z",
        },
        {
          id: "msg_command_event",
          chatId: "chat_1",
          role: "event" as const,
          text: "pnpm test",
          eventType: "item/commandExecution/outputDelta",
          itemId: "cmd_1",
          createdAt: "2026-04-25T00:00:02.000Z",
        },
        {
          id: "msg_pending_retry",
          chatId: "chat_1",
          role: "user" as const,
          text: "retry",
          createdAt: "2026-04-25T00:00:03.000Z",
        },
      ],
    };
    const { codex, services } = await createHarness(state);
    codex.readThread.mockResolvedValueOnce({
      thread: {
        turns: [
          {
            id: "turn_old",
            items: [{ type: "userMessage", text: "retry" }],
          },
        ],
      },
    });

    const messages = await services.getMessages("chat_1");

    deepStrictEqual(
      messages.map((message) => [
        message.role,
        message.text,
        message.eventType,
      ]),
      [
        ["user", "retry", undefined],
        ["assistant", "still working", "item/agentMessage/delta"],
        ["event", "", "item/commandExecution/outputDelta"],
        ["user", "retry", undefined],
      ],
    );
  });

  it("keeps live assistant deltas before a repeated user boundary after fallback-timestamp history", async () => {
    const state = {
      ...createTestState(),
      projects: [createProject()],
      chats: [createChat()],
      messages: [
        {
          id: "msg_live_assistant",
          chatId: "chat_1",
          role: "assistant" as const,
          text: "still working",
          eventType: "item/agentMessage/delta",
          itemId: "assistant_1",
          createdAt: "2026-04-25T00:00:01.000Z",
        },
        {
          id: "msg_command_event",
          chatId: "chat_1",
          role: "event" as const,
          text: "pnpm test",
          eventType: "item/commandExecution/outputDelta",
          itemId: "cmd_1",
          createdAt: "2026-04-25T00:00:02.000Z",
        },
        {
          id: "msg_pending_retry",
          chatId: "chat_1",
          role: "user" as const,
          text: "retry",
          createdAt: "2026-04-25T00:00:03.000Z",
        },
      ],
    };
    const { codex, services } = await createHarness(state);
    codex.readThread.mockResolvedValueOnce({
      thread: {
        turns: [
          {
            id: "turn_old",
            items: [{ type: "userMessage", text: "retry" }],
          },
          {
            id: "turn_new",
            createdAt: "2026-04-25T00:00:03.000Z",
            items: [{ type: "userMessage", text: "retry" }],
          },
        ],
      },
    });

    const messages = await services.getMessages("chat_1");

    deepStrictEqual(
      messages.map((message) => [
        message.role,
        message.text,
        message.eventType,
      ]),
      [
        ["user", "retry", undefined],
        ["assistant", "still working", "item/agentMessage/delta"],
        ["event", "", "item/commandExecution/outputDelta"],
        ["user", "retry", undefined],
      ],
    );
  });

  it("keeps local Codex events after thread messages with fallback timestamps", async () => {
    const state = {
      ...createTestState(),
      projects: [createProject()],
      chats: [createChat({ status: "running", activeTurnId: "turn_1" })],
      messages: [
        {
          id: "msg_command_event",
          chatId: "chat_1",
          role: "event" as const,
          text: "pnpm test",
          eventType: "item/commandExecution/outputDelta",
          itemId: "cmd_1",
          createdAt: "2026-04-25T00:00:01.000Z",
        },
      ],
    };
    const { codex, services } = await createHarness(state);
    codex.readThread.mockResolvedValueOnce({
      thread: {
        turns: [
          {
            id: "turn_1",
            input: [{ text: "fix the UI" }],
            items: [{ type: "agentMessage", text: "working" }],
          },
        ],
      },
    });

    const messages = await services.getMessages("chat_1");

    deepStrictEqual(
      messages.map((message) => [
        message.role,
        message.text,
        message.eventType,
      ]),
      [
        ["user", "fix the UI", undefined],
        ["assistant", "working", undefined],
        ["event", "", "item/commandExecution/outputDelta"],
      ],
    );
  });

  it("keeps local Codex events before later live assistant deltas", async () => {
    const state = {
      ...createTestState(),
      projects: [createProject()],
      chats: [createChat({ status: "running", activeTurnId: "turn_1" })],
      messages: [
        {
          id: "msg_command_event",
          chatId: "chat_1",
          role: "event" as const,
          text: "pnpm test",
          eventType: "item/commandExecution/outputDelta",
          itemId: "cmd_1",
          createdAt: "2026-04-25T00:00:01.000Z",
        },
        {
          id: "msg_live_assistant",
          chatId: "chat_1",
          role: "assistant" as const,
          text: "still working",
          eventType: "item/agentMessage/delta",
          itemId: "assistant_1",
          createdAt: "2026-04-25T00:00:02.000Z",
        },
        {
          id: "msg_next_user",
          chatId: "chat_1",
          role: "user" as const,
          text: "next request",
          createdAt: "2026-04-25T00:00:03.000Z",
        },
      ],
    };
    const { codex, services } = await createHarness(state);
    codex.readThread.mockResolvedValueOnce({
      thread: {
        turns: [
          {
            id: "turn_1",
            createdAt: "2026-04-25T00:00:03.000Z",
            input: [{ text: "fix the UI" }],
            items: [
              { type: "agentMessage", text: "done" },
              { type: "userMessage", text: "next request" },
            ],
          },
        ],
      },
    });

    const messages = await services.getMessages("chat_1");

    deepStrictEqual(
      messages.map((message) => [
        message.role,
        message.text,
        message.eventType,
      ]),
      [
        ["user", "fix the UI", undefined],
        ["assistant", "done", undefined],
        ["event", "", "item/commandExecution/outputDelta"],
        ["assistant", "still working", "item/agentMessage/delta"],
        ["user", "next request", undefined],
      ],
    );
  });

  it("keeps local Codex events before live assistant deltas merged into Codex history", async () => {
    const state = {
      ...createTestState(),
      projects: [createProject()],
      chats: [createChat({ status: "running", activeTurnId: "turn_1" })],
      messages: [
        {
          id: "msg_user",
          chatId: "chat_1",
          role: "user" as const,
          text: "fix the UI",
          createdAt: "2026-04-25T00:00:01.000Z",
        },
        {
          id: "msg_command_event",
          chatId: "chat_1",
          role: "event" as const,
          text: "pnpm test",
          eventType: "item/commandExecution/outputDelta",
          itemId: "cmd_1",
          createdAt: "2026-04-25T00:00:02.000Z",
        },
        {
          id: "msg_live_assistant",
          chatId: "chat_1",
          role: "assistant" as const,
          text: "still working",
          eventType: "item/agentMessage/delta",
          itemId: "assistant_1",
          createdAt: "2026-04-25T00:00:03.000Z",
        },
      ],
    };
    const { codex, services } = await createHarness(state);
    codex.readThread.mockResolvedValueOnce({
      thread: {
        turns: [
          {
            id: "turn_1",
            createdAt: "2026-04-25T00:00:01.000Z",
            input: [{ text: "fix the UI" }],
            items: [
              {
                id: "assistant_1",
                type: "agentMessage",
                text: "still",
              },
            ],
          },
        ],
      },
    });

    const messages = await services.getMessages("chat_1");

    deepStrictEqual(
      messages.map((message) => [
        message.role,
        message.text,
        message.eventType,
      ]),
      [
        ["user", "fix the UI", undefined],
        ["event", "", "item/commandExecution/outputDelta"],
        ["assistant", "still working", "item/agentMessage/delta"],
      ],
    );
  });

  it("keeps local Codex events before live assistant deltas deduplicated by text", async () => {
    const state = {
      ...createTestState(),
      projects: [createProject()],
      chats: [createChat({ status: "running", activeTurnId: "turn_1" })],
      messages: [
        {
          id: "msg_user",
          chatId: "chat_1",
          role: "user" as const,
          text: "fix the UI",
          createdAt: "2026-04-25T00:00:01.000Z",
        },
        {
          id: "msg_command_event",
          chatId: "chat_1",
          role: "event" as const,
          text: "pnpm test",
          eventType: "item/commandExecution/outputDelta",
          itemId: "cmd_1",
          createdAt: "2026-04-25T00:00:02.000Z",
        },
        {
          id: "msg_live_assistant",
          chatId: "chat_1",
          role: "assistant" as const,
          text: "done",
          eventType: "item/agentMessage/delta",
          itemId: "local_assistant",
          createdAt: "2026-04-25T00:00:03.000Z",
        },
      ],
    };
    const { codex, services } = await createHarness(state);
    codex.readThread.mockResolvedValueOnce({
      thread: {
        turns: [
          {
            id: "turn_1",
            createdAt: "2026-04-25T00:00:01.000Z",
            input: [{ text: "fix the UI" }],
            items: [
              {
                id: "codex_assistant",
                type: "agentMessage",
                text: "done",
                createdAt: "2026-04-25T00:00:04.000Z",
              },
            ],
          },
        ],
      },
    });

    const messages = await services.getMessages("chat_1");

    deepStrictEqual(
      messages.map((message) => [
        message.role,
        message.text,
        message.eventType,
      ]),
      [
        ["user", "fix the UI", undefined],
        ["event", "", "item/commandExecution/outputDelta"],
        ["assistant", "done", undefined],
      ],
    );
  });

  it("keeps local Codex events between live assistant deltas and later user messages", async () => {
    const state = {
      ...createTestState(),
      projects: [createProject()],
      chats: [createChat({ status: "running", activeTurnId: "turn_1" })],
      messages: [
        {
          id: "msg_live_assistant",
          chatId: "chat_1",
          role: "assistant" as const,
          text: "still working",
          eventType: "item/agentMessage/delta",
          itemId: "assistant_1",
          createdAt: "2026-04-25T00:00:01.000Z",
        },
        {
          id: "msg_command_event",
          chatId: "chat_1",
          role: "event" as const,
          text: "pnpm test",
          eventType: "item/commandExecution/outputDelta",
          itemId: "cmd_1",
          createdAt: "2026-04-25T00:00:02.000Z",
        },
        {
          id: "msg_next_user",
          chatId: "chat_1",
          role: "user" as const,
          text: "next request",
          createdAt: "2026-04-25T00:00:03.000Z",
        },
      ],
    };
    const { codex, services } = await createHarness(state);
    codex.readThread.mockResolvedValueOnce({
      thread: {
        turns: [
          {
            id: "turn_1",
            createdAt: "2026-04-25T00:00:03.000Z",
            input: [{ text: "fix the UI" }],
            items: [
              { type: "agentMessage", text: "done" },
              { type: "userMessage", text: "next request" },
            ],
          },
        ],
      },
    });

    const messages = await services.getMessages("chat_1");

    deepStrictEqual(
      messages.map((message) => [
        message.role,
        message.text,
        message.eventType,
      ]),
      [
        ["user", "fix the UI", undefined],
        ["assistant", "done", undefined],
        ["assistant", "still working", "item/agentMessage/delta"],
        ["event", "", "item/commandExecution/outputDelta"],
        ["user", "next request", undefined],
      ],
    );
  });

  it("keeps local Codex events after deduplicated local user messages", async () => {
    const state = {
      ...createTestState(),
      projects: [createProject()],
      chats: [createChat({ status: "running", activeTurnId: "turn_1" })],
      messages: [
        {
          id: "msg_user",
          chatId: "chat_1",
          role: "user" as const,
          text: "fix the UI",
          createdAt: "2026-04-25T00:00:01.000Z",
        },
        {
          id: "msg_command_event",
          chatId: "chat_1",
          role: "event" as const,
          text: "pnpm test",
          eventType: "item/commandExecution/outputDelta",
          itemId: "cmd_1",
          createdAt: "2026-04-25T00:00:02.000Z",
        },
      ],
    };
    const { codex, services } = await createHarness(state);
    codex.readThread.mockResolvedValueOnce({
      thread: {
        turns: [
          {
            id: "turn_1",
            createdAt: "2026-04-25T00:00:01.000Z",
            input: [{ text: "fix the UI" }],
            items: [{ type: "agentMessage", text: "done" }],
          },
        ],
      },
    });

    const messages = await services.getMessages("chat_1");

    deepStrictEqual(
      messages.map((message) => [
        message.role,
        message.text,
        message.eventType,
      ]),
      [
        ["user", "fix the UI", undefined],
        ["event", "", "item/commandExecution/outputDelta"],
        ["assistant", "done", undefined],
      ],
    );
  });

  it("keeps local Codex events after retained local user messages", async () => {
    const state = {
      ...createTestState(),
      projects: [createProject()],
      chats: [createChat({ status: "running", activeTurnId: "turn_1" })],
      messages: [
        {
          id: "msg_user",
          chatId: "chat_1",
          role: "user" as const,
          text: "new request",
          createdAt: "2026-04-25T00:01:00.000Z",
        },
        {
          id: "msg_command_event",
          chatId: "chat_1",
          role: "event" as const,
          text: "pnpm test",
          eventType: "item/commandExecution/outputDelta",
          itemId: "cmd_1",
          createdAt: "2026-04-25T00:02:00.000Z",
        },
        {
          id: "msg_live_assistant",
          chatId: "chat_1",
          role: "assistant" as const,
          text: "still working",
          eventType: "item/agentMessage/delta",
          itemId: "assistant_1",
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
            createdAt: "not-a-date",
            input: [{ text: "previous request" }],
            items: [{ type: "agentMessage", text: "previous response" }],
          },
        ],
      },
    });

    const messages = await services.getMessages("chat_1");

    deepStrictEqual(
      messages.map((message) => [
        message.role,
        message.text,
        message.eventType,
      ]),
      [
        ["user", "previous request", undefined],
        ["assistant", "previous response", undefined],
        ["user", "new request", undefined],
        ["event", "", "item/commandExecution/outputDelta"],
        ["assistant", "still working", "item/agentMessage/delta"],
      ],
    );
  });

  it("keeps retained local messages before later trusted Codex history after fallback timestamps", async () => {
    const state = {
      ...createTestState(),
      projects: [createProject()],
      chats: [createChat()],
      messages: [
        {
          id: "msg_user",
          chatId: "chat_1",
          role: "user" as const,
          text: "middle request",
          createdAt: "2026-04-25T00:05:00.000Z",
        },
        {
          id: "msg_command_event",
          chatId: "chat_1",
          role: "event" as const,
          text: "pnpm test",
          eventType: "item/commandExecution/outputDelta",
          itemId: "cmd_1",
          createdAt: "2026-04-25T00:06:00.000Z",
        },
      ],
    };
    const { codex, services } = await createHarness(state);
    codex.readThread.mockResolvedValueOnce({
      thread: {
        turns: [
          {
            id: "turn_old",
            items: [{ type: "userMessage", text: "previous request" }],
          },
          {
            id: "turn_new",
            createdAt: "2026-04-25T00:10:00.000Z",
            items: [{ type: "agentMessage", text: "later response" }],
          },
        ],
      },
    });

    const messages = await services.getMessages("chat_1");

    deepStrictEqual(
      messages.map((message) => [
        message.role,
        message.text,
        message.eventType,
      ]),
      [
        ["user", "previous request", undefined],
        ["user", "middle request", undefined],
        ["event", "", "item/commandExecution/outputDelta"],
        ["assistant", "later response", undefined],
      ],
    );
  });

  it("keeps local Codex events after repeated deduplicated local user messages", async () => {
    const state = {
      ...createTestState(),
      projects: [createProject()],
      chats: [createChat({ status: "running", activeTurnId: "turn_1" })],
      messages: [
        {
          id: "msg_user_1",
          chatId: "chat_1",
          role: "user" as const,
          text: "repeat",
          createdAt: "2026-04-25T00:00:01.000Z",
        },
        {
          id: "msg_user_2",
          chatId: "chat_1",
          role: "user" as const,
          text: "repeat",
          createdAt: "2026-04-25T00:00:02.000Z",
        },
        {
          id: "msg_command_event",
          chatId: "chat_1",
          role: "event" as const,
          text: "pnpm test",
          eventType: "item/commandExecution/outputDelta",
          itemId: "cmd_1",
          createdAt: "2026-04-25T00:00:03.000Z",
        },
      ],
    };
    const { codex, services } = await createHarness(state);
    codex.readThread.mockResolvedValueOnce({
      thread: {
        turns: [
          {
            id: "turn_1",
            items: [
              {
                type: "userMessage",
                text: "repeat",
                createdAt: "2026-04-25T00:00:01.000Z",
              },
              {
                type: "userMessage",
                text: "repeat",
                createdAt: "2026-04-25T00:00:02.000Z",
              },
              {
                type: "agentMessage",
                text: "done",
                createdAt: "2026-04-25T00:00:04.000Z",
              },
            ],
          },
        ],
      },
    });

    const messages = await services.getMessages("chat_1");

    deepStrictEqual(
      messages.map((message) => [
        message.role,
        message.text,
        message.eventType,
      ]),
      [
        ["user", "repeat", undefined],
        ["user", "repeat", undefined],
        ["event", "", "item/commandExecution/outputDelta"],
        ["assistant", "done", undefined],
      ],
    );
  });

  it("keeps local Codex events between a deduplicated and retained repeated user message", async () => {
    const state = {
      ...createTestState(),
      projects: [createProject()],
      chats: [createChat({ status: "running", activeTurnId: "turn_1" })],
      messages: [
        {
          id: "msg_user_1",
          chatId: "chat_1",
          role: "user" as const,
          text: "repeat",
          createdAt: "2026-04-25T00:00:01.000Z",
        },
        {
          id: "msg_command_event",
          chatId: "chat_1",
          role: "event" as const,
          text: "pnpm test",
          eventType: "item/commandExecution/outputDelta",
          itemId: "cmd_1",
          createdAt: "2026-04-25T00:00:02.000Z",
        },
        {
          id: "msg_live_assistant",
          chatId: "chat_1",
          role: "assistant" as const,
          text: "still working",
          eventType: "item/agentMessage/delta",
          itemId: "assistant_1",
          createdAt: "2026-04-25T00:00:03.000Z",
        },
        {
          id: "msg_user_2",
          chatId: "chat_1",
          role: "user" as const,
          text: "repeat",
          createdAt: "2026-04-25T00:00:04.000Z",
        },
      ],
    };
    const { codex, services } = await createHarness(state);
    codex.readThread.mockResolvedValueOnce({
      thread: {
        turns: [
          {
            id: "turn_1",
            items: [
              {
                type: "userMessage",
                text: "repeat",
                createdAt: "2026-04-25T00:00:01.000Z",
              },
            ],
          },
        ],
      },
    });

    const messages = await services.getMessages("chat_1");

    deepStrictEqual(
      messages.map((message) => [
        message.role,
        message.text,
        message.eventType,
      ]),
      [
        ["user", "repeat", undefined],
        ["event", "", "item/commandExecution/outputDelta"],
        ["assistant", "still working", "item/agentMessage/delta"],
        ["user", "repeat", undefined],
      ],
    );
  });

  it("keeps retained repeated user messages after earlier deduplicated matches", async () => {
    const state = {
      ...createTestState(),
      projects: [createProject()],
      chats: [createChat()],
      messages: [
        {
          id: "msg_user_1",
          chatId: "chat_1",
          role: "user" as const,
          text: "retry",
          createdAt: "2026-04-25T00:00:01.000Z",
        },
        {
          id: "msg_live_assistant",
          chatId: "chat_1",
          role: "assistant" as const,
          text: "still working",
          eventType: "item/agentMessage/delta",
          itemId: "assistant_1",
          createdAt: "2026-04-25T00:00:02.000Z",
        },
        {
          id: "msg_command_event",
          chatId: "chat_1",
          role: "event" as const,
          text: "pnpm test",
          eventType: "item/commandExecution/outputDelta",
          itemId: "cmd_1",
          createdAt: "2026-04-25T00:00:03.000Z",
        },
        {
          id: "msg_user_2",
          chatId: "chat_1",
          role: "user" as const,
          text: "retry",
          createdAt: "2026-04-25T00:00:04.000Z",
        },
      ],
    };
    const { codex, services } = await createHarness(state);
    codex.readThread.mockResolvedValueOnce({
      thread: {
        turns: [
          {
            id: "turn_1",
            createdAt: "2026-04-25T00:00:05.000Z",
            items: [{ type: "userMessage", text: "retry" }],
          },
        ],
      },
    });

    const messages = await services.getMessages("chat_1");

    deepStrictEqual(
      messages.map((message) => [
        message.role,
        message.text,
        message.eventType,
      ]),
      [
        ["user", "retry", undefined],
        ["assistant", "still working", "item/agentMessage/delta"],
        ["event", "", "item/commandExecution/outputDelta"],
        ["user", "retry", undefined],
      ],
    );
  });

  it("keeps local Codex events before a later repeated user boundary", async () => {
    const state = {
      ...createTestState(),
      projects: [createProject()],
      chats: [createChat({ status: "running", activeTurnId: "turn_1" })],
      messages: [
        {
          id: "msg_user_1",
          chatId: "chat_1",
          role: "user" as const,
          text: "repeat",
          createdAt: "2026-04-25T00:00:01.000Z",
        },
        {
          id: "msg_live_assistant",
          chatId: "chat_1",
          role: "assistant" as const,
          text: "still working",
          eventType: "item/agentMessage/delta",
          itemId: "assistant_1",
          createdAt: "2026-04-25T00:00:02.000Z",
        },
        {
          id: "msg_command_event",
          chatId: "chat_1",
          role: "event" as const,
          text: "pnpm test",
          eventType: "item/commandExecution/outputDelta",
          itemId: "cmd_1",
          createdAt: "2026-04-25T00:00:03.000Z",
        },
        {
          id: "msg_user_2",
          chatId: "chat_1",
          role: "user" as const,
          text: "repeat",
          createdAt: "2026-04-25T00:00:04.000Z",
        },
      ],
    };
    const { codex, services } = await createHarness(state);
    codex.readThread.mockResolvedValueOnce({
      thread: {
        turns: [
          {
            id: "turn_1",
            items: [
              {
                type: "userMessage",
                text: "repeat",
                createdAt: "2026-04-25T00:00:01.000Z",
              },
              {
                type: "userMessage",
                text: "repeat",
                createdAt: "2026-04-25T00:00:04.000Z",
              },
            ],
          },
        ],
      },
    });

    const messages = await services.getMessages("chat_1");

    deepStrictEqual(
      messages.map((message) => [
        message.role,
        message.text,
        message.eventType,
      ]),
      [
        ["user", "repeat", undefined],
        ["assistant", "still working", "item/agentMessage/delta"],
        ["event", "", "item/commandExecution/outputDelta"],
        ["user", "repeat", undefined],
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

    const chat = await services.createChat("proj_1", {
      name: "feature",
      serviceTier: "fast",
    });

    strictEqual(chat.title, "feature");
    strictEqual(chat.codexThreadId, "thread_new");
    deepStrictEqual(codex.startThread.mock.calls[0], [
      "/repo/.git/phantom/worktrees/feature",
      { serviceTier: "fast" },
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
      serviceTier: "fast",
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
      { serviceTier: "fast" },
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

  it("checks out a GitHub target before starting a new chat", async () => {
    const state = {
      ...createTestState(),
      projects: [createProject()],
    };
    const { codex, services, store } = await createHarness(state);
    coreMocks.githubCheckout.mockResolvedValueOnce({
      ok: true,
      value: {
        message: "Checked out PR #42",
        worktree: "feature",
        path: "/repo/.git/phantom/worktrees/feature",
      },
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
    codex.startThread.mockResolvedValueOnce({ thread: { id: "thread_new" } });

    const chat = await services.createChat("proj_1", {
      githubTargetNumber: 42,
      initialMessage: "Implement this PR feedback",
      serviceTier: "fast",
    });

    deepStrictEqual(coreMocks.githubCheckout.mock.calls[0], [
      {
        number: "42",
        base: undefined,
        cwd: "/repo",
      },
    ]);
    deepStrictEqual(codex.startThread.mock.calls[0], [
      "/repo/.git/phantom/worktrees/feature",
      { serviceTier: "fast" },
    ]);
    strictEqual(chat.worktreeName, "feature");
    strictEqual(chat.worktreePath, "/repo/.git/phantom/worktrees/feature");
    strictEqual(chat.codexThreadId, "thread_new");
    const savedState = await store.load();
    strictEqual(savedState.selectedChatId, chat.id);
  });

  it("rolls back a newly checked out GitHub worktree when Codex thread startup fails", async () => {
    const state = {
      ...createTestState(),
      projects: [createProject()],
    };
    const { codex, services } = await createHarness(state);
    coreMocks.githubCheckout.mockResolvedValueOnce({
      ok: true,
      value: {
        message: "Checked out PR #42",
        worktree: "feature",
        path: "/repo/.git/phantom/worktrees/feature",
        createdBranch: true,
      },
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
    codex.startThread.mockRejectedValueOnce(new Error("Codex unavailable"));
    coreMocks.removeWorktree.mockResolvedValueOnce(undefined);
    coreMocks.deleteBranch.mockResolvedValueOnce({
      ok: true,
      value: undefined,
    });

    await rejects(
      services.createChat("proj_1", {
        githubTargetNumber: 42,
        initialMessage: "Implement this PR feedback",
      }),
      /Codex unavailable/,
    );

    deepStrictEqual(coreMocks.removeWorktree.mock.calls[0], [
      "/repo",
      "/repo/.git/phantom/worktrees/feature",
      true,
    ]);
    deepStrictEqual(coreMocks.deleteBranch.mock.calls[0], ["/repo", "feature"]);
  });

  it("keeps existing GitHub checkout branches when rolling back chat startup", async () => {
    const state = {
      ...createTestState(),
      projects: [createProject()],
    };
    const { codex, services } = await createHarness(state);
    coreMocks.githubCheckout.mockResolvedValueOnce({
      ok: true,
      value: {
        message: "Checked out PR #42",
        worktree: "feature",
        path: "/repo/.git/phantom/worktrees/feature",
        createdBranch: false,
      },
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
    codex.startThread.mockRejectedValueOnce(new Error("Codex unavailable"));
    coreMocks.removeWorktree.mockResolvedValueOnce(undefined);

    await rejects(
      services.createChat("proj_1", {
        githubTargetNumber: 42,
        initialMessage: "Implement this PR feedback",
      }),
      /Codex unavailable/,
    );

    deepStrictEqual(coreMocks.removeWorktree.mock.calls[0], [
      "/repo",
      "/repo/.git/phantom/worktrees/feature",
      true,
    ]);
    strictEqual(coreMocks.deleteBranch.mock.calls.length, 0);
  });

  it("does not roll back existing GitHub checkout worktrees when chat startup fails", async () => {
    const state = {
      ...createTestState(),
      projects: [createProject()],
    };
    const { codex, services } = await createHarness(state);
    coreMocks.githubCheckout.mockResolvedValueOnce({
      ok: true,
      value: {
        message: "PR #42 is already checked out",
        worktree: "feature",
        path: "/repo/.git/phantom/worktrees/feature",
        alreadyExists: true,
        createdBranch: false,
      },
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
    codex.startThread.mockRejectedValueOnce(new Error("Codex unavailable"));

    await rejects(
      services.createChat("proj_1", {
        githubTargetNumber: 42,
        initialMessage: "Implement this PR feedback",
      }),
      /Codex unavailable/,
    );

    strictEqual(coreMocks.removeWorktree.mock.calls.length, 0);
    strictEqual(coreMocks.deleteBranch.mock.calls.length, 0);
  });

  it("lists GitHub checkout targets for a project", async () => {
    const state = {
      ...createTestState(),
      projects: [createProject()],
    };
    const { services } = await createHarness(state);
    coreMocks.listGitHubCheckoutTargets.mockResolvedValueOnce([
      {
        author: "alice",
        htmlUrl: "https://github.com/owner/repo/pull/42",
        kind: "pullRequest",
        number: 42,
        title: "Fix checkout",
        updatedAt: "2026-05-04T00:00:00Z",
      },
    ]);

    const result = await services.listProjectGitHubCheckoutTargets("proj_1");

    deepStrictEqual(coreMocks.listGitHubCheckoutTargets.mock.calls[0], [
      { cwd: "/repo" },
    ]);
    deepStrictEqual(result, {
      available: true,
      targets: [
        {
          author: "alice",
          htmlUrl: "https://github.com/owner/repo/pull/42",
          kind: "pullRequest",
          number: 42,
          title: "Fix checkout",
          updatedAt: "2026-05-04T00:00:00Z",
        },
      ],
    });
  });

  it("hides GitHub checkout targets when GitHub access is unavailable", async () => {
    const state = {
      ...createTestState(),
      projects: [createProject()],
    };
    const { services } = await createHarness(state);
    coreMocks.listGitHubCheckoutTargets.mockRejectedValueOnce(
      new Error("Failed to get GitHub auth token"),
    );

    const result = await services.listProjectGitHubCheckoutTargets("proj_1");

    deepStrictEqual(result, {
      available: false,
      targets: [],
    });
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
    )?.[1] as { params: unknown; requestId: string } | undefined;
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

  it("returns only unanswered pending approvals for a chat", async () => {
    const state = {
      ...createTestState(),
      projects: [createProject()],
      chats: [createChat({ status: "running", activeTurnId: "turn_1" })],
    };
    const { codex, services, store } = await createHarness(state);
    const emitSpy = vi.spyOn(services.eventHub, "emit");
    const params = {
      threadId: "thread_1",
      turnId: "turn_1",
      changes: [{ path: "src/app.ts", kind: "modify", diff: "@@ patch" }],
      item: {
        type: "commandExecution",
        aggregatedOutput: "large output",
      },
    };

    codex.emitServerRequest({
      id: 101,
      method: "item/fileChange/requestApproval",
      params,
    });
    await vi.waitFor(async () => {
      strictEqual((await store.load()).chats[0]?.status, "waitingForApproval");
    });
    const approvalRequest = emitSpy.mock.calls.find(
      (call) => call[0] === "agent.approval.requested",
    )?.[1] as { params: unknown; requestId: string } | undefined;
    if (!approvalRequest) {
      throw new Error("Approval request was not emitted");
    }

    deepStrictEqual(await services.getPendingApproval("chat_1"), {
      requestId: approvalRequest.requestId,
      method: "item/fileChange/requestApproval",
      params: {
        threadId: "thread_1",
        turnId: "turn_1",
        changes: [{ path: "src/app.ts", kind: "modify" }],
        item: {
          type: "commandExecution",
        },
      },
    });
    deepStrictEqual(approvalRequest.params, {
      threadId: "thread_1",
      turnId: "turn_1",
      changes: [{ path: "src/app.ts", kind: "modify" }],
      item: {
        type: "commandExecution",
      },
    });

    await services.answerApproval("chat_1", approvalRequest.requestId, {
      decision: "accept",
    });
    strictEqual(await services.getPendingApproval("chat_1"), null);
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

  it("passes selected model, effort, service tier, files, and skills to Codex turns", async () => {
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
      serviceTier: "fast",
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
        serviceTier: "fast",
        skills: [{ name: "review", path: "/skills/review/SKILL.md" }],
      },
    ]);
  });

  it("uploads image attachments and passes them to Codex turns", async () => {
    const worktreePath = await createTemporaryDirectory();
    const attachmentDir = await createTemporaryDirectory();
    const state = {
      ...createTestState(),
      projects: [createProject({ rootPath: worktreePath })],
      chats: [createChat({ worktreePath })],
    };
    const { codex, services, store } = await createHarness(state, {
      attachmentDir,
    });
    codex.resumeThread.mockResolvedValueOnce({});
    codex.startTurn.mockResolvedValueOnce({ turn: { id: "turn_1" } });

    const attachment = await services.uploadAttachment("chat_1", {
      bytes: validPngBytes,
      mimeType: "image/png",
      name: "screenshot.png",
      size: validPngBytes.byteLength,
    });
    await services.sendMessage("chat_1", {
      attachments: [attachment],
      text: "please inspect",
    });

    deepStrictEqual(codex.startTurn.mock.calls[0], [
      "thread_1",
      "please inspect",
      worktreePath,
      {
        attachments: [attachment],
      },
    ]);
    deepStrictEqual((await store.load()).messages[0]?.attachments, [
      attachment,
    ]);
  });

  it("uses image bytes instead of client MIME type when uploading attachments", async () => {
    const worktreePath = await createTemporaryDirectory();
    const attachmentDir = await createTemporaryDirectory();
    const state = {
      ...createTestState(),
      projects: [createProject({ rootPath: worktreePath })],
      chats: [createChat({ worktreePath })],
    };
    const { services } = await createHarness(state, {
      attachmentDir,
    });

    const attachment = await services.uploadAttachment("chat_1", {
      bytes: validPngBytes,
      mimeType: "application/octet-stream",
      name: "screenshot",
      size: validPngBytes.byteLength,
    });

    strictEqual(attachment.mimeType, "image/png");
    strictEqual(attachment.name, "screenshot");
    strictEqual(attachment.size, validPngBytes.byteLength);
  });

  it("uses stored attachment bytes as the source of truth when sending", async () => {
    const worktreePath = await createTemporaryDirectory();
    const attachmentDir = await createTemporaryDirectory();
    const state = {
      ...createTestState(),
      projects: [createProject({ rootPath: worktreePath })],
      chats: [createChat({ worktreePath })],
    };
    const { codex, services } = await createHarness(state, {
      attachmentDir,
    });
    codex.startTurn.mockResolvedValueOnce({ turn: { id: "turn_1" } });

    const attachment = await services.uploadAttachment("chat_1", {
      bytes: validPngBytes,
      mimeType: "image/png",
      name: "screenshot.png",
      size: validPngBytes.byteLength,
    });
    await services.sendMessage("chat_1", {
      attachments: [
        {
          name: "spoof.webp",
          path: attachment.path,
          mimeType: "image/webp",
          size: 1,
        },
      ],
      text: "please inspect",
    });

    deepStrictEqual(codex.startTurn.mock.calls[0]?.[3], {
      attachments: [
        {
          name: "spoof.webp",
          path: attachment.path,
          mimeType: "image/png",
          size: validPngBytes.byteLength,
        },
      ],
    });
  });

  it("accepts interlaced PNG image attachments", async () => {
    const worktreePath = await createTemporaryDirectory();
    const attachmentDir = await createTemporaryDirectory();
    const state = {
      ...createTestState(),
      projects: [createProject({ rootPath: worktreePath })],
      chats: [createChat({ worktreePath })],
    };
    const { services } = await createHarness(state, {
      attachmentDir,
    });

    const attachment = await services.uploadAttachment("chat_1", {
      bytes: validInterlacedPngBytes,
      mimeType: "image/png",
      name: "interlaced.png",
      size: validInterlacedPngBytes.byteLength,
    });

    strictEqual(attachment.mimeType, "image/png");
    strictEqual(attachment.size, validInterlacedPngBytes.byteLength);
  });

  it("rejects attachments with spoofed image MIME types", async () => {
    const worktreePath = await createTemporaryDirectory();
    const attachmentDir = await createTemporaryDirectory();
    const state = {
      ...createTestState(),
      projects: [createProject({ rootPath: worktreePath })],
      chats: [createChat({ worktreePath })],
    };
    const { services } = await createHarness(state, {
      attachmentDir,
    });

    await rejects(
      services.uploadAttachment("chat_1", {
        bytes: new TextEncoder().encode("not an image"),
        mimeType: "image/png",
        name: "not-image.png",
        size: 12,
      }),
      /Attachment file is not a supported image/,
    );
  });

  it("rejects attachments with truncated image bodies", async () => {
    const worktreePath = await createTemporaryDirectory();
    const attachmentDir = await createTemporaryDirectory();
    const state = {
      ...createTestState(),
      projects: [createProject({ rootPath: worktreePath })],
      chats: [createChat({ worktreePath })],
    };
    const { services } = await createHarness(state, {
      attachmentDir,
    });

    await rejects(
      services.uploadAttachment("chat_1", {
        bytes: validPngBytes.slice(0, 8),
        mimeType: "image/png",
        name: "truncated.png",
        size: 8,
      }),
      /Attachment file is not a supported image/,
    );
  });

  it("rejects structurally invalid PNG, JPEG, GIF, and WebP attachments", async () => {
    const worktreePath = await createTemporaryDirectory();
    const attachmentDir = await createTemporaryDirectory();
    const state = {
      ...createTestState(),
      projects: [createProject({ rootPath: worktreePath })],
      chats: [createChat({ worktreePath })],
    };
    const { services } = await createHarness(state, {
      attachmentDir,
    });

    const invalidImages = [
      {
        bytes: new Uint8Array([
          137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0,
          1, 0, 0, 0, 1, 8, 4, 0, 0, 0, 181, 28, 12, 2, 0, 0, 0, 0, 73, 69, 78,
          68, 174, 66, 96, 130,
        ]),
        mimeType: "image/png",
        name: "no-idat.png",
      },
      {
        bytes: new Uint8Array([
          137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0,
          0, 0, 0, 0, 1, 8, 4, 0, 0, 0, 90, 222, 103, 60, 0, 0, 0, 11, 73, 68,
          65, 84, 120, 218, 99, 252, 255, 31, 0, 3, 3, 2, 0, 239, 162, 167, 91,
          0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
        ]),
        mimeType: "image/png",
        name: "zero-width.png",
      },
      {
        bytes: new Uint8Array([
          137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0,
          1, 0, 0, 0, 1, 1, 2, 0, 0, 0, 157, 103, 49, 175, 0, 0, 0, 11, 73, 68,
          65, 84, 120, 218, 99, 252, 255, 31, 0, 3, 3, 2, 0, 239, 162, 167, 91,
          0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
        ]),
        mimeType: "image/png",
        name: "invalid-ihdr.png",
      },
      {
        bytes: new Uint8Array([
          137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0,
          1, 0, 0, 0, 1, 8, 4, 0, 0, 0, 181, 28, 12, 2, 0, 0, 0, 12, 73, 68, 65,
          84, 120, 156, 99, 96, 96, 96, 0, 0, 0, 4, 0, 1, 246, 23, 56, 85, 0, 0,
          0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
        ]),
        mimeType: "image/png",
        name: "oversized-scanline.png",
      },
      {
        bytes: new Uint8Array([
          137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0,
          1, 0, 0, 0, 1, 8, 2, 0, 0, 0, 144, 119, 83, 222, 0, 0, 0, 11, 73, 68,
          65, 84, 120, 156, 99, 101, 96, 0, 0, 0, 18, 0, 6, 115, 205, 104, 227,
          0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
        ]),
        mimeType: "image/png",
        name: "unsupported-filter.png",
      },
      {
        bytes: new Uint8Array([
          137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0,
          1, 0, 0, 0, 1, 1, 3, 0, 0, 0, 37, 219, 86, 202, 0, 0, 0, 10, 73, 68,
          65, 84, 120, 156, 99, 96, 0, 0, 0, 2, 0, 1, 72, 175, 164, 113, 0, 0,
          0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
        ]),
        mimeType: "image/png",
        name: "indexed-without-plte.png",
      },
      {
        bytes: new Uint8Array([
          137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0,
          1, 0, 0, 0, 1, 8, 4, 0, 0, 0, 181, 28, 12, 2, 0, 0, 0, 13, 73, 72, 68,
          82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 4, 0, 0, 0, 181, 28, 12, 2, 0, 0, 0,
          11, 73, 68, 65, 84, 120, 156, 99, 252, 255, 31, 0, 3, 3, 2, 0, 124, 6,
          208, 188, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
        ]),
        mimeType: "image/png",
        name: "duplicate-ihdr.png",
      },
      {
        bytes: new Uint8Array([
          137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0,
          1, 0, 0, 0, 1, 1, 3, 0, 0, 0, 37, 219, 86, 202, 0, 0, 0, 6, 80, 76,
          84, 69, 0, 0, 0, 255, 255, 255, 165, 217, 159, 221, 0, 0, 0, 6, 80,
          76, 84, 69, 0, 0, 0, 255, 255, 255, 165, 217, 159, 221, 0, 0, 0, 10,
          73, 68, 65, 84, 120, 156, 99, 96, 0, 0, 0, 2, 0, 1, 72, 175, 164, 113,
          0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
        ]),
        mimeType: "image/png",
        name: "duplicate-plte.png",
      },
      {
        bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
        mimeType: "image/jpeg",
        name: "fake.jpg",
      },
      {
        bytes: new Uint8Array([
          0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0xff, 0xff, 0xff, 0xff,
          0x01, 0x01, 0x11, 0x00, 0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00,
          0x00, 0x3f, 0x00, 0x00, 0xff, 0xd9,
        ]),
        mimeType: "image/jpeg",
        name: "huge-dimensions.jpg",
      },
      {
        bytes: new Uint8Array([
          0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x00,
          0x00, 0x00, 0x3b,
        ]),
        mimeType: "image/gif",
        name: "fake.gif",
      },
      {
        bytes: new Uint8Array([
          0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x00,
          0x00, 0x00, 0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00,
          0x00, 0x02, 0x01, 0x00, 0x00, 0x3b,
        ]),
        mimeType: "image/gif",
        name: "no-color-table.gif",
      },
      {
        bytes: new Uint8Array([
          0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0xff, 0xff, 0xff, 0xff, 0x80,
          0x00, 0x00, 0x00, 0x00, 0x00, 0xff, 0xff, 0xff, 0x2c, 0x00, 0x00,
          0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x02, 0x01, 0x00, 0x00,
          0x3b,
        ]),
        mimeType: "image/gif",
        name: "huge-logical-screen.gif",
      },
      {
        bytes: new Uint8Array([
          0x52, 0x49, 0x46, 0x46, 0x0c, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42,
          0x50, 0x46, 0x41, 0x4b, 0x45, 0x00, 0x00, 0x00, 0x00,
        ]),
        mimeType: "image/webp",
        name: "fake.webp",
      },
    ];

    for (const image of invalidImages) {
      await rejects(
        services.uploadAttachment("chat_1", {
          bytes: image.bytes,
          mimeType: image.mimeType,
          name: image.name,
          size: image.bytes.byteLength,
        }),
        /Attachment file is not a supported image/,
      );
    }
  });

  it("rejects attachment paths from another chat", async () => {
    const worktreePath = await createTemporaryDirectory();
    const attachmentDir = await createTemporaryDirectory();
    const state = {
      ...createTestState(),
      projects: [createProject({ rootPath: worktreePath })],
      chats: [
        createChat({ id: "chat_1", worktreePath }),
        createChat({ id: "chat_2", worktreePath }),
      ],
    };
    const { codex, services } = await createHarness(state, {
      attachmentDir,
    });

    const attachment = await services.uploadAttachment("chat_2", {
      bytes: validPngBytes,
      mimeType: "image/png",
      name: "screenshot.png",
      size: validPngBytes.byteLength,
    });

    await rejects(
      services.sendMessage("chat_1", {
        attachments: [attachment],
        text: "please inspect",
      }),
      /Attachment path must be within this chat's attachment storage/,
    );
    strictEqual(codex.startTurn.mock.calls.length, 0);
  });

  it("keeps queued messages editable when attachment validation fails during drain", async () => {
    const worktreePath = await createTemporaryDirectory();
    const attachmentDir = await createTemporaryDirectory();
    const missingAttachmentPath = join(attachmentDir, "chat_1", "missing.png");
    const state: ServeState = {
      ...createTestState(),
      projects: [createProject({ rootPath: worktreePath })],
      chats: [createChat({ worktreePath })],
      messages: [
        {
          id: "msg_queued",
          chatId: "chat_1",
          role: "user",
          text: "please inspect",
          attachments: [
            {
              name: "missing.png",
              path: missingAttachmentPath,
              mimeType: "image/png",
              size: 4,
            },
          ],
          eventType: "chat.message.queued",
          createdAt: timestamp,
        },
      ],
      queuedMessages: [
        {
          id: "queue_1",
          chatId: "chat_1",
          messageId: "msg_queued",
          text: "please inspect",
          attachments: [
            {
              name: "missing.png",
              path: missingAttachmentPath,
              mimeType: "image/png",
              size: 4,
            },
          ],
          createdAt: timestamp,
        },
      ],
    };
    const { codex, services, store } = await createHarness(state, {
      attachmentDir,
    });

    await services.queueMessage("chat_1", { text: "next queued" });

    const nextState = await store.load();
    strictEqual(nextState.messages[0]?.eventType, "chat.message.queued");
    strictEqual(
      nextState.queuedMessages.some((message) => message.id === "queue_1"),
      true,
    );
    strictEqual(
      nextState.messages.some(
        (message) =>
          message.role === "error" &&
          message.text.includes("Attachment path is not an existing file"),
      ),
      true,
    );
    strictEqual(codex.startTurn.mock.calls.length, 0);
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

  it("does not merge assistant deltas into rich events with the same item id", async () => {
    const state = {
      ...createTestState(),
      projects: [createProject()],
      chats: [createChat({ status: "running", activeTurnId: "turn_1" })],
    };
    const { codex, store } = await createHarness(state);

    codex.emitNotification({
      method: "item/commandExecution/outputDelta",
      params: {
        threadId: "thread_1",
        turnId: "turn_1",
        itemId: "shared_item",
        delta: "command output",
      },
    });
    codex.emitNotification({
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread_1",
        itemId: "shared_item",
        delta: "assistant response",
      },
    });

    await vi.waitFor(async () => {
      strictEqual((await store.load()).messages.length, 2);
    });

    const savedState = await store.load();
    deepStrictEqual(
      savedState.messages.map((message) => [
        message.role,
        message.text,
        message.eventType,
        message.itemId,
      ]),
      [
        ["event", "", "item/commandExecution/outputDelta", "shared_item"],
        [
          "assistant",
          "assistant response",
          "item/agentMessage/delta",
          "shared_item",
        ],
      ],
    );
  });

  it("keeps updated rich events at their original local timeline position", async () => {
    const state = {
      ...createTestState(),
      projects: [createProject()],
      chats: [createChat({ status: "running", activeTurnId: "turn_1" })],
    };
    const { codex, services, store } = await createHarness(state);

    codex.emitNotification({
      method: "turn/plan/updated",
      params: {
        turnId: "turn_1",
        explanation: "Starting",
        plan: [{ step: "Inspect code", status: "inProgress" }],
      },
    });
    codex.emitNotification({
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread_1",
        itemId: "assistant_1",
        delta: "working",
      },
    });
    codex.emitNotification({
      method: "turn/plan/updated",
      params: {
        turnId: "turn_1",
        explanation: "Continuing",
        plan: [
          { step: "Inspect code", status: "completed" },
          { step: "Patch UI", status: "inProgress" },
        ],
      },
    });

    await vi.waitFor(async () => {
      strictEqual((await store.load()).messages.length, 2);
    });

    codex.readThread.mockResolvedValueOnce({ thread: { turns: [] } });
    const messages = await services.getMessages("chat_1");

    deepStrictEqual(
      messages.map((message) => [
        message.role,
        message.text,
        message.eventType,
      ]),
      [
        ["event", "plan updated: 2 steps", "turn/plan/updated"],
        ["assistant", "working", "item/agentMessage/delta"],
      ],
    );
  });

  it("buffers threadless turn events until a new turn is committed", async () => {
    const state = {
      ...createTestState(),
      projects: [createProject()],
      chats: [createChat()],
    };
    const { codex, services, store } = await createHarness(state);
    codex.resumeThread.mockResolvedValueOnce({});
    codex.startTurn.mockImplementationOnce(async () => {
      codex.emitNotification({
        method: "turn/plan/updated",
        params: {
          turnId: "turn_1",
          explanation: "Starting quickly",
          plan: [{ step: "Inspect code", status: "inProgress" }],
        },
      });
      return { turn: { id: "turn_1" } };
    });

    await services.sendMessage("chat_1", { text: "hello" });

    await vi.waitFor(async () => {
      strictEqual((await store.load()).messages.length, 2);
    });

    const savedState = await store.load();
    const planMessage = savedState.messages.find(
      (message) => message.eventType === "turn/plan/updated",
    );
    deepStrictEqual(
      savedState.messages.map((message) => message.role),
      ["user", "event"],
    );
    strictEqual(savedState.chats[0]?.activeTurnId, "turn_1");
    strictEqual(planMessage?.text, "plan updated: 1 step");
    deepStrictEqual(
      (planMessage?.eventData as { plan?: unknown[] } | undefined)?.plan,
      [{ step: "Inspect code", status: "inProgress" }],
    );
  });

  it("stores rich Codex events as structured timeline messages", async () => {
    const state = {
      ...createTestState(),
      projects: [createProject()],
      chats: [createChat({ status: "running", activeTurnId: "turn_1" })],
    };
    const { codex, services, store } = await createHarness(state);
    const emitSpy = vi.spyOn(services.eventHub, "emit");

    codex.emitNotification({
      method: "turn/plan/updated",
      params: {
        turnId: "turn_1",
        explanation: "Working through the change",
        plan: [{ step: "Inspect code", status: "completed" }],
      },
    });
    codex.emitNotification({
      method: "turn/plan/updated",
      params: {
        turnId: "turn_1",
        explanation: "Working through the change",
        plan: [
          { step: "Inspect code", status: "completed" },
          { step: "Patch UI", status: "inProgress" },
        ],
      },
    });
    codex.emitNotification({
      method: "turn/diff/updated",
      params: {
        turnId: "turn_1",
        diff: "diff --git a/src/app.ts b/src/app.ts\n@@ -1 +1 @@\n-old\n+new",
      },
    });
    codex.emitNotification({
      method: "item/commandExecution/outputDelta",
      params: {
        threadId: "thread_1",
        turnId: "turn_1",
        itemId: "cmd_1",
        delta: "first",
      },
    });
    codex.emitNotification({
      method: "item/commandExecution/outputDelta",
      params: {
        threadId: "thread_1",
        turnId: "turn_1",
        itemId: "cmd_1",
        delta: " second",
      },
    });
    codex.emitNotification({
      method: "item/completed",
      params: {
        threadId: "thread_1",
        turnId: "turn_1",
        item: {
          type: "commandExecution",
          id: "cmd_1",
          command: "pnpm test",
          cwd: "/repo",
          processId: "proc_1",
          source: "agent",
          status: "completed",
          commandActions: [],
          aggregatedOutput: null,
          exitCode: 0,
          durationMs: 42,
        },
      },
    });
    codex.emitNotification({
      method: "item/completed",
      params: {
        threadId: "thread_1",
        turnId: "turn_1",
        item: {
          type: "commandExecution",
          id: "cmd_empty",
          command: "true",
          cwd: "/repo",
          processId: null,
          source: "agent",
          status: "completed",
          commandActions: [],
          aggregatedOutput: null,
          exitCode: 0,
          durationMs: 1,
        },
      },
    });
    codex.emitNotification({
      method: "command/exec/outputDelta",
      params: {
        threadId: "thread_1",
        turnId: "turn_1",
        processId: "proc_2",
        stream: "stdout",
        deltaBase64: Buffer.from("log").toString("base64"),
        capReached: false,
      },
    });
    codex.emitNotification({
      method: "command/exec/outputDelta",
      params: {
        threadId: "thread_1",
        turnId: "turn_1",
        processId: "proc_2",
        stream: "stdout",
        capReached: true,
      },
    });
    codex.emitNotification({
      method: "item/fileChange/patchUpdated",
      params: {
        threadId: "thread_1",
        turnId: "turn_1",
        itemId: "patch_1",
        changes: [{ path: "src/app.ts", kind: "modify", diff: "@@ patch" }],
      },
    });
    codex.emitNotification({
      method: "item/completed",
      params: {
        threadId: "thread_1",
        turnId: "turn_1",
        item: {
          type: "fileChange",
          id: "patch_1",
          changes: [
            { path: "src/app.ts", kind: "modify", diff: "@@ final patch" },
          ],
          status: "completed",
        },
      },
    });

    await vi.waitFor(async () => {
      strictEqual((await store.load()).messages.length, 6);
    });

    const savedState = await store.load();
    const planMessage = savedState.messages.find(
      (message) => message.eventType === "turn/plan/updated",
    );
    const commandMessage = savedState.messages.find(
      (message) => message.eventType === "item/commandExecution/outputDelta",
    );
    const diffMessage = savedState.messages.find(
      (message) => message.eventType === "turn/diff/updated",
    );
    const patchMessage = savedState.messages.find(
      (message) => message.eventType === "item/fileChange/patchUpdated",
    );
    const emptyCommandMessage = savedState.messages.find(
      (message) => message.itemId === "cmd_empty",
    );
    const shellCommandMessage = savedState.messages.find(
      (message) => message.eventType === "command/exec/outputDelta",
    );

    strictEqual(planMessage?.role, "event");
    strictEqual(planMessage?.text, "plan updated: 2 steps");
    deepStrictEqual(
      (planMessage?.eventData as { plan?: unknown[] } | undefined)?.plan,
      [
        { step: "Inspect code", status: "completed" },
        { step: "Patch UI", status: "inProgress" },
      ],
    );
    strictEqual(diffMessage?.text, "Diff updated: 1 file");
    deepStrictEqual(diffMessage?.eventData, {
      files: ["src/app.ts"],
      hasDiff: true,
      hiddenContentUpdateCount: 1,
    });
    strictEqual(commandMessage?.text, "");
    strictEqual(
      (commandMessage?.eventData as { text?: string } | undefined)?.text,
      undefined,
    );
    deepStrictEqual(
      {
        command: (
          commandMessage?.eventData as { command?: unknown } | undefined
        )?.command,
        durationMs: (
          commandMessage?.eventData as { durationMs?: unknown } | undefined
        )?.durationMs,
        exitCode: (
          commandMessage?.eventData as { exitCode?: unknown } | undefined
        )?.exitCode,
        hiddenContentDeltaCount: (
          commandMessage?.eventData as
            | { hiddenContentDeltaCount?: unknown }
            | undefined
        )?.hiddenContentDeltaCount,
        status: (commandMessage?.eventData as { status?: unknown } | undefined)
          ?.status,
      },
      {
        command: "pnpm test",
        durationMs: 42,
        exitCode: 0,
        hiddenContentDeltaCount: 2,
        status: "completed",
      },
    );
    strictEqual(
      emptyCommandMessage?.eventType,
      "item/commandExecution/outputDelta",
    );
    strictEqual(emptyCommandMessage?.text, "");
    strictEqual(shellCommandMessage?.text, "");
    strictEqual(
      (shellCommandMessage?.eventData as { capReached?: boolean } | undefined)
        ?.capReached,
      true,
    );
    strictEqual(
      (
        shellCommandMessage?.eventData as
          | { hiddenContentDeltaCount?: unknown }
          | undefined
      )?.hiddenContentDeltaCount,
      1,
    );
    deepStrictEqual(
      (patchMessage?.eventData as { changes?: unknown[] } | undefined)?.changes,
      [{ path: "src/app.ts", kind: "modify" }],
    );
    strictEqual(
      (patchMessage?.eventData as { status?: string } | undefined)?.status,
      "completed",
    );
    strictEqual(
      (
        patchMessage?.eventData as
          | { hiddenContentUpdateCount?: unknown }
          | undefined
      )?.hiddenContentUpdateCount,
      2,
    );
    strictEqual(
      emitSpy.mock.calls.some((call) => call[0] === "agent.plan.updated"),
      true,
    );
    strictEqual(
      emitSpy.mock.calls.some((call) => call[0] === "agent.command.output"),
      true,
    );
    const emittedCommandParams = getEmittedCodexParams(
      emitSpy.mock.calls,
      "agent.command.output",
      "item/commandExecution/outputDelta",
    );
    const emittedShellCommandParams = getEmittedCodexParams(
      emitSpy.mock.calls,
      "agent.command.output",
      "command/exec/outputDelta",
    );
    const emittedDiffParams = getEmittedCodexParams(
      emitSpy.mock.calls,
      "agent.diff.updated",
      "turn/diff/updated",
    );
    const emittedPatchParams = getEmittedCodexParams(
      emitSpy.mock.calls,
      "agent.file.updated",
      "item/fileChange/patchUpdated",
    );
    const emittedCommandCompletedParams = getEmittedCodexParams(
      emitSpy.mock.calls,
      "agent.item.updated",
      "item/completed",
      "commandExecution",
    );
    const emittedFileCompletedParams = getEmittedCodexParams(
      emitSpy.mock.calls,
      "agent.item.updated",
      "item/completed",
      "fileChange",
    );
    const emittedPatchChanges = emittedPatchParams?.changes as
      | Array<Record<string, unknown>>
      | undefined;
    const emittedFileCompletedItem = emittedFileCompletedParams?.item as
      | Record<string, unknown>
      | undefined;
    const emittedFileCompletedChanges = emittedFileCompletedItem?.changes as
      | Array<Record<string, unknown>>
      | undefined;
    strictEqual(emittedCommandParams?.delta, undefined);
    strictEqual(emittedShellCommandParams?.deltaBase64, undefined);
    strictEqual(emittedDiffParams?.diff, undefined);
    strictEqual(emittedPatchChanges?.[0]?.diff, undefined);
    strictEqual(
      (
        emittedCommandCompletedParams?.item as
          | Record<string, unknown>
          | undefined
      )?.aggregatedOutput,
      undefined,
    );
    strictEqual(emittedFileCompletedChanges?.[0]?.diff, undefined);
  });

  it("preserves lightweight markers for repeated hidden diff and patch updates", async () => {
    const state = {
      ...createTestState(),
      projects: [createProject()],
      chats: [createChat({ status: "running", activeTurnId: "turn_1" })],
    };
    const { codex, store } = await createHarness(state);

    codex.emitNotification({
      method: "turn/diff/updated",
      params: {
        turnId: "turn_1",
        diff: "diff --git a/src/app.ts b/src/app.ts\n@@ -1 +1 @@\n-old\n+new",
      },
    });
    codex.emitNotification({
      method: "turn/diff/updated",
      params: {
        turnId: "turn_1",
        diff: "diff --git a/src/app.ts b/src/app.ts\n@@ -1 +1 @@\n-new\n+newer",
      },
    });
    codex.emitNotification({
      method: "item/fileChange/patchUpdated",
      params: {
        threadId: "thread_1",
        turnId: "turn_1",
        itemId: "patch_1",
        changes: [{ path: "src/app.ts", kind: "modify", diff: "@@ patch 1" }],
      },
    });
    codex.emitNotification({
      method: "item/fileChange/patchUpdated",
      params: {
        threadId: "thread_1",
        turnId: "turn_1",
        itemId: "patch_1",
        changes: [{ path: "src/app.ts", kind: "modify", diff: "@@ patch 2" }],
      },
    });

    let savedState = await store.load();
    await vi.waitFor(async () => {
      savedState = await store.load();
      const diffMessage = savedState.messages.find(
        (message) => message.eventType === "turn/diff/updated",
      );
      const patchMessage = savedState.messages.find(
        (message) => message.eventType === "item/fileChange/patchUpdated",
      );
      strictEqual(
        (
          diffMessage?.eventData as
            | { hiddenContentUpdateCount?: unknown }
            | undefined
        )?.hiddenContentUpdateCount,
        2,
      );
      strictEqual(
        (
          patchMessage?.eventData as
            | { hiddenContentUpdateCount?: unknown }
            | undefined
        )?.hiddenContentUpdateCount,
        2,
      );
    });

    const diffMessage = savedState.messages.find(
      (message) => message.eventType === "turn/diff/updated",
    );
    const patchMessage = savedState.messages.find(
      (message) => message.eventType === "item/fileChange/patchUpdated",
    );

    deepStrictEqual(diffMessage?.eventData, {
      files: ["src/app.ts"],
      hasDiff: true,
      hiddenContentUpdateCount: 2,
    });
    deepStrictEqual(patchMessage?.eventData, {
      changes: [{ path: "src/app.ts", kind: "modify" }],
      hiddenContentUpdateCount: 2,
    });
  });

  it("flushes sanitized hidden events buffered during turn startup", async () => {
    const state = {
      ...createTestState(),
      projects: [createProject()],
      chats: [createChat()],
    };
    const { codex, services, store } = await createHarness(state);
    codex.resumeThread.mockResolvedValueOnce({});
    codex.startTurn.mockImplementationOnce(async () => {
      codex.emitNotification({
        method: "item/commandExecution/outputDelta",
        params: {
          threadId: "thread_1",
          turnId: "turn_1",
          itemId: "cmd_1",
          delta: "large output",
        },
      });
      codex.emitNotification({
        method: "turn/diff/updated",
        params: {
          turnId: "turn_1",
          diff: "diff --git a/src/app.ts b/src/app.ts\n@@ -1 +1 @@\n-old\n+new",
        },
      });
      codex.emitNotification({
        method: "item/fileChange/patchUpdated",
        params: {
          threadId: "thread_1",
          turnId: "turn_1",
          itemId: "patch_1",
          changes: [{ path: "src/app.ts", kind: "modify", diff: "@@ patch" }],
        },
      });
      return { turn: { id: "turn_1" } };
    });

    await services.sendMessage("chat_1", { text: "hello" });
    await vi.waitFor(async () => {
      strictEqual((await store.load()).messages.length, 4);
    });

    const savedState = await store.load();
    const commandMessage = savedState.messages.find(
      (message) => message.eventType === "item/commandExecution/outputDelta",
    );
    const diffMessage = savedState.messages.find(
      (message) => message.eventType === "turn/diff/updated",
    );
    const patchMessage = savedState.messages.find(
      (message) => message.eventType === "item/fileChange/patchUpdated",
    );

    strictEqual(commandMessage?.text, "");
    deepStrictEqual(commandMessage?.eventData, {
      hiddenContentDeltaCount: 1,
      hiddenContentLength: 12,
      kind: "commandExecutionOutput",
    });
    deepStrictEqual(diffMessage?.eventData, {
      files: ["src/app.ts"],
      hasDiff: true,
      hiddenContentUpdateCount: 1,
    });
    deepStrictEqual(patchMessage?.eventData, {
      changes: [{ path: "src/app.ts", kind: "modify" }],
      hiddenContentUpdateCount: 1,
    });
  });

  it("ignores empty reasoning summary parts before summary text arrives", async () => {
    const state = {
      ...createTestState(),
      projects: [createProject()],
      chats: [createChat({ status: "running", activeTurnId: "turn_1" })],
    };
    const { codex, store } = await createHarness(state);

    codex.emitNotification({
      method: "item/reasoning/summaryPartAdded",
      params: {
        threadId: "thread_1",
        turnId: "turn_1",
        itemId: "reasoning_1",
        summaryIndex: 0,
      },
    });
    codex.emitNotification({
      method: "item/reasoning/summaryTextDelta",
      params: {
        threadId: "thread_1",
        turnId: "turn_1",
        itemId: "reasoning_1",
        summaryIndex: 0,
        delta: "First",
      },
    });
    codex.emitNotification({
      method: "item/reasoning/summaryTextDelta",
      params: {
        threadId: "thread_1",
        turnId: "turn_1",
        itemId: "reasoning_1",
        summaryIndex: 0,
        delta: " second",
      },
    });

    await vi.waitFor(async () => {
      strictEqual((await store.load()).messages.length, 1);
    });

    const savedState = await store.load();
    strictEqual(
      savedState.messages.some(
        (message) => message.eventType === "item/reasoning/summaryPartAdded",
      ),
      false,
    );
    const reasoningMessage = savedState.messages[0];
    strictEqual(reasoningMessage?.eventType, "item/reasoning/summaryTextDelta");
    strictEqual(reasoningMessage?.text, "First second");
    deepStrictEqual(reasoningMessage?.eventData, {
      kind: "summaryText",
      summaryIndex: 0,
      text: "First second",
    });
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
        serviceTier: "fast",
        createdAt: timestamp,
      },
      queuedMessageIndex: 0,
    });

    strictEqual(result.queuedMessage.model, "gpt-5.2");
    strictEqual(result.queuedMessage.serviceTier, "fast");
    const savedState = await store.load();
    strictEqual(savedState.messages.length, 1);
    strictEqual(savedState.queuedMessages.length, 1);
    strictEqual(savedState.queuedMessages[0]?.serviceTier, "fast");
    strictEqual(codex.startTurn.mock.calls.length, 0);
    strictEqual(
      emitSpy.mock.calls.some((call) => call[0] === "chat.message.created"),
      true,
    );
  });

  it("rejects restoring deleted pending messages into archived chats", async () => {
    const state = {
      ...createTestState(),
      projects: [createProject()],
      chats: [createChat({ status: "archived" })],
      messages: [],
      queuedMessages: [],
    };
    const { codex, services, store } = await createHarness(state);

    await rejects(
      services.restorePendingMessage("chat_1", {
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
      }),
      /Archived chats must be restored/,
    );

    const savedState = await store.load();
    strictEqual(savedState.messages.length, 0);
    strictEqual(savedState.queuedMessages.length, 0);
    strictEqual(codex.startTurn.mock.calls.length, 0);
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

    await services.queueMessage("chat_1", {
      serviceTier: "fast",
      text: "follow up next",
    });

    let savedState = await store.load();
    strictEqual(savedState.messages[0]?.text, "follow up next");
    strictEqual(savedState.queuedMessages[0]?.text, "follow up next");
    strictEqual(savedState.queuedMessages[0]?.serviceTier, "fast");
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
      { serviceTier: "fast" },
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

    await vi.waitFor(async () => {
      strictEqual(
        emitSpy.mock.calls.some((call) => call[0] === "agent.error"),
        true,
      );
      const savedState = await store.load();
      strictEqual(savedState.queuedMessages.length, 0);
      strictEqual(savedState.messages[0]?.text, "queued failure");
      strictEqual(savedState.messages.at(-1)?.role, "error");
      strictEqual(savedState.messages.at(-1)?.text, "queued start failed");
      strictEqual(savedState.chats[0]?.status, "failed");
      strictEqual(savedState.chats[0]?.activeTurnId, null);
    });
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
