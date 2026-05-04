import { realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  getGitRoot,
  getRemoteDefaultBranch,
  getRemotes,
  getUpstreamBranch,
  pull,
} from "@phantompane/git";
import {
  createContext,
  deleteBranch,
  deleteWorktree as deleteWorktreeCore,
  listWorktrees,
  removeWorktree,
  runCreateWorktree,
} from "@phantompane/core";
import {
  CodexBridge,
  extractServerRequestIdFromParams,
  extractThreadId,
  extractThreadIdFromParams,
  extractTurnId,
  extractTurnIdFromParams,
  getCodexBin,
  getParamObject,
  getServerRequestId,
  mapCodexMethodToEvent,
  summarizeCodexEvent,
  type CodexMessage,
} from "@phantompane/codex";
import {
  createRecordId,
  createTimestamp,
  ServeStateStore,
  touchProject,
} from "@phantompane/state";
import { EventHub } from "./event-hub.ts";
import type {
  ChatMessageRecord,
  ChatRecord,
  ChatStatus,
  CodexFileRecord,
  CodexModelRecord,
  CodexSkillRecord,
  CodexTurnContextItem,
  ProjectWorktreeRecord,
  ProjectRecord,
  QueuedMessageRecord,
  ServeState,
} from "./types.ts";

export interface CreateChatInput {
  name?: string;
  base?: string;
  worktreeName?: string;
  worktreePath?: string;
}

export interface DeleteProjectWorktreeInput {
  force?: boolean;
  keepBranch?: boolean;
  name: string;
  path?: string;
}

export interface DeleteProjectWorktreeResult {
  message: string;
}

export interface SyncProjectWorktreeBranchInput {
  name: string;
  path?: string;
}

export interface SyncProjectWorktreeBranchResult {
  message: string;
}

export interface SendMessageInput {
  effort?: string;
  files?: CodexTurnContextItem[];
  model?: string;
  skills?: CodexTurnContextItem[];
  text: string;
}

export interface ApprovalInput {
  decision: "accept" | "acceptForSession" | "decline" | "cancel";
}

export interface ServeServicesOptions {
  eventHub?: EventHub;
  store?: ServeStateStore;
  codex?: CodexBridge;
  codexHome?: string;
}

interface PendingApprovalRequest {
  chatId: string;
  serverRequestId: ServerRequestId;
  responded: boolean;
}

interface PendingTurnEventBuffer {
  chatId: string;
  discard: boolean;
  events: PendingTurnEvent[];
  flushing: boolean;
}

interface SubmitMessageOptions {
  existingUserMessageId?: string;
  queuedMessageId?: string;
  requireActiveTurn: boolean;
}

type PendingTurnEvent =
  | { kind: "notification"; message: CodexMessage }
  | { kind: "serverRequest"; message: CodexMessage };
type ServerRequestId = number | string;

interface ProjectWorktreeSnapshot {
  branch: string;
  isClean: boolean;
  name: string;
  path: string;
  pathToDisplay: string;
}

interface CodexThreadRecord {
  createdAt: string;
  id: string;
  preview: string | null;
  status: ChatStatus;
  title: string | null;
  updatedAt: string;
  worktreePath: string | null;
}

export class ServeServices {
  readonly eventHub: EventHub;
  readonly store: ServeStateStore;
  readonly codex: CodexBridge;
  private readonly loadedThreadIds = new Set<string>();
  private readonly approvalRequests = new Map<string, PendingApprovalRequest>();
  private readonly pendingTurnEvents = new Map<
    string,
    PendingTurnEventBuffer
  >();
  private readonly pendingChatTurns = new Set<string>();
  private readonly drainingQueuedMessageChatIds = new Set<string>();
  private readonly pendingQueuedMessageDrainChatIds = new Set<string>();
  private readonly activeTurnChatIds = new Set<string>();
  private readonly activeWorktreeOperationLocks = new Map<string, number>();
  private readonly reportedAgentErrors = new WeakSet<object>();

  constructor(options: ServeServicesOptions = {}) {
    this.eventHub = options.eventHub ?? new EventHub();
    this.store = options.store ?? new ServeStateStore();
    this.codex = options.codex ?? new CodexBridge();
    this.codex.onNotification((message) => {
      void this.handleCodexNotification(message);
    });
    this.codex.onServerRequest((message) => {
      void this.handleCodexServerRequest(message);
    });
    this.codex.onProcessExit((error) => {
      void this.handleCodexProcessExit(error);
    });
  }

  async getHealth() {
    await this.resetStaleTransientChatState();
    const state = await this.store.load();
    return {
      ok: true,
      projectCount: state.projects.length,
      chatCount: state.chats.length,
      codexBin: getCodexBin(),
      dataDir: process.env.PHANTOM_SERVE_DATA_DIR ?? null,
    };
  }

  async listProjects(): Promise<ProjectRecord[]> {
    await this.resetStaleTransientChatState();
    const state = await this.store.load();
    return state.projects;
  }

  async addProject(path: string): Promise<ProjectRecord> {
    if (!isAbsolute(path)) {
      throw new Error("Project path must be absolute");
    }

    const resolvedPath = await realpath(path);
    const rootPath = await getGitRoot({ cwd: resolvedPath });
    const timestamp = createTimestamp();
    let createdProject: ProjectRecord | null = null;

    await this.store.update((state) => {
      const existingProject = state.projects.find(
        (project) => project.rootPath === rootPath,
      );
      if (existingProject) {
        createdProject = touchProject(existingProject);
        return {
          ...state,
          projects: state.projects.map((project) =>
            project.id === existingProject.id ? createdProject! : project,
          ),
          selectedProjectId: existingProject.id,
        };
      }

      createdProject = {
        id: createRecordId("proj"),
        name: basename(rootPath),
        rootPath,
        createdAt: timestamp,
        updatedAt: timestamp,
        lastOpenedAt: timestamp,
      };
      return {
        ...state,
        projects: [...state.projects, createdProject],
        selectedProjectId: createdProject.id,
      };
    });

    this.eventHub.emit("project.created", createdProject);
    return createdProject!;
  }

  async removeProject(projectId: string): Promise<void> {
    await this.store.update((state) => {
      const removedChatIds = new Set(
        state.chats
          .filter((chat) => chat.projectId === projectId)
          .map((chat) => chat.id),
      );

      return {
        ...state,
        projects: state.projects.filter((project) => project.id !== projectId),
        chats: state.chats.filter((chat) => chat.projectId !== projectId),
        messages: state.messages.filter(
          (message) => !removedChatIds.has(message.chatId),
        ),
        queuedMessages: state.queuedMessages.filter(
          (message) => !removedChatIds.has(message.chatId),
        ),
        selectedProjectId:
          state.selectedProjectId === projectId
            ? null
            : state.selectedProjectId,
        selectedChatId: removedChatIds.has(state.selectedChatId ?? "")
          ? null
          : state.selectedChatId,
      };
    });
    this.eventHub.emit("project.removed", { projectId });
  }

  async listChats(projectId: string): Promise<ChatRecord[]> {
    await this.resetStaleTransientChatState();
    const state = await this.store.load();
    const project = this.requireProject(state, projectId);
    const worktrees = await this.listProjectWorktreeSnapshot(projectId);
    if (!worktrees) {
      return sortChatsByUpdatedAt(
        state.chats.filter((chat) => chat.projectId === projectId),
      );
    }

    let codexThreads: CodexThreadRecord[];
    try {
      codexThreads = await this.listCodexThreadsForWorktrees(worktrees);
    } catch {
      return sortChatsByUpdatedAt(
        state.chats.filter((chat) => chat.projectId === projectId),
      );
    }

    const worktreesByPath = new Map(
      worktrees.map((worktree) => [worktree.path, worktree]),
    );
    const canPruneMissingChats = worktreesByPath.has(project.rootPath);
    const initialProjectChatIds = new Set(
      state.chats
        .filter((chat) => chat.projectId === projectId)
        .map((chat) => chat.id),
    );
    const threadChats = codexThreads
      .map((thread) =>
        createChatFromCodexThread(project.id, thread, worktreesByPath),
      )
      .filter((chat): chat is ChatRecord => Boolean(chat));

    await this.store.update((nextState) => {
      const existingProjectChats = nextState.chats.filter(
        (chat) => chat.projectId === projectId,
      );
      const queuedMessageChatIds = getQueuedMessageChatIds(nextState);
      const existingChatsByThreadId = new Map(
        existingProjectChats
          .filter((chat) => chat.codexThreadId)
          .map((chat) => [chat.codexThreadId, chat]),
      );
      const nextProjectChats = threadChats.map((chat) => {
        const existingChat = existingChatsByThreadId.get(chat.codexThreadId);
        if (!existingChat) {
          return chat;
        }
        return {
          ...chat,
          id: existingChat.id,
          status: isChatActive(existingChat, this.pendingChatTurns)
            ? existingChat.status
            : chat.status,
          activeTurnId: isChatActive(existingChat, this.pendingChatTurns)
            ? existingChat.activeTurnId
            : null,
          createdAt: existingChat.createdAt,
        };
      });
      const threadChatIds = new Set(nextProjectChats.map((chat) => chat.id));
      const threadIds = new Set(
        threadChats
          .map((chat) => chat.codexThreadId)
          .filter((threadId): threadId is string => Boolean(threadId)),
      );
      const retainedLocalChats = existingProjectChats.filter(
        (chat) =>
          !threadChatIds.has(chat.id) &&
          (!chat.codexThreadId || !threadIds.has(chat.codexThreadId)) &&
          (worktreesByPath.has(chat.worktreePath) ||
            !canPruneMissingChats ||
            isChatActive(chat, this.pendingChatTurns) ||
            queuedMessageChatIds.has(chat.id) ||
            !initialProjectChatIds.has(chat.id)),
      );
      const retainedProjectChats = sortChatsByUpdatedAt([
        ...nextProjectChats,
        ...retainedLocalChats,
      ]);
      const retainedProjectChatIds = new Set(
        retainedProjectChats.map((chat) => chat.id),
      );
      const removedProjectChatIds = new Set(
        existingProjectChats
          .filter((chat) => !retainedProjectChatIds.has(chat.id))
          .map((chat) => chat.id),
      );
      const selectedChatId = removedProjectChatIds.has(
        nextState.selectedChatId ?? "",
      )
        ? null
        : nextState.selectedChatId;

      return {
        ...nextState,
        chats: [
          ...nextState.chats.filter((chat) => chat.projectId !== projectId),
          ...retainedProjectChats,
        ],
        messages: nextState.messages.filter(
          (message) => !removedProjectChatIds.has(message.chatId),
        ),
        queuedMessages: nextState.queuedMessages.filter(
          (message) => !removedProjectChatIds.has(message.chatId),
        ),
        selectedChatId,
      };
    });

    const syncedState = await this.store.load();
    return sortChatsByUpdatedAt(
      syncedState.chats.filter((chat) => chat.projectId === projectId),
    );
  }

