import { realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { getGitRoot } from "@phantompane/git";
import {
  deleteBranch,
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
  listCodexSessionsForWorktree,
  listCodexSessionsForWorktrees,
  mapCodexMethodToEvent,
  summarizeCodexEvent,
  type CodexMessage,
  type ImportedCodexSession,
} from "@phantompane/codex";
import {
  createRecordId,
  createTimestamp,
  ServeStateStore,
  touchProject,
} from "@phantompane/state";
import { EventHub } from "./event-hub";
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
  ServeState,
} from "./types";

export interface CreateChatInput {
  name?: string;
  base?: string;
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
}

type PendingTurnEvent =
  | { kind: "notification"; message: CodexMessage }
  | { kind: "serverRequest"; message: CodexMessage };
type ServerRequestId = number | string;

export class ServeServices {
  readonly eventHub: EventHub;
  readonly store: ServeStateStore;
  readonly codex: CodexBridge;
  private readonly codexHome?: string;
  private readonly loadedThreadIds = new Set<string>();
  private readonly approvalRequests = new Map<string, PendingApprovalRequest>();
  private readonly pendingTurnEvents = new Map<
    string,
    PendingTurnEventBuffer
  >();
  private readonly pendingChatTurns = new Set<string>();

  constructor(options: ServeServicesOptions = {}) {
    this.eventHub = options.eventHub ?? new EventHub();
    this.store = options.store ?? new ServeStateStore();
    this.codex = options.codex ?? new CodexBridge();
    this.codexHome = options.codexHome;
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
    const state = await this.store.load();
    return state.chats.filter((chat) => chat.projectId === projectId);
  }

  async listProjectWorktrees(
    projectId: string,
    options: { sync?: boolean } = {},
  ): Promise<ProjectWorktreeRecord[]> {
    const state = await this.store.load();
    if (options.sync === false) {
      return projectWorktreesFromPersistedChats(state, projectId);
    }

    const project = this.requireProject(state, projectId);
    let result;
    try {
      result = await listWorktrees(project.rootPath);
    } catch {
      return projectWorktreesFromPersistedChats(state, projectId);
    }
    if (!result.ok) {
      return projectWorktreesFromPersistedChats(state, projectId);
    }

    const { worktrees } = result.value;
    const timestamp = createTimestamp();
    const importedSessions = await listCodexSessionsForWorktrees({
      codexHome: this.codexHome,
      projectId,
      worktrees: worktrees.map((worktree) => ({
        branchName: worktree.branch,
        worktreeName: worktree.name,
        worktreePath: worktree.path,
      })),
    });

    if (
      shouldSyncProjectWorktreeChats({
        importedSessions,
        projectId,
        state,
        worktrees,
      })
    ) {
      await this.store.update((nextState) => {
        const existingChatsByPath = new Map(
          nextState.chats
            .filter((chat) => chat.projectId === projectId)
            .map((chat) => [chat.worktreePath, chat]),
        );
        const importedWorktreePaths = new Set(
          importedSessions.map((session) => session.chat.worktreePath),
        );
        const chatsToAdd = worktrees
          .filter(
            (worktree) =>
              !existingChatsByPath.has(worktree.path) &&
              !importedWorktreePaths.has(worktree.path),
          )
          .map((worktree) => ({
            id: createRecordId("chat"),
            projectId,
            worktreeName: worktree.name,
            worktreePath: worktree.path,
            branchName: worktree.branch,
            codexThreadId: null,
            title: worktree.name,
            status: "idle" as const,
            activeTurnId: null,
            createdAt: timestamp,
            updatedAt: timestamp,
          }));
        const importableSessions = importedSessions.filter(
          (session) =>
            !nextState.chats.some((chat) =>
              shouldPreferExistingChatOverImport(chat, session.chat),
            ),
        );
        const importableMessages = importableSessions.flatMap(
          (session) => session.messages,
        );

        if (chatsToAdd.length === 0 && importableSessions.length === 0) {
          return nextState;
        }
        const chatsToRemove = nextState.chats.filter(
          (chat) =>
            !shouldPreserveChatDuringImport(
              chat,
              projectId,
              importableSessions,
            ),
        );
        const chatIdsToRemove = new Set(chatsToRemove.map((chat) => chat.id));
        const selectedReplacement = findImportedReplacement(
          nextState.selectedChatId,
          chatsToRemove,
          importableSessions,
        );

        return {
          ...nextState,
          chats: [
            ...nextState.chats.filter((chat) => !chatIdsToRemove.has(chat.id)),
            ...importableSessions.map((session) => session.chat),
            ...chatsToAdd,
          ],
          messages: [
            ...nextState.messages.filter(
              (message) => !chatIdsToRemove.has(message.chatId),
            ),
            ...importableMessages,
          ],
          selectedChatId:
            nextState.selectedChatId &&
            chatIdsToRemove.has(nextState.selectedChatId)
              ? (selectedReplacement?.chat.id ?? nextState.selectedChatId)
              : nextState.selectedChatId,
        };
      });
    }

    const syncedState = await this.store.load();
    const syncedChatsByPath = new Map<string, ChatRecord[]>();
    for (const chat of syncedState.chats.filter(
      (candidate) => candidate.projectId === projectId,
    )) {
      syncedChatsByPath.set(chat.worktreePath, [
        ...(syncedChatsByPath.get(chat.worktreePath) ?? []),
        chat,
      ]);
    }

    return worktrees.map((worktree) => {
      const chat = latestChatForWorktree(
        syncedChatsByPath.get(worktree.path) ?? [],
      );
      return {
        name: worktree.name,
        path: worktree.path,
        pathToDisplay: worktree.pathToDisplay,
        branch: worktree.branch,
        isClean: worktree.isClean,
        chatId: chat?.id ?? null,
        chatStatus: chat?.status ?? null,
        chatTitle: chat?.title ?? worktree.name,
      };
    });
  }

