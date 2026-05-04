import { realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  branchExists,
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
  githubCheckout,
  listWorktrees,
  listGitHubCheckoutTargets,
  removeWorktree,
  runCreateWorktree,
  WorktreeAlreadyExistsError,
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
  GitHubCheckoutTargetsResult,
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
  githubTargetNumber?: number;
  initialMessage?: string;
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

export interface DeletePendingMessageResult {
  message: ChatMessageRecord;
  messageIndex: number;
  queuedMessage: QueuedMessageRecord;
  queuedMessageIndex: number;
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

const worktreeNameInferenceModel = "gpt-5.4-mini";

function createWorktreeNameInferencePrompt(message: string): string {
  return [
    "Infer a concise Git worktree and branch name from this user request.",
    "Return exactly one name and nothing else.",
    "Use lowercase ASCII letters, numbers, hyphens, dots, underscores, and optional slashes.",
    "Prefer 2-5 words. Use a prefix like feat/, fix/, docs/, refactor/, or chore/ only when it is clearly appropriate.",
    "Do not include quotes, Markdown, explanations, or code fences.",
    "",
    "User request:",
    message,
  ].join("\n");
}

function normalizeInferredWorktreeName(value: string): string | undefined {
  let name = value
    .trim()
    .split(/\r?\n/)
    .find((line) => line.trim())
    ?.trim();
  if (!name) {
    return undefined;
  }

  name = name
    .replace(/^["'`]+|["'`]+$/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9._/-]+/g, "-")
    .replace(/\/+/g, "/")
    .replace(/-+/g, "-")
    .replace(/\.{2,}/g, ".")
    .replace(/^[./_-]+|[./_-]+$/g, "");

  const segments = name
    .split("/")
    .map((segment) => segment.replace(/^[._-]+|[._-]+$/g, ""))
    .filter(Boolean);
  name = segments.join("/");

  if (!name) {
    return undefined;
  }

  const candidate =
    name.length > 72 ? name.slice(0, 72).replace(/[./_-]+$/g, "") : name;
  return isValidInferredWorktreeName(candidate) ? candidate : undefined;
}

function isValidInferredWorktreeName(name: string): boolean {
  if (
    !name ||
    name === "@" ||
    name.includes("..") ||
    name.includes("@{") ||
    name.includes("//") ||
    name.endsWith(".") ||
    /[\s~^:?*[\]\\]/.test(name) ||
    [...name].some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
  ) {
    return false;
  }

  return name.split("/").every((segment) => {
    return (
      segment.length > 0 &&
      !segment.startsWith(".") &&
      !segment.endsWith(".lock")
    );
  });
}

type PendingTurnEvent =
  | { kind: "notification"; message: CodexMessage }
  | { kind: "serverRequest"; message: CodexMessage };

type CodexTurnItemSource = "input" | "item";
type InternalChatMessageRecord = ChatMessageRecord & {
  codexOrder?: number;
  codexItemSource?: CodexTurnItemSource;
  mergeSortBucket?: number;
  mergeSortIndex?: number;
};
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

  async listProjectGitHubCheckoutTargets(
    projectId: string,
  ): Promise<GitHubCheckoutTargetsResult> {
    await this.resetStaleTransientChatState();
    const state = await this.store.load();
    const project = this.requireProject(state, projectId);

    try {
      const targets = await listGitHubCheckoutTargets({
        cwd: project.rootPath,
      });
      return {
        available: true,
        targets,
      };
    } catch {
      return {
        available: false,
        targets: [],
      };
    }
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

  private async createExistingWorktreeChat(
    projectId: string,
    project: ProjectRecord,
    input: {
      worktreeName?: string;
      worktreePath: string;
    },
  ): Promise<ChatRecord> {
    const targetWorktreePath = input.worktreePath.trim();
    const targetWorktreeName = input.worktreeName?.trim();
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
    if (input.githubTargetNumber !== undefined && hasExistingWorktreeInput) {
      throw new Error(
        "GitHub checkout target cannot be combined with worktree input",
      );
    }
    if (input.githubTargetNumber !== undefined) {
      const result = await githubCheckout({
        number: String(input.githubTargetNumber),
        base: input.base,
        cwd: project.rootPath,
      });
      if (!result.ok) {
        throw result.error;
      }
      try {
        return await this.createExistingWorktreeChat(projectId, project, {
          worktreeName: result.value.worktree,
          worktreePath: result.value.path,
        });
      } catch (error) {
        if (!result.value.alreadyExists) {
          try {
            await rollbackCreatedWorktree(
              project.rootPath,
              result.value.path,
              result.value.worktree,
              {
                deleteBranch: result.value.createdBranch === true,
              },
            );
          } catch (rollbackError) {
            throw new Error(
              `Failed to start Codex thread: ${toErrorMessage(error)}. Rollback failed: ${toErrorMessage(rollbackError)}`,
            );
          }
        }
        throw error instanceof Error ? error : new Error(String(error));
      }
    }
    if (hasExistingWorktreeInput) {
      return this.createExistingWorktreeChat(projectId, project, {
        worktreeName: targetWorktreeName,
        worktreePath: targetWorktreePath ?? "",
      });
    }

    const explicitName = input.name?.trim();
    let inferredName =
      explicitName ||
      (input.initialMessage?.trim()
        ? await this.inferWorktreeName(project.rootPath, input.initialMessage)
        : undefined);
    if (!explicitName && inferredName) {
      const inferredBranchExists = await branchExists(
        project.rootPath,
        inferredName,
      );
      if (inferredBranchExists.ok && inferredBranchExists.value) {
        inferredName = undefined;
      }
    }
    let createResult = await runCreateWorktree({
      gitRoot: project.rootPath,
      name: inferredName,
      base: input.base,
    });
    if (
      !createResult.ok &&
      !explicitName &&
      inferredName &&
      createResult.error instanceof WorktreeAlreadyExistsError
    ) {
      createResult = await runCreateWorktree({
        gitRoot: project.rootPath,
        base: input.base,
      });
    }

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

  private async inferWorktreeName(
    projectRoot: string,
    message: string,
  ): Promise<string | undefined> {
    try {
      const result = await this.codex.exec(
        createWorktreeNameInferencePrompt(message),
        {
          cwd: projectRoot,
          model: worktreeNameInferenceModel,
        },
      );
      return normalizeInferredWorktreeName(result);
    } catch {
      return undefined;
    }
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
      return localMessagesWithoutStaleSteeredState(chat, localMessages);
    }

    try {
      const result = await this.codex.readThread(chat.codexThreadId, {
        includeTurns: true,
      });
      const codexMessages = normalizeCodexThreadMessages(result, chat.id);
      if (codexMessages.length === 0) {
        return localMessagesWithoutStaleSteeredState(chat, localMessages);
      }
      return mergeCodexAndLocalMessages(codexMessages, localMessages);
    } catch {
      return localMessagesWithoutStaleSteeredState(chat, localMessages);
    }
  }

  async sendMessage(
    chatId: string,
    input: SendMessageInput,
  ): Promise<ChatRecord> {
    await this.resetStaleTransientChatState();
    const state = await this.store.load();
    const chat = this.requireChat(state, chatId);
    const isDrainingQueuedMessage =
      this.drainingQueuedMessageChatIds.has(chatId);
    if (
      !isChatInActiveTurn(chat) &&
      (isDrainingQueuedMessage ||
        (!this.pendingChatTurns.has(chatId) &&
          state.queuedMessages.some((message) => message.chatId === chatId)))
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
    let shouldRequestPendingDrain = false;
    let queuedUserMessage: ChatMessageRecord | null = null;
    await this.store.update((nextState) => {
      const chat = this.requireChat(nextState, chatId);
      this.assertChatWorktreeIsAvailable(chat);
      const isDrainingQueuedMessage =
        this.drainingQueuedMessageChatIds.has(chatId);
      const hasQueuedMessages = nextState.queuedMessages.some(
        (message) => message.chatId === chatId,
      );
      const isQueueBlocked =
        isChatInActiveTurn(chat) ||
        this.pendingChatTurns.has(chatId) ||
        isDrainingQueuedMessage;
      if (!isQueueBlocked && !hasQueuedMessages) {
        shouldSubmitImmediately = true;
        return nextState;
      }
      shouldDrainQueuedMessages = !isQueueBlocked;
      shouldRequestPendingDrain = isDrainingQueuedMessage;

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
    if (shouldRequestPendingDrain) {
      this.pendingQueuedMessageDrainChatIds.add(chatId);
    }
    if (shouldDrainQueuedMessages) {
      await this.drainQueuedMessagesAndReport(chatId);
    }
    return await this.getChat(chatId);
  }

  async deletePendingMessage(
    chatId: string,
    messageId: string,
  ): Promise<DeletePendingMessageResult> {
    await this.resetStaleTransientChatState();
    let deletedMessage: ChatMessageRecord | null = null;
    let deletedMessageIndex = -1;
    let deletedQueuedMessage: QueuedMessageRecord | null = null;
    let deletedQueuedMessageIndex = -1;

    await this.store.update((nextState) => {
      const chat = this.requireChat(nextState, chatId);
      this.assertChatWorktreeIsAvailable(chat);
      const messageIndex = nextState.messages.findIndex(
        (candidate) =>
          candidate.id === messageId &&
          candidate.chatId === chatId &&
          candidate.role === "user",
      );
      const message =
        messageIndex === -1 ? undefined : nextState.messages[messageIndex];
      if (!message) {
        throw new Error("Pending message was not found");
      }
      if (message.eventType !== "chat.message.queued") {
        throw new Error("Message is not pending");
      }
      const queuedMessageIndex = nextState.queuedMessages.findIndex(
        (candidate) =>
          candidate.chatId === chatId && candidate.messageId === message.id,
      );
      const queuedMessage =
        queuedMessageIndex === -1
          ? undefined
          : nextState.queuedMessages[queuedMessageIndex];
      if (!queuedMessage) {
        throw new Error("Queued message is already being sent");
      }

      deletedMessage = message;
      deletedMessageIndex = messageIndex;
      deletedQueuedMessage = queuedMessage;
      deletedQueuedMessageIndex = queuedMessageIndex;
      return {
        ...nextState,
        messages: nextState.messages.filter(
          (candidate) => candidate.id !== message.id,
        ),
        queuedMessages: nextState.queuedMessages.filter(
          (queuedMessage) =>
            queuedMessage.chatId !== chatId ||
            queuedMessage.messageId !== message.id,
        ),
      };
    });

    if (!deletedMessage) {
      throw new Error("Pending message was not found");
    }
    if (!deletedQueuedMessage) {
      throw new Error("Queued message was not found");
    }
    this.eventHub.emit("chat.message.deleted", deletedMessage, { chatId });
    return {
      message: deletedMessage,
      messageIndex: deletedMessageIndex,
      queuedMessage: deletedQueuedMessage,
      queuedMessageIndex: deletedQueuedMessageIndex,
    };
  }

  async restorePendingMessage(
    chatId: string,
    input: DeletePendingMessageResult,
  ): Promise<DeletePendingMessageResult> {
    await this.resetStaleTransientChatState();
    const { message, queuedMessage } = input;
    let shouldDrainQueuedMessages = false;
    let shouldRequestPendingDrain = false;
    if (
      message.chatId !== chatId ||
      queuedMessage.chatId !== chatId ||
      queuedMessage.messageId !== message.id ||
      message.role !== "user" ||
      message.eventType !== "chat.message.queued" ||
      !Number.isInteger(input.messageIndex) ||
      input.messageIndex < 0 ||
      !Number.isInteger(input.queuedMessageIndex) ||
      input.queuedMessageIndex < 0
    ) {
      throw new Error("Pending message restore payload is invalid");
    }

    await this.store.update((nextState) => {
      const chat = this.requireChat(nextState, chatId);
      this.assertChatWorktreeIsAvailable(chat);
      const isDrainingQueuedMessage =
        this.drainingQueuedMessageChatIds.has(chatId);
      const isQueueBlocked =
        isChatInActiveTurn(chat) ||
        this.pendingChatTurns.has(chatId) ||
        isDrainingQueuedMessage;
      shouldDrainQueuedMessages = !isQueueBlocked;
      shouldRequestPendingDrain = isDrainingQueuedMessage;
      if (
        nextState.messages.some((candidate) => candidate.id === message.id) ||
        nextState.queuedMessages.some(
          (candidate) =>
            candidate.id === queuedMessage.id ||
            candidate.messageId === queuedMessage.messageId,
        )
      ) {
        throw new Error("Pending message was already restored");
      }
      return {
        ...nextState,
        messages: insertRecordAtIndex(
          nextState.messages,
          message,
          input.messageIndex,
        ),
        queuedMessages: insertRecordAtIndex(
          nextState.queuedMessages,
          queuedMessage,
          input.queuedMessageIndex,
        ),
      };
    });

    this.eventHub.emit("chat.message.created", message, { chatId });
    if (shouldRequestPendingDrain) {
      this.pendingQueuedMessageDrainChatIds.add(chatId);
    }
    if (shouldDrainQueuedMessages) {
      await this.drainQueuedMessagesAndReport(chatId);
    }
    return input;
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
      : createMessage(
          chat.id,
          "user",
          text,
          isSteeringActiveTurn ? "chat.message.steered" : undefined,
          isSteeringActiveTurn ? (chat.activeTurnId ?? undefined) : undefined,
        );
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
    const chat = await this.findChatByCodexParams(message.params);
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
    const claimedQueuedMessageRef: { current: QueuedMessageRecord | null } = {
      current: null,
    };
    let queuedUserMessageMissing = false;
    await this.store.update((nextState) => {
      const nextQueuedMessage = nextState.queuedMessages.find(
        (message) =>
          message.id === queuedMessage.id && message.chatId === chatId,
      );
      if (!nextQueuedMessage) {
        return nextState;
      }
      const nextQueuedUserMessage = nextState.messages.find(
        (message) =>
          message.id === nextQueuedMessage.messageId &&
          message.chatId === chatId &&
          message.role === "user",
      );
      if (!nextQueuedUserMessage) {
        queuedUserMessageMissing = true;
        return {
          ...nextState,
          queuedMessages: nextState.queuedMessages.filter(
            (message) => message.id !== nextQueuedMessage.id,
          ),
        };
      }

      claimedQueuedMessageRef.current = nextQueuedMessage;
      return {
        ...nextState,
        messages: nextState.messages.map((message) =>
          message.id === nextQueuedUserMessage.id
            ? { ...message, eventType: undefined }
            : message,
        ),
        queuedMessages: nextState.queuedMessages.filter(
          (message) => message.id !== nextQueuedMessage.id,
        ),
      };
    });
    if (queuedUserMessageMissing) {
      await this.drainQueuedMessages(chatId);
      throw new Error("Queued message was not found");
    }
    const claimedQueuedMessage = claimedQueuedMessageRef.current;
    if (!claimedQueuedMessage) {
      await this.drainQueuedMessages(chatId);
      return;
    }

    await this.submitMessage(
      chatId,
      queuedMessageToSendInput(claimedQueuedMessage),
      {
        existingUserMessageId: claimedQueuedMessage.messageId,
        requireActiveTurn: false,
      },
    );
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
          const state = await this.store.load();
          if (
            state.queuedMessages.some((message) => message.chatId === chatId)
          ) {
            this.pendingQueuedMessageDrainChatIds.add(chatId);
          }
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

  private async findChatByCodexParams(
    params: unknown,
  ): Promise<ChatRecord | null> {
    const threadId = extractThreadIdFromParams(params);
    if (threadId) {
      const chat = await this.findChatByThreadId(threadId);
      if (chat) {
        return chat;
      }
    }

    const turnId = extractTurnIdFromParams(params);
    if (!turnId) {
      return null;
    }
    const state = await this.store.load();
    return state.chats.find((chat) => chat.activeTurnId === turnId) ?? null;
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

    if (method === "turn/plan/updated") {
      const eventData = normalizePlanEventData(params);
      await this.upsertRichEventMessage({
        chatId,
        eventData,
        eventType: method,
        itemId: extractTurnIdFromParams(params) ?? method,
        text: summarizeCodexEvent(method, params),
      });
      return;
    }

    if (method === "item/plan/delta") {
      const delta = getRecordString(params, "delta") ?? "";
      if (!delta) {
        return;
      }
      await this.appendRichEventMessage({
        chatId,
        delta,
        eventData: { kind: "planDelta" },
        eventType: method,
        itemId: getRecordString(params, "itemId") ?? method,
      });
      return;
    }

    if (method === "turn/diff/updated") {
      const eventData = normalizeDiffEventData(params);
      await this.upsertRichEventMessage({
        chatId,
        eventData,
        eventType: method,
        itemId: extractTurnIdFromParams(params) ?? method,
        text: summarizeDiffEvent(eventData),
      });
      return;
    }

    if (
      method === "item/commandExecution/outputDelta" ||
      method === "command/exec/outputDelta"
    ) {
      const delta = extractCommandOutputDelta(method, params);
      if (!delta) {
        return;
      }
      await this.appendRichEventMessage({
        chatId,
        delta,
        eventData: createCommandOutputEventData(method, params),
        eventType: method,
        itemId: getCommandOutputItemId(method, params),
      });
      return;
    }

    if (method === "item/fileChange/patchUpdated") {
      const eventData = normalizeFilePatchEventData(params);
      await this.upsertRichEventMessage({
        chatId,
        eventData,
        eventType: method,
        itemId: getRecordString(params, "itemId") ?? method,
        text: summarizeFilePatchEvent(eventData),
      });
      return;
    }

    if (method === "item/fileChange/outputDelta") {
      const delta = getRecordString(params, "delta") ?? "";
      if (!delta) {
        return;
      }
      await this.appendRichEventMessage({
        chatId,
        delta,
        eventData: { kind: "fileChangeOutput" },
        eventType: method,
        itemId: getRecordString(params, "itemId") ?? method,
      });
      return;
    }

    if (method.startsWith("item/reasoning/")) {
      const delta = getRecordString(params, "delta") ?? "";
      if (!delta) {
        return;
      }
      const eventData = createReasoningEventData(method, params);
      await this.appendRichEventMessage({
        chatId,
        delta,
        eventData,
        eventType: method,
        itemId: getReasoningEventItemId(method, params),
      });
      return;
    }

    if (
      method === "warning" ||
      method === "guardianWarning" ||
      method === "configWarning"
    ) {
      await this.addRichEventMessage({
        chatId,
        eventData: params,
        eventType: method,
        text: summarizeCodexEvent(method, params),
      });
      return;
    }

    if (method === "item/started" || method === "item/completed") {
      const item = getRecordObject(params, "item");
      const itemId = getRecordString(item, "id");
      const itemType = getRecordString(item, "type");
      if (item && itemId && itemType === "commandExecution") {
        await this.mergeRichEventMessage({
          chatId,
          eventData: createCommandLifecycleEventData(method, item),
          eventType: "item/commandExecution/outputDelta",
          itemId,
          text: getRecordString(item, "aggregatedOutput"),
        });
        return;
      }
      if (item && itemId && itemType === "fileChange") {
        const eventData = normalizeFilePatchEventData(item);
        await this.upsertRichEventMessage({
          chatId,
          eventData: {
            ...eventData,
            lifecycleEventType: method,
            status: getRecordString(item, "status") ?? null,
          },
          eventType: "item/fileChange/patchUpdated",
          itemId,
          text: summarizeFilePatchEvent(eventData),
        });
        return;
      }
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

  private async addRichEventMessage({
    chatId,
    eventData,
    eventType,
    itemId,
    text,
  }: {
    chatId: string;
    eventData: unknown;
    eventType: string;
    itemId?: string;
    text: string;
  }): Promise<void> {
    await this.store.update((state) => ({
      ...state,
      messages: [
        ...state.messages,
        createMessage(chatId, "event", text, eventType, itemId, eventData),
      ],
    }));
  }

  private async upsertRichEventMessage({
    chatId,
    eventData,
    eventType,
    itemId,
    text,
  }: {
    chatId: string;
    eventData: unknown;
    eventType: string;
    itemId: string;
    text: string;
  }): Promise<void> {
    await this.store.update((state) => {
      const existingMessage = state.messages.find(
        (message) =>
          message.chatId === chatId &&
          message.role === "event" &&
          message.eventType === eventType &&
          message.itemId === itemId,
      );
      if (!existingMessage) {
        return {
          ...state,
          messages: [
            ...state.messages,
            createMessage(chatId, "event", text, eventType, itemId, eventData),
          ],
        };
      }
      return {
        ...state,
        messages: state.messages.map((message) =>
          message.id === existingMessage.id
            ? { ...message, eventData, text }
            : message,
        ),
      };
    });
  }

  private async appendRichEventMessage({
    chatId,
    delta,
    eventData,
    eventType,
    itemId,
  }: {
    chatId: string;
    delta: string;
    eventData: Record<string, unknown>;
    eventType: string;
    itemId: string;
  }): Promise<void> {
    await this.store.update((state) => {
      const existingMessage = state.messages.find(
        (message) =>
          message.chatId === chatId &&
          message.role === "event" &&
          message.eventType === eventType &&
          message.itemId === itemId,
      );
      const text = `${existingMessage?.text ?? ""}${delta}`;
      const existingEventData = isRecord(existingMessage?.eventData)
        ? existingMessage.eventData
        : {};
      const nextEventData = { ...existingEventData, ...eventData, text };
      if (!existingMessage) {
        return {
          ...state,
          messages: [
            ...state.messages,
            createMessage(
              chatId,
              "event",
              text,
              eventType,
              itemId,
              nextEventData,
            ),
          ],
        };
      }
      return {
        ...state,
        messages: state.messages.map((message) =>
          message.id === existingMessage.id
            ? { ...message, eventData: nextEventData, text }
            : message,
        ),
      };
    });
  }

  private async mergeRichEventMessage({
    chatId,
    eventData,
    eventType,
    itemId,
    text,
  }: {
    chatId: string;
    eventData: Record<string, unknown>;
    eventType: string;
    itemId: string;
    text?: string;
  }): Promise<void> {
    await this.store.update((state) => {
      const existingMessage = state.messages.find(
        (message) =>
          message.chatId === chatId &&
          message.role === "event" &&
          message.eventType === eventType &&
          message.itemId === itemId,
      );
      const existingEventData = isRecord(existingMessage?.eventData)
        ? existingMessage.eventData
        : {};
      const nextText = text ?? existingMessage?.text ?? "";
      const nextEventData = {
        ...existingEventData,
        ...eventData,
        text: nextText,
      };
      if (!existingMessage) {
        return {
          ...state,
          messages: [
            ...state.messages,
            createMessage(
              chatId,
              "event",
              nextText,
              eventType,
              itemId,
              nextEventData,
            ),
          ],
        };
      }
      return {
        ...state,
        messages: state.messages.map((message) =>
          message.id === existingMessage.id
            ? { ...message, eventData: nextEventData, text: nextText }
            : message,
        ),
      };
    });
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
  eventData?: unknown,
): ChatMessageRecord {
  const message: ChatMessageRecord = {
    id: createRecordId("msg"),
    chatId,
    role,
    text,
    eventType,
    itemId,
    createdAt: createTimestamp(),
  };
  return eventData === undefined ? message : { ...message, eventData };
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
): InternalChatMessageRecord[] {
  const thread =
    getRecordObject(value, "thread") ?? (isRecord(value) ? value : null);
  const turns = thread ? getRecordArray(thread, "turns") : undefined;
  if (!turns) {
    return [];
  }

  const messages: InternalChatMessageRecord[] = [];
  let codexOrder = 0;
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
        codexOrder: codexOrder++,
        codexItemSource: item.codexItemSource,
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
): Array<Record<string, unknown> & { codexItemSource: CodexTurnItemSource }> {
  const inputItems = Array.isArray(turn.input)
    ? turn.input.filter(isRecord).map((item) => ({
        ...item,
        codexItemSource: "input" as const,
        role: "user",
      }))
    : [];
  const turnItems = (items: unknown[]) =>
    items
      .filter(isRecord)
      .map((item) => ({ ...item, codexItemSource: "item" as const }));
  if (Array.isArray(turn.items)) {
    return [...inputItems, ...turnItems(turn.items)];
  }
  if (Array.isArray(turn.output)) {
    return [...inputItems, ...turnItems(turn.output)];
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
  codexMessages: InternalChatMessageRecord[],
  localMessages: ChatMessageRecord[],
): ChatMessageRecord[] {
  if (codexMessages.length === 0) {
    return localMessages;
  }
  const mergedCodexMessages = [...codexMessages];
  const unmatchedCodexMessageIndexes = codexMessages.map((_, index) => index);
  const steeredLocalMessageCounts = countSteeredLocalMessages(localMessages);
  const liveAssistantDeltaCodexOrderLimits =
    findLiveAssistantDeltaCodexOrderLimits(
      localMessages,
      mergedCodexMessages,
      steeredLocalMessageCounts,
    );
  const retainedLocalMessages = localMessages.filter((message) => {
    if (message.role === "event" || message.role === "error") {
      return true;
    }
    if (message.eventType === "chat.message.queued") {
      return true;
    }
    const staleLiveAssistantDeltaIndex =
      findStaleLiveAssistantDeltaCodexMessageIndex(
        unmatchedCodexMessageIndexes,
        mergedCodexMessages,
        message,
      );
    if (staleLiveAssistantDeltaIndex !== undefined) {
      const staleCodexMessage =
        mergedCodexMessages[staleLiveAssistantDeltaIndex];
      if (staleCodexMessage) {
        mergedCodexMessages[staleLiveAssistantDeltaIndex] = {
          ...message,
          codexOrder: staleCodexMessage.codexOrder,
          codexItemSource: staleCodexMessage.codexItemSource,
        };
      }
      unmatchedCodexMessageIndexes.splice(
        unmatchedCodexMessageIndexes.indexOf(staleLiveAssistantDeltaIndex),
        1,
      );
      return false;
    }
    const matchedCodexIndex = findDeduplicatedCodexMessageIndex(
      unmatchedCodexMessageIndexes,
      mergedCodexMessages,
      message,
      steeredLocalMessageCounts,
      liveAssistantDeltaCodexOrderLimits,
    );
    if (matchedCodexIndex === undefined) {
      return true;
    }
    const matchedCodexMessage = mergedCodexMessages[matchedCodexIndex];
    if (message.eventType === "chat.message.steered" && matchedCodexMessage) {
      mergedCodexMessages[matchedCodexIndex] = {
        ...matchedCodexMessage,
        createdAt: message.createdAt,
      };
    }
    unmatchedCodexMessageIndexes.splice(
      unmatchedCodexMessageIndexes.indexOf(matchedCodexIndex),
      1,
    );
    return false;
  });
  return assignMergedMessageSortKeys(
    mergedCodexMessages,
    retainedLocalMessages,
    liveAssistantDeltaCodexOrderLimits,
    steeredLocalMessageCounts,
  )
    .sort(compareMergedMessages)
    .map(stripInternalCodexMessageMetadata);
}

function localMessagesWithoutStaleSteeredState(
  chat: ChatRecord,
  localMessages: ChatMessageRecord[],
): ChatMessageRecord[] {
  if (isChatInActiveTurn(chat)) {
    return localMessages;
  }
  return localMessages.map((message) =>
    message.eventType === "chat.message.steered"
      ? { ...message, eventType: undefined }
      : message,
  );
}

function insertRecordAtIndex<TRecord>(
  records: TRecord[],
  record: TRecord,
  index: number,
): TRecord[] {
  if (index >= records.length) {
    return [...records, record];
  }
  return [...records.slice(0, index), record, ...records.slice(index)];
}

function assignMergedMessageSortKeys(
  codexMessages: InternalChatMessageRecord[],
  localMessages: ChatMessageRecord[],
  liveAssistantDeltaCodexOrderLimits: ReadonlyMap<string, number>,
  steeredLocalMessageCounts: ReadonlyMap<string, number>,
): InternalChatMessageRecord[] {
  const orderedCodexMessages = [...codexMessages].sort(
    (left, right) => (left.codexOrder ?? 0) - (right.codexOrder ?? 0),
  );
  return [
    ...orderedCodexMessages.map((message, index) => ({
      ...message,
      mergeSortBucket: (message.codexOrder ?? index) * 2,
      mergeSortIndex: 0,
    })),
    ...localMessages.map((message, index) => {
      const mergeSortBucket = getLocalMessageMergeSortBucket(
        message,
        index,
        localMessages,
        orderedCodexMessages,
        liveAssistantDeltaCodexOrderLimits,
        steeredLocalMessageCounts,
      );
      return {
        ...message,
        mergeSortBucket,
        mergeSortIndex: index,
      };
    }),
  ];
}

function getLocalMessageMergeSortBucket(
  message: ChatMessageRecord,
  index: number,
  localMessages: ChatMessageRecord[],
  orderedCodexMessages: InternalChatMessageRecord[],
  liveAssistantDeltaCodexOrderLimits: ReadonlyMap<string, number>,
  steeredLocalMessageCounts: ReadonlyMap<string, number>,
): number {
  if (isPendingSteeredMessage(message)) {
    return orderedCodexMessages.length * 2 + 2;
  }
  if (isQueuedMessage(message)) {
    return orderedCodexMessages.length * 2 + 3;
  }
  if (isLiveAssistantDeltaMessage(message)) {
    const boundaryInsertionIndex = findLiveAssistantDeltaBoundaryInsertionIndex(
      message,
      index,
      localMessages,
      orderedCodexMessages,
      liveAssistantDeltaCodexOrderLimits,
      steeredLocalMessageCounts,
    );
    return boundaryInsertionIndex === null
      ? orderedCodexMessages.length * 2 + 1
      : boundaryInsertionIndex * 2 - 1;
  }
  const insertionIndex = orderedCodexMessages.findIndex(
    (codexMessage) => codexMessage.createdAt > message.createdAt,
  );
  return insertionIndex === -1
    ? orderedCodexMessages.length * 2 + 1
    : insertionIndex * 2 - 1;
}

function findLiveAssistantDeltaBoundaryInsertionIndex(
  message: ChatMessageRecord,
  index: number,
  localMessages: ChatMessageRecord[],
  orderedCodexMessages: InternalChatMessageRecord[],
  liveAssistantDeltaCodexOrderLimits: ReadonlyMap<string, number>,
  steeredLocalMessageCounts: ReadonlyMap<string, number>,
): number | null {
  if (!isLiveAssistantDeltaMessage(message)) {
    return null;
  }
  const codexOrderLimit = liveAssistantDeltaCodexOrderLimits.get(message.id);
  if (codexOrderLimit !== undefined) {
    const insertionIndex = orderedCodexMessages.findIndex(
      (codexMessage) => (codexMessage.codexOrder ?? 0) >= codexOrderLimit,
    );
    return insertionIndex === -1 ? null : insertionIndex;
  }
  const laterUserMessageEntry = localMessages
    .slice(index + 1)
    .map((message, offset) => ({ index: index + offset + 1, message }))
    .find(({ message }) => isLiveAssistantDeltaBoundaryUserMessage(message));
  if (!laterUserMessageEntry) {
    return null;
  }
  if (getSteeredMessageGroupKey(laterUserMessageEntry.message)) {
    return null;
  }
  const boundaryCodexMessage = findLiveAssistantDeltaBoundaryCodexMessage(
    orderedCodexMessages,
    localMessages,
    laterUserMessageEntry.index,
    steeredLocalMessageCounts,
  );
  if (boundaryCodexMessage?.codexOrder === undefined) {
    return null;
  }
  const insertionIndex = orderedCodexMessages.findIndex(
    (codexMessage) =>
      (codexMessage.codexOrder ?? 0) >= (boundaryCodexMessage.codexOrder ?? 0),
  );
  return insertionIndex === -1 ? null : insertionIndex;
}

function compareMergedMessages(
  left: InternalChatMessageRecord,
  right: InternalChatMessageRecord,
): number {
  if (left.mergeSortBucket !== right.mergeSortBucket) {
    return (left.mergeSortBucket ?? 0) - (right.mergeSortBucket ?? 0);
  }
  const timeComparison = left.createdAt.localeCompare(right.createdAt);
  if (timeComparison !== 0) {
    return timeComparison;
  }
  return (left.mergeSortIndex ?? 0) - (right.mergeSortIndex ?? 0);
}

function findDeduplicatedCodexMessageIndex(
  unmatchedCodexMessageIndexes: number[],
  codexMessages: InternalChatMessageRecord[],
  localMessage: ChatMessageRecord,
  steeredLocalMessageCounts: ReadonlyMap<string, number>,
  liveAssistantDeltaCodexOrderLimits: ReadonlyMap<string, number>,
): number | undefined {
  const matchedIndexes = unmatchedCodexMessageIndexes.filter((index) => {
    const codexMessage = codexMessages[index];
    return codexMessage
      ? shouldDeduplicateLocalMessage(
          codexMessage,
          localMessage,
          liveAssistantDeltaCodexOrderLimits,
        )
      : false;
  });
  if (localMessage.eventType === "chat.message.steered") {
    const orderedMatchedIndexes = [...matchedIndexes].sort(
      (left, right) =>
        (codexMessages[left]?.codexOrder ?? left) -
        (codexMessages[right]?.codexOrder ?? right),
    );
    const localGroupKey = getSteeredMessageGroupKey(localMessage);
    if (localMessage.itemId && localGroupKey) {
      const localSteeredCount =
        steeredLocalMessageCounts.get(localGroupKey) ?? 0;
      const sameTurnCandidateIndexes = codexMessages
        .map((message, index) => ({ index, message }))
        .filter(
          ({ message }) =>
            message.codexItemSource === "item" &&
            messageFingerprint(message) === messageFingerprint(localMessage) &&
            getCodexTurnItemIndex(message, localMessage.itemId ?? "") !== null,
        )
        .sort(
          (left, right) =>
            (left.message.codexOrder ?? left.index) -
            (right.message.codexOrder ?? right.index),
        )
        .map(({ index }) => index);
      const excludedInitialIndexes = new Set(
        sameTurnCandidateIndexes.slice(
          0,
          Math.max(0, sameTurnCandidateIndexes.length - localSteeredCount),
        ),
      );
      const sameTurnMatchedIndexes = orderedMatchedIndexes.filter(
        (index) =>
          sameTurnCandidateIndexes.includes(index) &&
          !excludedInitialIndexes.has(index),
      );
      if (sameTurnMatchedIndexes.length > 0) {
        return sameTurnMatchedIndexes[0];
      }
    }
    return orderedMatchedIndexes[0];
  }
  return matchedIndexes[0];
}

function findStaleLiveAssistantDeltaCodexMessageIndex(
  unmatchedCodexMessageIndexes: number[],
  codexMessages: InternalChatMessageRecord[],
  localMessage: ChatMessageRecord,
): number | undefined {
  if (!isLiveAssistantDeltaMessage(localMessage) || !localMessage.itemId) {
    return undefined;
  }
  return unmatchedCodexMessageIndexes.find((index) => {
    const codexMessage = codexMessages[index];
    return (
      codexMessage?.role === "assistant" &&
      codexMessage.itemId === localMessage.itemId &&
      !isCodexLiveAssistantMessageFresh(codexMessage, localMessage)
    );
  });
}

function countSteeredLocalMessages(
  messages: ChatMessageRecord[],
): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const message of messages) {
    const key = getSteeredMessageGroupKey(message);
    if (!key) {
      continue;
    }
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function getSteeredMessageGroupKey(message: ChatMessageRecord): string | null {
  if (message.eventType !== "chat.message.steered" || !message.itemId) {
    return null;
  }
  return `${message.itemId}\0${message.text}`;
}

function shouldDeduplicateLocalMessage(
  codexMessage: InternalChatMessageRecord,
  localMessage: ChatMessageRecord,
  liveAssistantDeltaCodexOrderLimits: ReadonlyMap<string, number>,
): boolean {
  if (codexMessage.role !== localMessage.role) {
    return false;
  }
  if (isLiveAssistantDeltaMessage(localMessage)) {
    if (
      codexMessage.itemId &&
      localMessage.itemId &&
      codexMessage.itemId === localMessage.itemId
    ) {
      return isCodexLiveAssistantMessageFresh(codexMessage, localMessage);
    }
    const codexOrderLimit = liveAssistantDeltaCodexOrderLimits.get(
      localMessage.id,
    );
    if (
      codexOrderLimit !== undefined &&
      (codexMessage.codexOrder ?? 0) >= codexOrderLimit
    ) {
      return false;
    }
  }
  if (
    localMessage.eventType !== "chat.message.steered" &&
    codexMessage.itemId &&
    localMessage.itemId
  ) {
    if (codexMessage.itemId === localMessage.itemId) {
      return true;
    }
    if (!isLiveAssistantDeltaMessage(localMessage)) {
      return false;
    }
  }
  if (messageFingerprint(codexMessage) !== messageFingerprint(localMessage)) {
    return false;
  }
  if (isCodexMessageAtOrAfterLocalMessage(codexMessage, localMessage)) {
    return true;
  }
  return isRelaxedSteeredCodexMatch(codexMessage, localMessage);
}

function isLiveAssistantDeltaMessage(message: ChatMessageRecord): boolean {
  return (
    message.role === "assistant" &&
    message.eventType === "item/agentMessage/delta"
  );
}

function isPendingSteeredMessage(message: ChatMessageRecord): boolean {
  return (
    message.role === "user" && message.eventType === "chat.message.steered"
  );
}

function isQueuedMessage(message: ChatMessageRecord): boolean {
  return message.role === "user" && message.eventType === "chat.message.queued";
}

function isCodexLiveAssistantMessageFresh(
  codexMessage: ChatMessageRecord,
  localMessage: ChatMessageRecord,
): boolean {
  return (
    codexMessage.text === localMessage.text ||
    codexMessage.text.startsWith(localMessage.text)
  );
}

function findLiveAssistantDeltaCodexOrderLimits(
  messages: ChatMessageRecord[],
  codexMessages: InternalChatMessageRecord[],
  steeredLocalMessageCounts: ReadonlyMap<string, number>,
): ReadonlyMap<string, number> {
  const codexOrderLimits = new Map<string, number>();
  for (const [index, message] of messages.entries()) {
    if (!isLiveAssistantDeltaMessage(message)) {
      continue;
    }
    const laterUserMessageEntry = messages
      .slice(index + 1)
      .map((message, offset) => ({ index: index + offset + 1, message }))
      .find(({ message }) => isLiveAssistantDeltaBoundaryUserMessage(message));
    if (!laterUserMessageEntry) {
      continue;
    }
    const boundaryCodexMessage = findLiveAssistantDeltaBoundaryCodexMessage(
      codexMessages,
      messages,
      laterUserMessageEntry.index,
      steeredLocalMessageCounts,
    );
    if (boundaryCodexMessage?.codexOrder !== undefined) {
      codexOrderLimits.set(message.id, boundaryCodexMessage.codexOrder);
    }
  }
  return codexOrderLimits;
}

function findLiveAssistantDeltaBoundaryCodexMessage(
  codexMessages: InternalChatMessageRecord[],
  localMessages: ChatMessageRecord[],
  laterUserMessageIndex: number,
  steeredLocalMessageCounts: ReadonlyMap<string, number>,
): InternalChatMessageRecord | undefined {
  const laterUserMessage = localMessages[laterUserMessageIndex];
  if (!laterUserMessage) {
    return undefined;
  }
  const localGroupKey = getSteeredMessageGroupKey(laterUserMessage);
  if (localGroupKey) {
    return findSteeredBoundaryCodexMessageForLocalOccurrence(
      codexMessages,
      localMessages,
      laterUserMessageIndex,
      laterUserMessage,
      steeredLocalMessageCounts,
    );
  }
  const matchedIndex = findDeduplicatedCodexMessageIndex(
    codexMessages.map((_, index) => index),
    codexMessages,
    laterUserMessage,
    steeredLocalMessageCounts,
    new Map(),
  );
  return matchedIndex === undefined ? undefined : codexMessages[matchedIndex];
}

function findSteeredBoundaryCodexMessageForLocalOccurrence(
  codexMessages: InternalChatMessageRecord[],
  localMessages: ChatMessageRecord[],
  localMessageIndex: number,
  localMessage: ChatMessageRecord,
  steeredLocalMessageCounts: ReadonlyMap<string, number>,
): InternalChatMessageRecord | undefined {
  const localGroupKey = getSteeredMessageGroupKey(localMessage);
  if (!localGroupKey) {
    return undefined;
  }
  const localOccurrenceIndex =
    localMessages
      .slice(0, localMessageIndex + 1)
      .filter((message) => getSteeredMessageGroupKey(message) === localGroupKey)
      .length - 1;
  if (localOccurrenceIndex < 0) {
    return undefined;
  }
  const localGroupCount = steeredLocalMessageCounts.get(localGroupKey) ?? 0;
  const sameTurnCandidateIndexes = codexMessages
    .map((message, index) => ({ index, message }))
    .filter(
      ({ message }) =>
        message.codexItemSource === "item" &&
        messageFingerprint(message) === messageFingerprint(localMessage) &&
        getCodexTurnItemIndex(message, localMessage.itemId ?? "") !== null,
    )
    .sort(
      (left, right) =>
        (left.message.codexOrder ?? left.index) -
        (right.message.codexOrder ?? right.index),
    )
    .map(({ index }) => index);
  const firstMatchedCandidateOffset = Math.max(
    0,
    sameTurnCandidateIndexes.length - localGroupCount,
  );
  const candidateIndex =
    sameTurnCandidateIndexes[
      firstMatchedCandidateOffset + localOccurrenceIndex
    ];
  const candidate =
    candidateIndex === undefined ? undefined : codexMessages[candidateIndex];
  return candidate && isCodexBoundaryUserMessage(candidate, localMessage)
    ? candidate
    : undefined;
}

function isLiveAssistantDeltaBoundaryUserMessage(
  message: ChatMessageRecord,
): boolean {
  return (
    message.role === "user" &&
    (!message.eventType || message.eventType === "chat.message.steered")
  );
}

function isCodexBoundaryUserMessage(
  codexMessage: InternalChatMessageRecord,
  localMessage: ChatMessageRecord,
): boolean {
  if (messageFingerprint(codexMessage) !== messageFingerprint(localMessage)) {
    return false;
  }
  if (localMessage.eventType === "chat.message.steered") {
    return (
      isCodexMessageAtOrAfterLocalMessage(codexMessage, localMessage) ||
      isRelaxedSteeredCodexMatch(codexMessage, localMessage)
    );
  }
  return isCodexMessageAtOrAfterLocalMessage(codexMessage, localMessage);
}

function isRelaxedSteeredCodexMatch(
  codexMessage: InternalChatMessageRecord,
  localMessage: ChatMessageRecord,
): boolean {
  if (
    localMessage.eventType !== "chat.message.steered" ||
    !localMessage.itemId ||
    codexMessage.codexItemSource !== "item"
  ) {
    return false;
  }
  const codexItemIndex = getCodexTurnItemIndex(
    codexMessage,
    localMessage.itemId,
  );
  return codexItemIndex !== null;
}

function stripInternalCodexMessageMetadata(
  message: InternalChatMessageRecord,
): ChatMessageRecord {
  const publicMessage: InternalChatMessageRecord = { ...message };
  delete publicMessage.codexOrder;
  delete publicMessage.codexItemSource;
  delete publicMessage.mergeSortBucket;
  delete publicMessage.mergeSortIndex;
  return publicMessage;
}

function getCodexTurnItemIndex(
  message: ChatMessageRecord,
  turnId: string,
): number | null {
  const marker = `_codex_${turnId}_`;
  const markerIndex = message.id.lastIndexOf(marker);
  if (markerIndex === -1) {
    return null;
  }
  const itemIndex = Number(message.id.slice(markerIndex + marker.length));
  return Number.isInteger(itemIndex) && itemIndex >= 0 ? itemIndex : null;
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

interface RichPlanStep {
  status: "completed" | "inProgress" | "pending";
  step: string;
}

interface PlanEventData {
  explanation: string | null;
  plan: RichPlanStep[];
}

interface DiffEventData {
  diff: string;
  files: string[];
}

interface FilePatchEventData {
  changes: Array<{
    diff: string;
    kind: string;
    path: string;
  }>;
}

function normalizePlanEventData(params: unknown): PlanEventData {
  const explanation = getRecordString(params, "explanation") ?? null;
  const plan = (getRecordArray(params, "plan") ?? [])
    .map((step) => {
      const text = getRecordString(step, "step");
      const status = getRecordString(step, "status");
      if (
        !text ||
        (status !== "pending" &&
          status !== "inProgress" &&
          status !== "completed")
      ) {
        return null;
      }
      return { step: text, status };
    })
    .filter((step): step is RichPlanStep => Boolean(step));
  return { explanation, plan };
}

function normalizeDiffEventData(params: unknown): DiffEventData {
  const diff = getRecordString(params, "diff") ?? "";
  return {
    diff,
    files: extractDiffFilePaths(diff),
  };
}

function normalizeFilePatchEventData(params: unknown): FilePatchEventData {
  const changes = (getRecordArray(params, "changes") ?? [])
    .map((change) => {
      const path = getRecordString(change, "path");
      if (!path) {
        return null;
      }
      return {
        path,
        kind: getRecordString(change, "kind") ?? "update",
        diff: getRecordString(change, "diff") ?? "",
      };
    })
    .filter((change): change is FilePatchEventData["changes"][number] =>
      Boolean(change),
    );
  return { changes };
}

function summarizeDiffEvent(eventData: DiffEventData): string {
  if (eventData.files.length === 0) {
    return eventData.diff ? "Diff updated" : "Diff cleared";
  }
  return `Diff updated: ${eventData.files.length} file${
    eventData.files.length === 1 ? "" : "s"
  }`;
}

function summarizeFilePatchEvent(eventData: FilePatchEventData): string {
  if (eventData.changes.length === 0) {
    return "File patch updated";
  }
  return `File patch updated: ${eventData.changes.length} file${
    eventData.changes.length === 1 ? "" : "s"
  }`;
}

function extractCommandOutputDelta(method: string, params: unknown): string {
  if (method === "command/exec/outputDelta") {
    const encoded = getRecordString(params, "deltaBase64");
    return encoded ? Buffer.from(encoded, "base64").toString("utf8") : "";
  }
  return getRecordString(params, "delta") ?? "";
}

function createCommandOutputEventData(
  method: string,
  params: unknown,
): Record<string, unknown> {
  if (method === "command/exec/outputDelta") {
    return {
      kind: "commandExecOutput",
      processId: getRecordString(params, "processId") ?? null,
      stream: getRecordString(params, "stream") ?? "stdout",
      capReached: Boolean(isRecord(params) && params.capReached === true),
    };
  }
  return { kind: "commandExecutionOutput" };
}

function createCommandLifecycleEventData(
  method: string,
  item: Record<string, unknown>,
): Record<string, unknown> {
  return {
    kind: "commandExecution",
    lifecycleEventType: method,
    command: getRecordString(item, "command") ?? null,
    cwd: getRecordString(item, "cwd") ?? null,
    processId: getRecordString(item, "processId") ?? null,
    source: getRecordString(item, "source") ?? null,
    status: getRecordString(item, "status") ?? null,
    exitCode: getRecordNumber(item, "exitCode") ?? null,
    durationMs: getRecordNumber(item, "durationMs") ?? null,
  };
}

function getCommandOutputItemId(method: string, params: unknown): string {
  if (method === "command/exec/outputDelta") {
    const processId = getRecordString(params, "processId") ?? "process";
    const stream = getRecordString(params, "stream") ?? "stdout";
    return `${processId}:${stream}`;
  }
  return getRecordString(params, "itemId") ?? method;
}

function createReasoningEventData(
  method: string,
  params: unknown,
): Record<string, unknown> {
  if (method === "item/reasoning/summaryTextDelta") {
    return {
      kind: "summaryText",
      summaryIndex: getRecordNumber(params, "summaryIndex") ?? null,
    };
  }
  if (method === "item/reasoning/summaryPartAdded") {
    return {
      kind: "summaryPart",
      summaryIndex: getRecordNumber(params, "summaryIndex") ?? null,
    };
  }
  return {
    kind: "text",
    contentIndex: getRecordNumber(params, "contentIndex") ?? null,
  };
}

function getReasoningEventItemId(method: string, params: unknown): string {
  const itemId = getRecordString(params, "itemId") ?? "reasoning";
  if (method === "item/reasoning/summaryTextDelta") {
    return `${itemId}:summary:${getRecordNumber(params, "summaryIndex") ?? 0}`;
  }
  if (method === "item/reasoning/summaryPartAdded") {
    return `${itemId}:summary-part:${
      getRecordNumber(params, "summaryIndex") ?? 0
    }`;
  }
  return `${itemId}:text:${getRecordNumber(params, "contentIndex") ?? 0}`;
}

function extractDiffFilePaths(diff: string): string[] {
  const files = new Set<string>();
  for (const line of diff.split(/\r?\n/)) {
    const diffMatch = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (diffMatch?.[2]) {
      files.add(diffMatch[2]);
      continue;
    }
    const nextFileMatch = /^\+\+\+ b\/(.+)$/.exec(line);
    if (nextFileMatch?.[1]) {
      files.add(nextFileMatch[1]);
    }
  }
  return [...files];
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

function getRecordNumber(value: unknown, key: string): number | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const candidate = value[key];
  return typeof candidate === "number" && Number.isFinite(candidate)
    ? candidate
    : undefined;
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
  options: { deleteBranch?: boolean } = {},
): Promise<void> {
  const { deleteBranch: shouldDeleteBranch = true } = options;
  const errors: string[] = [];

  try {
    await removeWorktree(gitRoot, worktreePath, true);
  } catch (error) {
    errors.push(`worktree remove failed: ${toErrorMessage(error)}`);
  }

  if (shouldDeleteBranch) {
    const branchResult = await deleteBranch(gitRoot, branchName);
    if (!branchResult.ok) {
      errors.push(`branch delete failed: ${branchResult.error.message}`);
    }
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