  async listProjectWorktrees(
    projectId: string,
  ): Promise<ProjectWorktreeRecord[]> {
    await this.resetStaleTransientChatState();
    const state = await this.store.load();
    const project = this.requireProject(state, projectId);
    const worktreesDirectory = await getProjectWorktreesDirectory(
      project.rootPath,
    );

    const worktrees = await this.listProjectWorktreeSnapshot(projectId);
    if (!worktrees) {
      return projectWorktreesFromPersistedChats(
        state,
        projectId,
        worktreesDirectory,
        project.rootPath,
      );
    }

    const syncedChatsByPath = new Map<string, ChatRecord[]>();
    for (const chat of state.chats.filter(
      (candidate) => candidate.projectId === projectId,
    )) {
      syncedChatsByPath.set(chat.worktreePath, [
        ...(syncedChatsByPath.get(chat.worktreePath) ?? []),
        chat,
      ]);
    }

    return sortProjectWorktrees(
      worktrees.map((worktree) => {
        const chat = latestChatForWorktree(
          syncedChatsByPath.get(worktree.path) ?? [],
        );
        return {
          name: worktree.name,
          path: worktree.path,
          pathToDisplay: worktree.pathToDisplay,
          branch: worktree.branch,
          isClean: worktree.isClean,
          isMainWorktree: worktree.path === project.rootPath,
          isManagedByPhantom: isPathInsideDirectory(
            worktree.path,
            worktreesDirectory,
          ),
          chatId: chat?.id ?? null,
          chatStatus: chat?.status ?? null,
          chatTitle: chat?.title ?? worktree.name,
        };
      }),
    );
  }

  private async listProjectWorktreeSnapshot(
    projectId: string,
  ): Promise<ProjectWorktreeSnapshot[] | null> {
    const state = await this.store.load();
    const project = this.requireProject(state, projectId);
    try {
      const result = await listWorktrees(project.rootPath, {
        includePrunable: false,
      });
      if (!result.ok) {
        return null;
      }
      return result.value.worktrees;
    } catch {
      return null;
    }
  }

  private async listCodexThreadsForWorktrees(
    worktrees: ProjectWorktreeSnapshot[],
  ): Promise<CodexThreadRecord[]> {
    const cwd = worktrees.map((worktree) => worktree.path);
    if (cwd.length === 0) {
      return [];
    }

    const threads: CodexThreadRecord[] = [];
    let cursor: string | null = null;
    do {
      const result = await this.codex.listThreads({
        archived: false,
        cursor,
        cwd,
        limit: 100,
        sourceKinds: ["cli", "vscode", "appServer"],
        sortDirection: "desc",
        sortKey: "updated_at",
        useStateDbOnly: true,
      });
      threads.push(...normalizeCodexThreadList(result));
      cursor = normalizeCodexCursor(result, "nextCursor");
    } while (cursor);

    return threads;
  }

  async syncProjectWorktreeBranch(
    projectId: string,
    input: SyncProjectWorktreeBranchInput,
  ): Promise<SyncProjectWorktreeBranchResult> {
    await this.resetStaleTransientChatState();
    const worktreeName = input.name.trim();
    if (!worktreeName) {
      throw new Error("Worktree name is required");
    }
    const worktreePath = input.path?.trim();

    const state = await this.store.load();
    const project = this.requireProject(state, projectId);
    const context = await createContext(project.rootPath);
    const worktreesResult = await listWorktrees(context.gitRoot);
    const targetWorktree = worktreesResult.ok
      ? worktreesResult.value.worktrees.find(
          (worktree) =>
            worktree.name === worktreeName &&
            (!worktreePath || worktree.path === worktreePath),
        )
      : null;
    if (!targetWorktree) {
      throw new Error(`Worktree '${worktreeName}' not found`);
    }
    this.assertNoBlockingWorktreeChat(
      state,
      projectId,
      targetWorktree.path,
      worktreeName,
      "syncing the branch",
    );

    const releaseWorktreeOperation = this.acquireWorktreeOperationLock(
      targetWorktree.path,
    );
    try {
      this.assertNoBlockingWorktreeChat(
        await this.store.load(),
        projectId,
        targetWorktree.path,
        worktreeName,
        "syncing the branch",
      );
      const pullTarget = await getWorktreePullTarget(targetWorktree.path);
      const result = await pull({
        cwd: targetWorktree.path,
        remote: pullTarget.remote,
        branch: pullTarget.branch,
      });
      if (!result.ok) {
        throw result.error;
      }
    } finally {
      releaseWorktreeOperation();
    }

    return {
      message: `Synced branch '${targetWorktree.branch}'`,
    };
  }

