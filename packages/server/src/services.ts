import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import {
  basename,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { inflateSync } from "node:zlib";
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
  hasPostCreateWorktreeCommands,
  listGitHubCheckoutTargets,
  listWorktrees,
  removeWorktree,
  runCreateWorktree,
  runPostCreateWorktree,
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
  type CodexTurnOptions,
} from "@phantompane/codex";
import {
  createRecordId,
  createTimestamp,
  getRecentProjectSkillRecords,
  getServeDataDir,
  rememberRecentProjectSkillSelection,
  ServeStateStore,
  touchProject,
} from "@phantompane/state";
import { EventHub } from "./event-hub.ts";
import type {
  ChatAttachmentRecord,
  ChatMessageRecord,
  ChatRecord,
  ChatStatus,
  CodexFileRecord,
  GitHubCheckoutTargetsResult,
  CodexModelRecord,
  CodexServiceTier,
  CodexSkillRecord,
  CodexTurnContextItem,
  PendingApprovalRecord,
  ProjectWorktreeRecord,
  ProjectRecord,
  QueuedMessageRecord,
  RecentProjectSkillRecord,
  ServeState,
} from "./types.ts";

export interface CreateChatInput {
  name?: string;
  base?: string;
  githubTargetNumber?: number;
  initialMessage?: string;
  serviceTier?: CodexServiceTier;
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
  attachments?: ChatAttachmentRecord[];
  effort?: string;
  files?: CodexTurnContextItem[];
  model?: string;
  serviceTier?: CodexServiceTier;
  skills?: CodexTurnContextItem[];
  text: string;
}

export interface UploadAttachmentInput {
  bytes: Uint8Array;
  mimeType: string;
  name: string;
  size: number;
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
  attachmentDir?: string;
  eventHub?: EventHub;
  store?: ServeStateStore;
  codex?: CodexBridge;
  codexHome?: string;
}

interface PendingApprovalRequest {
  chatId: string;
  method: string;
  params: unknown;
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
  prevalidatedTurnOptions?: CodexTurnOptions | undefined;
  queuedMessageId?: string;
  requireActiveTurn: boolean;
}

const worktreeNameInferenceModel = "gpt-5.4-mini";
export const maxAttachmentBytes = 10 * 1024 * 1024;
const maxDecodedImageBytes = 64 * 1024 * 1024;

class QueuedAttachmentValidationError extends Error {
  constructor(error: unknown) {
    super(toErrorMessage(error));
    this.name = "QueuedAttachmentValidationError";
  }
}

interface PngHeader {
  bitDepth: number;
  colorType: number;
  height: number;
  interlaceMethod: number;
  width: number;
}

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

interface PendingTurnEvent {
  kind: "notification" | "serverRequest";
  message: CodexMessage;
  order: number;
}

