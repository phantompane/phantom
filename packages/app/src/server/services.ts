import { realpath } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";
import { getGitRoot } from "@phantompane/git";
import {
  deleteBranch,
  removeWorktree,
  runCreateWorktree,
} from "@phantompane/core";
import { CodexBridge, type CodexMessage } from "./codex-bridge";
import { EventHub } from "./event-hub";
import {
  createRecordId,
  createTimestamp,
  ServeStateStore,
  touchProject,
} from "./storage";
import type {
  ChatMessageRecord,
  ChatRecord,
  ChatStatus,
  ProjectRecord,
  ServeState,
} from "./types";

export interface CreateChatInput {
  name?: string;
  base?: string;
}

export interface SendMessageInput {
  text: string;
}

export interface ApprovalInput {
  decision: "accept" | "acceptForSession" | "decline" | "cancel";
}

export interface ServeServicesOptions {
  eventHub?: EventHub;
  store?: ServeStateStore;
  codex?: CodexBridge;
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
    this.codex.onNotification((message) => {
      void this.handleCodexNotification(message);
    });
    this.codex.onServerRequest((message) => {
      void this.handleCodexServerRequest(message);
    });
    this.codex.onProcessExit(() => {
      this.loadedThreadIds.clear();
    });
  }

  async getHealth() {
    const state = await this.store.load();
    return {
      ok: true,
      projectCount: state.projects.length,
      chatCount: state.chats.length,
      codexBin: process.env.PHANTOM_SERVE_CODEX_BIN ?? "codex",
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
          await this.codex.steerTurn(threadId, activeTurnId, text);
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
          const turnResult = await this.codex.startTurn(
            threadId,
            text,
            chat.worktreePath,
          );
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

  async listModels(): Promise<unknown> {
    return this.codex.listModels();
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

function getParamObject(params: unknown): Record<string, unknown> | null {
  return params && typeof params === "object" && !Array.isArray(params)
    ? (params as Record<string, unknown>)
    : null;
}

function extractThreadId(result: unknown): string {
  const object = getParamObject(result);
  const thread = getParamObject(object?.thread);
  const threadId = thread?.id;
  if (typeof threadId !== "string") {
    throw new Error("Codex response did not include a thread id");
  }
  return threadId;
}

function extractTurnId(result: unknown): string | null {
  const object = getParamObject(result);
  const turn = getParamObject(object?.turn);
  const turnId = turn?.id;
  return typeof turnId === "string" ? turnId : null;
}

function extractThreadIdFromParams(params: unknown): string | null {
  const object = getParamObject(params);
  if (!object) {
    return null;
  }
  if (typeof object.threadId === "string") {
    return object.threadId;
  }
  const thread = getParamObject(object.thread);
  return typeof thread?.id === "string" ? thread.id : null;
}

function extractTurnIdFromParams(params: unknown): string | null {
  const object = getParamObject(params);
  if (!object) {
    return null;
  }
  if (typeof object.turnId === "string") {
    return object.turnId;
  }
  const turn = getParamObject(object.turn);
  return typeof turn?.id === "string" ? turn.id : null;
}

function getServerRequestId(requestId: unknown): ServerRequestId | null {
  if (typeof requestId === "string" || typeof requestId === "number") {
    return requestId;
  }
  return null;
}

function extractServerRequestIdFromParams(
  params: unknown,
): ServerRequestId | null {
  const object = getParamObject(params);
  if (!object) {
    return null;
  }
  return (
    getServerRequestId(object.requestId) ??
    getServerRequestId(object.serverRequestId) ??
    getServerRequestId(object.id)
  );
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

function mapCodexMethodToEvent(method: string): string {
  if (method === "thread/started") {
    return "agent.thread.started";
  }
  if (method === "turn/started") {
    return "agent.turn.started";
  }
  if (method === "turn/completed") {
    return "agent.turn.completed";
  }
  if (method.startsWith("item/") && method.endsWith("/requestApproval")) {
    return "agent.approval.requested";
  }
  if (method.startsWith("item/")) {
    return method.includes("delta") ? "agent.item.delta" : "agent.item.updated";
  }
  if (method === "serverRequest/resolved") {
    return "agent.approval.resolved";
  }
  if (method === "account/updated") {
    return "auth.updated";
  }
  if (method === "error") {
    return "agent.error";
  }
  return "agent.event";
}

function summarizeCodexEvent(method: string, params: unknown): string {
  const object = getParamObject(params);
  if (method === "item/started" || method === "item/completed") {
    const item = getParamObject(object?.item);
    const type = typeof item?.type === "string" ? item.type : "item";
    return `${method}: ${type}`;
  }
  if (method === "turn/completed") {
    const turn = getParamObject(object?.turn);
    const status = typeof turn?.status === "string" ? turn.status : "unknown";
    return `turn completed: ${status}`;
  }
  if (method === "error") {
    const error = getParamObject(object?.error);
    return typeof error?.message === "string" ? error.message : "Codex error";
  }
  return method;
}

let services: ServeServices | null = null;

export function getServeServices(): ServeServices {
  services ??= new ServeServices();
  return services;
}