  async createChat(
    projectId: string,
    input: CreateChatInput,
  ): Promise<ChatRecord> {
    const state = await this.store.load();
    const project = this.requireProject(state, projectId);

    const targetWorktreePath = input.worktreePath?.trim();
    const targetWorktreeName = input.worktreeName?.trim();
    const hasExistingWorktreeInput =
      input.worktreePath !== undefined || input.worktreeName !== undefined;
    if (hasExistingWorktreeInput) {
      if (!targetWorktreePath) {
        throw new Error("Worktree path is required");
      }
      const worktreesResult = await listWorktrees(project.rootPath, {
        includePrunable: false,
      });
      if (!worktreesResult.ok) {
        throw worktreesResult.error;
      }
      const targetWorktree = worktreesResult.value.worktrees.find(
        (worktree) =>
          worktree.path === targetWorktreePath &&
          (!targetWorktreeName || worktree.name === targetWorktreeName),
      );
      if (!targetWorktree) {
        throw new Error(`Worktree '${targetWorktreePath}' not found`);
      }

      const threadResult = await this.codex.startThread(targetWorktree.path);
      const codexThreadId = extractThreadId(threadResult);
      this.loadedThreadIds.add(codexThreadId);
      const timestamp = createTimestamp();
      const chat: ChatRecord = {
        id: createRecordId("chat"),
        projectId,
        worktreeName: targetWorktree.name,
        worktreePath: targetWorktree.path,
        branchName: targetWorktree.branch,
        codexThreadId,
        title: targetWorktree.name,
        status: "idle",
        activeTurnId: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      };

      await this.store.update((nextState) => ({
        ...nextState,
        chats: [...nextState.chats, chat],
        selectedProjectId: projectId,
        selectedChatId: chat.id,
      }));

      this.eventHub.emit("chat.created", chat, { chatId: chat.id });
      return chat;
    }

    const createResult = await runCreateWorktree({
      gitRoot: project.rootPath,
      name: input.name,
      base: input.base,
    });

    if (!createResult.ok) {
      throw createResult.error;
    }

    let codexThreadId: string;
    try {
      const threadResult = await this.codex.startThread(
        createResult.value.path,
      );
      codexThreadId = extractThreadId(threadResult);
    } catch (error) {
      try {
        await rollbackCreatedWorktree(
          project.rootPath,
          createResult.value.path,
          createResult.value.name,
        );
      } catch (rollbackError) {
        throw new Error(
          `Failed to start Codex thread: ${toErrorMessage(error)}. Rollback failed: ${toErrorMessage(rollbackError)}`,
        );
      }
      throw error instanceof Error ? error : new Error(String(error));
    }

    this.loadedThreadIds.add(codexThreadId);
    const timestamp = createTimestamp();
    const chat: ChatRecord = {
      id: createRecordId("chat"),
      projectId,
      worktreeName: createResult.value.name,
      worktreePath: createResult.value.path,
      branchName: createResult.value.name,
      codexThreadId,
      title: createResult.value.name,
      status: "idle",
      activeTurnId: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    await this.store.update((nextState) => ({
      ...nextState,
      chats: [...nextState.chats, chat],
      selectedProjectId: projectId,
      selectedChatId: chat.id,
    }));

    this.eventHub.emit("chat.created", chat, { chatId: chat.id });
    return chat;
  }

  async deleteProjectWorktree(
    projectId: string,
    input: DeleteProjectWorktreeInput,
  ): Promise<DeleteProjectWorktreeResult> {
    await this.resetStaleTransientChatState();
    const worktreeName = input.name.trim();
    if (!worktreeName) {
      throw new Error("Worktree name is required");
    }
    const worktreePath = input.path?.trim();

    const state = await this.store.load();
    const project = this.requireProject(state, projectId);
    const context = await createContext(project.rootPath);
    const worktreesResult = await listWorktrees(context.gitRoot, {
      excludeDefault: true,
    });
    const targetWorktree = worktreesResult.ok
      ? worktreesResult.value.worktrees.find(
          (worktree) =>
            worktree.name === worktreeName &&
            (!worktreePath || worktree.path === worktreePath),
        )
      : null;
    if (!targetWorktree) {
      throw new Error(`Worktree '${worktreeName}' not found`);
    }
    if (
      !isPathInsideDirectory(targetWorktree.path, context.worktreesDirectory)
    ) {
      throw new Error(
        `Worktree '${worktreeName}' is not managed by Phantom and cannot be deleted from Serve.`,
      );
    }
    this.assertNoBlockingWorktreeChat(
      state,
      projectId,
      targetWorktree.path,
      worktreeName,
      "deleting the worktree",
    );

    let deleteMessage = "";
    const releaseWorktreeOperation = this.acquireWorktreeOperationLock(
      targetWorktree.path,
    );
    try {
      this.assertNoBlockingWorktreeChat(
        await this.store.load(),
        projectId,
        targetWorktree.path,
        worktreeName,
        "deleting the worktree",
      );
      const result = await deleteWorktreeCore(
        context.gitRoot,
        context.worktreesDirectory,
        worktreeName,
        {
          force: input.force,
          keepBranch:
            input.keepBranch ?? context.preferences.keepBranch ?? false,
          path: targetWorktree.path,
        },
        context.config?.preDelete?.commands,
      );
      if (!result.ok) {
        throw result.error;
      }
      deleteMessage = result.value.message;

      await this.store.update((nextState) => {
        const removedChatIds = new Set(
          nextState.chats
            .filter(
              (chat) =>
                chat.projectId === projectId &&
                chat.worktreePath === targetWorktree.path,
            )
            .map((chat) => chat.id),
        );
        return {
          ...nextState,
          chats: nextState.chats.filter((chat) => !removedChatIds.has(chat.id)),
          messages: nextState.messages.filter(
            (message) => !removedChatIds.has(message.chatId),
          ),
          queuedMessages: nextState.queuedMessages.filter(
            (message) => !removedChatIds.has(message.chatId),
          ),
          selectedChatId: removedChatIds.has(nextState.selectedChatId ?? "")
            ? null
            : nextState.selectedChatId,
        };
      });
    } finally {
      releaseWorktreeOperation();
    }

    this.eventHub.emit("worktree.removed", {
      projectId,
      worktreeName,
    });
    return { message: deleteMessage };
  }

  async getChat(chatId: string): Promise<ChatRecord> {
    await this.resetStaleTransientChatState();
    const state = await this.store.load();
    return this.requireChat(state, chatId);
  }

  async getMessages(chatId: string): Promise<ChatMessageRecord[]> {
    await this.resetStaleTransientChatState();
    const state = await this.store.load();
    const chat = this.requireChat(state, chatId);
    const localMessages = state.messages.filter(
      (message) => message.chatId === chatId,
    );
    if (!chat.codexThreadId) {
      return localMessages;
    }

    try {
      const result = await this.codex.readThread(chat.codexThreadId, {
        includeTurns: true,
      });
      const codexMessages = normalizeCodexThreadMessages(result, chat.id);
      return mergeCodexAndLocalMessages(codexMessages, localMessages);
    } catch {
      return localMessages;
    }
  }

  async sendMessage(
    chatId: string,
    input: SendMessageInput,
  ): Promise<ChatRecord> {
    await this.resetStaleTransientChatState();
    const state = await this.store.load();
    const chat = this.requireChat(state, chatId);
    if (
      !isChatInActiveTurn(chat) &&
      !this.pendingChatTurns.has(chatId) &&
      state.queuedMessages.some((message) => message.chatId === chatId)
    ) {
      return this.queueMessage(chatId, input);
    }
    return this.submitMessage(chatId, input, { requireActiveTurn: false });
  }

  async steerMessage(
    chatId: string,
    input: SendMessageInput,
  ): Promise<ChatRecord> {
    return this.submitMessage(chatId, input, { requireActiveTurn: true });
  }

  async queueMessage(
    chatId: string,
    input: SendMessageInput,
  ): Promise<ChatRecord> {
    await this.resetStaleTransientChatState();
    const text = input.text.trim();
    if (!text) {
      throw new Error("Message text cannot be empty");
    }

    let shouldSubmitImmediately = false;
    let shouldDrainQueuedMessages = false;
    let queuedUserMessage: ChatMessageRecord | null = null;
    await this.store.update((nextState) => {
      const chat = this.requireChat(nextState, chatId);
      this.assertChatWorktreeIsAvailable(chat);
      const hasQueuedMessages = nextState.queuedMessages.some(
        (message) => message.chatId === chatId,
      );
      const isQueueBlocked =
        isChatInActiveTurn(chat) || this.pendingChatTurns.has(chatId);
      if (!isQueueBlocked && !hasQueuedMessages) {
        shouldSubmitImmediately = true;
        return nextState;
      }
      shouldDrainQueuedMessages = !isQueueBlocked;

      const userMessage = createMessage(
        chat.id,
        "user",
        text,
        "chat.message.queued",
      );
      const queuedMessage = createQueuedMessage(chat.id, userMessage.id, input);
      queuedUserMessage = userMessage;
      return {
        ...nextState,
        messages: [...nextState.messages, userMessage],
        queuedMessages: [...nextState.queuedMessages, queuedMessage],
      };
    });

    if (shouldSubmitImmediately) {
      return this.submitMessage(chatId, input, { requireActiveTurn: false });
    }

    if (queuedUserMessage) {
      this.eventHub.emit("chat.message.created", queuedUserMessage, { chatId });
    }
    if (shouldDrainQueuedMessages) {
      await this.drainQueuedMessagesAndReport(chatId);
    }
    return await this.getChat(chatId);
  }

  private async submitMessage(
    chatId: string,
    input: SendMessageInput,
    options: SubmitMessageOptions,
  ): Promise<ChatRecord> {
    await this.resetStaleTransientChatState();
    const text = input.text.trim();
    if (!text) {
      throw new Error("Message text cannot be empty");
    }

    const state = await this.store.load();
    const chat = this.requireChat(state, chatId);
    if (chat.status === "waitingForApproval") {
      throw new Error("Chat is waiting for approval");
    }
    this.assertChatWorktreeIsAvailable(chat);
    const existingUserMessage = options.existingUserMessageId
      ? state.messages.find(
          (message) =>
            message.id === options.existingUserMessageId &&
            message.chatId === chatId &&
            message.role === "user",
        )
      : undefined;
    if (options.existingUserMessageId && !existingUserMessage) {
      throw new Error("Queued message was not found");
    }
    const previousMessageIds = new Set(
      state.messages
        .filter((message) => message.chatId === chatId)
        .map((message) => message.id),
    );
    const isSteeringActiveTurn =
      chat.status === "running" && Boolean(chat.activeTurnId);
    if (options.requireActiveTurn && !isSteeringActiveTurn) {
      throw new Error("Chat does not have an active Codex turn");
    }
    let pendingChatTurnCleared = false;
    const clearPendingChatTurn = () => {
      if (!isSteeringActiveTurn && !pendingChatTurnCleared) {
        this.pendingChatTurns.delete(chatId);
        pendingChatTurnCleared = true;
      }
    };
    if (!isSteeringActiveTurn) {
      if (this.pendingChatTurns.has(chatId)) {
        throw new Error("Chat already has an active Codex turn");
      }
      this.pendingChatTurns.add(chatId);
    }

    const turnOptions = await this.createCodexTurnOptions(input, chat).catch(
      async (error) => {
        clearPendingChatTurn();
        if (options.queuedMessageId) {
          await this.store.update((nextState) => ({
            ...nextState,
            messages: existingUserMessage
              ? nextState.messages.map((message) =>
                  message.id === existingUserMessage.id
                    ? { ...message, eventType: undefined }
                    : message,
                )
              : nextState.messages,
            queuedMessages: nextState.queuedMessages.filter(
              (message) => message.id !== options.queuedMessageId,
            ),
          }));
        }
        await this.drainQueuedMessagesAndReport(chatId);
        throw error;
      },
    );

    const userMessage = existingUserMessage
      ? {
          ...existingUserMessage,
          eventType: undefined,
        }
      : createMessage(chat.id, "user", text);
    let nextStatus: ChatStatus | null = null;
    let nextActiveTurnId: string | null | undefined;
    let pendingTurnThreadId: string | null = null;
    let userMessageStored = false;

    try {
      await this.store.update((nextState) => ({
        ...nextState,
        messages: existingUserMessage
          ? nextState.messages.map((message) =>
              message.id === userMessage.id ? userMessage : message,
            )
          : [...nextState.messages, userMessage],
      }));
      userMessageStored = true;

      try {
        const threadId = await this.ensureThread(chat);
        const activeTurnId = chat.activeTurnId;
        if (chat.status === "running" && activeTurnId) {
          if (turnOptions) {
            await this.codex.steerTurn(
              threadId,
              activeTurnId,
              text,
              turnOptions,
            );
          } else {
            await this.codex.steerTurn(threadId, activeTurnId, text);
          }
        } else {
          const existingPendingTurn = this.pendingTurnEvents.get(threadId);
          if (existingPendingTurn) {
            if (existingPendingTurn.discard) {
              throw new Error("Chat is waiting for failed Codex turn cleanup");
            }
            if (!existingPendingTurn.flushing) {
              throw new Error("Chat already has an active Codex turn");
            }
          }
          pendingTurnThreadId = threadId;
          this.pendingTurnEvents.set(threadId, {
            chatId,
            discard: false,
            events: [],
            flushing: false,
          });
          const turnResult = turnOptions
            ? await this.codex.startTurn(
                threadId,
                text,
                chat.worktreePath,
                turnOptions,
              )
            : await this.codex.startTurn(threadId, text, chat.worktreePath);
          const turnId = extractTurnId(turnResult);
          if (turnId) {
            this.activeTurnChatIds.add(chatId);
            nextStatus = "running";
            nextActiveTurnId = turnId;
          }
        }
      } catch (error) {
        if (pendingTurnThreadId) {
          this.discardPendingTurnEvents(pendingTurnThreadId);
        }
        await this.store.update((nextState) => {
          const queuedMessageIds = new Set(
            nextState.queuedMessages.map((message) => message.messageId),
          );
          return {
            ...nextState,
            messages:
              userMessageStored && !existingUserMessage
                ? nextState.messages.filter(
                    (message) =>
                      message.id !== userMessage.id &&
                      (isSteeringActiveTurn ||
                        message.chatId !== chatId ||
                        previousMessageIds.has(message.id) ||
                        queuedMessageIds.has(message.id)),
                  )
                : nextState.messages,
            queuedMessages: options.queuedMessageId
              ? nextState.queuedMessages.filter(
                  (message) => message.id !== options.queuedMessageId,
                )
              : nextState.queuedMessages,
            chats: isSteeringActiveTurn
              ? nextState.chats
              : nextState.chats.map((candidate) =>
                  candidate.id === chatId
                    ? {
                        ...candidate,
                        status: "failed",
                        activeTurnId: chat.activeTurnId ?? null,
                        updatedAt: createTimestamp(),
                      }
                    : candidate,
                ),
          };
        });
        this.emitAgentError(chatId, error);
        throw error instanceof Error ? error : new Error(String(error));
      }

      await this.store.update((nextState) => ({
        ...nextState,
        chats: nextState.chats.map((candidate) =>
          candidate.id === chatId && nextStatus
            ? {
                ...candidate,
                status: nextStatus,
                activeTurnId: nextActiveTurnId,
                updatedAt: createTimestamp(),
              }
            : candidate,
        ),
        queuedMessages: options.queuedMessageId
          ? nextState.queuedMessages.filter(
              (message) => message.id !== options.queuedMessageId,
            )
          : nextState.queuedMessages,
      }));
      if (!existingUserMessage) {
        this.eventHub.emit("chat.message.created", userMessage, { chatId });
      }
      clearPendingChatTurn();
      if (pendingTurnThreadId) {
        await this.flushPendingTurnEvents(pendingTurnThreadId);
      }

      return await this.getChat(chatId);
    } finally {
      clearPendingChatTurn();
    }
  }

  async interruptChat(chatId: string): Promise<void> {
    await this.resetStaleTransientChatState();
    const chat = await this.getChat(chatId);
    if (!chat.codexThreadId || !chat.activeTurnId) {
      throw new Error("Chat does not have an active Codex turn");
    }
    await this.codex.interruptTurn(chat.codexThreadId, chat.activeTurnId);
  }

  async answerApproval(
    chatId: string,
    requestId: string,
    input: ApprovalInput,
  ): Promise<void> {
    await this.resetStaleTransientChatState();
    const chat = await this.getChat(chatId);
    const pendingApproval = this.approvalRequests.get(requestId);
    if (!pendingApproval) {
      throw new Error(`Approval request '${requestId}' was not found`);
    }
    if (pendingApproval.chatId !== chat.id) {
      throw new Error(
        `Approval request '${requestId}' does not belong to chat '${chatId}'`,
      );
    }
    if (pendingApproval.responded) {
      throw new Error(`Approval request '${requestId}' was already answered`);
    }

    this.codex.respondToServerRequest(pendingApproval.serverRequestId, {
      decision: input.decision,
    });
    this.approvalRequests.set(requestId, {
      ...pendingApproval,
      responded: true,
    });
    this.eventHub.emit(
      "agent.approval.answered",
      { requestId, decision: input.decision },
      { chatId: chat.id },
    );
  }

  private declineApprovalRequest(requestId: ServerRequestId): void {
    try {
      this.codex.respondToServerRequest(requestId, {
        decision: "decline",
      });
    } catch (error) {
      this.eventHub.emit("agent.error", {
        message: "Failed to decline unmapped Codex approval request",
        requestId,
        error: toErrorMessage(error),
      });
    }
  }

  async readAuth(): Promise<unknown> {
    return this.codex.readAccount();
  }

  async listModels(): Promise<CodexModelRecord[]> {
    return normalizeModelRecords(await this.codex.listModels());
  }

  async listSkills(chatId: string): Promise<CodexSkillRecord[]> {
    const chat = await this.getChat(chatId);
    return normalizeSkillRecords(
      await this.codex.listSkills([chat.worktreePath]),
    );
  }

  async searchFiles(chatId: string, query: string): Promise<CodexFileRecord[]> {
    const trimmedQuery = query.trim();
    if (!trimmedQuery) {
      return [];
    }

    const chat = await this.getChat(chatId);
    return normalizeFileRecords(
      await this.codex.searchFiles(trimmedQuery, [chat.worktreePath]),
    );
  }

  private async createCodexTurnOptions(
    input: SendMessageInput,
    chat: ChatRecord,
  ): Promise<
    | {
        effort?: string;
        files?: CodexTurnContextItem[];
        model?: string;
        skills?: CodexTurnContextItem[];
      }
    | undefined
  > {
    const files = await normalizeFileContextItems(
      input.files,
      chat.worktreePath,
    );
    const skills = await this.normalizeSkillContextItems(
      input.skills,
      chat.worktreePath,
    );
    if (
      !input.effort &&
      !input.model &&
      files.length === 0 &&
      skills.length === 0
    ) {
      return undefined;
    }
    return {
      effort: input.effort,
      files: files.length > 0 ? files : undefined,
      model: input.model,
      skills: skills.length > 0 ? skills : undefined,
    };
  }

  private async normalizeSkillContextItems(
    items: CodexTurnContextItem[] | undefined,
    worktreePath: string,
  ): Promise<CodexTurnContextItem[]> {
    const normalized = normalizeTurnContextItems(items);
    if (normalized.length === 0) {
      return [];
    }

    const availableSkills = normalizeSkillRecords(
      await this.codex.listSkills([worktreePath]),
    );
    const skillsByPath = new Map(
      availableSkills
        .filter((skill) => skill.enabled)
        .map((skill) => [skill.path, skill]),
    );
    return normalized.map((item) => {
      const skill = skillsByPath.get(item.path);
      if (!skill) {
        throw new Error(`Skill context path is not available: ${item.path}`);
      }
      return {
        name: skill.name,
        path: skill.path,
      };
    });
  }

  private async ensureThread(chat: ChatRecord): Promise<string> {
    if (chat.codexThreadId) {
      if (!this.loadedThreadIds.has(chat.codexThreadId)) {
        await this.codex.resumeThread(chat.codexThreadId, chat.worktreePath);
        this.loadedThreadIds.add(chat.codexThreadId);
      }
      return chat.codexThreadId;
    }

    const threadResult = await this.codex.startThread(chat.worktreePath);
    const threadId = extractThreadId(threadResult);
    this.loadedThreadIds.add(threadId);
    await this.store.update((state) => ({
      ...state,
      chats: state.chats.map((candidate) =>
        candidate.id === chat.id
          ? {
              ...candidate,
              codexThreadId: threadId,
              updatedAt: createTimestamp(),
            }
          : candidate,
      ),
    }));
    return threadId;
  }

  private async handleCodexProcessExit(error: Error): Promise<void> {
    this.loadedThreadIds.clear();
    this.approvalRequests.clear();
    this.pendingTurnEvents.clear();
    this.pendingChatTurns.clear();
    this.activeTurnChatIds.clear();

    const affectedChatIds: string[] = [];
    await this.store.update((state) => ({
      ...state,
      chats: state.chats.map((chat) => {
        const hasTransientTurn =
          chat.status === "running" ||
          chat.status === "waitingForApproval" ||
          Boolean(chat.activeTurnId);
        if (!hasTransientTurn) {
          return chat;
        }
        affectedChatIds.push(chat.id);
        return {
          ...chat,
          status: "failed",
          activeTurnId: null,
          updatedAt: createTimestamp(),
        };
      }),
    }));

    for (const chatId of affectedChatIds) {
      this.eventHub.emit(
        "agent.error",
        {
          message: "Codex App Server exited; chat turn state was reset",
          error: error.message,
        },
        { chatId },
      );
    }
  }

  private async handleCodexNotification(message: CodexMessage): Promise<void> {
    const threadId = extractThreadIdFromParams(message.params);
    if (
      threadId &&
      this.bufferPendingTurnEvent(threadId, {
        kind: "notification",
        message,
      })
    ) {
      return;
    }
    await this.processCodexNotification(message);
  }

  private async processCodexNotification(message: CodexMessage): Promise<void> {
    const method = message.method ?? "unknown";
    const threadId = extractThreadIdFromParams(message.params);
    const chat = threadId ? await this.findChatByThreadId(threadId) : null;
    const eventType = mapCodexMethodToEvent(method);

    if (chat) {
      const shouldEmit = await this.applyCodexStateChange(
        chat.id,
        method,
        message.params,
      );
      if (!shouldEmit) {
        return;
      }
      await this.addMessageFromCodexEvent(chat.id, method, message.params);
      this.eventHub.emit(eventType, message, { chatId: chat.id });
      if (method === "turn/completed") {
        await this.drainQueuedMessagesAndReport(chat.id);
      }
    } else {
      if (method === "serverRequest/resolved") {
        return;
      }
      this.eventHub.emit(eventType, message);
    }
  }

  private async handleCodexServerRequest(message: CodexMessage): Promise<void> {
    const threadId = extractThreadIdFromParams(message.params);
    if (
      threadId &&
      this.bufferPendingTurnEvent(threadId, {
        kind: "serverRequest",
        message,
      })
    ) {
      return;
    }
    await this.processCodexServerRequest(message);
  }

  private async processCodexServerRequest(
    message: CodexMessage,
  ): Promise<void> {
    const threadId = extractThreadIdFromParams(message.params);
    const chat = threadId ? await this.findChatByThreadId(threadId) : null;
    const serverRequestId = getServerRequestId(message.id);
    if (!chat) {
      if (serverRequestId !== null) {
        this.declineApprovalRequest(serverRequestId);
      }
      this.eventHub.emit("agent.error", {
        message: "Codex approval request could not be mapped to a chat",
        method: message.method,
        requestId: serverRequestId,
      });
      return;
    }
    if (serverRequestId === null) {
      this.eventHub.emit(
        "agent.error",
        {
          message: "Codex approval request did not include a request id",
          method: message.method,
        },
        { chatId: chat.id },
      );
      return;
    }
    if (!chat.activeTurnId) {
      this.declineApprovalRequest(serverRequestId);
      this.eventHub.emit(
        "agent.error",
        {
          message: "Codex approval request did not belong to an active turn",
          method: message.method,
          requestId: serverRequestId,
        },
        { chatId: chat.id },
      );
      return;
    }
    const requestTurnId = extractTurnIdFromParams(message.params);
    if (requestTurnId !== null && requestTurnId !== chat.activeTurnId) {
      this.declineApprovalRequest(serverRequestId);
      this.eventHub.emit(
        "agent.error",
        {
          message: "Codex approval request belonged to a stale turn",
          method: message.method,
          requestId: serverRequestId,
          turnId: requestTurnId,
        },
        { chatId: chat.id },
      );
      return;
    }

    const approvalRequestId = createRecordId("approval");
    this.approvalRequests.set(approvalRequestId, {
      chatId: chat.id,
      serverRequestId,
      responded: false,
    });
    await this.updateChatStatus(
      chat.id,
      "waitingForApproval",
      chat.activeTurnId,
    );
    this.eventHub.emit(
      "agent.approval.requested",
      {
        requestId: approvalRequestId,
        method: message.method,
        params: message.params,
      },
      { chatId: chat.id },
    );
  }

  private async drainQueuedMessages(chatId: string): Promise<void> {
    const state = await this.store.load();
    const chat = this.requireChat(state, chatId);
    if (isChatInActiveTurn(chat) || this.pendingChatTurns.has(chatId)) {
      return;
    }

    const queuedMessage = state.queuedMessages.find(
      (message) => message.chatId === chatId,
    );
    if (!queuedMessage) {
      return;
    }
    const queuedUserMessage = state.messages.find(
      (message) =>
        message.id === queuedMessage.messageId &&
        message.chatId === chatId &&
        message.role === "user",
    );
    if (!queuedUserMessage) {
      await this.store.update((nextState) => ({
        ...nextState,
        queuedMessages: nextState.queuedMessages.filter(
          (message) => message.id !== queuedMessage.id,
        ),
      }));
      await this.drainQueuedMessages(chatId);
      throw new Error("Queued message was not found");
    }

    await this.submitMessage(chatId, queuedMessageToSendInput(queuedMessage), {
      existingUserMessageId: queuedMessage.messageId,
      queuedMessageId: queuedMessage.id,
      requireActiveTurn: false,
    });
  }

  private async drainQueuedMessagesAndReport(chatId: string): Promise<void> {
    if (this.drainingQueuedMessageChatIds.has(chatId)) {
      this.pendingQueuedMessageDrainChatIds.add(chatId);
      return;
    }

    this.drainingQueuedMessageChatIds.add(chatId);
    try {
      do {
        this.pendingQueuedMessageDrainChatIds.delete(chatId);
        try {
          await this.drainQueuedMessages(chatId);
        } catch (error) {
          const wasReported = this.isAgentErrorReported(error);
          await this.addAgentErrorMessage(chatId, error);
          if (!wasReported) {
            this.emitAgentError(chatId, error);
          }
        }
      } while (this.pendingQueuedMessageDrainChatIds.has(chatId));
    } finally {
      this.pendingQueuedMessageDrainChatIds.delete(chatId);
      this.drainingQueuedMessageChatIds.delete(chatId);
    }
  }

  private async addAgentErrorMessage(
    chatId: string,
    error: unknown,
  ): Promise<void> {
    const message = toErrorMessage(error);
    await this.store.update((state) => {
      if (!state.chats.some((chat) => chat.id === chatId)) {
        return state;
      }
      return {
        ...state,
        messages: [...state.messages, createMessage(chatId, "error", message)],
      };
    });
  }

  private emitAgentError(chatId: string, error: unknown): void {
    this.markAgentErrorReported(error);
    this.eventHub.emit(
      "agent.error",
      { message: toErrorMessage(error) },
      { chatId },
    );
  }

  private markAgentErrorReported(error: unknown): void {
    if ((typeof error === "object" || typeof error === "function") && error) {
      this.reportedAgentErrors.add(error);
    }
  }

  private isAgentErrorReported(error: unknown): boolean {
    if (!error || (typeof error !== "object" && typeof error !== "function")) {
      return false;
    }
    return this.reportedAgentErrors.has(error);
  }

  private assertChatWorktreeIsAvailable(chat: ChatRecord): void {
    if (this.isWorktreeOperationActive(chat.worktreePath)) {
      throw new Error(
        `Worktree '${chat.worktreeName}' is busy. Wait for the current worktree operation to finish before sending messages.`,
      );
    }
  }

  private acquireWorktreeOperationLock(worktreePath: string): () => void {
    const activeCount =
      this.activeWorktreeOperationLocks.get(worktreePath) ?? 0;
    this.activeWorktreeOperationLocks.set(worktreePath, activeCount + 1);
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      const nextCount =
        (this.activeWorktreeOperationLocks.get(worktreePath) ?? 1) - 1;
      if (nextCount > 0) {
        this.activeWorktreeOperationLocks.set(worktreePath, nextCount);
      } else {
        this.activeWorktreeOperationLocks.delete(worktreePath);
      }
    };
  }