  async createChat(
    projectId: string,
    input: CreateChatInput,
  ): Promise<ChatRecord> {
    const state = await this.store.load();
    const project = this.requireProject(state, projectId);
    const createResult = await runCreateWorktree({
      gitRoot: project.rootPath,
      name: input.name,
      base: input.base,
    });

    if (!createResult.ok) {
      throw createResult.error;
    }

    let importedSessions: ImportedCodexSession[];
    try {
      importedSessions = await listCodexSessionsForWorktree({
        branchName: createResult.value.name,
        codexHome: this.codexHome,
        projectId,
        worktreeName: createResult.value.name,
        worktreePath: createResult.value.path,
      });
    } catch (error) {
      try {
        await rollbackCreatedWorktree(
          project.rootPath,
          createResult.value.path,
          createResult.value.name,
        );
      } catch (rollbackError) {
        throw new Error(
          `Failed to import Codex history: ${toErrorMessage(error)}. Rollback failed: ${toErrorMessage(rollbackError)}`,
        );
      }
      throw error instanceof Error ? error : new Error(String(error));
    }
    const latestImportedSession = importedSessions[0];
    if (latestImportedSession) {
      let selectedImportedChat: ChatRecord = latestImportedSession.chat;
      await this.store.update((nextState) => {
        selectedImportedChat =
          findExistingChatForImportedSession(
            nextState.chats,
            projectId,
            latestImportedSession.chat,
          ) ?? latestImportedSession.chat;
        return {
          ...mergeImportedSessionsForProject(
            nextState,
            projectId,
            importedSessions,
          ),
          selectedProjectId: projectId,
          selectedChatId: selectedImportedChat.id,
        };
      });

      this.eventHub.emit("chat.created", selectedImportedChat, {
        chatId: selectedImportedChat.id,
      });
      return selectedImportedChat;
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

  async getChat(chatId: string): Promise<ChatRecord> {
    const state = await this.store.load();
    return this.requireChat(state, chatId);
  }

  async getMessages(chatId: string): Promise<ChatMessageRecord[]> {
    const state = await this.store.load();
    this.requireChat(state, chatId);
    return state.messages.filter((message) => message.chatId === chatId);
  }

  async sendMessage(
    chatId: string,
    input: SendMessageInput,
  ): Promise<ChatRecord> {
    return this.submitMessage(chatId, input, { requireActiveTurn: false });
  }

  async steerMessage(
    chatId: string,
    input: SendMessageInput,
  ): Promise<ChatRecord> {
    return this.submitMessage(chatId, input, { requireActiveTurn: true });
  }

  private async submitMessage(
    chatId: string,
    input: SendMessageInput,
    options: { requireActiveTurn: boolean },
  ): Promise<ChatRecord> {
    const text = input.text.trim();
    if (!text) {
      throw new Error("Message text cannot be empty");
    }

    const state = await this.store.load();
    const chat = this.requireChat(state, chatId);
    if (chat.status === "waitingForApproval") {
      throw new Error("Chat is waiting for approval");
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
    const turnOptions = await this.createCodexTurnOptions(input, chat);
    if (!isSteeringActiveTurn) {
      if (this.pendingChatTurns.has(chatId)) {
        throw new Error("Chat already has an active Codex turn");
      }
      this.pendingChatTurns.add(chatId);
    }

    const userMessage = createMessage(chat.id, "user", text);
    let nextStatus: ChatStatus | null = null;
    let nextActiveTurnId: string | null | undefined;
    let pendingTurnThreadId: string | null = null;
    let userMessageStored = false;

    try {
      await this.store.update((nextState) => ({
        ...nextState,
        messages: [...nextState.messages, userMessage],
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
            throw new Error("Chat already has an active Codex turn");
          }
          pendingTurnThreadId = threadId;
          this.pendingTurnEvents.set(threadId, {
            chatId,
            discard: false,
            events: [],
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
            nextStatus = "running";
            nextActiveTurnId = turnId;
          }
        }
      } catch (error) {
        if (pendingTurnThreadId) {
          this.discardPendingTurnEvents(pendingTurnThreadId);
        }
        await this.store.update((nextState) => ({
          ...nextState,
          messages: userMessageStored
            ? nextState.messages.filter(
                (message) =>
                  message.id !== userMessage.id &&
                  (isSteeringActiveTurn ||
                    message.chatId !== chatId ||
                    previousMessageIds.has(message.id)),
              )
            : nextState.messages,
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
        }));
        this.eventHub.emit(
          "agent.error",
          { message: toErrorMessage(error) },
          { chatId },
        );
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
      }));
      this.eventHub.emit("chat.message.created", userMessage, { chatId });
      if (pendingTurnThreadId) {
        await this.flushPendingTurnEvents(pendingTurnThreadId);
      }

      return await this.getChat(chatId);
    } finally {
      if (!isSteeringActiveTurn) {
        this.pendingChatTurns.delete(chatId);
      }
    }
  }

  async interruptChat(chatId: string): Promise<void> {
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

  private async flushPendingTurnEvents(threadId: string): Promise<void> {
    const pendingTurnEvents = this.pendingTurnEvents.get(threadId);
    if (!pendingTurnEvents || pendingTurnEvents.discard) {
      this.pendingTurnEvents.delete(threadId);
      return;
    }
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

function latestChatForWorktree(chats: ChatRecord[]): ChatRecord | null {
  const sortedChats = [...chats].sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt),
  );
  return (
    sortedChats.find((chat) => chat.codexThreadId) ?? sortedChats[0] ?? null
  );
}

function projectWorktreesFromPersistedChats(
  state: ServeState,
  projectId: string,
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

  return Array.from(chatsByPath.values())
    .map((chats) => latestChatForWorktree(chats))
    .filter((chat): chat is ChatRecord => Boolean(chat))
    .sort((left, right) => left.worktreeName.localeCompare(right.worktreeName))
    .map((chat) => ({
      name: chat.worktreeName,
      path: chat.worktreePath,
      pathToDisplay: chat.worktreePath,
      branch: chat.branchName,
      isClean: true,
      chatId: chat.id,
      chatStatus: chat.status,
      chatTitle: chat.title,
    }));
}

function shouldSyncProjectWorktreeChats({
  importedSessions,
  projectId,
  state,
  worktrees,
}: {
  importedSessions: ImportedCodexSession[];
  projectId: string;
  state: ServeState;
  worktrees: Array<{ path: string }>;
}): boolean {
  const existingChatsByPath = new Map(
    state.chats
      .filter((chat) => chat.projectId === projectId)
      .map((chat) => [chat.worktreePath, chat]),
  );
  const importedWorktreePaths = new Set(
    importedSessions.map((session) => session.chat.worktreePath),
  );
  return (
    worktrees.some(
      (worktree) =>
        !existingChatsByPath.has(worktree.path) &&
        !importedWorktreePaths.has(worktree.path),
    ) ||
    importedSessions.some(
      (session) =>
        !state.chats.some((chat) =>
          shouldPreferExistingChatOverImport(chat, session.chat),
        ),
    )
  );
}

function shouldPreferExistingChatOverImport(
  chat: ChatRecord,
  importedChat: ChatRecord,
): boolean {
  if (chat.projectId !== importedChat.projectId) {
    return false;
  }
  if (
    chat.codexThreadId !== null &&
    chat.codexThreadId === importedChat.codexThreadId
  ) {
    return true;
  }
  if (chat.codexThreadId !== null) {
    return false;
  }
  return (
    Boolean(
      chat.activeTurnId ||
      chat.status === "running" ||
      chat.status === "waitingForApproval",
    ) && chat.worktreePath === importedChat.worktreePath
  );
}

function findExistingChatForImportedSession(
  chats: ChatRecord[],
  projectId: string,
  importedChat: ChatRecord,
): ChatRecord | null {
  return (
    chats.find(
      (chat) =>
        chat.projectId === projectId &&
        (chat.id === importedChat.id ||
          shouldPreferExistingChatOverImport(chat, importedChat)),
    ) ?? null
  );
}

function mergeImportedSessionsForProject(
  state: ServeState,
  projectId: string,
  importedSessions: ImportedCodexSession[],
): ServeState {
  const importableSessions = importedSessions.filter(
    (session) =>
      !state.chats.some((chat) =>
        shouldPreferExistingChatOverImport(chat, session.chat),
      ),
  );
  const chatsToRemove = state.chats.filter(
    (chat) =>
      !shouldPreserveChatDuringImport(chat, projectId, importableSessions),
  );
  const chatIdsToRemove = new Set(chatsToRemove.map((chat) => chat.id));

  return {
    ...state,
    chats: [
      ...state.chats.filter((chat) => !chatIdsToRemove.has(chat.id)),
      ...importableSessions.map((session) => session.chat),
    ],
    messages: [
      ...state.messages.filter(
        (message) => !chatIdsToRemove.has(message.chatId),
      ),
      ...importableSessions.flatMap((session) => session.messages),
    ],
  };
}

function shouldPreserveChatDuringImport(
  chat: ChatRecord,
  projectId: string,
  importedSessions: ImportedCodexSession[],
): boolean {
  if (chat.projectId !== projectId) {
    return true;
  }
  if (
    chat.activeTurnId ||
    chat.status === "running" ||
    chat.status === "waitingForApproval"
  ) {
    return true;
  }
  return !importedSessions.some((session) => {
    const importedChat = session.chat;
    return (
      chat.id === importedChat.id ||
      (chat.codexThreadId !== null &&
        chat.codexThreadId === importedChat.codexThreadId) ||
      (chat.codexThreadId === null &&
        chat.worktreePath === importedChat.worktreePath)
    );
  });
}

function findImportedReplacement(
  selectedChatId: string | null,
  removedChats: ChatRecord[],
  importedSessions: ImportedCodexSession[],
): ImportedCodexSession | null {
  const removedChat = removedChats.find((chat) => chat.id === selectedChatId);
  if (!removedChat) {
    return null;
  }
  return (
    importedSessions.find((session) => {
      const importedChat = session.chat;
      return (
        removedChat.codexThreadId === importedChat.codexThreadId ||
        removedChat.worktreePath === importedChat.worktreePath
      );
    }) ?? null
  );
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