type CodexTurnItemSource = "input" | "item";
type InternalChatMessageRecord = ChatMessageRecord & {
  codexOrder?: number;
  codexItemSource?: CodexTurnItemSource;
  codexTurnId?: string;
  hasFallbackTimestamp?: boolean;
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
  private readonly attachmentDir: string;
  private readonly loadedThreadIds = new Set<string>();
  private readonly approvalRequests = new Map<string, PendingApprovalRequest>();
  private readonly pendingTurnEvents = new Map<
    string,
    PendingTurnEventBuffer
  >();
  private readonly pendingTurnEventsByTurnId = new Map<
    string,
    PendingTurnEvent[]
  >();
  private readonly pendingTurnThreadsByTurnId = new Map<string, string>();
  private pendingTurnEventOrder = 0;
  private readonly pendingChatTurns = new Set<string>();
  private readonly drainingQueuedMessageChatIds = new Set<string>();
  private readonly pendingQueuedMessageDrainChatIds = new Set<string>();
  private readonly activeTurnChatIds = new Set<string>();
  private readonly archiveOperationChatIds = new Set<string>();
  private readonly activeWorktreeOperationLocks = new Map<string, number>();
  private readonly waitableWorktreeOperationLocks = new Map<string, number>();
  private readonly worktreeOperationWaiters = new Map<
    string,
    Set<() => void>
  >();
  private readonly reportedAgentErrors = new WeakSet<object>();

  constructor(options: ServeServicesOptions = {}) {
    this.eventHub = options.eventHub ?? new EventHub();
    this.store = options.store ?? new ServeStateStore();
    this.codex = options.codex ?? new CodexBridge();
    this.attachmentDir =
      options.attachmentDir ?? join(getServeDataDir(), "attachments");
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
    await this.resetStaleTransientChatState();
    await this.store.update((state) => {
      const queuedMessageChatIds = getQueuedMessageChatIds(state);
      const projectChats = state.chats.filter(
        (chat) => chat.projectId === projectId,
      );
      const activeChat = projectChats.find(
        (chat) =>
          isChatActive(chat, this.pendingChatTurns) ||
          queuedMessageChatIds.has(chat.id) ||
          this.drainingQueuedMessageChatIds.has(chat.id) ||
          this.pendingQueuedMessageDrainChatIds.has(chat.id),
      );
      if (activeChat) {
        throw new Error(
          "Cannot remove project while it has running, approval, or queued chats",
        );
      }

      const removedChatIds = new Set(projectChats.map((chat) => chat.id));

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
        recentProjectSkills: Object.fromEntries(
          Object.entries(state.recentProjectSkills).filter(
            ([storedProjectId]) => storedProjectId !== projectId,
          ),
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

  async listRecentProjectSkills(
    projectId: string,
  ): Promise<RecentProjectSkillRecord[]> {
    const state = await this.store.load();
    const project = this.requireProject(state, projectId);
    return normalizeRecentProjectSkillRecordPaths(
      getRecentProjectSkillRecords(state.recentProjectSkills, projectId),
      getProjectSkillRoots(state, project),
    );
  }

  async rememberRecentProjectSkill(
    projectId: string,
    skillPath: string,
  ): Promise<RecentProjectSkillRecord[]> {
    if (!skillPath.trim()) {
      throw new Error("Skill path is required");
    }

    let recentSkills: RecentProjectSkillRecord[] = [];
    const lastUsedAt = createTimestamp();
    await this.store.update((state) => {
      const project = this.requireProject(state, projectId);
      const projectSkillRoots = getProjectSkillRoots(state, project);
      const normalizedSkillPath = normalizeProjectSkillPath(
        skillPath,
        projectSkillRoots,
      );
      const normalizedRecordsByProject = {
        ...state.recentProjectSkills,
        [projectId]: normalizeRecentProjectSkillRecordPaths(
          getRecentProjectSkillRecords(state.recentProjectSkills, projectId),
          projectSkillRoots,
        ),
      };
      const recentProjectSkills = rememberRecentProjectSkillSelection(
        normalizedRecordsByProject,
        projectId,
        normalizedSkillPath,
        lastUsedAt,
      );
      recentSkills = getRecentProjectSkillRecords(
        recentProjectSkills,
        projectId,
      );
      return {
        ...state,
        recentProjectSkills,
      };
    });

    return recentSkills;
  }

  async listChats(projectId: string): Promise<ChatRecord[]> {
    await this.resetStaleTransientChatState();
    const state = await this.store.load();
    const project = this.requireProject(state, projectId);
    const worktrees = await this.listProjectWorktreeSnapshot(projectId);
    if (!worktrees) {
      return annotateTransientChatState(
        sortChatsByUpdatedAt(
          state.chats.filter((chat) => chat.projectId === projectId),
        ),
        state,
        this.drainingQueuedMessageChatIds,
        this.pendingQueuedMessageDrainChatIds,
      );
    }

    let codexThreads: CodexThreadRecord[];
    try {
      codexThreads = await this.listCodexThreadsForWorktrees(worktrees);
    } catch {
      return annotateTransientChatState(
        sortChatsByUpdatedAt(
          state.chats.filter((chat) => chat.projectId === projectId),
        ),
        state,
        this.drainingQueuedMessageChatIds,
        this.pendingQueuedMessageDrainChatIds,
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

    const rejectedArchivedThreadChats: Array<{
      chat: ChatRecord;
      reason: string;
    }> = [];
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
      const nextProjectChats = threadChats.map((chat): ChatRecord => {
        const existingChat = existingChatsByThreadId.get(chat.codexThreadId);
        if (!existingChat) {
          return chat;
        }
        if (
          chat.status !== "archived" &&
          existingChat.status === "archived" &&
          existingChat.codexArchiveUnavailable &&
          isLocallyEmptyChat(nextState, existingChat)
        ) {
          return {
            ...chat,
            id: existingChat.id,
            status: "archived",
            activeTurnId: null,
            codexArchiveUnavailable: true,
            createdAt: existingChat.createdAt,
            updatedAt: existingChat.updatedAt,
          };
        }
        const archiveBlockMessage =
          chat.status === "archived"
            ? this.getChatArchiveBlockMessage(nextState, existingChat, true)
            : null;
        if (archiveBlockMessage) {
          rejectedArchivedThreadChats.push({
            chat: existingChat,
            reason: archiveBlockMessage,
          });
          return {
            ...chat,
            id: existingChat.id,
            status: existingChat.status,
            activeTurnId: existingChat.activeTurnId,
            createdAt: existingChat.createdAt,
          };
        }
        const shouldPreserveActiveChatState =
          chat.status !== "archived" &&
          (isChatActive(existingChat, this.pendingChatTurns) ||
            this.isChatActiveInCurrentProcess(existingChat));
        return {
          ...chat,
          id: existingChat.id,
          status: shouldPreserveActiveChatState
            ? existingChat.status
            : chat.status,
          activeTurnId:
            chat.status === "archived"
              ? null
              : shouldPreserveActiveChatState
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
    await Promise.all(
      rejectedArchivedThreadChats.map(({ chat, reason }) =>
        this.restoreRejectedCodexArchive(chat, reason),
      ),
    );

    const syncedState = await this.store.load();
    return annotateTransientChatState(
      sortChatsByUpdatedAt(
        syncedState.chats.filter((chat) => chat.projectId === projectId),
      ),
      syncedState,
      this.drainingQueuedMessageChatIds,
      this.pendingQueuedMessageDrainChatIds,
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

    const threadsById = new Map<string, CodexThreadRecord>();
    for (const archived of [false, true]) {
      let cursor: string | null = null;
      do {
        const result = await this.codex.listThreads({
          archived,
          cursor,
          cwd,
          limit: 100,
          sourceKinds: ["cli", "vscode", "appServer"],
          sortDirection: "desc",
          sortKey: "updated_at",
          useStateDbOnly: true,
        });
        for (const thread of normalizeCodexThreadList(result)) {
          const nextThread: CodexThreadRecord = archived
            ? { ...thread, status: "archived" }
            : thread;
          if (!archived || !threadsById.has(thread.id)) {
            threadsById.set(thread.id, nextThread);
          }
        }
        cursor = normalizeCodexCursor(result, "nextCursor");
      } while (cursor);
    }

    return Array.from(threadsById.values());
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
      serviceTier?: CodexServiceTier;
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

    const threadResult = input.serviceTier
      ? await this.codex.startThread(targetWorktree.path, {
          serviceTier: input.serviceTier,
        })
      : await this.codex.startThread(targetWorktree.path);
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
        const chat = await this.createExistingWorktreeChat(projectId, project, {
          serviceTier: input.serviceTier,
          worktreeName: result.value.worktree,
          worktreePath: result.value.path,
        });
        if (!result.value.alreadyExists) {
          await this.scheduleDeferredPostCreate(
            chat,
            project.rootPath,
            result.value.worktree,
          );
        }
        return chat;
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
        serviceTier: input.serviceTier,
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
      const threadResult = input.serviceTier
        ? await this.codex.startThread(createResult.value.path, {
            serviceTier: input.serviceTier,
          })
        : await this.codex.startThread(createResult.value.path);
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
    await this.scheduleDeferredPostCreate(
      chat,
      project.rootPath,
      createResult.value.name,
    );
    return chat;
  }

  private async scheduleDeferredPostCreate(
    chat: ChatRecord,
    gitRoot: string,
    worktreeName: string,
  ): Promise<void> {
    const hasCommands = await hasPostCreateWorktreeCommands({ gitRoot });
    if (!hasCommands.ok) {
      await this.addAgentErrorMessage(chat.id, hasCommands.error);
      this.emitAgentError(chat.id, hasCommands.error);
      return;
    }
    if (!hasCommands.value) {
      return;
    }

    const release = this.acquireWorktreeOperationLock(chat.worktreePath, {
      waitForMessages: true,
    });
    const timer = setTimeout(() => {
      void this.runDeferredPostCreate(chat, gitRoot, worktreeName, release);
    }, 0);
    timer.unref?.();
  }

  private async runDeferredPostCreate(
    chat: ChatRecord,
    gitRoot: string,
    worktreeName: string,
    release: () => void,
  ): Promise<void> {
    try {
      const result = await runPostCreateWorktree({
        gitRoot,
        worktreeName,
      });
      if (!result.ok) {
        throw result.error;
      }
    } catch (error) {
      await this.addAgentErrorMessage(chat.id, error);
      this.emitAgentError(chat.id, error);
    } finally {
      release();
      await this.drainQueuedMessagesAndReport(chat.id);
    }
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
    return annotateTransientChatState(
      [this.requireChat(state, chatId)],
      state,
      this.drainingQueuedMessageChatIds,
      this.pendingQueuedMessageDrainChatIds,
    )[0]!;
  }

  async getPendingApproval(
    chatId: string,
  ): Promise<PendingApprovalRecord | null> {
    await this.resetStaleTransientChatState();
    const state = await this.store.load();
    const chat = this.requireChat(state, chatId);
    for (const [requestId, approvalRequest] of this.approvalRequests) {
      if (approvalRequest.chatId === chat.id && !approvalRequest.responded) {
        return {
          requestId,
          method: approvalRequest.method,
          params: approvalRequest.params,
        };
      }
    }
    return null;
  }

  async setChatArchived(
    chatId: string,
    archived: boolean,
  ): Promise<ChatRecord> {
    await this.resetStaleTransientChatState();
    const initialState = await this.store.load();
    const initialChat = this.requireChat(initialState, chatId);
    if (this.archiveOperationChatIds.has(chatId)) {
      throw new Error("Chat archive state is already changing");
    }
    if (!archived && initialChat.status !== "archived") {
      return initialChat;
    }
    this.assertCanSetChatArchived(initialState, initialChat, archived);
    this.archiveOperationChatIds.add(chatId);
    let codexArchiveUnavailable = false;
    try {
      if (initialChat.codexThreadId) {
        try {
          if (archived) {
            await this.codex.archiveThread(initialChat.codexThreadId);
          } else if (!initialChat.codexArchiveUnavailable) {
            await this.codex.unarchiveThread(initialChat.codexThreadId);
          }
        } catch (error) {
          if (
            archived &&
            isMissingCodexRolloutError(error, initialChat.codexThreadId) &&
            isLocallyEmptyChat(initialState, initialChat)
          ) {
            codexArchiveUnavailable = true;
          } else {
            throw error;
          }
        }
      }

      let updatedChat: ChatRecord | null = null;
      let didUpdate = false;
      await this.store.update((state) => {
        const chat = this.requireChat(state, chatId);
        if (!archived && chat.status !== "archived") {
          updatedChat = chat;
          return state;
        }
        this.assertCanSetChatArchived(state, chat, archived);

        const nextChat: ChatRecord = {
          ...chat,
          status: archived ? "archived" : "idle",
          activeTurnId: null,
          codexArchiveUnavailable:
            archived &&
            (codexArchiveUnavailable || chat.codexArchiveUnavailable)
              ? true
              : undefined,
          updatedAt: createTimestamp(),
        };
        updatedChat = nextChat;
        didUpdate = true;

        return {
          ...state,
          chats: state.chats.map((candidate) =>
            candidate.id === chatId ? nextChat : candidate,
          ),
        };
      });

      if (!updatedChat) {
        throw new Error(`Chat '${chatId}' not found`);
      }
      if (!didUpdate) {
        return updatedChat;
      }
      this.eventHub.emit("chat.updated", updatedChat, { chatId });
      return updatedChat;
    } finally {
      this.archiveOperationChatIds.delete(chatId);
    }
  }

  async getMessages(chatId: string): Promise<ChatMessageRecord[]> {
    const resetChatIds = await this.resetStaleTransientChatState();
    const state = await this.store.load();
    const chat = this.requireChat(state, chatId);
    const localMessages = state.messages.filter(
      (message) => message.chatId === chatId,
    );
    const activeTurnId =
      chat.activeTurnId ??
      (resetChatIds.has(chatId) ? null : findLocalSteeredTurnId(localMessages));
    if (!chat.codexThreadId) {
      return localMessagesWithoutStaleSteeredState(chat, localMessages);
    }

    try {
      const result = await this.codex.readThread(chat.codexThreadId, {
        includeTurns: true,
      });
      const codexMessages = normalizeCodexThreadMessages(result, chat.id);
      return resolveChatMessageTimeline({
        activeTurnId,
        chat,
        codexMessages,
        localMessages,
      });
    } catch {
      return localMessagesWithoutStaleSteeredState(chat, localMessages);
    }
  }

  async sendMessage(
    chatId: string,
    input: SendMessageInput,
  ): Promise<ChatRecord> {
    await this.resetStaleTransientChatState();
    let state = await this.store.load();
    let chat = this.requireChat(state, chatId);
    if (this.isWaitableWorktreeOperationActive(chat.worktreePath)) {
      await this.waitForWorktreeOperation(chat.worktreePath);
      state = await this.store.load();
      chat = this.requireChat(state, chatId);
    }
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

  async uploadAttachment(
    chatId: string,
    input: UploadAttachmentInput,
  ): Promise<ChatAttachmentRecord> {
    const state = await this.store.load();
    this.requireChat(state, chatId);

    if (input.size <= 0 || input.bytes.byteLength <= 0) {
      throw new Error("Attachment file is empty");
    }
    if (
      input.size > maxAttachmentBytes ||
      input.bytes.byteLength > maxAttachmentBytes
    ) {
      throw new Error("Attachment file is too large");
    }
    const mimeType = detectSupportedImageMimeType(input.bytes);
    if (!mimeType) {
      throw new Error("Attachment file is not a supported image");
    }

    const safeName = sanitizeAttachmentName(input.name);
    const extension = sanitizeAttachmentExtension(safeName, mimeType);
    const attachmentId = createRecordId("att");
    const chatAttachmentDir = join(this.attachmentDir, chatId);
    const attachmentPath = join(
      chatAttachmentDir,
      `${attachmentId}${extension}`,
    );
    await mkdir(chatAttachmentDir, { recursive: true });
    await writeFile(attachmentPath, input.bytes);

    return {
      name: safeName,
      path: attachmentPath,
      mimeType,
      size: input.size,
    };
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
      this.assertChatCanReceiveMessage(chat);
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
      userMessage.attachments = cloneAttachmentRecords(input.attachments);
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
      this.assertChatCanReceiveMessage(chat);
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
    this.assertChatCanReceiveMessage(chat);
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

    const turnOptions =
      options.prevalidatedTurnOptions ??
      (await this.createCodexTurnOptions(input, chat).catch(async (error) => {
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
      }));

    const userMessage = existingUserMessage
      ? {
          ...existingUserMessage,
          eventType: undefined,
        }
      : {
          ...createMessage(
            chat.id,
            "user",
            text,
            isSteeringActiveTurn ? "chat.message.steered" : undefined,
            isSteeringActiveTurn ? (chat.activeTurnId ?? undefined) : undefined,
          ),
          attachments: cloneAttachmentRecords(input.attachments),
        };
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
            this.pendingTurnThreadsByTurnId.set(turnId, threadId);
            this.attachPendingTurnEventsForTurn(threadId, turnId);
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
        if (nextActiveTurnId) {
          this.attachPendingTurnEventsForTurn(
            pendingTurnThreadId,
            nextActiveTurnId,
          );
        }
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

  async listProjectSkills(projectId: string): Promise<CodexSkillRecord[]> {
    const state = await this.store.load();
    const project = this.requireProject(state, projectId);
    return normalizeSkillRecords(
      await this.codex.listSkills([project.rootPath]),
    );
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
        attachments?: ChatAttachmentRecord[];
        effort?: string;
        files?: CodexTurnContextItem[];
        model?: string;
        serviceTier?: CodexServiceTier;
        skills?: CodexTurnContextItem[];
      }
    | undefined
  > {
    const attachments = await this.normalizeAttachmentItems(
      input.attachments,
      chat.id,
    );
    const files = await normalizeFileContextItems(
      input.files,
      chat.worktreePath,
    );
    const skills = await this.normalizeSkillContextItems(input.skills, chat);
    if (
      !input.effort &&
      !input.model &&
      !input.serviceTier &&
      attachments.length === 0 &&
      files.length === 0 &&
      skills.length === 0
    ) {
      return undefined;
    }
    const options: {
      attachments?: ChatAttachmentRecord[];
      effort?: string;
      files?: CodexTurnContextItem[];
      model?: string;
      serviceTier?: CodexServiceTier;
      skills?: CodexTurnContextItem[];
    } = {};
    if (attachments.length > 0) {
      options.attachments = attachments;
    }
    if (input.effort) {
      options.effort = input.effort;
    }
    if (files.length > 0) {
      options.files = files;
    }
    if (input.model) {
      options.model = input.model;
    }
    if (input.serviceTier) {
      options.serviceTier = input.serviceTier;
    }
    if (skills.length > 0) {
      options.skills = skills;
    }
    return options;
  }

  private async normalizeAttachmentItems(
    items: ChatAttachmentRecord[] | undefined,
    chatId: string,
  ): Promise<ChatAttachmentRecord[]> {
    const normalized = normalizeAttachmentRecords(items);
    if (normalized.length === 0) {
      return [];
    }

    const chatAttachmentDir = join(this.attachmentDir, chatId);
    return await Promise.all(
      normalized.map(async (item) => {
        const resolvedPath = resolve(item.path);
        if (!isPathInside(chatAttachmentDir, resolvedPath)) {
          throw new Error(
            `Attachment path must be within this chat's attachment storage: ${item.path}`,
          );
        }

        let realChatAttachmentDir: string;
        try {
          realChatAttachmentDir = await realpath(chatAttachmentDir);
        } catch {
          throw new Error(
            `Attachment path is not an existing file: ${item.path}`,
          );
        }
        let realAttachmentPath: string;
        try {
          realAttachmentPath = await realpath(resolvedPath);
        } catch {
          throw new Error(
            `Attachment path is not an existing file: ${item.path}`,
          );
        }
        if (!isPathInside(realChatAttachmentDir, realAttachmentPath)) {
          throw new Error(
            `Attachment path must resolve within this chat's attachment storage: ${item.path}`,
          );
        }
        const attachmentStat = await stat(realAttachmentPath);
        if (!attachmentStat.isFile()) {
          throw new Error(`Attachment path is not a file: ${item.path}`);
        }
        if (
          attachmentStat.size <= 0 ||
          attachmentStat.size > maxAttachmentBytes
        ) {
          throw new Error("Attachment file is too large");
        }
        const bytes = await readFile(realAttachmentPath);
        const mimeType = detectSupportedImageMimeType(bytes);
        if (!mimeType) {
          throw new Error("Attachment file is not a supported image");
        }

        return {
          name: item.name,
          path: realAttachmentPath,
          mimeType,
          size: attachmentStat.size,
        };
      }),
    );
  }

  private async normalizeSkillContextItems(
    items: CodexTurnContextItem[] | undefined,
    chat: ChatRecord,
  ): Promise<CodexTurnContextItem[]> {
    const normalized = normalizeTurnContextItems(items);
    if (normalized.length === 0) {
      return [];
    }

    const state = await this.store.load();
    const project = this.requireProject(state, chat.projectId);
    const projectSkillRoots = getProjectSkillRoots(state, project);
    const skillListRoots = getSkillListRoots(chat, project);
    const availableSkills = normalizeSkillRecords(
      await this.codex.listSkills(skillListRoots),
    );
    const skillsByPath = new Map<string, CodexSkillRecord>();
    for (const skill of sortSkillsByRootPreference(
      availableSkills.filter((candidate) => candidate.enabled),
      skillListRoots,
    )) {
      skillsByPath.set(skill.path, skill);
      const skillIdentity = normalizeProjectSkillPath(
        skill.path,
        projectSkillRoots,
      );
      if (!skillsByPath.has(skillIdentity)) {
        skillsByPath.set(skillIdentity, skill);
      }
    }
    return normalized.map((item) => {
      const skill =
        skillsByPath.get(
          normalizeProjectSkillPath(item.path, projectSkillRoots),
        ) ?? skillsByPath.get(item.path);
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
    this.pendingTurnEventsByTurnId.clear();
    this.pendingTurnThreadsByTurnId.clear();
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
    const pendingEvent = this.createPendingTurnEvent("notification", message);
    if (threadId && this.bufferPendingTurnEvent(threadId, pendingEvent)) {
      return;
    }
    if (
      await this.bufferPendingTurnEventByTurnId(message.params, pendingEvent)
    ) {
      return;
    }
    await this.processCodexNotification(message);
  }

  private async processCodexNotification(message: CodexMessage): Promise<void> {
    const method = message.method ?? "unknown";
    if (isHiddenCodexWarning(method, message.params)) {
      return;
    }
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
      this.eventHub.emit(eventType, sanitizeCodexMessageForEventHub(message), {
        chatId: chat.id,
      });
      if (method === "turn/completed") {
        await this.drainQueuedMessagesAndReport(chat.id);
      }
    } else {
      if (method === "serverRequest/resolved") {
        return;
      }
      this.eventHub.emit(eventType, sanitizeCodexMessageForEventHub(message));
    }
  }

  private async handleCodexServerRequest(message: CodexMessage): Promise<void> {
    const threadId = extractThreadIdFromParams(message.params);
    if (
      threadId &&
      this.bufferPendingTurnEvent(
        threadId,
        this.createPendingTurnEvent("serverRequest", message),
      )
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

    const approvalMethod = message.method ?? "unknown";
    const approvalRequestId = createRecordId("approval");
    const approvalParams = sanitizeCodexEventParams(
      approvalMethod,
      message.params,
    );
    this.approvalRequests.set(approvalRequestId, {
      chatId: chat.id,
      method: approvalMethod,
      params: approvalParams,
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
        method: approvalMethod,
        params: approvalParams,
      },
      { chatId: chat.id },
    );
  }

  private async drainQueuedMessages(chatId: string): Promise<void> {
    const state = await this.store.load();
    const chat = this.requireChat(state, chatId);
    if (chat.status === "archived") {
      return;
    }
    if (isChatInActiveTurn(chat) || this.pendingChatTurns.has(chatId)) {
      return;
    }

    const queuedMessage = state.queuedMessages.find(
      (message) => message.chatId === chatId,
    );
    if (!queuedMessage) {
      return;
    }
    let prevalidatedTurnOptions: CodexTurnOptions | undefined;
    if ((queuedMessage.attachments ?? []).length > 0) {
      try {
        prevalidatedTurnOptions = await this.createCodexTurnOptions(
          queuedMessageToSendInput(queuedMessage),
          chat,
        );
      } catch (error) {
        throw new QueuedAttachmentValidationError(error);
      }
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
        prevalidatedTurnOptions,
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
            !(error instanceof QueuedAttachmentValidationError) &&
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

  private assertChatCanReceiveMessage(chat: ChatRecord): void {
    if (this.archiveOperationChatIds.has(chat.id)) {
      throw new Error("Chat archive state is already changing");
    }
    if (chat.status === "archived") {
      throw new Error(
        "Archived chats must be restored before sending messages",
      );
    }
  }

  private acquireWorktreeOperationLock(
    worktreePath: string,
    options: { waitForMessages?: boolean } = {},
  ): () => void {
    const activeCount =
      this.activeWorktreeOperationLocks.get(worktreePath) ?? 0;
    this.activeWorktreeOperationLocks.set(worktreePath, activeCount + 1);
    if (options.waitForMessages) {
      const waitableCount =
        this.waitableWorktreeOperationLocks.get(worktreePath) ?? 0;
      this.waitableWorktreeOperationLocks.set(worktreePath, waitableCount + 1);
    }
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
      if (options.waitForMessages) {
        const nextWaitableCount =
          (this.waitableWorktreeOperationLocks.get(worktreePath) ?? 1) - 1;
        if (nextWaitableCount > 0) {
          this.waitableWorktreeOperationLocks.set(
            worktreePath,
            nextWaitableCount,
          );
        } else {
          this.waitableWorktreeOperationLocks.delete(worktreePath);
          this.resolveWorktreeOperationWaiters(worktreePath);
        }
      }
    };
  }

  private resolveWorktreeOperationWaiters(worktreePath: string): void {
    const waiters = this.worktreeOperationWaiters.get(worktreePath);
    if (!waiters) {
      return;
    }

    this.worktreeOperationWaiters.delete(worktreePath);
    for (const resolveWaiter of waiters) {
      resolveWaiter();
    }
  }

  private async waitForWorktreeOperation(worktreePath: string): Promise<void> {
    while (this.isWaitableWorktreeOperationActive(worktreePath)) {
      await new Promise<void>((resolveWaiter) => {
        const waiters =
          this.worktreeOperationWaiters.get(worktreePath) ??
          new Set<() => void>();
        waiters.add(resolveWaiter);
        this.worktreeOperationWaiters.set(worktreePath, waiters);
      });
    }
  }

  private isWorktreeOperationActive(worktreePath: string): boolean {
    return (this.activeWorktreeOperationLocks.get(worktreePath) ?? 0) > 0;
  }

  private isWaitableWorktreeOperationActive(worktreePath: string): boolean {
    return (this.waitableWorktreeOperationLocks.get(worktreePath) ?? 0) > 0;
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
      this.deletePendingTurnThreadMappings(threadId);
      return;
    }
    pendingTurnEvents.flushing = true;
    pendingTurnEvents.events.sort((a, b) => a.order - b.order);
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
      this.deletePendingTurnThreadMappings(threadId);
    }
  }

  private createPendingTurnEvent(
    kind: PendingTurnEvent["kind"],
    message: CodexMessage,
  ): PendingTurnEvent {
    return {
      kind,
      message: sanitizeCodexMessageForEventHub(message),
      order: this.pendingTurnEventOrder++,
    };
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

  private async bufferPendingTurnEventByTurnId(
    params: unknown,
    event: PendingTurnEvent,
  ): Promise<boolean> {
    const turnId = extractTurnIdFromParams(params);
    if (!turnId) {
      return false;
    }

    const threadId = this.pendingTurnThreadsByTurnId.get(turnId);
    if (threadId) {
      return this.bufferPendingTurnEvent(threadId, event);
    }

    if (!this.hasPendingTurnStartup()) {
      return false;
    }

    const state = await this.store.load();
    if (state.chats.some((chat) => chat.activeTurnId === turnId)) {
      return false;
    }

    const existingEvents = this.pendingTurnEventsByTurnId.get(turnId);
    if (existingEvents) {
      existingEvents.push(event);
      return true;
    }

    const events = [event];
    this.pendingTurnEventsByTurnId.set(turnId, events);
    const cleanup = setTimeout(() => {
      if (this.pendingTurnEventsByTurnId.get(turnId) === events) {
        this.pendingTurnEventsByTurnId.delete(turnId);
      }
    }, 30000);
    cleanup.unref?.();
    return true;
  }

  private hasPendingTurnStartup(): boolean {
    for (const pendingTurnEvents of this.pendingTurnEvents.values()) {
      if (!pendingTurnEvents.discard) {
        return true;
      }
    }
    return false;
  }

  private attachPendingTurnEventsForTurn(
    threadId: string,
    turnId: string,
  ): void {
    const events = this.pendingTurnEventsByTurnId.get(turnId);
    if (!events) {
      return;
    }
    this.pendingTurnEventsByTurnId.delete(turnId);
    for (const event of events) {
      this.bufferPendingTurnEvent(threadId, event);
    }
  }

  private deletePendingTurnThreadMappings(threadId: string): void {
    for (const [turnId, mappedThreadId] of this.pendingTurnThreadsByTurnId) {
      if (mappedThreadId === threadId) {
        this.pendingTurnThreadsByTurnId.delete(turnId);
      }
    }
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
    this.deletePendingTurnThreadMappings(threadId);
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
    const state = await this.store.load();
    const chat = this.requireChat(state, chatId);
    if (method === "thread/archived" || method === "thread/unarchived") {
      return await this.updateChatArchiveStatusFromCodex(
        chatId,
        method === "thread/archived",
      );
    }
    if (this.archiveOperationChatIds.has(chatId)) {
      return false;
    }
    if (chat.status === "archived") {
      return false;
    }

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

  private async updateChatArchiveStatusFromCodex(
    chatId: string,
    archived: boolean,
  ): Promise<boolean> {
    let blockedChat: ChatRecord | null = null;
    let blockMessage: string | null = null;
    let didUpdate = false;
    await this.store.update((state) => {
      const chat = this.requireChat(state, chatId);
      if (archived) {
        const nextBlockMessage = this.getChatArchiveBlockMessage(
          state,
          chat,
          true,
        );
        if (nextBlockMessage) {
          blockedChat = chat;
          blockMessage = nextBlockMessage;
          return state;
        }
      } else if (chat.status !== "archived") {
        return state;
      }

      const nextChat: ChatRecord = {
        ...chat,
        status: archived ? "archived" : "idle",
        activeTurnId: null,
        updatedAt: createTimestamp(),
      };
      didUpdate = true;
      return {
        ...state,
        chats: state.chats.map((candidate) =>
          candidate.id === chatId ? nextChat : candidate,
        ),
      };
    });

    if (blockedChat && blockMessage) {
      await this.restoreRejectedCodexArchive(blockedChat, blockMessage);
      return false;
    }
    return didUpdate;
  }

  private async resetStaleTransientChatState(): Promise<ReadonlySet<string>> {
    const state = await this.store.load();
    const hasStaleTransientChat = state.chats.some((chat) =>
      this.isStaleTransientChat(chat),
    );
    const hasStoredHiddenRichEventContent = state.messages.some(
      hasHiddenRichEventContent,
    );
    if (!hasStaleTransientChat && !hasStoredHiddenRichEventContent) {
      return new Set();
    }

    const resetChatIds = new Set<string>();
    const timestamp = createTimestamp();
    await this.store.update((nextState) => {
      resetChatIds.clear();
      const chats = nextState.chats.map((chat) => {
        if (!this.isStaleTransientChat(chat)) {
          return chat;
        }
        resetChatIds.add(chat.id);
        return {
          ...chat,
          status: "idle" as const,
          activeTurnId: null,
          updatedAt: timestamp,
        };
      });
      if (resetChatIds.size === 0 && !hasStoredHiddenRichEventContent) {
        return nextState;
      }
      return {
        ...nextState,
        chats,
        messages: nextState.messages.map((message) => {
          const nextMessage =
            resetChatIds.has(message.chatId) &&
            message.eventType === "chat.message.steered"
              ? { ...message, eventType: undefined }
              : message;
          return stripHiddenRichEventContent(nextMessage);
        }),
      };
    });
    return resetChatIds;
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

  private assertCanSetChatArchived(
    state: ServeState,
    chat: ChatRecord,
    archived: boolean,
  ): void {
    const blockMessage = this.getChatArchiveBlockMessage(state, chat, archived);
    if (blockMessage) {
      throw new Error(blockMessage);
    }
  }

  private getChatArchiveBlockMessage(
    state: ServeState,
    chat: ChatRecord,
    archived: boolean,
  ): string | null {
    if (!archived) {
      return null;
    }
    if (
      isChatActive(chat, this.pendingChatTurns) ||
      this.isChatActiveInCurrentProcess(chat)
    ) {
      return "Cannot archive a chat with an active Codex turn";
    }
    if (this.drainingQueuedMessageChatIds.has(chat.id)) {
      return "Cannot archive a chat while queued messages are sending";
    }
    if (state.queuedMessages.some((message) => message.chatId === chat.id)) {
      return "Cannot archive a chat with pending messages";
    }
    return null;
  }

  private async restoreRejectedCodexArchive(
    chat: ChatRecord,
    reason: string,
  ): Promise<void> {
    if (!chat.codexThreadId) {
      return;
    }
    try {
      await this.codex.unarchiveThread(chat.codexThreadId);
    } catch (error) {
      this.eventHub.emit(
        "agent.error",
        {
          message: "Codex archived a chat that Phantom could not archive",
          reason,
          error: toErrorMessage(error),
        },
        { chatId: chat.id },
      );
    }
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
          ? chat.status === "archived"
            ? {
                ...chat,
                activeTurnId: null,
              }
            : {
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
          (message) =>
            message.chatId === chatId &&
            message.role === "assistant" &&
            message.eventType === method &&
            message.itemId === itemId,
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
      const eventData = createCommandOutputEventData(method, params);
      if (!delta) {
        if (hasHiddenOutputDelta(params)) {
          await this.appendRichEventMessage({
            chatId,
            delta: "",
            eventData,
            eventType: method,
            itemId: getCommandOutputItemId(method, params),
          });
          return;
        }
        if (hasCommandOutputMetadataUpdate(method, params)) {
          await this.mergeRichEventMessage({
            chatId,
            eventData,
            eventType: method,
            itemId: getCommandOutputItemId(method, params),
          });
        }
        return;
      }
      await this.appendRichEventMessage({
        chatId,
        delta,
        eventData,
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
        if (hasHiddenOutputDelta(params)) {
          await this.appendRichEventMessage({
            chatId,
            delta: "",
            eventData: createFileChangeOutputEventData(params),
            eventType: method,
            itemId: getRecordString(params, "itemId") ?? method,
          });
        }
        return;
      }
      await this.appendRichEventMessage({
        chatId,
        delta,
        eventData: createFileChangeOutputEventData(params),
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
      if (isHiddenCodexWarning(method, params)) {
        return;
      }
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
      const existingEventData = isRecord(existingMessage?.eventData)
        ? existingMessage.eventData
        : {};
      const nextEventData = withHiddenContentUpdateCount(
        eventType,
        existingEventData,
        eventData,
      );
      if (!existingMessage) {
        return {
          ...state,
          messages: [
            ...state.messages,
            stripHiddenRichEventContent(
              createMessage(
                chatId,
                "event",
                text,
                eventType,
                itemId,
                nextEventData,
              ),
            ),
          ],
        };
      }
      return {
        ...state,
        messages: state.messages.map((message) =>
          message.id === existingMessage.id
            ? stripHiddenRichEventContent({
                ...message,
                eventData: nextEventData,
                text,
              })
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
      const text = shouldStripHiddenRichEventContent(eventType)
        ? ""
        : `${existingMessage?.text ?? ""}${delta}`;
      const existingEventData = isRecord(existingMessage?.eventData)
        ? existingMessage.eventData
        : {};
      const nextEventData = shouldStripHiddenRichEventContent(eventType)
        ? {
            ...existingEventData,
            ...eventData,
            hiddenContentDeltaCount:
              (getRecordNumber(existingEventData, "hiddenContentDeltaCount") ??
                0) + 1,
          }
        : { ...existingEventData, ...eventData, text };
      if (!existingMessage) {
        return {
          ...state,
          messages: [
            ...state.messages,
            stripHiddenRichEventContent(
              createMessage(
                chatId,
                "event",
                text,
                eventType,
                itemId,
                nextEventData,
              ),
            ),
          ],
        };
      }
      return {
        ...state,
        messages: state.messages.map((message) =>
          message.id === existingMessage.id
            ? stripHiddenRichEventContent({
                ...message,
                eventData: nextEventData,
                text,
              })
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
      const nextText = shouldStripHiddenRichEventContent(eventType)
        ? ""
        : (text ?? existingMessage?.text ?? "");
      const nextEventData = {
        ...existingEventData,
        ...eventData,
        ...(shouldStripHiddenRichEventContent(eventType)
          ? {}
          : { text: nextText }),
      };
      if (!existingMessage) {
        return {
          ...state,
          messages: [
            ...state.messages,
            stripHiddenRichEventContent(
              createMessage(
                chatId,
                "event",
                nextText,
                eventType,
                itemId,
                nextEventData,
              ),
            ),
          ],
        };
      }
      return {
        ...state,
        messages: state.messages.map((message) =>
          message.id === existingMessage.id
            ? stripHiddenRichEventContent({
                ...message,
                eventData: nextEventData,
                text: nextText,
              })
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
    attachments: cloneAttachmentRecords(input.attachments),
    effort: input.effort,
    files: cloneContextItems(input.files),
    model: input.model,
    serviceTier: input.serviceTier,
    skills: cloneContextItems(input.skills),
    createdAt: createTimestamp(),
  };
}

function queuedMessageToSendInput(
  message: QueuedMessageRecord,
): SendMessageInput {
  return {
    attachments: cloneAttachmentRecords(message.attachments),
    effort: message.effort,
    files: cloneContextItems(message.files),
    model: message.model,
    serviceTier: message.serviceTier,
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

function cloneAttachmentRecords(
  items: ChatAttachmentRecord[] | undefined,
): ChatAttachmentRecord[] | undefined {
  const normalized = normalizeAttachmentRecords(items);
  return normalized.length > 0 ? normalized : undefined;
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
  const selectableChats = sortedChats.some((chat) => chat.status !== "archived")
    ? sortedChats.filter((chat) => chat.status !== "archived")
    : sortedChats;
  return (
    selectableChats.find((chat) => chat.codexThreadId) ??
    selectableChats[0] ??
    null
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

function isValidCodexTimestamp(value: unknown): boolean {
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function sortChatsByUpdatedAt(chats: ChatRecord[]): ChatRecord[] {
  return [...chats].sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt),
  );
}

function annotateTransientChatState(
  chats: ChatRecord[],
  state: ServeState,
  drainingQueuedMessageChatIds: ReadonlySet<string>,
  pendingQueuedMessageDrainChatIds: ReadonlySet<string>,
): ChatRecord[] {
  const queuedMessageChatIds = getQueuedMessageChatIds(state);
  return chats.map((chat) => ({
    ...chat,
    hasQueuedMessages: queuedMessageChatIds.has(chat.id),
    isDrainingQueuedMessages:
      drainingQueuedMessageChatIds.has(chat.id) ||
      pendingQueuedMessageDrainChatIds.has(chat.id),
  }));
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
    const turnTimestampValue =
      turn.createdAt ?? turn.created_at ?? turn.updatedAt ?? turn.updated_at;
    const hasFallbackTurnTimestamp = !isValidCodexTimestamp(turnTimestampValue);
    const turnTimestamp = normalizeCodexTimestamp(
      turnTimestampValue,
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
      const itemTimestampValue =
        item.createdAt ?? item.created_at ?? item.timestamp;
      messages.push({
        id: `${chatId}_codex_${turnId}_${itemIndex}`,
        chatId,
        role,
        text,
        codexOrder: codexOrder++,
        codexItemSource: item.codexItemSource,
        codexTurnId: turnId,
        hasFallbackTimestamp:
          !isValidCodexTimestamp(itemTimestampValue) &&
          hasFallbackTurnTimestamp,
        itemId: getRecordString(item, "id") ?? undefined,
        createdAt: normalizeCodexTimestamp(itemTimestampValue, turnTimestamp),
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

interface ResolveChatMessageTimelineInput {
  activeTurnId: string | null;
  chat: ChatRecord;
  codexMessages: InternalChatMessageRecord[];
  localMessages: ChatMessageRecord[];
}

function resolveChatMessageTimeline({
  activeTurnId,
  chat,
  codexMessages,
  localMessages,
}: ResolveChatMessageTimelineInput): ChatMessageRecord[] {
  if (codexMessages.length === 0) {
    return localMessagesWithoutStaleSteeredState(chat, localMessages);
  }
  const localMessagesForCanonicalTranscript = isChatInActiveTurn(chat)
    ? localMessages
    : localMessagesWithoutStaleSteeredState(chat, localMessages);
  const canonicalLocalTranscriptMatch = isChatInActiveTurn(chat)
    ? emptyCanonicalLocalTranscriptMatch()
    : findCanonicalLocalTranscriptMatch(
        codexMessages,
        localMessagesForCanonicalTranscript,
      );
  const deduplicatedCodexMessages =
    codexMessagesWithoutCanonicalLocalTranscript(
      codexMessages,
      canonicalLocalTranscriptMatch.codexMessageIndexes,
    );
  if (deduplicatedCodexMessages.length === 0) {
    return localMessagesWithoutStaleSteeredState(chat, localMessages);
  }
  const localMessagesForMerge =
    localMessagesWithCanonicalStaleSteeredStateCleared(
      chat,
      localMessages,
      canonicalLocalTranscriptMatch,
    );
  return mergeCodexAndLocalMessages(
    deduplicatedCodexMessages,
    localMessagesForMerge,
    activeTurnId,
    chat.activeTurnId != null,
    canonicalLocalTranscriptMatch.localMessageCodexOrderMatches,
  );
}

function mergeCodexAndLocalMessages(
  codexMessages: InternalChatMessageRecord[],
  localMessages: ChatMessageRecord[],
  activeTurnId: string | null,
  protectActiveLocalTurn: boolean,
  protectedLocalMessageCodexOrderMatches: ReadonlyMap<
    string,
    number
  > = new Map(),
): ChatMessageRecord[] {
  if (codexMessages.length === 0) {
    return localMessages;
  }
  const mergedCodexMessages = [...codexMessages];
  const unmatchedCodexMessageIndexes = codexMessages.map((_, index) => index);
  const localMessageCodexOrderMatches = new Map(
    protectedLocalMessageCodexOrderMatches,
  );
  const steeredLocalMessageCounts = countSteeredLocalMessages(localMessages);
  const activeLocalTurnStartIndex = protectActiveLocalTurn
    ? findActiveLocalTurnStartIndex(localMessages)
    : localMessages.length;
  const fallbackTranscriptLocalMessageMatches =
    findFallbackTranscriptLocalMessageMatches(
      mergedCodexMessages,
      localMessages,
      activeTurnId,
      activeLocalTurnStartIndex,
    );
  const liveAssistantDeltaCodexOrderLimits =
    findLiveAssistantDeltaCodexOrderLimits(
      localMessages,
      mergedCodexMessages,
      steeredLocalMessageCounts,
      activeTurnId,
    );
  const retainedLocalMessages = localMessages.filter((message) => {
    if (message.role === "event" || message.role === "error") {
      return true;
    }
    if (message.eventType === "chat.message.queued") {
      return true;
    }
    if (protectedLocalMessageCodexOrderMatches.has(message.id)) {
      return true;
    }
    const fallbackTranscriptCodexIndex =
      fallbackTranscriptLocalMessageMatches.get(message.id);
    if (
      fallbackTranscriptCodexIndex !== undefined &&
      unmatchedCodexMessageIndexes.includes(fallbackTranscriptCodexIndex)
    ) {
      const fallbackCodexMessage =
        mergedCodexMessages[fallbackTranscriptCodexIndex];
      if (fallbackCodexMessage) {
        localMessageCodexOrderMatches.set(
          message.id,
          fallbackCodexMessage.codexOrder ?? fallbackTranscriptCodexIndex,
        );
        mergedCodexMessages[fallbackTranscriptCodexIndex] =
          mergeLocalMessageMetadataIntoCodexMessage(
            fallbackCodexMessage,
            message,
          );
      }
      unmatchedCodexMessageIndexes.splice(
        unmatchedCodexMessageIndexes.indexOf(fallbackTranscriptCodexIndex),
        1,
      );
      return false;
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
        localMessageCodexOrderMatches.set(
          message.id,
          staleCodexMessage.codexOrder ?? staleLiveAssistantDeltaIndex,
        );
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
      activeTurnId,
    );
    if (matchedCodexIndex === undefined) {
      return true;
    }
    const matchedCodexMessage = mergedCodexMessages[matchedCodexIndex];
    if (matchedCodexMessage) {
      localMessageCodexOrderMatches.set(
        message.id,
        matchedCodexMessage.codexOrder ?? matchedCodexIndex,
      );
      mergedCodexMessages[matchedCodexIndex] =
        mergeLocalMessageMetadataIntoCodexMessage(matchedCodexMessage, message);
    }
    if (message.eventType === "chat.message.steered" && matchedCodexMessage) {
      mergedCodexMessages[matchedCodexIndex] = {
        ...mergedCodexMessages[matchedCodexIndex],
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
    localMessages,
    localMessageCodexOrderMatches,
    liveAssistantDeltaCodexOrderLimits,
    steeredLocalMessageCounts,
    activeTurnId,
  )
    .sort(compareMergedMessages)
    .map(stripInternalCodexMessageMetadata);
}

function mergeLocalMessageMetadataIntoCodexMessage(
  codexMessage: InternalChatMessageRecord,
  localMessage: ChatMessageRecord,
): InternalChatMessageRecord {
  const attachments = cloneAttachmentRecords(localMessage.attachments);
  return attachments ? { ...codexMessage, attachments } : codexMessage;
}

function localMessagesWithoutStaleSteeredState(
  chat: ChatRecord,
  localMessages: ChatMessageRecord[],
): ChatMessageRecord[] {
  if (isChatInActiveTurn(chat)) {
    return localMessages;
  }
  return localMessages.map((message) =>
    localMessageWithoutStaleSteeredState(chat, message),
  );
}

function localMessagesWithCanonicalStaleSteeredStateCleared(
  chat: ChatRecord,
  localMessages: ChatMessageRecord[],
  canonicalLocalTranscriptMatch: CanonicalLocalTranscriptMatch,
): ChatMessageRecord[] {
  if (
    isChatInActiveTurn(chat) ||
    canonicalLocalTranscriptMatch.localMessageCodexOrderMatches.size === 0
  ) {
    return localMessages;
  }
  return localMessages.map((message) =>
    canonicalLocalTranscriptMatch.localMessageCodexOrderMatches.has(message.id)
      ? localMessageWithoutStaleSteeredState(chat, message)
      : message,
  );
}

function localMessageWithoutStaleSteeredState(
  chat: ChatRecord,
  message: ChatMessageRecord,
): ChatMessageRecord {
  if (
    isChatInActiveTurn(chat) ||
    message.eventType !== "chat.message.steered"
  ) {
    return message;
  }
  return { ...message, eventType: undefined };
}

interface CanonicalLocalTranscriptMatch {
  codexMessageIndexes: ReadonlySet<number>;
  localMessageCodexOrderMatches: ReadonlyMap<string, number>;
}

function emptyCanonicalLocalTranscriptMatch(): CanonicalLocalTranscriptMatch {
  return {
    codexMessageIndexes: new Set(),
    localMessageCodexOrderMatches: new Map(),
  };
}

function codexMessagesWithoutCanonicalLocalTranscript(
  codexMessages: InternalChatMessageRecord[],
  duplicateCodexMessageIndexes: ReadonlySet<number>,
): InternalChatMessageRecord[] {
  if (duplicateCodexMessageIndexes.size === 0) {
    return codexMessages;
  }
  const filteredMessages = codexMessages.filter(
    (_, index) => !duplicateCodexMessageIndexes.has(index),
  );
  return filteredMessages;
}

function findCanonicalLocalTranscriptMatch(
  codexMessages: InternalChatMessageRecord[],
  localMessages: ChatMessageRecord[],
): CanonicalLocalTranscriptMatch {
  const matchedEntries = findCanonicalLocalTranscriptEntries(
    codexMessages,
    localMessages,
  );
  if (matchedEntries.length === 0) {
    return emptyCanonicalLocalTranscriptMatch();
  }
  return {
    codexMessageIndexes: new Set(
      matchedEntries.map((entry) => entry.codexIndex),
    ),
    localMessageCodexOrderMatches: new Map(
      matchedEntries.map((entry) => [
        entry.localId,
        entry.message.codexOrder ?? entry.codexIndex,
      ]),
    ),
  };
}

function findCanonicalLocalTranscriptEntries(
  codexMessages: InternalChatMessageRecord[],
  localMessages: ChatMessageRecord[],
): Array<{
  codexIndex: number;
  localId: string;
  message: InternalChatMessageRecord;
}> {
  const minimumCanonicalTranscriptLength = 4;
  const matchedCodexEntries: Array<{
    codexIndex: number;
    localId: string;
    message: InternalChatMessageRecord;
  }> = [];
  let nextLocalIndex = 0;
  for (const [codexIndex, codexMessage] of codexMessages.entries()) {
    if (!isTranscriptMessage(codexMessage)) {
      continue;
    }
    const matchedLocalIndex = findNextCanonicalLocalTranscriptIndex(
      localMessages,
      nextLocalIndex,
      codexMessage,
    );
    if (matchedLocalIndex === -1) {
      break;
    }
    const matchedLocalMessage = localMessages[matchedLocalIndex];
    if (!matchedLocalMessage) {
      break;
    }
    matchedCodexEntries.push({
      codexIndex,
      localId: matchedLocalMessage.id,
      message: codexMessage,
    });
    nextLocalIndex = matchedLocalIndex + 1;
  }
  const matchedMessages = matchedCodexEntries.map((entry) => entry.message);
  const hasNewerCodexTranscriptMessage =
    hasCodexTranscriptMessageAfterMatchedPrefix(
      codexMessages,
      matchedCodexEntries,
    );
  const hasSubstantialCanonicalTranscript =
    matchedMessages.length >= minimumCanonicalTranscriptLength &&
    matchedMessages.some((message) => message.role === "user") &&
    matchedMessages.filter((message) => message.role === "assistant").length >=
      2;
  const hasOpenUserBoundaryBeforeNewerCodexTranscript =
    hasNewerCodexTranscriptMessage &&
    matchedMessages[0]?.role === "user" &&
    matchedMessages.some((message) => message.role === "assistant") &&
    matchedMessages[matchedMessages.length - 1]?.role === "user";
  const hasCompletedExchangeBeforeSameTurnCodexAssistant =
    matchedMessages[0]?.role === "user" &&
    matchedMessages.some((message) => message.role === "assistant") &&
    matchedMessages[matchedMessages.length - 1]?.role === "assistant" &&
    hasSameTurnAssistantMessageAfterMatchedPrefix(
      codexMessages,
      matchedCodexEntries,
    );
  if (
    !hasSubstantialCanonicalTranscript &&
    !hasOpenUserBoundaryBeforeNewerCodexTranscript &&
    !hasCompletedExchangeBeforeSameTurnCodexAssistant
  ) {
    return [];
  }
  const codexTurnIds = new Set(
    matchedMessages.map((message) => message.codexTurnId).filter(Boolean),
  );
  if (codexTurnIds.size > 1 && !hasOpenUserBoundaryBeforeNewerCodexTranscript) {
    return [];
  }
  return matchedCodexEntries;
}

function findNextCanonicalLocalTranscriptIndex(
  localMessages: ChatMessageRecord[],
  startIndex: number,
  codexMessage: InternalChatMessageRecord,
): number {
  for (
    let localIndex = startIndex;
    localIndex < localMessages.length;
    localIndex += 1
  ) {
    const localMessage = localMessages[localIndex]!;
    if (!isTranscriptMessage(localMessage)) {
      if (isSkippableCanonicalLocalTimelineMessage(localMessage)) {
        continue;
      }
      return -1;
    }
    return messageFingerprint(localMessage) ===
      messageFingerprint(codexMessage) &&
      isLocalMessageAtOrBeforeCodexMessage(localMessage, codexMessage)
      ? localIndex
      : -1;
  }
  return -1;
}

function isSkippableCanonicalLocalTimelineMessage(
  message: ChatMessageRecord,
): boolean {
  return message.role === "event" || message.role === "error";
}

function hasCodexTranscriptMessageAfterMatchedPrefix(
  codexMessages: InternalChatMessageRecord[],
  matchedEntries: Array<{ codexIndex: number }>,
): boolean {
  const lastMatchedEntry = matchedEntries[matchedEntries.length - 1];
  if (!lastMatchedEntry) {
    return false;
  }
  return codexMessages.some(
    (message, index) =>
      index > lastMatchedEntry.codexIndex && isTranscriptMessage(message),
  );
}

function hasSameTurnAssistantMessageAfterMatchedPrefix(
  codexMessages: InternalChatMessageRecord[],
  matchedEntries: Array<{ codexIndex: number }>,
): boolean {
  const lastMatchedEntry = matchedEntries[matchedEntries.length - 1];
  if (!lastMatchedEntry) {
    return false;
  }
  const lastMatchedMessage = codexMessages[lastMatchedEntry.codexIndex];
  if (!lastMatchedMessage?.codexTurnId) {
    return false;
  }
  return codexMessages.some(
    (message, index) =>
      index > lastMatchedEntry.codexIndex &&
      message.codexTurnId === lastMatchedMessage.codexTurnId &&
      message.role === "assistant" &&
      isTranscriptMessage(message),
  );
}

function isTranscriptMessage(message: ChatMessageRecord): boolean {
  return (
    (message.role === "assistant" || message.role === "user") &&
    !isQueuedMessage(message) &&
    !isPendingSteeredMessage(message)
  );
}

function isLocalMessageAtOrBeforeCodexMessage(
  localMessage: ChatMessageRecord,
  codexMessage: InternalChatMessageRecord,
): boolean {
  if (codexMessage.hasFallbackTimestamp) {
    return true;
  }
  const codexTime = Date.parse(codexMessage.createdAt);
  const localTime = Date.parse(localMessage.createdAt);
  if (Number.isFinite(codexTime) && Number.isFinite(localTime)) {
    return localTime <= codexTime;
  }
  return localMessage.createdAt <= codexMessage.createdAt;
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
  allLocalMessages: ChatMessageRecord[],
  localMessageCodexOrderMatches: ReadonlyMap<string, number>,
  liveAssistantDeltaCodexOrderLimits: ReadonlyMap<string, number>,
  steeredLocalMessageCounts: ReadonlyMap<string, number>,
  activeTurnId: string | null,
): InternalChatMessageRecord[] {
  const orderedCodexMessages = [...codexMessages].sort(
    (left, right) => (left.codexOrder ?? 0) - (right.codexOrder ?? 0),
  );
  const allLocalMessageIndexes = new Map(
    allLocalMessages.map((message, index) => [message.id, index]),
  );
  return [
    ...orderedCodexMessages.map((message, index) => ({
      ...message,
      mergeSortBucket: (message.codexOrder ?? index) * 2,
      mergeSortIndex: 0,
    })),
    ...localMessages.map((message, index) => {
      const allLocalMessageIndex = allLocalMessageIndexes.get(message.id);
      const mergeSortBucket = getLocalMessageMergeSortBucket(
        message,
        allLocalMessageIndex ?? index,
        allLocalMessages,
        orderedCodexMessages,
        localMessageCodexOrderMatches,
        liveAssistantDeltaCodexOrderLimits,
        steeredLocalMessageCounts,
        activeTurnId,
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
  localMessageCodexOrderMatches: ReadonlyMap<string, number>,
  liveAssistantDeltaCodexOrderLimits: ReadonlyMap<string, number>,
  steeredLocalMessageCounts: ReadonlyMap<string, number>,
  activeTurnId: string | null,
): number {
  if (isPendingSteeredMessage(message)) {
    return getAfterCodexMessagesMergeSortBucket(orderedCodexMessages, 2);
  }
  if (isQueuedMessage(message)) {
    return getAfterCodexMessagesMergeSortBucket(orderedCodexMessages, 3);
  }
  const matchedCodexOrder = localMessageCodexOrderMatches.get(message.id);
  if (matchedCodexOrder !== undefined && isTranscriptMessage(message)) {
    return matchedCodexOrder * 2;
  }
  if (isLocalTimelineEvent(message)) {
    return getLocalTimelineEventMergeSortBucket(
      index,
      localMessages,
      orderedCodexMessages,
      localMessageCodexOrderMatches,
      liveAssistantDeltaCodexOrderLimits,
      steeredLocalMessageCounts,
      activeTurnId,
    );
  }
  if (isLiveAssistantDeltaMessage(message)) {
    return getLiveAssistantDeltaMergeSortBucket(
      message,
      index,
      localMessages,
      orderedCodexMessages,
      localMessageCodexOrderMatches,
      liveAssistantDeltaCodexOrderLimits,
      steeredLocalMessageCounts,
      activeTurnId,
    );
  }
  return getStandardLocalMessageMergeSortBucket(
    message,
    orderedCodexMessages,
    index,
    localMessages,
    localMessageCodexOrderMatches,
  );
}

function getAfterCodexMessagesMergeSortBucket(
  orderedCodexMessages: InternalChatMessageRecord[],
  offset: number,
): number {
  const maxCodexOrder = orderedCodexMessages.reduce(
    (maxOrder, message, index) =>
      Math.max(maxOrder, message.codexOrder ?? index),
    -1,
  );
  return (maxCodexOrder + 1) * 2 + offset;
}

function getBeforeCodexMessageMergeSortBucket(
  orderedCodexMessages: InternalChatMessageRecord[],
  insertionIndex: number,
): number {
  const codexMessage = orderedCodexMessages[insertionIndex];
  if (!codexMessage) {
    return getAfterCodexMessagesMergeSortBucket(orderedCodexMessages, 1);
  }
  return (codexMessage.codexOrder ?? insertionIndex) * 2 - 1;
}

function getLocalTimelineEventMergeSortBucket(
  index: number,
  localMessages: ChatMessageRecord[],
  orderedCodexMessages: InternalChatMessageRecord[],
  localMessageCodexOrderMatches: ReadonlyMap<string, number>,
  liveAssistantDeltaCodexOrderLimits: ReadonlyMap<string, number>,
  steeredLocalMessageCounts: ReadonlyMap<string, number>,
  activeTurnId: string | null,
): number {
  const earlierLocalBoundaryBucket = localMessages
    .slice(0, index)
    .map((message, index) => ({ index, message }))
    .reverse()
    .map(({ index, message }) =>
      getLocalTimelineEventBoundaryMergeSortBucket(
        message,
        index,
        localMessages,
        orderedCodexMessages,
        localMessageCodexOrderMatches,
        liveAssistantDeltaCodexOrderLimits,
        steeredLocalMessageCounts,
        activeTurnId,
      ),
    )
    .find((bucket): bucket is number => bucket !== null);
  const laterLocalBoundaryBucket = localMessages
    .slice(index + 1)
    .map((message, offset) => ({ index: index + offset + 1, message }))
    .map(({ index, message }) =>
      getLocalTimelineEventBoundaryMergeSortBucket(
        message,
        index,
        localMessages,
        orderedCodexMessages,
        localMessageCodexOrderMatches,
        liveAssistantDeltaCodexOrderLimits,
        steeredLocalMessageCounts,
        activeTurnId,
      ),
    )
    .find((bucket): bucket is number => bucket !== null);

  if (
    earlierLocalBoundaryBucket !== undefined &&
    laterLocalBoundaryBucket !== undefined
  ) {
    if (earlierLocalBoundaryBucket === laterLocalBoundaryBucket) {
      return earlierLocalBoundaryBucket;
    }
    if (earlierLocalBoundaryBucket < laterLocalBoundaryBucket) {
      return (
        earlierLocalBoundaryBucket +
        (laterLocalBoundaryBucket - earlierLocalBoundaryBucket) / 2
      );
    }
    return earlierLocalBoundaryBucket + 0.5;
  }
  if (earlierLocalBoundaryBucket !== undefined) {
    return earlierLocalBoundaryBucket + 0.5;
  }
  if (laterLocalBoundaryBucket === undefined) {
    return getAfterCodexMessagesMergeSortBucket(orderedCodexMessages, 1);
  }
  return laterLocalBoundaryBucket - 0.5;
}

function getLocalTimelineEventBoundaryMergeSortBucket(
  message: ChatMessageRecord,
  index: number,
  localMessages: ChatMessageRecord[],
  orderedCodexMessages: InternalChatMessageRecord[],
  localMessageCodexOrderMatches: ReadonlyMap<string, number>,
  liveAssistantDeltaCodexOrderLimits: ReadonlyMap<string, number>,
  steeredLocalMessageCounts: ReadonlyMap<string, number>,
  activeTurnId: string | null,
): number | null {
  if (!isLocalTimelineEventBoundary(message)) {
    return null;
  }
  if (isLiveAssistantDeltaBoundaryUserMessage(message)) {
    const boundaryBucket = getLocalUserBoundaryMergeSortBucket(
      message,
      index,
      localMessages,
      orderedCodexMessages,
      localMessageCodexOrderMatches,
    );
    if (boundaryBucket !== null) {
      return boundaryBucket;
    }
  }
  if (isPendingSteeredMessage(message)) {
    return getAfterCodexMessagesMergeSortBucket(orderedCodexMessages, 2);
  }
  if (isQueuedMessage(message)) {
    return getAfterCodexMessagesMergeSortBucket(orderedCodexMessages, 3);
  }
  if (!isLiveAssistantDeltaMessage(message)) {
    return null;
  }
  return (
    getMergedLiveAssistantDeltaMergeSortBucket(
      message,
      orderedCodexMessages,
      localMessageCodexOrderMatches,
    ) ??
    getLiveAssistantDeltaMergeSortBucket(
      message,
      index,
      localMessages,
      orderedCodexMessages,
      localMessageCodexOrderMatches,
      liveAssistantDeltaCodexOrderLimits,
      steeredLocalMessageCounts,
      activeTurnId,
    )
  );
}

function getStandardLocalMessageMergeSortBucket(
  message: ChatMessageRecord,
  orderedCodexMessages: InternalChatMessageRecord[],
  index?: number,
  localMessages?: ChatMessageRecord[],
  localMessageCodexOrderMatches?: ReadonlyMap<string, number>,
): number {
  const insertionIndex = orderedCodexMessages.findIndex(
    (codexMessage) => codexMessage.createdAt > message.createdAt,
  );
  if (
    insertionIndex !== -1 &&
    orderedCodexMessages[insertionIndex]?.hasFallbackTimestamp
  ) {
    const nextTrustedInsertionIndex = orderedCodexMessages.findIndex(
      (codexMessage, index) =>
        index > insertionIndex &&
        !codexMessage.hasFallbackTimestamp &&
        codexMessage.createdAt > message.createdAt,
    );
    return applyEarlierLocalCodexBoundary(
      nextTrustedInsertionIndex === -1
        ? getAfterCodexMessagesMergeSortBucket(orderedCodexMessages, 1)
        : getBeforeCodexMessageMergeSortBucket(
            orderedCodexMessages,
            nextTrustedInsertionIndex,
          ),
      index,
      localMessages,
      localMessageCodexOrderMatches,
    );
  }
  const bucket =
    insertionIndex === -1
      ? getAfterCodexMessagesMergeSortBucket(orderedCodexMessages, 1)
      : getBeforeCodexMessageMergeSortBucket(
          orderedCodexMessages,
          insertionIndex,
        );
  return applyEarlierLocalCodexBoundary(
    bucket,
    index,
    localMessages,
    localMessageCodexOrderMatches,
  );
}

function applyEarlierLocalCodexBoundary(
  bucket: number,
  index: number | undefined,
  localMessages: ChatMessageRecord[] | undefined,
  localMessageCodexOrderMatches: ReadonlyMap<string, number> | undefined,
): number {
  if (index === undefined || !localMessages || !localMessageCodexOrderMatches) {
    return bucket;
  }
  const earlierMatchedCodexOrder = localMessages
    ? getEarlierLocalCodexOrder(
        index,
        localMessages,
        localMessageCodexOrderMatches,
      )
    : undefined;
  if (earlierMatchedCodexOrder === undefined) {
    return bucket;
  }
  return Math.max(bucket, earlierMatchedCodexOrder * 2 + 0.5);
}

function getEarlierLocalCodexOrder(
  index: number,
  localMessages: ChatMessageRecord[],
  localMessageCodexOrderMatches: ReadonlyMap<string, number>,
): number | undefined {
  return localMessages
    .slice(0, index)
    .reverse()
    .map((message) => localMessageCodexOrderMatches.get(message.id))
    .find((codexOrder): codexOrder is number => codexOrder !== undefined);
}

function getMergedLiveAssistantDeltaMergeSortBucket(
  message: ChatMessageRecord,
  orderedCodexMessages: InternalChatMessageRecord[],
  localMessageCodexOrderMatches: ReadonlyMap<string, number>,
): number | null {
  const matchedCodexOrder = localMessageCodexOrderMatches.get(message.id);
  if (matchedCodexOrder !== undefined) {
    return matchedCodexOrder * 2;
  }
  const matchedCodexMessage = orderedCodexMessages.find(
    (codexMessage) =>
      codexMessage.role === "assistant" &&
      (codexMessage.id === message.id ||
        (Boolean(message.itemId) && codexMessage.itemId === message.itemId)),
  );
  if (!matchedCodexMessage) {
    return null;
  }
  const codexOrder = matchedCodexMessage.codexOrder;
  if (codexOrder !== undefined) {
    return codexOrder * 2;
  }
  const index = orderedCodexMessages.indexOf(matchedCodexMessage);
  return index === -1 ? null : index * 2;
}

function getLocalUserBoundaryMergeSortBucket(
  message: ChatMessageRecord,
  index: number,
  localMessages: ChatMessageRecord[],
  orderedCodexMessages: InternalChatMessageRecord[],
  localMessageCodexOrderMatches: ReadonlyMap<string, number>,
): number | null {
  const matchedCodexOrder = localMessageCodexOrderMatches.get(message.id);
  if (matchedCodexOrder !== undefined) {
    return matchedCodexOrder * 2;
  }
  if (!message.eventType) {
    return getStandardLocalMessageMergeSortBucket(
      message,
      orderedCodexMessages,
      index,
      localMessages,
      localMessageCodexOrderMatches,
    );
  }
  return null;
}

function getLiveAssistantDeltaMergeSortBucket(
  message: ChatMessageRecord,
  index: number,
  localMessages: ChatMessageRecord[],
  orderedCodexMessages: InternalChatMessageRecord[],
  localMessageCodexOrderMatches: ReadonlyMap<string, number>,
  liveAssistantDeltaCodexOrderLimits: ReadonlyMap<string, number>,
  steeredLocalMessageCounts: ReadonlyMap<string, number>,
  activeTurnId: string | null,
): number {
  const boundaryInsertionIndex = findLiveAssistantDeltaBoundaryInsertionIndex(
    message,
    index,
    localMessages,
    orderedCodexMessages,
    liveAssistantDeltaCodexOrderLimits,
    steeredLocalMessageCounts,
    activeTurnId,
  );
  if (boundaryInsertionIndex === null) {
    const earlierMatchedCodexOrder = getEarlierLocalCodexOrder(
      index,
      localMessages,
      localMessageCodexOrderMatches,
    );
    return earlierMatchedCodexOrder === undefined
      ? getAfterCodexMessagesMergeSortBucket(orderedCodexMessages, 1)
      : earlierMatchedCodexOrder * 2 + 0.5;
  }
  const bucket = getBeforeCodexMessageMergeSortBucket(
    orderedCodexMessages,
    boundaryInsertionIndex,
  );
  return applyEarlierLocalCodexBoundary(
    bucket,
    index,
    localMessages,
    localMessageCodexOrderMatches,
  );
}

function findLiveAssistantDeltaBoundaryInsertionIndex(
  message: ChatMessageRecord,
  index: number,
  localMessages: ChatMessageRecord[],
  orderedCodexMessages: InternalChatMessageRecord[],
  liveAssistantDeltaCodexOrderLimits: ReadonlyMap<string, number>,
  steeredLocalMessageCounts: ReadonlyMap<string, number>,
  activeTurnId: string | null,
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
    activeTurnId,
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
  activeTurnId: string | null,
): number | undefined {
  const matchedIndexes = unmatchedCodexMessageIndexes.filter((index) => {
    const codexMessage = codexMessages[index];
    return codexMessage
      ? shouldDeduplicateLocalMessage(
          codexMessage,
          localMessage,
          liveAssistantDeltaCodexOrderLimits,
          activeTurnId,
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

function findLocalSteeredTurnId(messages: ChatMessageRecord[]): string | null {
  return (
    messages.find((message) => message.eventType === "chat.message.steered")
      ?.itemId ?? null
  );
}

function shouldDeduplicateLocalMessage(
  codexMessage: InternalChatMessageRecord,
  localMessage: ChatMessageRecord,
  liveAssistantDeltaCodexOrderLimits: ReadonlyMap<string, number>,
  activeTurnId: string | null,
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
  if (
    isCodexTimestampTrustedForDeduplication(codexMessage, activeTurnId) &&
    isCodexMessageAtOrAfterLocalMessage(codexMessage, localMessage)
  ) {
    return true;
  }
  return isRelaxedSteeredCodexMatch(codexMessage, localMessage);
}

function isCodexTimestampTrustedForDeduplication(
  codexMessage: InternalChatMessageRecord,
  activeTurnId: string | null,
): boolean {
  return (
    !codexMessage.hasFallbackTimestamp ||
    (activeTurnId !== null && codexMessage.codexTurnId === activeTurnId)
  );
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

function findFallbackTranscriptLocalMessageMatches(
  codexMessages: InternalChatMessageRecord[],
  localMessages: ChatMessageRecord[],
  activeTurnId: string | null,
  activeLocalTurnStartIndex: number,
): ReadonlyMap<string, number> {
  const localEntries = localMessages
    .map((message, index) => ({ index, message }))
    .filter(({ message }) => isFallbackTranscriptMatchableLocalMessage(message))
    .filter(
      ({ index }) => activeTurnId === null || index < activeLocalTurnStartIndex,
    );
  if (localEntries.length === 0) {
    return new Map();
  }

  const codexEntriesByTurnId = new Map<
    string,
    Array<{ index: number; message: InternalChatMessageRecord }>
  >();
  for (const [index, message] of codexMessages.entries()) {
    if (
      !message.hasFallbackTimestamp ||
      !message.codexTurnId ||
      message.codexTurnId === activeTurnId
    ) {
      continue;
    }
    const entries = codexEntriesByTurnId.get(message.codexTurnId) ?? [];
    entries.push({ index, message });
    codexEntriesByTurnId.set(message.codexTurnId, entries);
  }

  const matches = new Map<string, number>();
  const usedLocalMessageIds = new Set<string>();
  let nextSearchLocalEntryIndex = localEntries.length;
  const codexTurnEntries = [...codexEntriesByTurnId.values()];
  for (
    let turnEntryIndex = codexTurnEntries.length - 1;
    turnEntryIndex >= 0;
    turnEntryIndex -= 1
  ) {
    const entries = codexTurnEntries[turnEntryIndex]!;
    const orderedEntries = [...entries].sort(
      (left, right) =>
        (left.message.codexOrder ?? left.index) -
        (right.message.codexOrder ?? right.index),
    );
    if (
      orderedEntries.length === 0 ||
      !orderedEntries.some(({ message }) => message.role === "assistant")
    ) {
      continue;
    }

    let turnMatches: Array<{
      codexIndex: number;
      localEntryIndex: number;
      localMessageId: string;
    }> = [];
    let candidateStartIndex = nextSearchLocalEntryIndex - orderedEntries.length;
    while (candidateStartIndex >= 0) {
      const candidateMatches: Array<{
        codexIndex: number;
        localEntryIndex: number;
        localMessageId: string;
      }> = [];
      let nextLocalEntryIndex = candidateStartIndex;
      for (const { index, message } of orderedEntries) {
        const localEntry = localEntries[nextLocalEntryIndex];
        if (
          !localEntry ||
          usedLocalMessageIds.has(localEntry.message.id) ||
          messageFingerprint(localEntry.message) !== messageFingerprint(message)
        ) {
          candidateMatches.length = 0;
          break;
        }
        candidateMatches.push({
          codexIndex: index,
          localEntryIndex: nextLocalEntryIndex,
          localMessageId: localEntry.message.id,
        });
        nextLocalEntryIndex += 1;
      }

      if (candidateMatches.length > 0) {
        turnMatches = candidateMatches;
        break;
      }
      candidateStartIndex -= 1;
    }

    if (turnMatches.length === 0) {
      continue;
    }
    for (const match of turnMatches) {
      matches.set(match.localMessageId, match.codexIndex);
      usedLocalMessageIds.add(match.localMessageId);
    }
    nextSearchLocalEntryIndex =
      turnMatches[0]?.localEntryIndex ?? nextSearchLocalEntryIndex;
  }
  return matches;
}

function findActiveLocalTurnStartIndex(messages: ChatMessageRecord[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (
      message.role === "user" &&
      !isQueuedMessage(message) &&
      !isPendingSteeredMessage(message)
    ) {
      return index;
    }
  }
  return messages.length;
}

function isFallbackTranscriptMatchableLocalMessage(
  message: ChatMessageRecord,
): boolean {
  return (
    (message.role === "assistant" || message.role === "user") &&
    !isQueuedMessage(message) &&
    !isPendingSteeredMessage(message)
  );
}

function isLocalTimelineEvent(message: ChatMessageRecord): boolean {
  return message.role === "event" || message.role === "error";
}

function isLocalTimelineEventBoundary(message: ChatMessageRecord): boolean {
  return (
    isLiveAssistantDeltaMessage(message) ||
    isLiveAssistantDeltaBoundaryUserMessage(message) ||
    isPendingSteeredMessage(message) ||
    isQueuedMessage(message)
  );
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
  activeTurnId: string | null,
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
      activeTurnId,
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
  activeTurnId: string | null,
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
      activeTurnId,
    );
  }
  return findBoundaryCodexMessageForLocalOccurrence(
    codexMessages,
    localMessages,
    laterUserMessageIndex,
    laterUserMessage,
    activeTurnId,
  );
}

function findBoundaryCodexMessageForLocalOccurrence(
  codexMessages: InternalChatMessageRecord[],
  localMessages: ChatMessageRecord[],
  localMessageIndex: number,
  localMessage: ChatMessageRecord,
  activeTurnId: string | null,
): InternalChatMessageRecord | undefined {
  const fingerprint = messageFingerprint(localMessage);
  const localOccurrenceIndex =
    localMessages
      .slice(0, localMessageIndex + 1)
      .filter(
        (message) =>
          !getSteeredMessageGroupKey(message) &&
          isLiveAssistantDeltaBoundaryUserMessage(message) &&
          messageFingerprint(message) === fingerprint,
      ).length - 1;
  if (localOccurrenceIndex < 0) {
    return undefined;
  }
  const candidates = codexMessages
    .filter((codexMessage) => messageFingerprint(codexMessage) === fingerprint)
    .sort((left, right) => (left.codexOrder ?? 0) - (right.codexOrder ?? 0));
  return candidates
    .slice(localOccurrenceIndex)
    .find((codexMessage) =>
      isCodexBoundaryUserMessage(codexMessage, localMessage, activeTurnId),
    );
}

function findSteeredBoundaryCodexMessageForLocalOccurrence(
  codexMessages: InternalChatMessageRecord[],
  localMessages: ChatMessageRecord[],
  localMessageIndex: number,
  localMessage: ChatMessageRecord,
  steeredLocalMessageCounts: ReadonlyMap<string, number>,
  activeTurnId: string | null,
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
  return candidate &&
    isCodexBoundaryUserMessage(candidate, localMessage, activeTurnId)
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
  activeTurnId: string | null,
): boolean {
  if (messageFingerprint(codexMessage) !== messageFingerprint(localMessage)) {
    return false;
  }
  if (localMessage.eventType === "chat.message.steered") {
    return (
      (isCodexTimestampTrustedForDeduplication(codexMessage, activeTurnId) &&
        isCodexMessageAtOrAfterLocalMessage(codexMessage, localMessage)) ||
      isRelaxedSteeredCodexMatch(codexMessage, localMessage)
    );
  }
  return (
    isCodexTimestampTrustedForDeduplication(codexMessage, activeTurnId) &&
    isCodexMessageAtOrAfterLocalMessage(codexMessage, localMessage)
  );
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
  delete publicMessage.codexTurnId;
  delete publicMessage.hasFallbackTimestamp;
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

function normalizeAttachmentRecords(
  items: ChatAttachmentRecord[] | undefined,
): ChatAttachmentRecord[] {
  return (items ?? [])
    .map((item) => ({
      name: item.name.trim(),
      path: item.path.trim(),
      mimeType: item.mimeType.trim().toLowerCase(),
      size: item.size,
    }))
    .filter(
      (item) =>
        item.name &&
        item.path &&
        item.mimeType.startsWith("image/") &&
        Number.isInteger(item.size) &&
        item.size > 0 &&
        item.size <= maxAttachmentBytes,
    );
}

function sanitizeAttachmentName(name: string): string {
  const trimmedName = basename(name.trim());
  const safeName = trimmedName.replace(/[^\w .-]+/g, "_").trim();
  return safeName || "attachment";
}

function sanitizeAttachmentExtension(name: string, mimeType: string): string {
  const currentExtension = extname(name).toLowerCase();
  if (mimeType === "image/png" && currentExtension === ".png") {
    return currentExtension;
  }
  return ".png";
}

function detectSupportedImageMimeType(bytes: Uint8Array): string | null {
  if (isValidPng(bytes)) {
    return "image/png";
  }
  return null;
}

function isValidPng(bytes: Uint8Array): boolean {
  if (
    bytes.length < 33 ||
    bytes[0] !== 0x89 ||
    bytes[1] !== 0x50 ||
    bytes[2] !== 0x4e ||
    bytes[3] !== 0x47 ||
    bytes[4] !== 0x0d ||
    bytes[5] !== 0x0a ||
    bytes[6] !== 0x1a ||
    bytes[7] !== 0x0a
  ) {
    return false;
  }

  let offset = 8;
  let sawIhdr = false;
  const idatChunks: Uint8Array[] = [];
  let pngHeader: PngHeader | null = null;
  let finishedIdat = false;
  let sawIdat = false;
  let sawPlte = false;
  while (offset + 12 <= bytes.length) {
    const chunkLength = readUint32(bytes, offset);
    const chunkTypeOffset = offset + 4;
    const chunkDataOffset = offset + 8;
    const nextOffset = chunkDataOffset + chunkLength + 4;
    if (nextOffset > bytes.length) {
      return false;
    }

    const chunkType = readAscii(bytes, chunkTypeOffset, 4);
    if (!sawIhdr) {
      const header = parsePngHeader(
        bytes.subarray(chunkDataOffset, chunkDataOffset + 13),
      );
      if (chunkType !== "IHDR" || chunkLength !== 13 || !header) {
        return false;
      }
      pngHeader = header;
      sawIhdr = true;
    } else if (chunkType === "IHDR") {
      return false;
    }
    if (
      crc32(bytes.subarray(chunkTypeOffset, chunkDataOffset + chunkLength)) !==
      readUint32(bytes, chunkDataOffset + chunkLength)
    ) {
      return false;
    }
    if (chunkType === "IEND") {
      return (
        chunkLength === 0 &&
        sawIdat &&
        isValidPngPaletteState(pngHeader, sawPlte) &&
        pngHeader != null &&
        nextOffset === bytes.length &&
        isValidPngImageData(idatChunks, pngHeader)
      );
    }
    if (sawIdat && chunkType !== "IDAT") {
      finishedIdat = true;
    }
    if (chunkType === "PLTE") {
      if (
        !pngHeader ||
        sawIdat ||
        sawPlte ||
        !isValidPngPaletteChunk(chunkLength, pngHeader)
      ) {
        return false;
      }
      sawPlte = true;
    }
    if (chunkType === "IDAT") {
      if (
        chunkLength === 0 ||
        finishedIdat ||
        !isValidPngPaletteState(pngHeader, sawPlte)
      ) {
        return false;
      }
      idatChunks.push(
        bytes.subarray(chunkDataOffset, chunkDataOffset + chunkLength),
      );
      sawIdat = true;
    }
    offset = nextOffset;
  }

  return false;
}

function isValidPngPaletteState(
  header: PngHeader | null,
  sawPlte: boolean,
): boolean {
  if (!header) {
    return false;
  }
  if (header.colorType === 3) {
    return sawPlte;
  }
  return header.colorType === 2 || header.colorType === 6 ? true : !sawPlte;
}

function isValidPngPaletteChunk(
  chunkLength: number,
  header: PngHeader,
): boolean {
  if (
    header.colorType !== 3 &&
    header.colorType !== 2 &&
    header.colorType !== 6
  ) {
    return false;
  }
  const paletteEntries = chunkLength / 3;
  return (
    Number.isInteger(paletteEntries) &&
    paletteEntries >= 1 &&
    paletteEntries <= 256 &&
    (header.colorType !== 3 || paletteEntries <= 2 ** header.bitDepth)
  );
}

function isValidPngImageData(chunks: Uint8Array[], header: PngHeader): boolean {
  const expectedByteLength = getExpectedPngImageDataByteLength(header);
  if (
    expectedByteLength == null ||
    expectedByteLength <= 0 ||
    expectedByteLength > maxDecodedImageBytes
  ) {
    return false;
  }

  const totalLength = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const bytes = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }

  try {
    const inflated = inflateSync(bytes, {
      maxOutputLength: expectedByteLength + 1,
    });
    return (
      inflated.byteLength === expectedByteLength &&
      hasValidPngScanlineFilters(inflated, header)
    );
  } catch {
    return false;
  }
}

function hasValidPngScanlineFilters(
  bytes: Uint8Array,
  header: PngHeader,
): boolean {
  const rowLengths = getPngImageDataRowLengths(header);
  if (!rowLengths) {
    return false;
  }

  let offset = 0;
  for (const rowLength of rowLengths) {
    const filterType = bytes[offset];
    if (filterType == null || filterType > 4) {
      return false;
    }
    offset += rowLength;
  }
  return offset === bytes.length;
}

function parsePngHeader(bytes: Uint8Array): PngHeader | null {
  const width = readUint32(bytes, 0);
  const height = readUint32(bytes, 4);
  const bitDepth = bytes[8];
  const colorType = bytes[9];
  const compressionMethod = bytes[10];
  const filterMethod = bytes[11];
  const interlaceMethod = bytes[12];
  if (
    bytes.length === 13 &&
    width > 0 &&
    height > 0 &&
    isValidPngColorTypeAndBitDepth(colorType, bitDepth) &&
    compressionMethod === 0 &&
    filterMethod === 0 &&
    (interlaceMethod === 0 || interlaceMethod === 1)
  ) {
    return {
      bitDepth: bitDepth ?? 0,
      colorType: colorType ?? 0,
      height,
      interlaceMethod,
      width,
    };
  }
  return null;
}

function getExpectedPngImageDataByteLength(header: PngHeader): number | null {
  const rowLengths = getPngImageDataRowLengths(header);
  if (!rowLengths) {
    return null;
  }
  const totalByteLength = rowLengths.reduce(
    (total, rowLength) => total + rowLength,
    0,
  );
  return Number.isSafeInteger(totalByteLength) ? totalByteLength : null;
}

function getPngImageDataRowLengths(header: PngHeader): number[] | null {
  const samplesPerPixel = getPngSamplesPerPixel(header.colorType);
  if (samplesPerPixel == null) {
    return null;
  }
  if (header.interlaceMethod === 0) {
    const rowLength = getPngRowLength(header.width, samplesPerPixel, header);
    return rowLength == null ? null : Array(header.height).fill(rowLength);
  }
  if (header.interlaceMethod !== 1) {
    return null;
  }

  const rowLengths: number[] = [];
  for (const pass of adam7Passes) {
    const passWidth = getAdam7PassSize(header.width, pass.xStart, pass.xStep);
    const passHeight = getAdam7PassSize(header.height, pass.yStart, pass.yStep);
    if (passWidth === 0 || passHeight === 0) {
      continue;
    }
    const rowLength = getPngRowLength(passWidth, samplesPerPixel, header);
    if (rowLength == null) {
      return null;
    }
    rowLengths.push(...Array(passHeight).fill(rowLength));
  }
  return rowLengths.length > 0 ? rowLengths : null;
}

const adam7Passes = [
  { xStart: 0, xStep: 8, yStart: 0, yStep: 8 },
  { xStart: 4, xStep: 8, yStart: 0, yStep: 8 },
  { xStart: 0, xStep: 4, yStart: 4, yStep: 8 },
  { xStart: 2, xStep: 4, yStart: 0, yStep: 4 },
  { xStart: 0, xStep: 2, yStart: 2, yStep: 4 },
  { xStart: 1, xStep: 2, yStart: 0, yStep: 2 },
  { xStart: 0, xStep: 1, yStart: 1, yStep: 2 },
] as const;

function getAdam7PassSize(
  imageSize: number,
  passStart: number,
  passStep: number,
): number {
  return imageSize > passStart
    ? Math.floor((imageSize - passStart + passStep - 1) / passStep)
    : 0;
}

function getPngRowLength(
  width: number,
  samplesPerPixel: number,
  header: PngHeader,
): number | null {
  const bitsPerScanline = width * samplesPerPixel * header.bitDepth;
  const bytesPerScanline = Math.ceil(bitsPerScanline / 8);
  const rowLength = bytesPerScanline + 1;
  return Number.isSafeInteger(rowLength) ? rowLength : null;
}

function getPngSamplesPerPixel(colorType: number): number | null {
  switch (colorType) {
    case 0:
    case 3:
      return 1;
    case 2:
      return 3;
    case 4:
      return 2;
    case 6:
      return 4;
    default:
      return null;
  }
}

function isValidPngColorTypeAndBitDepth(
  colorType: number | undefined,
  bitDepth: number | undefined,
): boolean {
  switch (colorType) {
    case 0:
      return [1, 2, 4, 8, 16].includes(bitDepth ?? 0);
    case 2:
    case 4:
    case 6:
      return bitDepth === 8 || bitDepth === 16;
    case 3:
      return [1, 2, 4, 8].includes(bitDepth ?? 0);
    default:
      return false;
  }
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] ?? 0) * 0x1000000 +
      ((bytes[offset + 1] ?? 0) << 16) +
      ((bytes[offset + 2] ?? 0) << 8) +
      (bytes[offset + 3] ?? 0)) >>>
    0
  );
}

function readAscii(bytes: Uint8Array, offset: number, length: number): string {
  let value = "";
  for (let index = 0; index < length; index += 1) {
    value += String.fromCharCode(bytes[offset + index] ?? 0);
  }
  return value;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
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
        additionalSpeedTiers: getStringArray(model.additionalSpeedTiers),
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

function getProjectSkillRoots(
  state: ServeState,
  project: ProjectRecord,
): string[] {
  return Array.from(
    new Set([
      project.rootPath,
      ...state.chats
        .filter((chat) => chat.projectId === project.id)
        .map((chat) => chat.worktreePath),
    ]),
  ).sort((left, right) => right.length - left.length);
}

function getSkillListRoots(chat: ChatRecord, project: ProjectRecord): string[] {
  return Array.from(new Set([chat.worktreePath, project.rootPath]));
}

function sortSkillsByRootPreference(
  skills: CodexSkillRecord[],
  roots: string[],
): CodexSkillRecord[] {
  return [...skills].sort(
    (left, right) =>
      getPathRootIndex(left.path, roots) - getPathRootIndex(right.path, roots),
  );
}

function getPathRootIndex(path: string, roots: string[]): number {
  if (!isAbsolute(path)) {
    return roots.length;
  }
  const rootIndex = roots.findIndex((root) => isPathInside(root, path));
  return rootIndex === -1 ? roots.length : rootIndex;
}

function normalizeRecentProjectSkillRecordPaths(
  records: RecentProjectSkillRecord[],
  projectSkillRoots: string[],
): RecentProjectSkillRecord[] {
  const seenSkillPaths = new Set<string>();
  return records
    .map((record) => ({
      ...record,
      path: normalizeProjectSkillPath(record.path, projectSkillRoots),
    }))
    .filter((record) => {
      if (seenSkillPaths.has(record.path)) {
        return false;
      }
      seenSkillPaths.add(record.path);
      return true;
    });
}

function normalizeProjectSkillPath(
  skillPath: string,
  projectSkillRoots: string[],
): string {
  const trimmedSkillPath = skillPath.trim();
  if (!isAbsolute(trimmedSkillPath)) {
    return trimmedSkillPath;
  }

  for (const root of projectSkillRoots) {
    const relativeSkillPath = relative(root, trimmedSkillPath);
    if (
      relativeSkillPath &&
      !relativeSkillPath.startsWith(`..${sep}`) &&
      relativeSkillPath !== ".." &&
      !isAbsolute(relativeSkillPath)
    ) {
      return relativeSkillPath.split(sep).join("/");
    }
  }

  return trimmedSkillPath;
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
  files: string[];
  hasDiff: boolean;
  hiddenContentUpdateCount?: number;
}

interface FilePatchEventData {
  changes: Array<{
    kind: string;
    path: string;
  }>;
  hiddenContentUpdateCount?: number;
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
  const files =
    diff === "" ? (getRecordStringArray(params, "files") ?? []) : [];
  return {
    files: diff === "" ? files : extractDiffFilePaths(diff),
    hasDiff: getRecordBoolean(params, "hasDiff") ?? Boolean(diff),
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
      };
    })
    .filter((change): change is FilePatchEventData["changes"][number] =>
      Boolean(change),
    );
  return { changes };
}

function summarizeDiffEvent(eventData: DiffEventData): string {
  if (eventData.files.length === 0) {
    return eventData.hasDiff ? "Diff updated" : "Diff cleared";
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
  const hiddenContentLength = getRecordNumber(params, "hiddenContentLength");
  if (method === "command/exec/outputDelta") {
    return {
      kind: "commandExecOutput",
      processId: getRecordString(params, "processId") ?? null,
      stream: getRecordString(params, "stream") ?? "stdout",
      capReached: Boolean(isRecord(params) && params.capReached === true),
      ...(hiddenContentLength === undefined ? {} : { hiddenContentLength }),
    };
  }
  return {
    kind: "commandExecutionOutput",
    ...(hiddenContentLength === undefined ? {} : { hiddenContentLength }),
  };
}

function createFileChangeOutputEventData(
  params: unknown,
): Record<string, unknown> {
  const hiddenContentLength = getRecordNumber(params, "hiddenContentLength");
  return {
    kind: "fileChangeOutput",
    ...(hiddenContentLength === undefined ? {} : { hiddenContentLength }),
  };
}

function hasHiddenOutputDelta(params: unknown): boolean {
  return (getRecordNumber(params, "hiddenContentDeltaCount") ?? 0) > 0;
}

function hasCommandOutputMetadataUpdate(
  method: string,
  params: unknown,
): boolean {
  return (
    method === "command/exec/outputDelta" &&
    isRecord(params) &&
    params.capReached === true
  );
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

function sanitizeCodexMessageForEventHub(message: CodexMessage): CodexMessage {
  const method = message.method ?? "";
  const params = sanitizeCodexEventParams(method, message.params);
  return params === message.params ? message : { ...message, params };
}

function sanitizeCodexEventParams(method: string, params: unknown): unknown {
  if (!isRecord(params)) {
    return params;
  }

  if (
    method === "item/commandExecution/outputDelta" ||
    method === "command/exec/outputDelta" ||
    method === "item/fileChange/outputDelta"
  ) {
    const delta =
      method === "command/exec/outputDelta"
        ? getRecordString(params, "deltaBase64")
        : getRecordString(params, "delta");
    const nextParams = { ...params };
    delete nextParams.delta;
    delete nextParams.deltaBase64;
    if (delta) {
      nextParams.hiddenContentDeltaCount = 1;
      nextParams.hiddenContentLength =
        method === "command/exec/outputDelta"
          ? Buffer.from(delta, "base64").byteLength
          : delta.length;
    }
    return nextParams;
  }

  if (method === "turn/diff/updated") {
    return stripDiffEventData(params);
  }

  if (method === "item/fileChange/patchUpdated") {
    return stripFilePatchDiffs(params);
  }

  if (method.endsWith("/requestApproval")) {
    return stripHiddenCodexPayloadContent(params);
  }

  if (method === "item/started" || method === "item/completed") {
    const item = getRecordObject(params, "item");
    if (!item) {
      return params;
    }
    const nextItem = sanitizeCodexEventItem(item);
    return nextItem === item ? params : { ...params, item: nextItem };
  }

  return params;
}

const hiddenCodexWarningMessages = new Set([
  "automatic approval review approved",
]);

function isHiddenCodexWarning(method: string, params: unknown): boolean {
  if (
    method !== "warning" &&
    method !== "guardianWarning" &&
    method !== "configWarning"
  ) {
    return false;
  }

  const object = getParamObject(params);
  const candidates = [
    summarizeCodexEvent(method, params),
    typeof object?.message === "string" ? object.message : null,
    typeof object?.summary === "string" ? object.summary : null,
  ];
  return candidates.some(
    (candidate) =>
      typeof candidate === "string" &&
      hiddenCodexWarningMessages.has(normalizeCodexWarningMessage(candidate)),
  );
}

function normalizeCodexWarningMessage(message: string): string {
  return message.trim().replace(/\s+/g, " ").toLowerCase();
}

function sanitizeCodexEventItem(item: Record<string, unknown>): unknown {
  const itemType = getRecordString(item, "type");
  if (itemType === "commandExecution") {
    return stripRecordKey(item, "aggregatedOutput");
  }
  if (itemType === "fileChange") {
    return stripFilePatchDiffs(item);
  }
  return item;
}

function stripHiddenRichEventContent(
  message: ChatMessageRecord,
): ChatMessageRecord {
  if (!hasHiddenRichEventContent(message)) {
    return message;
  }

  if (
    message.eventType === "item/commandExecution/outputDelta" ||
    message.eventType === "command/exec/outputDelta" ||
    message.eventType === "item/fileChange/outputDelta"
  ) {
    return {
      ...message,
      eventData: stripRecordKey(message.eventData, "text"),
      text: "",
    };
  }

  if (message.eventType === "turn/diff/updated") {
    return {
      ...message,
      eventData: stripDiffEventData(message.eventData),
    };
  }

  if (message.eventType === "item/fileChange/patchUpdated") {
    return {
      ...message,
      eventData: stripFilePatchDiffs(message.eventData),
    };
  }

  return message;
}

function hasHiddenRichEventContent(message: ChatMessageRecord): boolean {
  if (message.role !== "event") {
    return false;
  }

  if (
    message.eventType === "item/commandExecution/outputDelta" ||
    message.eventType === "command/exec/outputDelta" ||
    message.eventType === "item/fileChange/outputDelta"
  ) {
    return (
      message.text !== "" ||
      getRecordString(message.eventData, "text") !== undefined
    );
  }

  if (message.eventType === "turn/diff/updated") {
    return getRecordString(message.eventData, "diff") !== undefined;
  }

  if (message.eventType === "item/fileChange/patchUpdated") {
    const changes = getRecordArray(message.eventData, "changes") ?? [];
    return changes.some(
      (change) => getRecordString(change, "diff") !== undefined,
    );
  }

  return false;
}

function shouldStripHiddenRichEventContent(eventType: string): boolean {
  return (
    eventType === "item/commandExecution/outputDelta" ||
    eventType === "command/exec/outputDelta" ||
    eventType === "item/fileChange/outputDelta"
  );
}

function stripRecordKey(value: unknown, key: string): unknown {
  if (!isRecord(value)) {
    return value;
  }
  const nextValue = { ...value };
  delete nextValue[key];
  return nextValue;
}

function withHiddenContentUpdateCount(
  eventType: string,
  existingEventData: Record<string, unknown>,
  eventData: unknown,
): unknown {
  if (!shouldTrackHiddenContentUpdate(eventType) || !isRecord(eventData)) {
    return eventData;
  }
  return {
    ...eventData,
    hiddenContentUpdateCount:
      (getRecordNumber(existingEventData, "hiddenContentUpdateCount") ?? 0) + 1,
  };
}

function shouldTrackHiddenContentUpdate(eventType: string): boolean {
  return (
    eventType === "turn/diff/updated" ||
    eventType === "item/fileChange/patchUpdated"
  );
}

function stripDiffEventData(value: unknown): unknown {
  if (!isRecord(value)) {
    return value;
  }
  const diff = getRecordString(value, "diff");
  const nextValue = { ...value };
  delete nextValue.diff;
  if (diff) {
    if (!Array.isArray(nextValue.files)) {
      nextValue.files = extractDiffFilePaths(diff);
    }
    if (typeof nextValue.hasDiff !== "boolean") {
      nextValue.hasDiff = true;
    }
  }
  return nextValue;
}

function stripFilePatchDiffs(value: unknown): unknown {
  if (!isRecord(value)) {
    return value;
  }
  const changes = value.changes;
  if (!Array.isArray(changes)) {
    return value;
  }
  return {
    ...value,
    changes: changes.map((change) => stripRecordKey(change, "diff")),
  };
}

function stripHiddenCodexPayloadContent(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripHiddenCodexPayloadContent);
  }
  if (!isRecord(value)) {
    return value;
  }
  const nextValue: Record<string, unknown> = {};
  for (const [key, childValue] of Object.entries(value)) {
    if (
      key === "aggregatedOutput" ||
      key === "delta" ||
      key === "deltaBase64" ||
      key === "diff"
    ) {
      continue;
    }
    nextValue[key] = stripHiddenCodexPayloadContent(childValue);
  }
  return nextValue;
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

function getRecordBoolean(value: unknown, key: string): boolean | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const candidate = value[key];
  return typeof candidate === "boolean" ? candidate : undefined;
}

function getRecordStringArray(
  value: unknown,
  key: string,
): string[] | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const candidate = value[key];
  if (!Array.isArray(candidate)) {
    return undefined;
  }
  return candidate.filter(
    (entry): entry is string => typeof entry === "string",
  );
}

function getStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isLocallyEmptyChat(state: ServeState, chat: ChatRecord): boolean {
  return (
    !state.messages.some((message) => message.chatId === chat.id) &&
    !state.queuedMessages.some((message) => message.chatId === chat.id)
  );
}

function isMissingCodexRolloutError(error: unknown, threadId: string): boolean {
  const message = toErrorMessage(error);
  return (
    message.includes("no rollout found for thread id") &&
    message.includes(threadId)
  );
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