  private isWorktreeOperationActive(worktreePath: string): boolean {
    return (this.activeWorktreeOperationLocks.get(worktreePath) ?? 0) > 0;
  }

  private assertNoBlockingWorktreeChat(
    state: ServeState,
    projectId: string,
    worktreePath: string,
    worktreeName: string,
    action: string,
  ): void {
    const activeChat = findActiveWorktreeChat(
      state.chats,
      projectId,
      worktreePath,
      this.pendingChatTurns,
      getQueuedMessageChatIds(state),
    );
    if (activeChat) {
      throw new Error(
        `Worktree '${worktreeName}' has an active chat. Stop the chat before ${action}.`,
      );
    }
  }

  private async flushPendingTurnEvents(threadId: string): Promise<void> {
    const pendingTurnEvents = this.pendingTurnEvents.get(threadId);
    if (!pendingTurnEvents || pendingTurnEvents.discard) {
      this.pendingTurnEvents.delete(threadId);
      return;
    }
    pendingTurnEvents.flushing = true;
    while (!pendingTurnEvents.discard && pendingTurnEvents.events.length > 0) {
      const pendingEvent = pendingTurnEvents.events.shift();
      if (!pendingEvent) {
        continue;
      }
      if (pendingEvent.kind === "notification") {
        await this.processCodexNotification(pendingEvent.message);
      } else {
        await this.processCodexServerRequest(pendingEvent.message);
      }
    }
    pendingTurnEvents.flushing = false;
    if (this.pendingTurnEvents.get(threadId) === pendingTurnEvents) {
      this.pendingTurnEvents.delete(threadId);
    }
  }

  private bufferPendingTurnEvent(
    threadId: string,
    event: PendingTurnEvent,
  ): boolean {
    const pendingTurnEvents = this.pendingTurnEvents.get(threadId);
    if (!pendingTurnEvents) {
      return false;
    }
    if (pendingTurnEvents.discard) {
      if (event.kind === "serverRequest") {
        const serverRequestId = getServerRequestId(event.message.id);
        if (serverRequestId !== null) {
          this.declineApprovalRequest(serverRequestId);
        }
      }
      return true;
    }
    pendingTurnEvents.events.push(event);
    return true;
  }

  private discardPendingTurnEvents(threadId: string): void {
    const pendingTurnEvents = this.pendingTurnEvents.get(threadId);
    if (!pendingTurnEvents) {
      return;
    }

    for (const pendingEvent of pendingTurnEvents.events) {
      if (pendingEvent.kind !== "serverRequest") {
        continue;
      }
      const serverRequestId = getServerRequestId(pendingEvent.message.id);
      if (serverRequestId !== null) {
        this.declineApprovalRequest(serverRequestId);
      }
    }
    pendingTurnEvents.discard = true;
    pendingTurnEvents.events = [];
    const cleanup = setTimeout(() => {
      if (this.pendingTurnEvents.get(threadId) === pendingTurnEvents) {
        this.pendingTurnEvents.delete(threadId);
      }
    }, 30000);
    cleanup.unref?.();
  }

  private async findChatByThreadId(
    threadId: string,
  ): Promise<ChatRecord | null> {
    const state = await this.store.load();
    return state.chats.find((chat) => chat.codexThreadId === threadId) ?? null;
  }

  private async applyCodexStateChange(
    chatId: string,
    method: string,
    params: unknown,
  ): Promise<boolean> {
    if (method === "turn/started") {
      this.activeTurnChatIds.add(chatId);
      await this.updateChatStatus(
        chatId,
        "running",
        extractTurnId({ turn: getParamObject(params)?.turn }),
      );
      return true;
    }
    if (method === "turn/completed") {
      const turn = getParamObject(params)?.turn as
        | { status?: string }
        | undefined;
      this.activeTurnChatIds.delete(chatId);
      await this.updateChatStatus(
        chatId,
        turn?.status === "failed" ? "failed" : "idle",
        null,
      );
      return true;
    }
    if (method === "serverRequest/resolved") {
      const serverRequestId = extractServerRequestIdFromParams(params);
      if (serverRequestId === null) {
        return false;
      }
      const wasTracked = this.deleteApprovalRequestByServerId(
        chatId,
        serverRequestId,
      );
      if (!wasTracked) {
        return false;
      }
      await this.updateChatStatus(chatId, "running", undefined);
    }
    return true;
  }

  private async resetStaleTransientChatState(): Promise<void> {
    const state = await this.store.load();
    if (!state.chats.some((chat) => this.isStaleTransientChat(chat))) {
      return;
    }

    const timestamp = createTimestamp();
    await this.store.update((nextState) => ({
      ...nextState,
      chats: nextState.chats.map((chat) =>
        this.isStaleTransientChat(chat)
          ? {
              ...chat,
              status: "idle",
              activeTurnId: null,
              updatedAt: timestamp,
            }
          : chat,
      ),
    }));
  }

  private isStaleTransientChat(chat: ChatRecord): boolean {
    return Boolean(
      (chat.status === "running" ||
        chat.status === "waitingForApproval" ||
        chat.activeTurnId) &&
      !this.isChatActiveInCurrentProcess(chat),
    );
  }

  private isChatActiveInCurrentProcess(chat: ChatRecord): boolean {
    return Boolean(
      this.pendingChatTurns.has(chat.id) ||
      this.activeTurnChatIds.has(chat.id) ||
      this.hasApprovalRequestForChat(chat.id),
    );
  }

  private hasApprovalRequestForChat(chatId: string): boolean {
    for (const approvalRequest of this.approvalRequests.values()) {
      if (approvalRequest.chatId === chatId) {
        return true;
      }
    }
    return false;
  }

  private deleteApprovalRequestByServerId(
    chatId: string,
    serverRequestId: ServerRequestId,
  ): boolean {
    let wasTracked = false;
    for (const [approvalRequestId, approvalRequest] of this.approvalRequests) {
      if (
        approvalRequest.chatId === chatId &&
        approvalRequest.serverRequestId === serverRequestId
      ) {
        this.approvalRequests.delete(approvalRequestId);
        wasTracked = true;
      }
    }
    return wasTracked;
  }

  private async updateChatStatus(
    chatId: string,
    status: ChatStatus,
    activeTurnId: string | null | undefined,
  ): Promise<void> {
    await this.store.update((state) => ({
      ...state,
      chats: state.chats.map((chat) =>
        chat.id === chatId
          ? {
              ...chat,
              status,
              activeTurnId:
                activeTurnId === undefined ? chat.activeTurnId : activeTurnId,
              updatedAt: createTimestamp(),
            }
          : chat,
      ),
    }));
  }

  private async addMessageFromCodexEvent(
    chatId: string,
    method: string,
    params: unknown,
  ): Promise<void> {
    const paramObject = getParamObject(params);
    if (!paramObject) {
      return;
    }

    if (method === "item/agentMessage/delta") {
      const itemId =
        typeof paramObject.itemId === "string" ? paramObject.itemId : undefined;
      const delta =
        typeof paramObject.delta === "string" ? paramObject.delta : "";
      if (!itemId || !delta) {
        return;
      }
      await this.store.update((state) => {
        const existingMessage = state.messages.find(
          (message) => message.chatId === chatId && message.itemId === itemId,
        );
        if (!existingMessage) {
          return {
            ...state,
            messages: [
              ...state.messages,
              createMessage(chatId, "assistant", delta, method, itemId),
            ],
          };
        }
        return {
          ...state,
          messages: state.messages.map((message) =>
            message.id === existingMessage.id
              ? { ...message, text: `${message.text}${delta}` }
              : message,
          ),
        };
      });
      return;
    }

    if (
      method === "item/started" ||
      method === "item/completed" ||
      method === "turn/completed" ||
      method === "error"
    ) {
      const role = method === "error" ? "error" : "event";
      await this.store.update((state) => ({
        ...state,
        messages: [
          ...state.messages,
          createMessage(
            chatId,
            role,
            summarizeCodexEvent(method, params),
            method,
          ),
        ],
      }));
    }
  }

  private requireProject(state: ServeState, projectId: string): ProjectRecord {
    const project = state.projects.find(
      (candidate) => candidate.id === projectId,
    );
    if (!project) {
      throw new Error(`Project '${projectId}' not found`);
    }
    return project;
  }

  private requireChat(state: ServeState, chatId: string): ChatRecord {
    const chat = state.chats.find((candidate) => candidate.id === chatId);
    if (!chat) {
      throw new Error(`Chat '${chatId}' not found`);
    }
    return chat;
  }
}

function createMessage(
  chatId: string,
  role: ChatMessageRecord["role"],
  text: string,
  eventType?: string,
  itemId?: string,
): ChatMessageRecord {
  return {
    id: createRecordId("msg"),
    chatId,
    role,
    text,
    eventType,
    itemId,
    createdAt: createTimestamp(),
  };
}

function createQueuedMessage(
  chatId: string,
  messageId: string,
  input: SendMessageInput,
): QueuedMessageRecord {
  return {
    id: createRecordId("queue"),
    chatId,
    messageId,
    text: input.text.trim(),
    effort: input.effort,
    files: cloneContextItems(input.files),
    model: input.model,
    skills: cloneContextItems(input.skills),
    createdAt: createTimestamp(),
  };
}

function queuedMessageToSendInput(
  message: QueuedMessageRecord,
): SendMessageInput {
  return {
    effort: message.effort,
    files: cloneContextItems(message.files),
    model: message.model,
    skills: cloneContextItems(message.skills),
    text: message.text,
  };
}

function cloneContextItems(
  items: CodexTurnContextItem[] | undefined,
): CodexTurnContextItem[] | undefined {
  if (!items || items.length === 0) {
    return undefined;
  }
  return items.map((item) => ({
    name: item.name,
    path: item.path,
  }));
}

function isChatInActiveTurn(chat: ChatRecord): boolean {
  return Boolean(
    chat.activeTurnId &&
    (chat.status === "running" || chat.status === "waitingForApproval"),
  );
}

function latestChatForWorktree(chats: ChatRecord[]): ChatRecord | null {
  const sortedChats = [...chats].sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt),
  );
  return (
    sortedChats.find((chat) => chat.codexThreadId) ?? sortedChats[0] ?? null
  );
}

function findActiveWorktreeChat(
  chats: ChatRecord[],
  projectId: string,
  worktreePath: string,
  pendingChatTurns: ReadonlySet<string>,
  queuedMessageChatIds: ReadonlySet<string>,
): ChatRecord | undefined {
  return chats.find(
    (chat) =>
      chat.projectId === projectId &&
      chat.worktreePath === worktreePath &&
      (pendingChatTurns.has(chat.id) ||
        queuedMessageChatIds.has(chat.id) ||
        chat.status === "running" ||
        chat.status === "waitingForApproval" ||
        Boolean(chat.activeTurnId)),
  );
}

async function getWorktreePullTarget(
  worktreePath: string,
): Promise<{ branch?: string; remote?: string }> {
  const remotes = await getRemotes({ cwd: worktreePath });
  const normalizedUpstream = (
    await getUpstreamBranch({ cwd: worktreePath })
  )?.trim();
  if (normalizedUpstream) {
    const upstreamRemote = findUpstreamRemote(remotes, normalizedUpstream);
    if (upstreamRemote) {
      return {
        remote: upstreamRemote,
        branch: normalizedUpstream.slice(upstreamRemote.length + 1),
      };
    }
    return {};
  }

  const remote = remotes.includes("origin") ? "origin" : remotes[0];
  if (!remote) {
    throw new Error(
      "Cannot sync branch because no Git remotes are configured.",
    );
  }

  return {
    remote,
    branch:
      (await getRemoteDefaultBranch({ cwd: worktreePath, remote })) ?? "HEAD",
  };
}

function findUpstreamRemote(
  remotes: string[],
  upstreamBranch: string,
): string | null {
  return (
    remotes
      .filter((remote) => upstreamBranch.startsWith(`${remote}/`))
      .sort((left, right) => right.length - left.length)[0] ?? null
  );
}

function projectWorktreesFromPersistedChats(
  state: ServeState,
  projectId: string,
  worktreesDirectory: string,
  projectRootPath: string,
): ProjectWorktreeRecord[] {
  const chatsByPath = new Map<string, ChatRecord[]>();
  for (const chat of state.chats.filter(
    (chat) => chat.projectId === projectId,
  )) {
    chatsByPath.set(chat.worktreePath, [
      ...(chatsByPath.get(chat.worktreePath) ?? []),
      chat,
    ]);
  }

  return sortProjectWorktrees(
    Array.from(chatsByPath.values())
      .map((chats) => latestChatForWorktree(chats))
      .filter((chat): chat is ChatRecord => Boolean(chat))
      .map((chat) => ({
        name: chat.worktreeName,
        path: chat.worktreePath,
        pathToDisplay: chat.worktreePath,
        branch: chat.branchName,
        isClean: true,
        isMainWorktree: chat.worktreePath === projectRootPath,
        isManagedByPhantom: isPathInsideDirectory(
          chat.worktreePath,
          worktreesDirectory,
        ),
        chatId: chat.id,
        chatStatus: chat.status,
        chatTitle: chat.title,
      })),
  );
}

function sortProjectWorktrees(
  worktrees: ProjectWorktreeRecord[],
): ProjectWorktreeRecord[] {
  return [...worktrees].sort((left, right) => {
    if (left.isMainWorktree !== right.isMainWorktree) {
      return left.isMainWorktree ? -1 : 1;
    }
    return left.name.localeCompare(right.name);
  });
}

async function getProjectWorktreesDirectory(
  projectRootPath: string,
): Promise<string> {
  try {
    const context = await createContext(projectRootPath);
    return context.worktreesDirectory;
  } catch {
    return join(projectRootPath, ".git", "phantom", "worktrees");
  }
}

function isPathInsideDirectory(path: string, directory: string): boolean {
  const relativePath = relative(directory, path);
  return Boolean(
    relativePath && !relativePath.startsWith("..") && !isAbsolute(relativePath),
  );
}

function isChatActive(
  chat: ChatRecord,
  pendingChatTurns: ReadonlySet<string>,
): boolean {
  return Boolean(
    pendingChatTurns.has(chat.id) ||
    chat.activeTurnId ||
    chat.status === "running" ||
    chat.status === "waitingForApproval",
  );
}

function getQueuedMessageChatIds(state: ServeState): ReadonlySet<string> {
  return new Set(state.queuedMessages.map((message) => message.chatId));
}

function normalizeCodexThreadList(value: unknown): CodexThreadRecord[] {
  const source =
    getRecordArray(value, "data") ?? getRecordArray(value, "threads");
  return (source ?? [])
    .map((thread) => normalizeCodexThread(thread))
    .filter((thread): thread is CodexThreadRecord => Boolean(thread));
}

function normalizeCodexThread(value: unknown): CodexThreadRecord | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = getRecordString(value, "id") ?? getRecordString(value, "threadId");
  if (!id) {
    return null;
  }
  const fallbackTimestamp = createTimestamp();
  const createdAt = normalizeCodexTimestamp(
    value.createdAt ?? value.created_at,
    fallbackTimestamp,
  );
  const updatedAt = normalizeCodexTimestamp(
    value.updatedAt ?? value.updated_at,
    createdAt,
  );
  return {
    id,
    title:
      getRecordString(value, "title") ??
      getRecordString(value, "name") ??
      getRecordString(value, "firstUserMessage") ??
      null,
    preview: getRecordString(value, "preview") ?? null,
    worktreePath: getRecordString(value, "cwd") ?? null,
    status: normalizeCodexThreadStatus(value.status),
    createdAt,
    updatedAt,
  };
}

function normalizeCodexCursor(value: unknown, key: string): string | null {
  return (
    getRecordString(value, key) ?? getRecordString(value, "next_cursor") ?? null
  );
}

function createChatFromCodexThread(
  projectId: string,
  thread: CodexThreadRecord,
  worktreesByPath: ReadonlyMap<string, ProjectWorktreeSnapshot>,
): ChatRecord | null {
  if (!thread.worktreePath) {
    return null;
  }
  const worktree = worktreesByPath.get(thread.worktreePath);
  if (!worktree) {
    return null;
  }
  const title =
    normalizeTitle(thread.title) ??
    normalizeTitle(thread.preview) ??
    worktree.name;
  return {
    id: createImportedChatId(thread.id),
    projectId,
    worktreeName: worktree.name,
    worktreePath: worktree.path,
    branchName: worktree.branch,
    codexThreadId: thread.id,
    title,
    status: thread.status,
    activeTurnId: null,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
  };
}

function normalizeTitle(value: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function createImportedChatId(threadId: string): string {
  return `chat_codex_${threadId}`;
}

function normalizeCodexThreadStatus(value: unknown): ChatStatus {
  if (typeof value === "string") {
    if (value === "active" || value === "running") {
      return "running";
    }
    if (value === "systemError" || value === "failed") {
      return "failed";
    }
    return "idle";
  }
  if (!isRecord(value)) {
    return "idle";
  }
  const type = getRecordString(value, "type");
  if (type === "active") {
    return "running";
  }
  if (type === "systemError" || type === "failed") {
    return "failed";
  }
  return "idle";
}

function normalizeCodexTimestamp(value: unknown, fallback: string): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    const millis = value < 10_000_000_000 ? value * 1000 : value;
    return new Date(millis).toISOString();
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) {
      return new Date(parsed).toISOString();
    }
  }
  return fallback;
}

function sortChatsByUpdatedAt(chats: ChatRecord[]): ChatRecord[] {
  return [...chats].sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt),
  );
}

function normalizeCodexThreadMessages(
  value: unknown,
  chatId: string,
): ChatMessageRecord[] {
  const thread =
    getRecordObject(value, "thread") ?? (isRecord(value) ? value : null);
  const turns = thread ? getRecordArray(thread, "turns") : undefined;
  if (!turns) {
    return [];
  }

  const messages: ChatMessageRecord[] = [];
  for (const [turnIndex, turn] of turns.entries()) {
    const turnId =
      getRecordString(turn, "id") ??
      getRecordString(turn, "turnId") ??
      String(turnIndex);
    const turnTimestamp = normalizeCodexTimestamp(
      turn.createdAt ?? turn.created_at ?? turn.updatedAt ?? turn.updated_at,
      createTimestamp(),
    );
    const items = getCodexTurnItems(turn);
    for (const [itemIndex, item] of items.entries()) {
      const role = normalizeCodexMessageRole(item);
      if (!role) {
        continue;
      }
      const text = extractCodexText(item).trim();
      if (!text) {
        continue;
      }
      messages.push({
        id: `${chatId}_codex_${turnId}_${itemIndex}`,
        chatId,
        role,
        text,
        itemId: getRecordString(item, "id") ?? undefined,
        createdAt: normalizeCodexTimestamp(
          item.createdAt ?? item.created_at ?? item.timestamp,
          turnTimestamp,
        ),
      });
    }
  }
  return messages.sort((left, right) =>
    left.createdAt.localeCompare(right.createdAt),
  );
}

function getCodexTurnItems(
  turn: Record<string, unknown>,
): Array<Record<string, unknown>> {
  const inputItems = Array.isArray(turn.input)
    ? turn.input.filter(isRecord).map((item) => ({ ...item, role: "user" }))
    : [];
  if (Array.isArray(turn.items)) {
    return [...inputItems, ...turn.items.filter(isRecord)];
  }
  if (Array.isArray(turn.output)) {
    return [...inputItems, ...turn.output.filter(isRecord)];
  }
  return inputItems;
}

function normalizeCodexMessageRole(
  item: Record<string, unknown>,
): "assistant" | "user" | null {
  const role = getRecordString(item, "role");
  if (role === "user" || role === "assistant") {
    return role;
  }
  const type = getRecordString(item, "type");
  if (
    type === "userMessage" ||
    type === "user_message" ||
    type === "input_text"
  ) {
    return "user";
  }
  if (
    type === "agentMessage" ||
    type === "assistantMessage" ||
    type === "agent_message" ||
    type === "assistant_message" ||
    type === "output_text"
  ) {
    return "assistant";
  }
  return null;
}

function extractCodexText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(extractCodexText).filter(Boolean).join("");
  }
  if (!isRecord(value)) {
    return "";
  }
  const directText =
    getRecordString(value, "text") ??
    getRecordString(value, "message") ??
    getRecordString(value, "input") ??
    getRecordString(value, "output");
  if (directText) {
    return directText;
  }
  return extractCodexText(value.content);
}

function mergeCodexAndLocalMessages(
  codexMessages: ChatMessageRecord[],
  localMessages: ChatMessageRecord[],
): ChatMessageRecord[] {
  if (codexMessages.length === 0) {
    return localMessages;
  }
  const unmatchedCodexMessages = [...codexMessages];
  const merged = [
    ...codexMessages,
    ...localMessages.filter((message) => {
      if (message.role === "event" || message.role === "error") {
        return true;
      }
      const matchedCodexIndex = unmatchedCodexMessages.findIndex(
        (codexMessage) => shouldDeduplicateLocalMessage(codexMessage, message),
      );
      if (matchedCodexIndex === -1) {
        return true;
      }
      unmatchedCodexMessages.splice(matchedCodexIndex, 1);
      return false;
    }),
  ];
  return merged.sort((left, right) =>
    left.createdAt.localeCompare(right.createdAt),
  );
}

function shouldDeduplicateLocalMessage(
  codexMessage: ChatMessageRecord,
  localMessage: ChatMessageRecord,
): boolean {
  if (codexMessage.role !== localMessage.role) {
    return false;
  }
  if (codexMessage.itemId && localMessage.itemId) {
    return codexMessage.itemId === localMessage.itemId;
  }
  if (messageFingerprint(codexMessage) !== messageFingerprint(localMessage)) {
    return false;
  }
  return isCodexMessageAtOrAfterLocalMessage(codexMessage, localMessage);
}

function isCodexMessageAtOrAfterLocalMessage(
  codexMessage: ChatMessageRecord,
  localMessage: ChatMessageRecord,
): boolean {
  const codexTime = Date.parse(codexMessage.createdAt);
  const localTime = Date.parse(localMessage.createdAt);
  if (Number.isFinite(codexTime) && Number.isFinite(localTime)) {
    return codexTime >= localTime;
  }
  return codexMessage.createdAt >= localMessage.createdAt;
}

function messageFingerprint(message: ChatMessageRecord): string {
  return `${message.role}:${message.text}`;
}

function normalizeTurnContextItems(
  items: CodexTurnContextItem[] | undefined,
): CodexTurnContextItem[] {
  return (items ?? [])
    .map((item) => ({
      name: item.name.trim(),
      path: item.path.trim(),
    }))
    .filter((item) => item.name && item.path);
}

async function normalizeFileContextItems(
  items: CodexTurnContextItem[] | undefined,
  worktreePath: string,
): Promise<CodexTurnContextItem[]> {
  const normalized = normalizeTurnContextItems(items);
  if (normalized.length === 0) {
    return [];
  }

  const realWorktreePath = await realpath(worktreePath);
  return await Promise.all(
    normalized.map(async (item) => {
      const resolvedPath = resolve(item.path);
      if (!isPathInside(worktreePath, resolvedPath)) {
        throw new Error(
          `File context path must be within the chat worktree: ${item.path}`,
        );
      }

      let realFilePath: string;
      try {
        realFilePath = await realpath(resolvedPath);
      } catch {
        throw new Error(
          `File context path is not an existing file: ${item.path}`,
        );
      }
      if (!isPathInside(realWorktreePath, realFilePath)) {
        throw new Error(
          `File context path must resolve within the chat worktree: ${item.path}`,
        );
      }
      if (!(await stat(realFilePath)).isFile()) {
        throw new Error(`File context path is not a file: ${item.path}`);
      }

      return {
        name: item.name,
        path: resolvedPath,
      };
    }),
  );
}

function isPathInside(rootPath: string, candidatePath: string): boolean {
  const normalizedRoot = resolve(rootPath);
  const normalizedCandidate = resolve(candidatePath);
  const relativePath = relative(normalizedRoot, normalizedCandidate);
  return (
    relativePath === "" ||
    (relativePath !== ".." &&
      !relativePath.startsWith(`..${sep}`) &&
      !isAbsolute(relativePath))
  );
}

function normalizeModelRecords(value: unknown): CodexModelRecord[] {
  const source =
    getRecordArray(value, "data") ?? getRecordArray(value, "models");
  return (source ?? [])
    .map((model) => {
      const id =
        getRecordString(model, "id") ?? getRecordString(model, "model");
      if (!id) {
        return null;
      }
      const modelName = getRecordString(model, "model") ?? id;
      return {
        id,
        model: modelName,
        displayName: getRecordString(model, "displayName") ?? id,
        description: getRecordString(model, "description") ?? "",
        defaultReasoningEffort:
          getRecordString(model, "defaultReasoningEffort") ?? null,
        inputModalities: getStringArray(model.inputModalities),
        isDefault: model.isDefault === true,
        supportedReasoningEfforts: getReasoningEfforts(model),
      } satisfies CodexModelRecord;
    })
    .filter((model): model is CodexModelRecord => Boolean(model));
}

function normalizeSkillRecords(value: unknown): CodexSkillRecord[] {
  const entries =
    getRecordArray(value, "data") ?? getRecordArray(value, "skills");
  const skills = (entries ?? []).flatMap((entry) => {
    if (Array.isArray(entry.skills)) {
      return entry.skills.filter(isRecord);
    }
    return isRecord(entry) ? [entry] : [];
  });
  return skills
    .map((skill) => {
      const name = getRecordString(skill, "name");
      const path = getRecordString(skill, "path");
      if (!name || !path) {
        return null;
      }
      const skillInterface = isRecord(skill.interface) ? skill.interface : null;
      const shortDescription =
        getRecordString(skillInterface, "shortDescription") ??
        getRecordString(skill, "shortDescription") ??
        null;
      return {
        name,
        path,
        displayName: getRecordString(skillInterface, "displayName") ?? name,
        description: getRecordString(skill, "description") ?? "",
        shortDescription,
        enabled: skill.enabled !== false,
      } satisfies CodexSkillRecord;
    })
    .filter((skill): skill is CodexSkillRecord => Boolean(skill));
}

function normalizeFileRecords(value: unknown): CodexFileRecord[] {
  const files = getRecordArray(value, "files");
  return (files ?? [])
    .map((file) => {
      const matchType = getRecordString(file, "match_type");
      if (matchType && matchType !== "file") {
        return null;
      }
      const root = getRecordString(file, "root");
      const relativePath = getRecordString(file, "path");
      if (!root || !relativePath) {
        return null;
      }
      return {
        name:
          getRecordString(file, "file_name") ??
          relativePath.split("/").pop() ??
          relativePath,
        path: join(root, relativePath),
        relativePath,
        root,
        score:
          typeof file.score === "number" && Number.isFinite(file.score)
            ? file.score
            : 0,
      } satisfies CodexFileRecord;
    })
    .filter((file): file is CodexFileRecord => Boolean(file));
}

function getReasoningEfforts(model: Record<string, unknown>): string[] {
  const supported = model.supportedReasoningEfforts;
  if (!Array.isArray(supported)) {
    return [];
  }
  return supported
    .map((effort) =>
      typeof effort === "string"
        ? effort
        : getRecordString(effort, "reasoningEffort"),
    )
    .filter((effort): effort is string => Boolean(effort));
}

function getRecordArray(
  value: unknown,
  key: string,
): Array<Record<string, unknown>> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const candidate = value[key];
  if (!Array.isArray(candidate)) {
    return undefined;
  }
  return candidate.filter(isRecord);
}

function getRecordObject(
  value: unknown,
  key: string,
): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const candidate = value[key];
  return isRecord(candidate) ? candidate : undefined;
}

function getRecordString(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const candidate = value[key];
  return typeof candidate === "string" ? candidate : undefined;
}

function getStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function rollbackCreatedWorktree(
  gitRoot: string,
  worktreePath: string,
  branchName: string,
): Promise<void> {
  const errors: string[] = [];

  try {
    await removeWorktree(gitRoot, worktreePath, true);
  } catch (error) {
    errors.push(`worktree remove failed: ${toErrorMessage(error)}`);
  }

  const branchResult = await deleteBranch(gitRoot, branchName);
  if (!branchResult.ok) {
    errors.push(`branch delete failed: ${branchResult.error.message}`);
  }

  if (errors.length > 0) {
    throw new Error(errors.join("; "));
  }
}

let services: ServeServices | null = null;

export function getServeServices(): ServeServices {
  services ??= new ServeServices();
  return services;
}
