import {
  AlertTriangle,
  Archive,
  ArchiveRestore,
  Bot,
  Brain,
  CheckCircle2,
  ChevronRight,
  Circle,
  CircleDot,
  Clock3,
  FileDiff,
  FileText,
  FolderGit2,
  GitBranch,
  GitPullRequest,
  Inbox,
  ListChecks,
  MessageSquare,
  MessageSquarePlus,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  Send,
  Sparkles,
  Square,
  Terminal,
  Trash2,
  X,
} from "lucide-react";
import type { ReactNode } from "react";
import {
  FormEvent,
  KeyboardEvent,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useSearchParams } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  answerApprovalMutation,
  addProjectMutation,
  archiveChatMutation,
  createChatMutation,
  deleteProjectMutation,
  deletePendingMessageMutation,
  deleteWorktreeMutation,
  interruptChatMutation,
  queueMessageMutation,
  restorePendingMessageMutation,
  sendMessageMutation,
  steerMessageMutation,
  syncWorktreeMutation,
  type SendMessageInput,
} from "../api/mutations";
import {
  authQueryOptions,
  chatApprovalQueryOptions,
  chatQueryOptions,
  chatSkillsQueryOptions,
  fileSearchQueryOptions,
  messagesQueryOptions,
  modelsQueryOptions,
  projectChatsQueryOptions,
  projectGitHubCheckoutTargetsQueryOptions,
  projectWorktreesQueryOptions,
  projectsQueryOptions,
} from "../api/queries";
import { apiUrl } from "../api/client";
import { queryKeys } from "../api/query-keys";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Combobox, type ComboboxOption } from "../components/ui/combobox";
import {
  InlineLoading,
  LoadingSpinner,
  ProjectListSkeleton,
  TimelineSkeleton,
  WorktreeListSkeleton,
} from "../components/loading";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupHeader,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
} from "../components/ui/sidebar";
import { Textarea } from "../components/ui/textarea";
import {
  getComposerEnterAction,
  getComposerSubmitModeForEnter,
  type ComposerSubmitMode,
} from "../lib/composer-keyboard";
import { cn } from "../lib/utils";
import {
  dedupeChatThreads,
  findValidatedSelectedProjectChat,
  findValidatedSelectedChat,
  getSelectableReasoningEfforts,
  getSelectedSkillContextItems,
  isKnownWorktreeChat,
  isShareableFileSearchQuery,
  mergeWorktreesWithChats,
  retainRecordsForProjects,
  resolveRefreshedWorktreeChatId,
} from "./home-url-state";
import {
  getCommandEventMeta,
  getDiffEventData,
  getFileEventMeta,
  getFilePatchEventData,
  getPlanEventData,
  getRichEventKind,
  getRichEventText,
  getWarningEventText,
  isRichEventMessage,
} from "./rich-events";
import { mergeStreamingMessagesForDisplay } from "./chat-message-stream-order";
import type {
  ChatRecord,
  ChatStatus,
  CodexFileRecord,
  CodexModelRecord,
  CodexSkillRecord,
  CodexTurnContextItem,
  GitHubCheckoutTargetRecord,
  GitHubCheckoutTargetsResult,
  PendingApprovalRecord,
  PhantomEvent,
  ProjectWorktreeRecord,
  ProjectRecord,
  RenderedChatMessageRecord,
} from "@phantompane/server";

const chatEventNames = [
  "chat.created",
  "chat.updated",
  "chat.message.created",
  "chat.message.deleted",
  "agent.thread.started",
  "agent.turn.started",
  "agent.plan.updated",
  "agent.diff.updated",
  "agent.command.output",
  "agent.file.updated",
  "agent.reasoning.updated",
  "agent.warning",
  "agent.item.updated",
  "agent.item.delta",
  "agent.approval.requested",
  "agent.approval.resolved",
  "agent.turn.completed",
  "agent.error",
  "agent.event",
  "auth.updated",
];
const streamOrderPreservingChatEventNames = new Set([
  "agent.plan.updated",
  "agent.diff.updated",
  "agent.command.output",
  "agent.file.updated",
  "agent.reasoning.updated",
  "agent.item.updated",
  "agent.item.delta",
]);

const chatScrollStorageKeyPrefix = "phantom.chatScroll:v1:";
const chatScrollBottomThreshold = 4;
const searchParamKeys = {
  chat: "chat",
  effort: "effort",
  expandedProject: "expandedProject",
  fileQuery: "fileQuery",
  model: "model",
  project: "project",
} as const;

const statusMeta: Record<
  ChatStatus,
  {
    badge: "danger" | "info" | "secondary" | "success" | "warning";
    dot: string;
    label: string;
  }
> = {
  archived: {
    badge: "secondary",
    dot: "bg-[var(--status-archived-dot)]",
    label: "Archived",
  },
  failed: {
    badge: "danger",
    dot: "bg-[var(--semantic-danger-fg)]",
    label: "Failed",
  },
  idle: {
    badge: "secondary",
    dot: "bg-[var(--status-idle-dot)]",
    label: "Idle",
  },
  running: {
    badge: "info",
    dot: "bg-[var(--semantic-info-fg)]",
    label: "Running",
  },
  waitingForApproval: {
    badge: "warning",
    dot: "bg-[var(--semantic-warning-fg)]",
    label: "Approval",
  },
};

type PendingApproval = PendingApprovalRecord & { chatId: string };
type PendingApprovalEventData = PendingApprovalRecord;

function canArchiveChat(chat: ChatRecord): boolean {
  return (
    chat.status !== "archived" &&
    chat.status !== "running" &&
    chat.status !== "waitingForApproval" &&
    !chat.activeTurnId
  );
}

interface DeleteWorktreeTarget {
  forceRequired: boolean;
  projectId: string;
  worktreePath: string;
}

type DeleteWorktreeBranchMode = "default" | "keep" | "delete";

type ToastTone = "danger" | "info" | "warning";

interface ToastMessage {
  id: number;
  message: string;
  tone: ToastTone;
}

interface RestoredPendingComposerContext {
  chatId: string;
  effort: string | null;
  model: string | null;
}

type VisibleMessageRecord = RenderedChatMessageRecord & {
  role: "assistant" | "error" | "event" | "user";
};

interface StoredChatScrollPosition {
  pinnedToBottom: boolean;
  top: number;
  version: 1;
}

interface SearchParamUpdateOptions {
  replace?: boolean;
}

interface TransientFileSearchQuery {
  query: string;
  workspaceSelectionKey: string;
}

const toastDismissDelayMs = 6000;
const maxVisibleToasts = 3;

function firstProjectWorktree(
  projectId: string | null,
  worktreesByProject: Record<string, ProjectWorktreeRecord[]>,
): ProjectWorktreeRecord | null {
  if (!projectId) {
    return null;
  }
  return worktreesByProject[projectId]?.[0] ?? null;
}

function getWorktreeExpansionKey(projectId: string, worktreePath: string) {
  return `${projectId}:${worktreePath}`;
}

function getErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  if (typeof err === "string") {
    return err;
  }
  return "Something went wrong";
}

function formatErrorMessage(context: string, err: unknown): string {
  const message = getErrorMessage(err);
  return message ? `${context}: ${message}` : context;
}

function readNullableSearchParam(
  searchParams: URLSearchParams,
  key: string,
): string | null {
  const value = searchParams.get(key)?.trim();
  return value ? value : null;
}

function readSearchParamSet(
  searchParams: URLSearchParams,
  key: string,
): Set<string> {
  const values = searchParams
    .getAll(key)
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean);
  return new Set(values);
}

function getWorkspaceSelectionKey(
  projectId: string | null,
  chatId: string | null,
): string {
  return `${projectId ?? ""}\u0000${chatId ?? ""}`;
}

function writeNullableSearchParam(
  searchParams: URLSearchParams,
  key: string,
  value: string | null,
): void {
  if (value) {
    searchParams.set(key, value);
  } else {
    searchParams.delete(key);
  }
}

function writeSearchParamSet(
  searchParams: URLSearchParams,
  key: string,
  values: Set<string>,
): void {
  searchParams.delete(key);
  const sortedValues = [...values].sort();
  if (sortedValues.length > 0) {
    searchParams.set(key, sortedValues.join(","));
  }
}

function addExpandedProjectSearchParam(
  searchParams: URLSearchParams,
  projectId: string | null,
): void {
  if (!projectId) {
    return;
  }
  const expandedProjectIds = readSearchParamSet(
    searchParams,
    searchParamKeys.expandedProject,
  );
  expandedProjectIds.add(projectId);
  writeSearchParamSet(
    searchParams,
    searchParamKeys.expandedProject,
    expandedProjectIds,
  );
}

function formatLeadingEllipsisPath(path: string, maxLength = 44): string {
  if (path.length <= maxLength) {
    return path;
  }

  const suffixLength = maxLength - 3;
  const suffix = path.slice(-suffixLength);
  const slashIndex = suffix.indexOf("/");
  return `...${slashIndex > 0 ? suffix.slice(slashIndex) : suffix}`;
}

function getChatScrollStorageKey(chatId: string): string {
  return `${chatScrollStorageKeyPrefix}${chatId}`;
}

function readStoredChatScrollPosition(
  chatId: string,
): StoredChatScrollPosition | null {
  try {
    const rawValue = window.localStorage.getItem(
      getChatScrollStorageKey(chatId),
    );
    if (!rawValue) {
      return null;
    }
    const parsedValue = JSON.parse(
      rawValue,
    ) as Partial<StoredChatScrollPosition>;
    if (
      parsedValue.version !== 1 ||
      typeof parsedValue.top !== "number" ||
      !Number.isFinite(parsedValue.top)
    ) {
      return null;
    }
    return {
      version: 1,
      pinnedToBottom: parsedValue.pinnedToBottom === true,
      top: Math.max(0, parsedValue.top),
    };
  } catch {
    return null;
  }
}

function writeStoredChatScrollPosition(
  chatId: string,
  timeline: HTMLElement,
): void {
  try {
    window.localStorage.setItem(
      getChatScrollStorageKey(chatId),
      JSON.stringify({
        version: 1,
        pinnedToBottom: isChatTimelineScrolledToBottom(timeline),
        top: Math.max(0, Math.round(timeline.scrollTop)),
      } satisfies StoredChatScrollPosition),
    );
  } catch {
    // Ignore storage failures so the chat view remains usable in private modes.
  }
}

function isChatTimelineScrolledToBottom(timeline: HTMLElement): boolean {
  return (
    timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight <=
    chatScrollBottomThreshold
  );
}

export function HomeRoute() {
  const [searchParams, setSearchParams] = useSearchParams();
  const searchParamsRef = useRef(searchParams);
  searchParamsRef.current = searchParams;
  const requestedProjectId = readNullableSearchParam(
    searchParams,
    searchParamKeys.project,
  );
  const selectedChatId = readNullableSearchParam(
    searchParams,
    searchParamKeys.chat,
  );
  const workspaceSelectionKey = getWorkspaceSelectionKey(
    requestedProjectId,
    selectedChatId,
  );
  const workspaceSelectionKeyRef = useRef(workspaceSelectionKey);
  workspaceSelectionKeyRef.current = workspaceSelectionKey;
  const selectedModelId = readNullableSearchParam(
    searchParams,
    searchParamKeys.model,
  );
  const selectedEffort = readNullableSearchParam(
    searchParams,
    searchParamKeys.effort,
  );
  const rawUrlFileSearchQuery =
    searchParams.get(searchParamKeys.fileQuery) ?? "";
  const urlFileSearchQuery = isShareableFileSearchQuery(rawUrlFileSearchQuery)
    ? rawUrlFileSearchQuery
    : "";
  const expandedProjectIds = useMemo(
    () => readSearchParamSet(searchParams, searchParamKeys.expandedProject),
    [searchParams],
  );
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [chatsByProject, setChatsByProject] = useState<
    Record<string, ChatRecord[]>
  >({});
  const [worktreesByProject, setWorktreesByProject] = useState<
    Record<string, ProjectWorktreeRecord[]>
  >({});
  const [githubTargetsByProject, setGithubTargetsByProject] = useState<
    Record<string, GitHubCheckoutTargetsResult>
  >({});
  const [expandedWorktreeKeys, setExpandedWorktreeKeys] = useState<Set<string>>(
    () => new Set(),
  );
  const [messages, setMessages] = useState<RenderedChatMessageRecord[]>([]);
  const [messagesChatId, setMessagesChatId] = useState<string | null>(null);
  const messagesChatIdRef = useRef(messagesChatId);
  messagesChatIdRef.current = messagesChatId;
  const [isAddProjectOpen, setIsAddProjectOpen] = useState(false);
  const [projectPath, setProjectPath] = useState("");
  const [deleteProjectTarget, setDeleteProjectTarget] = useState<string | null>(
    null,
  );
  const [deleteWorktreeTarget, setDeleteWorktreeTarget] =
    useState<DeleteWorktreeTarget | null>(null);
  const [deleteWorktreeBranchMode, setDeleteWorktreeBranchMode] =
    useState<DeleteWorktreeBranchMode>("default");
  const [deleteWorktreeForce, setDeleteWorktreeForce] = useState(false);
  const [composerText, setComposerText] = useState("");
  const [models, setModels] = useState<CodexModelRecord[]>([]);
  const [skills, setSkills] = useState<CodexSkillRecord[]>([]);
  const [selectedSkillPaths, setSelectedSkillPaths] = useState<Set<string>>(
    () => new Set(),
  );
  const [transientFileSearchQuery, setTransientFileSearchQuery] =
    useState<TransientFileSearchQuery | null>(null);
  const fileSearchQuery =
    urlFileSearchQuery ||
    (transientFileSearchQuery?.workspaceSelectionKey === workspaceSelectionKey
      ? transientFileSearchQuery.query
      : "");
  const fileSearchQueryRef = useRef(fileSearchQuery);
  const fileSearchRequestIdRef = useRef(0);
  const approvalRefreshRequestIdRef = useRef(0);
  const approvalEventVersionRef = useRef(0);
  const [fileSearchResults, setFileSearchResults] = useState<CodexFileRecord[]>(
    [],
  );
  const [selectedFiles, setSelectedFiles] = useState<CodexFileRecord[]>([]);
  const [status, setStatus] = useState("Starting");
  const [sidebarError, setSidebarError] = useState<string | null>(null);
  const [timelineError, setTimelineError] = useState<string | null>(null);
  const [composerError, setComposerError] = useState<string | null>(null);
  const [fileSearchError, setFileSearchError] = useState<string | null>(null);
  const [modelError, setModelError] = useState<string | null>(null);
  const [addProjectError, setAddProjectError] = useState<string | null>(null);
  const [deleteProjectError, setDeleteProjectError] = useState<string | null>(
    null,
  );
  const [deleteWorktreeError, setDeleteWorktreeError] = useState<string | null>(
    null,
  );
  const [approvalError, setApprovalError] = useState<string | null>(null);
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const [isBusy, setIsBusy] = useState(false);
  const [isProjectsLoading, setIsProjectsLoading] = useState(true);
  const [loadingProjectIds, setLoadingProjectIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [loadingChatProjectIds, setLoadingChatProjectIds] = useState<
    Set<string>
  >(() => new Set());
  const [isModelsLoading, setIsModelsLoading] = useState(true);
  const [isMessagesLoading, setIsMessagesLoading] = useState(false);
  const [isChatContextLoading, setIsChatContextLoading] = useState(false);
  const [isFileSearchLoading, setIsFileSearchLoading] = useState(false);
  const [loadingGitHubTargetProjectIds, setLoadingGitHubTargetProjectIds] =
    useState<Set<string>>(() => new Set());
  const [selectedGitHubTargetNumber, setSelectedGitHubTargetNumber] = useState<
    number | null
  >(null);
  const [creatingProjectId, setCreatingProjectId] = useState<string | null>(
    null,
  );
  const [creatingWorktreeKey, setCreatingWorktreeKey] = useState<string | null>(
    null,
  );
  const [isSendingMessage, setIsSendingMessage] = useState(false);
  const [pendingComposerMode, setPendingComposerMode] =
    useState<ComposerSubmitMode | null>(null);
  const [isInterrupting, setIsInterrupting] = useState(false);
  const [archiveTransitionChatId, setArchiveTransitionChatId] = useState<
    string | null
  >(null);
  const createChatInFlightRef = useRef(false);
  const chatTimelineRef = useRef<HTMLElement | null>(null);
  const isChatTimelinePinnedToBottomRef = useRef(true);
  const shouldIgnoreNextChatTimelineScrollRef = useRef(false);
  const scrollSaveAnimationFrameRef = useRef<number | null>(null);
  const scrollRestoredChatIdRef = useRef<string | null>(null);
  const selectedProjectIdRef = useRef<string | null>(null);
  const selectedChatIdRef = useRef<string | null>(null);
  const selectedChatVersionRef = useRef(0);
  const toastIdRef = useRef(0);
  const toastTimeoutsRef = useRef<Map<number, number>>(new Map());
  const chatsByProjectRef = useRef(chatsByProject);
  const worktreesByProjectRef = useRef(worktreesByProject);
  const githubTargetsByProjectRef = useRef(githubTargetsByProject);
  const messagesRefreshRequestIdRef = useRef(0);
  const sendMessageRequestIdRef = useRef(0);
  const composerTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const composerTextRef = useRef(composerText);
  const hasSelectedContextRef = useRef(false);
  const restoredPendingComposerContextRef =
    useRef<RestoredPendingComposerContext | null>(null);
  const pendingSendChatIdsRef = useRef<Set<string>>(new Set());
  const pendingComposerModesByChatRef = useRef<Map<string, ComposerSubmitMode>>(
    new Map(),
  );
  const [pendingApproval, setPendingApproval] =
    useState<PendingApproval | null>(null);
  const pendingApprovalRef = useRef<PendingApproval | null>(pendingApproval);
  pendingApprovalRef.current = pendingApproval;
  const queryClient = useQueryClient();
  const addProjectRequest = useMutation({
    mutationFn: addProjectMutation,
  });
  const deleteProjectRequest = useMutation({
    mutationFn: deleteProjectMutation,
  });
  const createChatRequest = useMutation({
    mutationFn: ({
      input,
      projectId,
    }: {
      input?: Parameters<typeof createChatMutation>[1];
      projectId: string;
    }) => createChatMutation(projectId, input),
  });
  const deleteWorktreeRequest = useMutation({
    mutationFn: ({
      input,
      projectId,
    }: {
      input: {
        force: boolean;
        keepBranch?: boolean;
        name: string;
        path: string;
      };
      projectId: string;
    }) => deleteWorktreeMutation(projectId, input),
  });
  const syncWorktreeRequest = useMutation({
    mutationFn: ({
      input,
      projectId,
    }: {
      input: { name: string; path: string };
      projectId: string;
    }) => syncWorktreeMutation(projectId, input),
  });
  const sendMessageRequest = useMutation({
    mutationFn: ({
      chatId,
      input,
    }: {
      chatId: string;
      input: Parameters<typeof sendMessageMutation>[1];
    }) => sendMessageMutation(chatId, input),
  });
  const deletePendingMessageRequest = useMutation({
    mutationFn: ({
      chatId,
      messageId,
    }: {
      chatId: string;
      messageId: string;
    }) => deletePendingMessageMutation(chatId, messageId),
  });
  const restorePendingMessageRequest = useMutation({
    mutationFn: ({
      chatId,
      input,
    }: {
      chatId: string;
      input: Parameters<typeof restorePendingMessageMutation>[1];
    }) => restorePendingMessageMutation(chatId, input),
  });
  const steerMessageRequest = useMutation({
    mutationFn: ({
      chatId,
      input,
    }: {
      chatId: string;
      input: Parameters<typeof steerMessageMutation>[1];
    }) => steerMessageMutation(chatId, input),
  });
  const queueMessageRequest = useMutation({
    mutationFn: ({
      chatId,
      input,
    }: {
      chatId: string;
      input: Parameters<typeof queueMessageMutation>[1];
    }) => queueMessageMutation(chatId, input),
  });
  const interruptChatRequest = useMutation({
    mutationFn: interruptChatMutation,
  });
  const answerApprovalRequest = useMutation({
    mutationFn: ({
      chatId,
      decision,
      requestId,
    }: {
      chatId: string;
      decision: "accept" | "acceptForSession" | "decline" | "cancel";
      requestId: string;
    }) => answerApprovalMutation(chatId, requestId, decision),
  });
  const archiveChatRequest = useMutation({
    mutationFn: ({ archived, chatId }: { archived: boolean; chatId: string }) =>
      archiveChatMutation(chatId, archived),
  });

  function clearToastTimer(id: number) {
    const timeout = toastTimeoutsRef.current.get(id);
    if (timeout !== undefined) {
      window.clearTimeout(timeout);
      toastTimeoutsRef.current.delete(id);
    }
  }

  function dismissToast(id: number) {
    clearToastTimer(id);
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }

  function showToast(message: string, tone: ToastTone = "danger") {
    const id = toastIdRef.current + 1;
    toastIdRef.current = id;
    const timeout = window.setTimeout(
      () => dismissToast(id),
      toastDismissDelayMs,
    );
    toastTimeoutsRef.current.set(id, timeout);
    setToasts((current) => {
      const next = [...current, { id, message, tone }].slice(-maxVisibleToasts);
      const nextIds = new Set(next.map((toast) => toast.id));
      for (const toast of current) {
        if (!nextIds.has(toast.id)) {
          clearToastTimer(toast.id);
        }
      }
      return next;
    });
  }

  useEffect(() => {
    return () => {
      for (const timeout of toastTimeoutsRef.current.values()) {
        window.clearTimeout(timeout);
      }
      toastTimeoutsRef.current.clear();
    };
  }, []);

  function updatePendingApproval(nextApproval: PendingApproval | null) {
    pendingApprovalRef.current = nextApproval;
    setPendingApproval(nextApproval);
  }

  function clearPendingApprovalForChat(chatId: string) {
    setPendingApproval((current) => {
      const nextApproval = current?.chatId === chatId ? null : current;
      pendingApprovalRef.current = nextApproval;
      return nextApproval;
    });
  }

  function clearPendingApprovalForRequest(chatId: string, requestId: string) {
    setPendingApproval((current) => {
      const nextApproval =
        current?.chatId === chatId && current.requestId === requestId
          ? null
          : current;
      pendingApprovalRef.current = nextApproval;
      return nextApproval;
    });
  }

  function updateSearchParams(
    updater: (nextSearchParams: URLSearchParams) => void,
    options: SearchParamUpdateOptions = {},
  ) {
    const nextSearchParams = new URLSearchParams(searchParamsRef.current);
    updater(nextSearchParams);
    searchParamsRef.current = nextSearchParams;
    setSearchParams(nextSearchParams, { replace: options.replace ?? false });
  }

  function updateWorkspaceSearchParams(
    selection: {
      chatId?: string | null;
      clearFileQuery?: boolean;
      projectId?: string | null;
    },
    options: SearchParamUpdateOptions = {},
  ) {
    if (selection.clearFileQuery) {
      setTransientFileSearchQuery(null);
    }
    updateSearchParams((nextSearchParams) => {
      if ("projectId" in selection) {
        writeNullableSearchParam(
          nextSearchParams,
          searchParamKeys.project,
          selection.projectId ?? null,
        );
        addExpandedProjectSearchParam(
          nextSearchParams,
          selection.projectId ?? null,
        );
      }
      if ("chatId" in selection) {
        writeNullableSearchParam(
          nextSearchParams,
          searchParamKeys.chat,
          selection.chatId ?? null,
        );
      }
      if (selection.clearFileQuery) {
        nextSearchParams.delete(searchParamKeys.fileQuery);
      }
    }, options);
  }

  function setSearchParamValue(
    key: string,
    value: string | null,
    options: SearchParamUpdateOptions = {},
  ) {
    updateSearchParams((nextSearchParams) => {
      writeNullableSearchParam(nextSearchParams, key, value);
    }, options);
  }

  function setFileSearchQuery(value: string) {
    const nextFileSearchQuery = value.trim() ? value : null;
    if (!nextFileSearchQuery) {
      setTransientFileSearchQuery(null);
      setSearchParamValue(searchParamKeys.fileQuery, null, { replace: true });
      return;
    }

    if (!isShareableFileSearchQuery(nextFileSearchQuery)) {
      setTransientFileSearchQuery({
        query: value,
        workspaceSelectionKey,
      });
      setSearchParamValue(searchParamKeys.fileQuery, null, { replace: true });
      return;
    }

    setTransientFileSearchQuery(null);
    setSearchParamValue(searchParamKeys.fileQuery, nextFileSearchQuery, {
      replace: true,
    });
  }

  function getCurrentUrlWorkspaceSelectionKey(): string {
    const currentSearchParams = searchParamsRef.current;
    return getWorkspaceSelectionKey(
      readNullableSearchParam(currentSearchParams, searchParamKeys.project),
      readNullableSearchParam(currentSearchParams, searchParamKeys.chat),
    );
  }

  const selectedChat = useMemo(
    () =>
      findValidatedSelectedChat(
        Object.values(chatsByProject).flat(),
        selectedChatId,
        requestedProjectId,
      ),
    [chatsByProject, requestedProjectId, selectedChatId],
  );
  const isSelectedChatValidated = !selectedChatId || Boolean(selectedChat);
  const hasSelectedChat = Boolean(selectedChat);
  const validatedSelectedChatId = selectedChat?.id ?? null;
  const selectedProjectId = selectedChat?.projectId ?? requestedProjectId;
  selectedChatIdRef.current = selectedChatId;
  selectedProjectIdRef.current = selectedProjectId;
  chatsByProjectRef.current = chatsByProject;
  worktreesByProjectRef.current = worktreesByProject;
  githubTargetsByProjectRef.current = githubTargetsByProject;
  fileSearchQueryRef.current = fileSearchQuery;
  const selectedProject = useMemo(
    () => projects.find((project) => project.id === selectedProjectId) ?? null,
    [projects, selectedProjectId],
  );
  const selectedProjectGitHubTargets =
    selectedProjectId && !selectedChatId
      ? (githubTargetsByProject[selectedProjectId] ?? null)
      : null;
  const isSelectedProjectGitHubTargetsLoading = Boolean(
    selectedProjectId && loadingGitHubTargetProjectIds.has(selectedProjectId),
  );
  const selectedGitHubTarget = useMemo(() => {
    if (!selectedProjectGitHubTargets?.available) {
      return null;
    }
    return (
      selectedProjectGitHubTargets.targets.find(
        (target) => target.number === selectedGitHubTargetNumber,
      ) ?? null
    );
  }, [selectedGitHubTargetNumber, selectedProjectGitHubTargets]);
  const hasLoadedSelectedProjectData = Boolean(
    selectedProjectId &&
    chatsByProject[selectedProjectId] !== undefined &&
    worktreesByProject[selectedProjectId] !== undefined,
  );
  const isSelectedChatKnownByWorktree = Boolean(
    selectedProjectId &&
    isKnownWorktreeChat(
      worktreesByProject[selectedProjectId] ?? [],
      selectedChatId,
    ),
  );
  const hasActiveTurn = Boolean(selectedChat?.activeTurnId);
  const isSelectedChatArchived = selectedChat?.status === "archived";
  const isChatRunning = selectedChat?.status === "running" && hasActiveTurn;

  const selectedModel = useMemo(
    () =>
      models.find((model) => model.id === selectedModelId) ??
      models.find((model) => model.isDefault) ??
      models[0] ??
      null,
    [models, selectedModelId],
  );
  const selectedModelSupportedEfforts = useMemo(
    () => getSelectableReasoningEfforts(selectedModel),
    [selectedModel],
  );

  const selectedSkills = useMemo(
    () =>
      skills.filter(
        (skill) => skill.enabled && selectedSkillPaths.has(skill.path),
      ),
    [selectedSkillPaths, skills],
  );
  const hasSelectedContext =
    selectedFiles.length > 0 || selectedSkills.length > 0;
  composerTextRef.current = composerText;
  hasSelectedContextRef.current = hasSelectedContext;
  const canStartNewProjectChat =
    Boolean(selectedProject) && !selectedChatId && Boolean(composerText.trim());
  const canSendMessage =
    (hasSelectedChat &&
      !isSelectedChatArchived &&
      Boolean(composerText.trim() || hasSelectedContext)) ||
    canStartNewProjectChat;
  const primaryComposerMode: ComposerSubmitMode = hasActiveTurn
    ? isChatRunning
      ? "steer"
      : "queue"
    : "send";
  const isComposerBlocked =
    isSendingMessage ||
    isSelectedChatArchived ||
    Boolean(selectedChatId && archiveTransitionChatId === selectedChatId) ||
    deletePendingMessageRequest.isPending ||
    restorePendingMessageRequest.isPending ||
    Boolean(
      selectedChatId && pendingSendChatIdsRef.current.has(selectedChatId),
    );
  const canSubmitPrimaryComposerAction =
    canSendMessage &&
    !isComposerBlocked &&
    (primaryComposerMode !== "steer" || isChatRunning);
  const canQueueComposerMessage =
    hasSelectedChat &&
    !isSelectedChatArchived &&
    canSendMessage &&
    !isComposerBlocked;
  const canInterruptActiveTurn =
    hasActiveTurn && !isInterrupting && Boolean(selectedChat?.activeTurnId);
  const areComposerOptionsDisabled = !hasSelectedChat || isComposerBlocked;
  const primaryComposerActionLabel =
    formatComposerModeAction(primaryComposerMode);
  const primaryComposerButtonLabel =
    pendingComposerMode === primaryComposerMode
      ? formatComposerModeBusy(pendingComposerMode)
      : primaryComposerActionLabel;

  const modelOptions = useMemo<ComboboxOption[]>(
    () =>
      models.map((model) => ({
        value: model.id,
        label: model.displayName,
        description: model.description || model.model,
        keywords: [model.model],
      })),
    [models],
  );

  const effortOptions = useMemo<ComboboxOption[]>(() => {
    return [
      {
        value: "auto",
        label: "Auto",
        description: selectedModel?.defaultReasoningEffort
          ? `Default: ${selectedModel.defaultReasoningEffort}`
          : "Use model default",
      },
      ...selectedModelSupportedEfforts.map((effort) => ({
        value: effort,
        label: formatReasoningEffort(effort),
      })),
    ];
  }, [selectedModel, selectedModelSupportedEfforts]);

  const skillOptions = useMemo<ComboboxOption[]>(
    () =>
      skills
        .filter((skill) => skill.enabled && !selectedSkillPaths.has(skill.path))
        .map((skill) => ({
          value: skill.path,
          label: skill.displayName,
          description: skill.shortDescription ?? skill.description,
          keywords: [skill.name],
        })),
    [selectedSkillPaths, skills],
  );

  const fileOptions = useMemo<ComboboxOption[]>(
    () =>
      fileSearchResults
        .filter(
          (file) =>
            !selectedFiles.some(
              (selectedFile) => selectedFile.path === file.path,
            ),
        )
        .map((file) => ({
          value: file.path,
          label: file.relativePath,
          description: file.root,
          keywords: [file.name],
        })),
    [fileSearchResults, selectedFiles],
  );

  const pendingDeleteProject = useMemo(
    () =>
      deleteProjectTarget
        ? (projects.find((project) => project.id === deleteProjectTarget) ??
          null)
        : null,
    [deleteProjectTarget, projects],
  );

  const pendingDeleteProjectChats = useMemo(
    () =>
      deleteProjectTarget ? (chatsByProject[deleteProjectTarget] ?? []) : [],
    [chatsByProject, deleteProjectTarget],
  );

  const pendingDeleteProjectBlockingChat = useMemo(
    () =>
      pendingDeleteProjectChats.find(
        (chat) =>
          chat.status === "running" ||
          chat.status === "waitingForApproval" ||
          Boolean(chat.activeTurnId) ||
          Boolean(chat.hasQueuedMessages) ||
          Boolean(chat.isDrainingQueuedMessages) ||
          pendingSendChatIdsRef.current.has(chat.id),
      ) ?? null,
    [pendingDeleteProjectChats],
  );

  const pendingDeleteWorktreeProject = useMemo(
    () =>
      deleteWorktreeTarget
        ? (projects.find(
            (project) => project.id === deleteWorktreeTarget.projectId,
          ) ?? null)
        : null,
    [deleteWorktreeTarget, projects],
  );

  const pendingDeleteWorktree = useMemo(() => {
    if (!deleteWorktreeTarget) {
      return null;
    }
    return (
      (worktreesByProject[deleteWorktreeTarget.projectId] ?? []).find(
        (worktree) => worktree.path === deleteWorktreeTarget.worktreePath,
      ) ?? null
    );
  }, [deleteWorktreeTarget, worktreesByProject]);
  const isDeleteWorktreeForceRequired = Boolean(
    deleteWorktreeTarget?.forceRequired ||
    (pendingDeleteWorktree && !pendingDeleteWorktree.isClean),
  );

  const selectedWorktree = useMemo(() => {
    if (!selectedProjectId) {
      return null;
    }
    const projectWorktrees = worktreesByProject[selectedProjectId] ?? [];
    if (selectedChat) {
      return (
        projectWorktrees.find(
          (worktree) => worktree.path === selectedChat.worktreePath,
        ) ?? null
      );
    }
    return null;
  }, [selectedChat, selectedProjectId, worktreesByProject]);

  const chatsByWorktreeByProject = useMemo(() => {
    const nextChatsByWorktreeByProject: Record<
      string,
      Map<string, ChatRecord[]>
    > = {};

    for (const [projectId, projectChats] of Object.entries(chatsByProject)) {
      const chatsByWorktree = new Map<string, ChatRecord[]>();
      for (const chat of projectChats) {
        const worktreeChats = chatsByWorktree.get(chat.worktreePath) ?? [];
        worktreeChats.push(chat);
        chatsByWorktree.set(chat.worktreePath, worktreeChats);
      }

      for (const [worktreePath, worktreeChats] of chatsByWorktree) {
        chatsByWorktree.set(worktreePath, dedupeChatThreads(worktreeChats));
      }

      nextChatsByWorktreeByProject[projectId] = chatsByWorktree;
    }

    return nextChatsByWorktreeByProject;
  }, [chatsByProject]);

  const selectedWorktreeChats = useMemo(() => {
    if (!selectedProjectId || !selectedWorktree) {
      return [];
    }
    return (
      chatsByWorktreeByProject[selectedProjectId]?.get(selectedWorktree.path) ??
      []
    );
  }, [chatsByWorktreeByProject, selectedProjectId, selectedWorktree]);

  const visibleMessages = useMemo(
    () =>
      messages.filter(
        (message): message is VisibleMessageRecord =>
          message.role !== "event" || isRichEventMessage(message),
      ),
    [messages],
  );
  const showProjectListSkeleton = isProjectsLoading && projects.length === 0;
  const showTimelineSkeleton =
    Boolean(selectedChatId) &&
    isMessagesLoading &&
    visibleMessages.length === 0;

  useEffect(() => {
    void refreshProjects();
    void refreshModels();
    void queryClient
      .fetchQuery(authQueryOptions())
      .then(() => setStatus("Ready"))
      .catch((err: Error) => setStatus(err.message));
  }, []);

  useEffect(() => {
    if (
      rawUrlFileSearchQuery &&
      !isShareableFileSearchQuery(rawUrlFileSearchQuery)
    ) {
      setSearchParamValue(searchParamKeys.fileQuery, null, { replace: true });
    }
  }, [rawUrlFileSearchQuery]);

  useEffect(() => {
    if (!selectedProjectId) {
      return;
    }
    void refreshWorktrees(selectedProjectId, {
      updateSelection: isSelectedChatValidated,
    });
    void refreshChats(selectedProjectId, {
      updateSelection: isSelectedChatValidated,
    });
  }, [isSelectedChatValidated, selectedProjectId]);

  useEffect(() => {
    setSelectedGitHubTargetNumber(null);
    if (!selectedProjectId || selectedChatId) {
      return;
    }
    void refreshGitHubCheckoutTargets(selectedProjectId);
  }, [selectedProjectId, selectedChatId]);

  useEffect(() => {
    if (
      selectedGitHubTargetNumber === null ||
      !selectedProjectGitHubTargets?.available ||
      selectedProjectGitHubTargets.targets.some(
        (target) => target.number === selectedGitHubTargetNumber,
      )
    ) {
      return;
    }
    setSelectedGitHubTargetNumber(null);
  }, [selectedGitHubTargetNumber, selectedProjectGitHubTargets]);

  useEffect(() => {
    selectedChatVersionRef.current += 1;
    isChatTimelinePinnedToBottomRef.current = true;
    scrollRestoredChatIdRef.current = null;
    setTimelineError(null);
    setComposerError(null);
    setApprovalError(null);
    if (scrollSaveAnimationFrameRef.current !== null) {
      cancelAnimationFrame(scrollSaveAnimationFrameRef.current);
      scrollSaveAnimationFrameRef.current = null;
    }
    setIsSendingMessage(
      Boolean(
        selectedChatId && pendingSendChatIdsRef.current.has(selectedChatId),
      ),
    );
    setPendingComposerMode(
      selectedChatId
        ? (pendingComposerModesByChatRef.current.get(selectedChatId) ?? null)
        : null,
    );

    if (!isSelectedChatValidated) {
      setMessages([]);
      setMessagesChatId(null);
      updatePendingApproval(null);
      setSelectedFiles([]);
      setSelectedSkillPaths(new Set());
      setFileSearchResults([]);
      setSkills([]);
      setIsMessagesLoading(false);
      setIsChatContextLoading(false);
      setIsFileSearchLoading(false);
      return;
    }

    if (!selectedChatId) {
      setMessages([]);
      setMessagesChatId(null);
      updatePendingApproval(null);
      setSelectedFiles([]);
      setSelectedSkillPaths(new Set());
      setFileSearchResults([]);
      setSkills([]);
      setIsMessagesLoading(false);
      setIsChatContextLoading(false);
      setIsFileSearchLoading(false);
      return;
    }

    setSelectedFiles([]);
    setSelectedSkillPaths(new Set());
    setFileSearchResults([]);
    setSkills([]);
    setMessages([]);
    setMessagesChatId(null);
    setApprovalError(null);
    updatePendingApproval(null);
    const chatContextController = new AbortController();
    void refreshMessages(selectedChatId, { showLoading: true });
    void refreshSelectedChat(selectedChatId);
    void refreshChatContext(selectedChatId, chatContextController.signal);

    const source = new EventSource(
      apiUrl(`/chats/${encodeURIComponent(selectedChatId)}/events`),
    );
    const handleEvent = (event: MessageEvent<string>) => {
      const phantomEvent = JSON.parse(event.data) as PhantomEvent;
      if (phantomEvent.type === "agent.approval.requested") {
        const data = phantomEvent.data as PendingApprovalEventData;
        approvalEventVersionRef.current += 1;
        updatePendingApproval({ ...data, chatId: selectedChatId });
        void queryClient.invalidateQueries({
          queryKey: queryKeys.chatApproval(selectedChatId),
        });
      }
      if (phantomEvent.type === "agent.approval.resolved") {
        approvalEventVersionRef.current += 1;
        clearPendingApprovalForChat(selectedChatId);
        void queryClient.invalidateQueries({
          queryKey: queryKeys.chatApproval(selectedChatId),
        });
      }
      void queryClient.invalidateQueries({
        queryKey: queryKeys.messages(selectedChatId),
      });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.chat(selectedChatId),
      });
      void refreshMessages(selectedChatId, {
        preserveStreamOrder: streamOrderPreservingChatEventNames.has(
          phantomEvent.type,
        ),
      });
      void refreshSelectedChat(selectedChatId);
      if (selectedProjectId) {
        void queryClient.invalidateQueries({
          queryKey: queryKeys.projectChats(selectedProjectId),
        });
        void refreshChats(selectedProjectId);
      }
    };

    for (const eventName of chatEventNames) {
      source.addEventListener(eventName, handleEvent);
    }
    source.onopen = () => {
      void refreshPendingApproval(selectedChatId, chatContextController.signal);
    };
    source.onerror = () => setStatus("Event stream disconnected");

    return () => {
      saveChatScrollPosition(selectedChatId);
      chatContextController.abort();
      for (const eventName of chatEventNames) {
        source.removeEventListener(eventName, handleEvent);
      }
      source.close();
    };
  }, [isSelectedChatValidated, selectedChatId, selectedProjectId]);

  useLayoutEffect(() => {
    if (!selectedChatId || messagesChatId !== selectedChatId) {
      return;
    }

    const timeline = chatTimelineRef.current;
    if (!timeline) {
      return;
    }

    if (scrollRestoredChatIdRef.current !== selectedChatId) {
      const storedScrollPosition = readStoredChatScrollPosition(selectedChatId);
      const shouldRestoreToBottom =
        !storedScrollPosition || storedScrollPosition.pinnedToBottom;
      shouldIgnoreNextChatTimelineScrollRef.current = true;
      timeline.scrollTop = shouldRestoreToBottom
        ? timeline.scrollHeight
        : storedScrollPosition.top;
      scrollRestoredChatIdRef.current = selectedChatId;
      isChatTimelinePinnedToBottomRef.current =
        shouldRestoreToBottom || isChatTimelineScrolledToBottom(timeline);
      return;
    }

    if (isChatTimelinePinnedToBottomRef.current) {
      shouldIgnoreNextChatTimelineScrollRef.current = true;
      timeline.scrollTop = timeline.scrollHeight;
    }
  }, [messagesChatId, selectedChatId, visibleMessages]);

  useEffect(() => {
    return () => {
      if (scrollSaveAnimationFrameRef.current !== null) {
        cancelAnimationFrame(scrollSaveAnimationFrameRef.current);
        scrollSaveAnimationFrameRef.current = null;
      }
      const chatId = selectedChatIdRef.current;
      if (chatId) {
        saveChatScrollPosition(chatId);
      }
    };
  }, []);

  useEffect(() => {
    if (
      selectedModelId &&
      models.length > 0 &&
      !models.some((model) => model.id === selectedModelId)
    ) {
      setSearchParamValue(searchParamKeys.model, null, { replace: true });
    }
  }, [models, selectedModelId]);

  useEffect(() => {
    if (!selectedEffort || selectedEffort === "auto") {
      if (selectedEffort === "auto") {
        setSearchParamValue(searchParamKeys.effort, null, { replace: true });
      }
      return;
    }
    if (models.length === 0 || !selectedModel) {
      return;
    }
    if (!selectedModelSupportedEfforts.includes(selectedEffort)) {
      setSearchParamValue(searchParamKeys.effort, null, { replace: true });
    }
  }, [
    models.length,
    selectedEffort,
    selectedModel,
    selectedModelSupportedEfforts,
  ]);

  useEffect(() => {
    const requestId = fileSearchRequestIdRef.current + 1;
    fileSearchRequestIdRef.current = requestId;

    if (!validatedSelectedChatId || !fileSearchQuery.trim()) {
      setFileSearchResults([]);
      setFileSearchError(null);
      setIsFileSearchLoading(false);
      return;
    }

    const controller = new AbortController();
    const query = fileSearchQuery.trim();
    setFileSearchError(null);
    setIsFileSearchLoading(true);
    const timeout = setTimeout(() => {
      void queryClient
        .fetchQuery(
          fileSearchQueryOptions(
            validatedSelectedChatId,
            query,
            controller.signal,
          ),
        )
        .then((data) => {
          if (
            controller.signal.aborted ||
            fileSearchRequestIdRef.current !== requestId
          ) {
            return;
          }
          setFileSearchResults(data.files);
          setFileSearchError(null);
        })
        .catch((err: Error) => {
          if (
            err.name !== "AbortError" &&
            !controller.signal.aborted &&
            fileSearchRequestIdRef.current === requestId
          ) {
            setFileSearchError(
              formatErrorMessage("Could not search files", err),
            );
          }
        })
        .finally(() => {
          if (
            !controller.signal.aborted &&
            fileSearchRequestIdRef.current === requestId
          ) {
            setIsFileSearchLoading(false);
          }
        });
    }, 160);

    return () => {
      clearTimeout(timeout);
      controller.abort();
    };
  }, [fileSearchQuery, validatedSelectedChatId]);

  useEffect(() => {
    if (
      !isSelectedChatValidated ||
      selectedWorktreeChats.length === 0 ||
      selectedWorktreeChats.some((chat) => chat.id === selectedChatId)
    ) {
      return;
    }
    updateWorkspaceSearchParams(
      {
        chatId: selectedWorktreeChats[0]?.id ?? null,
        clearFileQuery: Boolean(fileSearchQuery.trim()),
      },
      { replace: true },
    );
  }, [
    fileSearchQuery,
    isSelectedChatValidated,
    selectedChatId,
    selectedWorktreeChats,
  ]);

  useEffect(() => {
    if (
      !selectedChatId ||
      isSelectedChatValidated ||
      isSelectedChatKnownByWorktree ||
      !selectedProjectId ||
      !hasLoadedSelectedProjectData
    ) {
      return;
    }
    const fallbackChatId =
      firstProjectWorktree(selectedProjectId, worktreesByProject)?.chatId ??
      null;
    updateWorkspaceSearchParams(
      {
        chatId: fallbackChatId,
        clearFileQuery: Boolean(fileSearchQuery.trim()),
      },
      { replace: true },
    );
  }, [
    fileSearchQuery,
    hasLoadedSelectedProjectData,
    isSelectedChatKnownByWorktree,
    isSelectedChatValidated,
    selectedChatId,
    selectedProjectId,
    worktreesByProject,
  ]);

  function setProjectLoading(projectId: string, isLoading: boolean) {
    setLoadingProjectIds((current) => {
      const next = new Set(current);
      if (isLoading) {
        next.add(projectId);
      } else {
        next.delete(projectId);
      }
      return next;
    });
  }

  function setChatProjectLoading(projectId: string, isLoading: boolean) {
    setLoadingChatProjectIds((current) => {
      const next = new Set(current);
      if (isLoading) {
        next.add(projectId);
      } else {
        next.delete(projectId);
      }
      return next;
    });
  }

  function setGitHubTargetProjectLoading(
    projectId: string,
    isLoading: boolean,
  ) {
    setLoadingGitHubTargetProjectIds((current) => {
      const next = new Set(current);
      if (isLoading) {
        next.add(projectId);
      } else {
        next.delete(projectId);
      }
      return next;
    });
  }

  async function refreshProjects(): Promise<boolean> {
    const requestWorkspaceSelectionKey = workspaceSelectionKeyRef.current;
    setIsProjectsLoading(true);
    try {
      const data = await queryClient.fetchQuery(projectsQueryOptions());
      setProjects(data.projects);
      setSidebarError(null);
      const projectIds = new Set(data.projects.map((project) => project.id));
      const nextChatsByProject = retainRecordsForProjects(
        chatsByProjectRef.current,
        projectIds,
      );
      const nextWorktreesByProject = retainRecordsForProjects(
        worktreesByProjectRef.current,
        projectIds,
      );
      const nextGitHubTargetsByProject = Object.fromEntries(
        Object.entries(githubTargetsByProjectRef.current).filter(
          ([projectId]) => projectIds.has(projectId),
        ),
      );
      chatsByProjectRef.current = nextChatsByProject;
      worktreesByProjectRef.current = nextWorktreesByProject;
      githubTargetsByProjectRef.current = nextGitHubTargetsByProject;
      setChatsByProject(nextChatsByProject);
      setWorktreesByProject(nextWorktreesByProject);
      setGithubTargetsByProject(nextGitHubTargetsByProject);
      if (workspaceSelectionKeyRef.current !== requestWorkspaceSelectionKey) {
        return true;
      }
      const currentSelectedChatId = selectedChatIdRef.current;
      const currentSelectedProjectId = selectedProjectIdRef.current;
      const currentFileSearchQuery = fileSearchQueryRef.current;
      const requestedChat = findValidatedSelectedProjectChat(
        nextChatsByProject,
        data.projects,
        currentSelectedChatId,
        currentSelectedProjectId,
      );
      const fallbackProjectId =
        requestedChat?.projectId ??
        (currentSelectedProjectId &&
        data.projects.some((project) => project.id === currentSelectedProjectId)
          ? currentSelectedProjectId
          : (data.projects[0]?.id ?? null));
      const pendingChatId =
        currentSelectedProjectId === fallbackProjectId
          ? currentSelectedChatId
          : null;
      const nextChatId = requestedChat?.id ?? pendingChatId;
      updateWorkspaceSearchParams(
        {
          projectId: fallbackProjectId,
          chatId: nextChatId,
          clearFileQuery:
            Boolean(currentFileSearchQuery.trim()) &&
            currentSelectedChatId !== nextChatId,
        },
        { replace: true },
      );
      for (const project of data.projects) {
        void refreshWorktrees(project.id, {
          updateSelection: project.id === fallbackProjectId,
        });
        void refreshChats(project.id, {
          updateSelection: project.id === fallbackProjectId,
        });
      }
      return true;
    } catch (err) {
      setSidebarError(formatErrorMessage("Could not load projects", err));
      return false;
    } finally {
      setIsProjectsLoading(false);
    }
  }

  async function refreshModels() {
    setIsModelsLoading(true);
    try {
      const data = await queryClient.fetchQuery(modelsQueryOptions());
      setModels(data.models);
      setModelError(null);
    } catch (err) {
      setModelError(formatErrorMessage("Could not load models", err));
    } finally {
      setIsModelsLoading(false);
    }
  }

  async function refreshChatContext(chatId: string, signal?: AbortSignal) {
    setIsChatContextLoading(true);
    try {
      const data = await queryClient.fetchQuery(
        chatSkillsQueryOptions(chatId, signal),
      );
      if (signal?.aborted) {
        return;
      }
      setSkills(data.skills);
    } catch (err) {
      if (
        signal?.aborted ||
        (err instanceof Error && err.name === "AbortError")
      ) {
        return;
      }
      setComposerError(formatErrorMessage("Could not load skills", err));
    } finally {
      if (!signal?.aborted) {
        setIsChatContextLoading(false);
      }
    }
  }

  async function refreshWorktrees(
    projectId: string,
    options: { updateSelection?: boolean } = {},
  ): Promise<boolean> {
    const requestWorkspaceSelectionKey = workspaceSelectionKeyRef.current;
    setProjectLoading(projectId, true);
    try {
      const data = await queryClient.fetchQuery(
        projectWorktreesQueryOptions(projectId),
      );
      const mergedWorktrees = mergeWorktreesWithChats(
        data.worktrees,
        chatsByProjectRef.current[projectId] ?? [],
      );
      const nextWorktreesByProject = {
        ...worktreesByProjectRef.current,
        [projectId]: mergedWorktrees,
      };
      worktreesByProjectRef.current = nextWorktreesByProject;
      setWorktreesByProject(nextWorktreesByProject);
      if (options.updateSelection === false) {
        return true;
      }
      if (selectedProjectIdRef.current !== projectId) {
        return true;
      }
      if (workspaceSelectionKeyRef.current !== requestWorkspaceSelectionKey) {
        return true;
      }
      const fallbackWorktree = firstProjectWorktree(
        projectId,
        nextWorktreesByProject,
      );
      const currentSelectedChatId = selectedChatIdRef.current;
      const currentFileSearchQuery = fileSearchQueryRef.current;
      const nextChatId = resolveRefreshedWorktreeChatId(
        chatsByProjectRef.current[projectId],
        mergedWorktrees,
        currentSelectedChatId,
        fallbackWorktree?.chatId ?? null,
      );
      updateWorkspaceSearchParams(
        {
          projectId,
          chatId: nextChatId,
          clearFileQuery:
            Boolean(currentFileSearchQuery.trim()) &&
            currentSelectedChatId !== nextChatId,
        },
        { replace: true },
      );
      return true;
    } catch (err) {
      setSidebarError(formatErrorMessage("Could not load worktrees", err));
      return false;
    } finally {
      setProjectLoading(projectId, false);
    }
  }

  async function refreshChats(
    projectId: string,
    options: { updateSelection?: boolean } = {},
  ): Promise<boolean> {
    const requestWorkspaceSelectionKey = workspaceSelectionKeyRef.current;
    setChatProjectLoading(projectId, true);
    try {
      const data = await queryClient.fetchQuery(
        projectChatsQueryOptions(projectId),
      );
      const nextChatsByProject = {
        ...chatsByProjectRef.current,
        [projectId]: data.chats,
      };
      chatsByProjectRef.current = nextChatsByProject;
      setChatsByProject(nextChatsByProject);
      const currentProjectWorktrees =
        worktreesByProjectRef.current[projectId] ?? [];
      const mergedWorktrees = mergeWorktreesWithChats(
        currentProjectWorktrees,
        data.chats,
      );
      const nextWorktreesByProject = {
        ...worktreesByProjectRef.current,
        [projectId]: mergedWorktrees,
      };
      worktreesByProjectRef.current = nextWorktreesByProject;
      setWorktreesByProject(nextWorktreesByProject);
      if (options.updateSelection === false) {
        return true;
      }
      if (selectedProjectIdRef.current !== projectId) {
        return true;
      }
      if (workspaceSelectionKeyRef.current !== requestWorkspaceSelectionKey) {
        return true;
      }
      const fallbackWorktree = firstProjectWorktree(
        projectId,
        nextWorktreesByProject,
      );
      const currentSelectedChatId = selectedChatIdRef.current;
      const currentFileSearchQuery = fileSearchQueryRef.current;
      const nextChatId = data.chats.some(
        (chat) => chat.id === currentSelectedChatId,
      )
        ? currentSelectedChatId
        : currentSelectedChatId
          ? (fallbackWorktree?.chatId ?? data.chats[0]?.id ?? null)
          : null;
      updateWorkspaceSearchParams(
        {
          projectId,
          chatId: nextChatId,
          clearFileQuery:
            Boolean(currentFileSearchQuery.trim()) &&
            currentSelectedChatId !== nextChatId,
        },
        { replace: true },
      );
      return true;
    } catch (err) {
      setSidebarError(formatErrorMessage("Could not load chats", err));
      return false;
    } finally {
      setChatProjectLoading(projectId, false);
    }
  }

  async function refreshGitHubCheckoutTargets(projectId: string) {
    setGitHubTargetProjectLoading(projectId, true);
    try {
      const data = await queryClient.fetchQuery(
        projectGitHubCheckoutTargetsQueryOptions(projectId),
      );
      const nextGitHubTargetsByProject = {
        ...githubTargetsByProjectRef.current,
        [projectId]: data.github,
      };
      githubTargetsByProjectRef.current = nextGitHubTargetsByProject;
      setGithubTargetsByProject(nextGitHubTargetsByProject);
    } catch {
      const nextGitHubTargetsByProject = {
        ...githubTargetsByProjectRef.current,
        [projectId]: {
          available: false,
          targets: [],
        },
      };
      githubTargetsByProjectRef.current = nextGitHubTargetsByProject;
      setGithubTargetsByProject(nextGitHubTargetsByProject);
    } finally {
      setGitHubTargetProjectLoading(projectId, false);
    }
  }

  function upsertChatRecord(chat: ChatRecord) {
    const projectChats = chatsByProjectRef.current[chat.projectId] ?? [];
    const hasExistingChat = projectChats.some(
      (candidate) => candidate.id === chat.id,
    );
    const nextProjectChats = hasExistingChat
      ? projectChats.map((candidate) =>
          candidate.id === chat.id ? chat : candidate,
        )
      : [chat, ...projectChats];
    const nextChatsByProject = {
      ...chatsByProjectRef.current,
      [chat.projectId]: nextProjectChats,
    };
    chatsByProjectRef.current = nextChatsByProject;
    setChatsByProject(nextChatsByProject);

    const projectWorktrees =
      worktreesByProjectRef.current[chat.projectId] ?? [];
    const nextWorktreesByProject = {
      ...worktreesByProjectRef.current,
      [chat.projectId]: mergeWorktreesWithChats(
        projectWorktrees,
        nextProjectChats,
      ),
    };
    worktreesByProjectRef.current = nextWorktreesByProject;
    setWorktreesByProject(nextWorktreesByProject);
  }

  async function refreshSelectedChat(chatId: string) {
    const data = await queryClient.fetchQuery(chatQueryOptions(chatId));
    upsertChatRecord(data.chat);
  }

  async function refreshPendingApproval(chatId: string, signal?: AbortSignal) {
    const requestId = approvalRefreshRequestIdRef.current + 1;
    approvalRefreshRequestIdRef.current = requestId;
    const eventVersion = approvalEventVersionRef.current;
    try {
      const data = await queryClient.fetchQuery(
        chatApprovalQueryOptions(chatId, signal),
      );
      if (
        selectedChatIdRef.current === chatId &&
        approvalRefreshRequestIdRef.current === requestId &&
        approvalEventVersionRef.current === eventVersion
      ) {
        updatePendingApproval(
          data.approval ? { ...data.approval, chatId } : null,
        );
      }
    } catch (err) {
      if (
        signal?.aborted ||
        (err instanceof Error && err.name === "AbortError")
      ) {
        return;
      }
      if (
        selectedChatIdRef.current === chatId &&
        approvalRefreshRequestIdRef.current === requestId
      ) {
        showToast(formatErrorMessage("Could not load approval", err));
      }
    }
  }

  async function refreshMessages(
    chatId: string,
    options: { preserveStreamOrder?: boolean; showLoading?: boolean } = {},
  ) {
    const requestId = messagesRefreshRequestIdRef.current + 1;
    messagesRefreshRequestIdRef.current = requestId;
    if (options.showLoading) {
      setIsMessagesLoading(true);
    }
    try {
      const data = await queryClient.fetchQuery(messagesQueryOptions(chatId));
      if (
        selectedChatIdRef.current === chatId &&
        messagesRefreshRequestIdRef.current === requestId
      ) {
        const shouldPreserveStreamOrder =
          options.preserveStreamOrder === true &&
          messagesChatIdRef.current === chatId;
        setMessages((currentMessages) =>
          shouldPreserveStreamOrder
            ? mergeStreamingMessagesForDisplay(currentMessages, data.messages)
            : data.messages,
        );
        setMessagesChatId(chatId);
        setTimelineError(null);
      }
    } catch (err) {
      if (
        selectedChatIdRef.current === chatId &&
        messagesRefreshRequestIdRef.current === requestId
      ) {
        setTimelineError(formatErrorMessage("Could not load messages", err));
      }
    } finally {
      if (options.showLoading && selectedChatIdRef.current === chatId) {
        setIsMessagesLoading(false);
      }
    }
  }

  function saveChatScrollPosition(chatId: string) {
    const timeline = chatTimelineRef.current;
    if (!timeline || scrollRestoredChatIdRef.current !== chatId) {
      return;
    }
    writeStoredChatScrollPosition(chatId, timeline);
  }

  function scheduleSelectedChatScrollPositionSave() {
    const chatId = selectedChatIdRef.current;
    const timeline = chatTimelineRef.current;
    if (!chatId || !timeline || scrollRestoredChatIdRef.current !== chatId) {
      return;
    }
    isChatTimelinePinnedToBottomRef.current =
      isChatTimelineScrolledToBottom(timeline);
    if (shouldIgnoreNextChatTimelineScrollRef.current) {
      shouldIgnoreNextChatTimelineScrollRef.current = false;
      return;
    }
    if (scrollSaveAnimationFrameRef.current !== null) {
      return;
    }
    scrollSaveAnimationFrameRef.current = requestAnimationFrame(() => {
      scrollSaveAnimationFrameRef.current = null;
      if (
        selectedChatIdRef.current === chatId &&
        scrollRestoredChatIdRef.current === chatId
      ) {
        saveChatScrollPosition(chatId);
      }
    });
  }

  function openAddProjectDialog() {
    setAddProjectError(null);
    setIsAddProjectOpen(true);
  }

  function closeAddProjectDialog() {
    setIsAddProjectOpen(false);
    setAddProjectError(null);
  }

  async function addProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedProjectPath = projectPath.trim();
    if (!trimmedProjectPath) {
      return;
    }

    setAddProjectError(null);
    const requestWorkspaceSelectionKey = workspaceSelectionKeyRef.current;
    setIsBusy(true);
    try {
      const data = await addProjectRequest.mutateAsync(trimmedProjectPath);
      void queryClient.invalidateQueries({ queryKey: queryKeys.projects });
      setProjectPath("");
      closeAddProjectDialog();
      const didRefresh = await refreshProjects();
      if (!didRefresh) {
        return;
      }
      if (workspaceSelectionKeyRef.current !== requestWorkspaceSelectionKey) {
        return;
      }
      updateWorkspaceSearchParams({
        projectId: data.project.id,
        chatId: null,
      });
    } catch (err) {
      setAddProjectError(formatErrorMessage("Could not add project", err));
    } finally {
      setIsBusy(false);
    }
  }

  function openDeleteProject(project: ProjectRecord) {
    setDeleteProjectError(null);
    setDeleteProjectTarget(project.id);
  }

  function closeDeleteProjectDialog() {
    setDeleteProjectTarget(null);
    setDeleteProjectError(null);
  }

  async function deleteSelectedProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!pendingDeleteProject || pendingDeleteProjectBlockingChat) {
      return;
    }

    setDeleteProjectError(null);
    setIsBusy(true);
    const projectId = pendingDeleteProject.id;
    const deletedProjectChatIds = (
      chatsByProjectRef.current[projectId] ?? []
    ).map((chat) => chat.id);
    const shouldClearComposerContext =
      selectedProjectIdRef.current === projectId;
    try {
      await deleteProjectRequest.mutateAsync(projectId);
      queryClient.removeQueries({
        exact: true,
        queryKey: queryKeys.projects,
      });
      queryClient.removeQueries({
        queryKey: queryKeys.projectWorktrees(projectId),
      });
      queryClient.removeQueries({
        queryKey: queryKeys.projectChats(projectId),
      });
      for (const chatId of deletedProjectChatIds) {
        queryClient.removeQueries({ queryKey: queryKeys.chat(chatId) });
      }
      setExpandedWorktreeKeys((current) => {
        const next = new Set<string>();
        for (const key of current) {
          if (!key.startsWith(`${projectId}:`)) {
            next.add(key);
          }
        }
        return next;
      });
      if (shouldClearComposerContext) {
        setComposerText("");
        setSelectedFiles([]);
        setSelectedSkillPaths(new Set());
        setTransientFileSearchQuery(null);
        setFileSearchResults([]);
        setSkills([]);
        updatePendingApproval(null);
        restoredPendingComposerContextRef.current = null;
      }
      closeDeleteProjectDialog();
      await refreshProjects();
    } catch (err) {
      setDeleteProjectError(
        formatErrorMessage("Could not delete project", err),
      );
    } finally {
      setIsBusy(false);
    }
  }

  async function createProjectChat(
    projectId: string,
    requestWorkspaceSelectionKey: string,
    input: Parameters<typeof createChatMutation>[1] = {},
  ): Promise<ChatRecord | null> {
    const data = await createChatRequest.mutateAsync({ projectId, input });
    void queryClient.invalidateQueries({
      queryKey: queryKeys.projectWorktrees(projectId),
    });
    void queryClient.invalidateQueries({
      queryKey: queryKeys.projectChats(projectId),
    });
    void queryClient.invalidateQueries({
      queryKey: queryKeys.projectGitHubCheckoutTargets(projectId),
    });
    setExpandedWorktreeKeys((current) =>
      new Set(current).add(
        getWorktreeExpansionKey(projectId, data.chat.worktreePath),
      ),
    );
    const didRefreshWorktrees = await refreshWorktrees(projectId, {
      updateSelection: false,
    });
    if (!didRefreshWorktrees) {
      return null;
    }
    const didRefreshChats = await refreshChats(projectId, {
      updateSelection: false,
    });
    if (!didRefreshChats) {
      return null;
    }
    if (getCurrentUrlWorkspaceSelectionKey() !== requestWorkspaceSelectionKey) {
      return data.chat;
    }
    updateWorkspaceSearchParams({
      projectId,
      chatId: data.chat.id,
      clearFileQuery: true,
    });
    selectedProjectIdRef.current = projectId;
    selectedChatIdRef.current = data.chat.id;
    return data.chat;
  }

  async function createChat(
    projectId: string,
    worktree?: ProjectWorktreeRecord,
  ): Promise<ChatRecord | null> {
    if (isBusy || createChatInFlightRef.current) {
      return null;
    }

    setSidebarError(null);
    const requestWorkspaceSelectionKey = workspaceSelectionKeyRef.current;
    const worktreeKey = worktree
      ? getWorktreeExpansionKey(projectId, worktree.path)
      : null;
    createChatInFlightRef.current = true;
    if (worktreeKey) {
      setCreatingWorktreeKey(worktreeKey);
    } else {
      setCreatingProjectId(projectId);
    }
    setIsBusy(true);
    try {
      return await createProjectChat(
        projectId,
        requestWorkspaceSelectionKey,
        worktree
          ? {
              worktreeName: worktree.name,
              worktreePath: worktree.path,
            }
          : {},
      );
    } catch (err) {
      showToast(formatErrorMessage("Could not create worktree", err));
      return null;
    } finally {
      createChatInFlightRef.current = false;
      setCreatingProjectId(null);
      setCreatingWorktreeKey(null);
      setIsBusy(false);
    }
  }

  function openDeleteWorktree(
    projectId: string,
    worktree: ProjectWorktreeRecord,
  ) {
    confirmDeleteWorktree(projectId, worktree);
  }

  function confirmDeleteWorktree(
    projectId: string,
    worktree: ProjectWorktreeRecord,
  ) {
    setDeleteWorktreeError(null);
    setDeleteWorktreeBranchMode("default");
    setDeleteWorktreeForce(false);
    setDeleteWorktreeTarget({
      forceRequired: !worktree.isClean,
      projectId,
      worktreePath: worktree.path,
    });
  }

  function closeDeleteWorktreeDialog() {
    setDeleteWorktreeTarget(null);
    setDeleteWorktreeError(null);
    setDeleteWorktreeBranchMode("default");
    setDeleteWorktreeForce(false);
  }

  async function deleteWorktree(
    projectId: string,
    worktree: ProjectWorktreeRecord,
    options: {
      branchMode: DeleteWorktreeBranchMode;
      force: boolean;
    },
  ) {
    setDeleteWorktreeError(null);
    setIsBusy(true);
    try {
      const deleteWorktreeInput: {
        force: boolean;
        keepBranch?: boolean;
        name: string;
        path: string;
      } = {
        name: worktree.name,
        path: worktree.path,
        force: options.force,
      };
      if (options.branchMode === "keep") {
        deleteWorktreeInput.keepBranch = true;
      }
      if (options.branchMode === "delete") {
        deleteWorktreeInput.keepBranch = false;
      }
      await deleteWorktreeRequest.mutateAsync({
        projectId,
        input: deleteWorktreeInput,
      });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.projectWorktrees(projectId),
      });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.projectChats(projectId),
      });
      closeDeleteWorktreeDialog();
      await refreshWorktrees(projectId, {
        updateSelection: selectedProjectIdRef.current === projectId,
      });
      await refreshChats(projectId, {
        updateSelection: selectedProjectIdRef.current === projectId,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const requiresForce =
        !options.force && message.includes("has uncommitted changes");
      if (requiresForce) {
        setDeleteWorktreeBranchMode(options.branchMode);
        setDeleteWorktreeForce(false);
        setDeleteWorktreeTarget({
          forceRequired: true,
          projectId,
          worktreePath: worktree.path,
        });
      }
      if (deleteWorktreeTarget || requiresForce) {
        setDeleteWorktreeError(
          formatErrorMessage("Could not delete worktree", message),
        );
      } else {
        showToast(formatErrorMessage("Could not delete worktree", message));
      }
    } finally {
      setIsBusy(false);
    }
  }

  async function deleteSelectedWorktree(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!deleteWorktreeTarget || !pendingDeleteWorktree) {
      return;
    }

    await deleteWorktree(
      deleteWorktreeTarget.projectId,
      pendingDeleteWorktree,
      {
        branchMode: deleteWorktreeBranchMode,
        force: deleteWorktreeForce,
      },
    );
  }

  async function syncWorktreeBranch(
    projectId: string,
    worktree: ProjectWorktreeRecord,
  ) {
    if (isBusy) {
      return;
    }

    setSidebarError(null);
    setIsBusy(true);
    try {
      await syncWorktreeRequest.mutateAsync({
        projectId,
        input: {
          name: worktree.name,
          path: worktree.path,
        },
      });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.projectWorktrees(projectId),
      });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.projectChats(projectId),
      });
      await refreshWorktrees(projectId, {
        updateSelection: selectedProjectIdRef.current === projectId,
      });
      await refreshChats(projectId, {
        updateSelection: selectedProjectIdRef.current === projectId,
      });
    } catch (err) {
      showToast(formatErrorMessage("Could not sync branch", err));
    } finally {
      setIsBusy(false);
    }
  }

  async function setChatArchived(chat: ChatRecord, archived: boolean) {
    if (isBusy || archiveChatRequest.isPending) {
      return;
    }
    if (archived && !canArchiveChat(chat)) {
      return;
    }
    const hasRestoredPendingDraftForChat =
      selectedChatIdRef.current === chat.id &&
      restoredPendingComposerContextRef.current?.chatId === chat.id &&
      Boolean(composerTextRef.current.trim() || hasSelectedContextRef.current);
    const hasSelectedComposerDraftForChat =
      selectedChatIdRef.current === chat.id &&
      Boolean(composerTextRef.current.trim() || hasSelectedContextRef.current);
    if (
      archived &&
      (hasSelectedComposerDraftForChat || hasRestoredPendingDraftForChat)
    ) {
      setComposerError(
        "Clear or send the current message before archiving this chat",
      );
      composerTextareaRef.current?.focus();
      return;
    }

    setComposerError(null);
    setIsBusy(true);
    setArchiveTransitionChatId(chat.id);
    try {
      const data = await archiveChatRequest.mutateAsync({
        chatId: chat.id,
        archived,
      });
      upsertChatRecord(data.chat);
      void queryClient.invalidateQueries({
        queryKey: queryKeys.chat(chat.id),
      });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.projectChats(chat.projectId),
      });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.projectWorktrees(chat.projectId),
      });
      if (selectedChatIdRef.current === chat.id && archived) {
        restoredPendingComposerContextRef.current = null;
        setComposerText("");
        setSelectedFiles([]);
        setSelectedSkillPaths(new Set());
      }
      await refreshChats(chat.projectId, { updateSelection: false });
      await refreshWorktrees(chat.projectId, { updateSelection: false });
    } catch (err) {
      setComposerError(
        formatErrorMessage(
          archived ? "Could not archive chat" : "Could not restore chat",
          err,
        ),
      );
    } finally {
      setArchiveTransitionChatId(null);
      setIsBusy(false);
    }
  }

  function createSelectedWorktreeChat() {
    if (!selectedProjectId || !selectedWorktree) {
      return;
    }

    void createChat(selectedProjectId, selectedWorktree);
  }

  function openDeleteSelectedWorktree() {
    if (
      !selectedProjectId ||
      !selectedWorktree ||
      !selectedWorktree.isManagedByPhantom
    ) {
      return;
    }

    confirmDeleteWorktree(selectedProjectId, selectedWorktree);
  }

  async function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await submitComposer("send");
  }

  function createComposerMessageInput(
    text: string,
    restoredPendingContext: RestoredPendingComposerContext | null,
  ): SendMessageInput {
    const turnModel =
      selectedModel?.id ??
      selectedModel?.model ??
      restoredPendingContext?.model ??
      undefined;
    const turnEffort = selectedModel
      ? selectedEffort && selectedModelSupportedEfforts.includes(selectedEffort)
        ? selectedEffort
        : null
      : (restoredPendingContext?.effort ?? null);
    const files = selectedFiles.map((file) => ({
      name: file.relativePath,
      path: file.path,
    }));
    return {
      effort: turnEffort,
      files,
      model: turnModel,
      skills: getSelectedSkillContextItems(skills, selectedSkillPaths),
      text,
    };
  }

  async function submitNewProjectChat(
    projectId: string,
    input: SendMessageInput,
    composerInput: string,
    requestWorkspaceSelectionKey: string,
    githubTargetNumber: number | null,
  ) {
    let createdChatId: string | null = null;
    const isRequestWorkspaceSelected = () =>
      getCurrentUrlWorkspaceSelectionKey() === requestWorkspaceSelectionKey;
    const isCreatedChatSelected = () =>
      createdChatId !== null &&
      getCurrentUrlWorkspaceSelectionKey() ===
        getWorkspaceSelectionKey(projectId, createdChatId);
    createChatInFlightRef.current = true;
    setCreatingProjectId(projectId);
    setIsBusy(true);
    try {
      const chat = await createProjectChat(
        projectId,
        requestWorkspaceSelectionKey,
        {
          githubTargetNumber: githubTargetNumber ?? undefined,
          initialMessage: input.text,
        },
      );
      if (!chat) {
        if (isRequestWorkspaceSelected()) {
          setComposerText(composerInput);
        }
        return;
      }

      createdChatId = chat.id;
      pendingSendChatIdsRef.current.add(chat.id);
      pendingComposerModesByChatRef.current.set(chat.id, "send");
      const sentData = await sendMessageRequest.mutateAsync({
        chatId: chat.id,
        input,
      });
      upsertChatRecord(sentData.chat);
      void queryClient.invalidateQueries({
        queryKey: queryKeys.messages(chat.id),
      });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.chat(chat.id),
      });
      if (isCreatedChatSelected()) {
        setSelectedFiles([]);
        setSelectedSkillPaths(new Set());
        setSelectedGitHubTargetNumber(null);
        setFileSearchQuery("");
        await refreshMessages(chat.id);
      }
    } catch (err) {
      if (
        createdChatId ? isCreatedChatSelected() : isRequestWorkspaceSelected()
      ) {
        setComposerText(composerInput);
        setComposerError(formatErrorMessage("Could not send message", err));
      }
    } finally {
      if (createdChatId) {
        pendingSendChatIdsRef.current.delete(createdChatId);
        pendingComposerModesByChatRef.current.delete(createdChatId);
      }
      createChatInFlightRef.current = false;
      setCreatingProjectId(null);
      setIsBusy(false);
    }
  }

  async function submitComposer(mode: ComposerSubmitMode) {
    const requestChatId = validatedSelectedChatId;
    const isStartingNewProjectChat =
      !requestChatId && Boolean(selectedProjectId);
    if (
      (!requestChatId && (!selectedProjectId || mode !== "send")) ||
      !canSendMessage ||
      isComposerBlocked ||
      (isStartingNewProjectChat && (isBusy || createChatInFlightRef.current)) ||
      (mode === "steer" && !selectedChat?.activeTurnId)
    ) {
      return;
    }
    setComposerError(null);
    const requestChatVersion = selectedChatVersionRef.current;
    const requestId = sendMessageRequestIdRef.current + 1;
    sendMessageRequestIdRef.current = requestId;
    const isCurrentSendRequest = () =>
      requestChatId !== null &&
      selectedChatIdRef.current === requestChatId &&
      selectedChatVersionRef.current === requestChatVersion &&
      sendMessageRequestIdRef.current === requestId;
    const composerInput = composerText;
    const text =
      composerInput.trim().length > 0
        ? composerInput
        : getContextOnlyMessage({
            hasFiles: selectedFiles.length > 0,
            hasSkills: selectedSkills.length > 0,
          });
    setComposerText("");
    const restoredPendingContext =
      requestChatId &&
      restoredPendingComposerContextRef.current?.chatId === requestChatId
        ? restoredPendingComposerContextRef.current
        : null;
    const messageInput = createComposerMessageInput(
      text,
      restoredPendingContext,
    );
    if (!requestChatId) {
      if (!selectedProjectId) {
        return;
      }
      setIsSendingMessage(true);
      setPendingComposerMode("send");
      await submitNewProjectChat(
        selectedProjectId,
        messageInput,
        composerInput,
        workspaceSelectionKeyRef.current,
        selectedGitHubTarget?.number ?? null,
      );
      setIsSendingMessage(false);
      setPendingComposerMode(null);
      return;
    }
    pendingSendChatIdsRef.current.add(requestChatId);
    pendingComposerModesByChatRef.current.set(requestChatId, mode);
    setIsSendingMessage(true);
    setPendingComposerMode(mode);
    try {
      const mutation =
        mode === "steer"
          ? steerMessageRequest
          : mode === "queue"
            ? queueMessageRequest
            : sendMessageRequest;
      await mutation.mutateAsync({
        chatId: requestChatId,
        input: messageInput,
      });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.messages(requestChatId),
      });
      if (restoredPendingComposerContextRef.current?.chatId === requestChatId) {
        restoredPendingComposerContextRef.current = null;
      }
      if (!isCurrentSendRequest()) {
        return;
      }
      setSelectedFiles([]);
      setSelectedSkillPaths(new Set());
      setFileSearchQuery("");
      await refreshMessages(requestChatId);
    } catch (err) {
      if (!isCurrentSendRequest()) {
        return;
      }
      setComposerText(composerInput);
      setComposerError(formatErrorMessage("Could not send message", err));
    } finally {
      pendingSendChatIdsRef.current.delete(requestChatId);
      pendingComposerModesByChatRef.current.delete(requestChatId);
      if (
        isCurrentSendRequest() ||
        selectedChatIdRef.current === requestChatId
      ) {
        setIsSendingMessage(false);
        setPendingComposerMode(
          pendingComposerModesByChatRef.current.get(requestChatId) ?? null,
        );
      }
    }
  }

  async function deletePendingMessage(message: VisibleMessageRecord) {
    if (!selectedChatId || message.chatId !== selectedChatId) {
      return null;
    }
    const requestChatId = selectedChatId;
    try {
      const data = await deletePendingMessageRequest.mutateAsync({
        chatId: requestChatId,
        messageId: message.id,
      });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.messages(requestChatId),
      });
      await refreshMessages(requestChatId);
      return data;
    } catch (err) {
      showToast(formatErrorMessage("Could not delete pending message", err));
      return null;
    }
  }

  async function editPendingMessage(message: VisibleMessageRecord) {
    if (composerText.trim() || hasSelectedContext) {
      setComposerError(
        "Clear the current message before editing a pending message",
      );
      composerTextareaRef.current?.focus();
      return;
    }
    const deletedPendingMessage = await deletePendingMessage(message);
    if (!deletedPendingMessage) {
      return;
    }
    const canRestoreIntoComposer =
      selectedChatIdRef.current === deletedPendingMessage.message.chatId &&
      !composerTextRef.current.trim() &&
      !hasSelectedContextRef.current;
    if (!canRestoreIntoComposer) {
      const requeueChatId = deletedPendingMessage.message.chatId;
      try {
        await restorePendingMessageRequest.mutateAsync({
          chatId: requeueChatId,
          input: deletedPendingMessage,
        });
        void queryClient.invalidateQueries({
          queryKey: queryKeys.messages(requeueChatId),
        });
        if (selectedChatIdRef.current === requeueChatId) {
          await refreshMessages(requeueChatId);
        }
        showToast(
          "Pending message was restored to the queue because the composer changed before editing completed",
          "warning",
        );
      } catch (err) {
        showToast(
          `Pending message was deleted but could not be restored: ${getErrorMessage(
            err,
          )}`,
        );
      }
      return;
    }
    restoredPendingComposerContextRef.current = {
      chatId: deletedPendingMessage.message.chatId,
      effort: deletedPendingMessage.queuedMessage.effort ?? null,
      model: deletedPendingMessage.queuedMessage.model ?? null,
    };
    setComposerText(deletedPendingMessage.message.text);
    setSelectedFiles(
      (deletedPendingMessage.queuedMessage.files ?? []).map(
        contextItemToSelectedFile,
      ),
    );
    setSelectedSkillPaths(
      new Set(
        (deletedPendingMessage.queuedMessage.skills ?? []).map(
          (skill) => skill.path,
        ),
      ),
    );
    setSearchParamValue(
      searchParamKeys.model,
      deletedPendingMessage.queuedMessage.model ?? null,
    );
    setSearchParamValue(
      searchParamKeys.effort,
      deletedPendingMessage.queuedMessage.effort ?? null,
    );
    requestAnimationFrame(() => {
      composerTextareaRef.current?.focus();
    });
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    const action = getComposerEnterAction({
      altKey: event.altKey,
      code: event.code,
      ctrlKey: event.ctrlKey,
      isComposing: event.nativeEvent.isComposing,
      key: event.key,
      keyCode: event.keyCode,
      metaKey: event.metaKey,
      shiftKey: event.shiftKey,
    });
    if (!action) {
      return;
    }
    if (
      (!validatedSelectedChatId && !selectedProjectId) ||
      !canSendMessage ||
      isSendingMessage
    ) {
      return;
    }
    const submitMode = getComposerSubmitModeForEnter(action, selectedChat);
    if (!submitMode || (!validatedSelectedChatId && submitMode !== "send")) {
      return;
    }
    event.preventDefault();
    if (submitMode === "send") {
      event.currentTarget.form?.requestSubmit();
      return;
    }
    void submitComposer(submitMode);
  }

  async function interruptChat() {
    if (!selectedChatId) {
      return;
    }
    setIsInterrupting(true);
    try {
      await interruptChatRequest.mutateAsync(selectedChatId);
      void queryClient.invalidateQueries({
        queryKey: queryKeys.chat(selectedChatId),
      });
    } catch (err) {
      showToast(formatErrorMessage("Could not stop turn", err));
    } finally {
      setIsInterrupting(false);
    }
  }

  async function answerApproval(decision: string) {
    if (
      !selectedChatId ||
      !pendingApproval ||
      pendingApproval.chatId !== selectedChatId
    ) {
      return;
    }
    const requestChatId = pendingApproval.chatId;
    const requestApproval = pendingApproval;
    const isCurrentApproval = () =>
      selectedChatIdRef.current === requestChatId &&
      pendingApprovalRef.current?.requestId === requestApproval.requestId;
    setApprovalError(null);
    try {
      if (
        decision !== "accept" &&
        decision !== "acceptForSession" &&
        decision !== "decline" &&
        decision !== "cancel"
      ) {
        throw new Error("Approval decision is invalid");
      }
      await answerApprovalRequest.mutateAsync({
        chatId: requestChatId,
        decision,
        requestId: requestApproval.requestId,
      });
      approvalEventVersionRef.current += 1;
      void queryClient.invalidateQueries({
        queryKey: queryKeys.chatApproval(requestChatId),
      });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.chat(requestChatId),
      });
      clearPendingApprovalForRequest(requestChatId, requestApproval.requestId);
    } catch (err) {
      if (isCurrentApproval()) {
        setApprovalError(formatErrorMessage("Could not answer approval", err));
      }
    }
  }

  function toggleProject(projectId: string) {
    updateSearchParams((nextSearchParams) => {
      const next = readSearchParamSet(
        nextSearchParams,
        searchParamKeys.expandedProject,
      );
      if (next.has(projectId)) {
        next.delete(projectId);
      } else {
        next.add(projectId);
      }
      writeSearchParamSet(
        nextSearchParams,
        searchParamKeys.expandedProject,
        next,
      );
    });
  }

  function selectProject(projectId: string) {
    restoredPendingComposerContextRef.current = null;
    setComposerText("");
    setSelectedFiles([]);
    setSelectedSkillPaths(new Set());
    setFileSearchResults([]);
    setSkills([]);
    updateWorkspaceSearchParams({
      projectId,
      chatId: null,
      clearFileQuery: true,
    });
  }

  function toggleWorktreeChats(projectId: string, worktreePath: string) {
    const worktreeKey = getWorktreeExpansionKey(projectId, worktreePath);
    setExpandedWorktreeKeys((current) => {
      const next = new Set(current);
      if (next.has(worktreeKey)) {
        next.delete(worktreeKey);
      } else {
        next.add(worktreeKey);
      }
      return next;
    });
  }

  function selectWorktree(projectId: string, worktree: ProjectWorktreeRecord) {
    updateWorkspaceSearchParams({
      projectId,
      chatId: worktree.chatId,
      clearFileQuery: true,
    });
  }

  function selectChat(
    projectId: string,
    worktree: ProjectWorktreeRecord,
    chatId: string,
  ) {
    updateWorkspaceSearchParams({
      projectId,
      chatId,
      clearFileQuery: true,
    });
    setExpandedWorktreeKeys((current) =>
      new Set(current).add(getWorktreeExpansionKey(projectId, worktree.path)),
    );
  }

  function selectFile(path: string) {
    const file = fileSearchResults.find((candidate) => candidate.path === path);
    if (!file) {
      return;
    }
    setSelectedFiles((current) =>
      current.some((selectedFile) => selectedFile.path === file.path)
        ? current
        : [...current, file],
    );
    setFileSearchQuery("");
  }

  function selectSkill(path: string) {
    setSelectedSkillPaths((current) => new Set(current).add(path));
  }

  const visiblePendingApproval =
    pendingApproval?.chatId === selectedChatId ? pendingApproval : null;

  return (
    <SidebarProvider className="app-shell">
      <Sidebar collapsible="offcanvas" variant="inset">
        <SidebarHeader>
          <div className="flex size-8 shrink-0 items-center justify-center rounded-[var(--radius-sm)] bg-[var(--brand-mark-bg)] text-[var(--brand-mark-fg)]">
            <FolderGit2 className="size-4" />
          </div>
          <div className="min-w-0 flex-1 group-data-[state=collapsed]/sidebar:hidden">
            <h1 className="truncate text-[length:var(--font-size-lg)] font-semibold leading-tight">
              Phantom
            </h1>
          </div>
          <Badge
            className="max-w-28 truncate group-data-[state=collapsed]/sidebar:hidden"
            variant={status === "Ready" ? "success" : "warning"}
          >
            {status !== "Ready" && <LoadingSpinner className="size-3" />}
            {status}
          </Badge>
        </SidebarHeader>

        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupHeader>
              <SidebarGroupLabel>Projects</SidebarGroupLabel>
              <SidebarGroupAction
                aria-label="Add project"
                onClick={openAddProjectDialog}
                title="Add project"
              >
                <Plus className="size-4" />
              </SidebarGroupAction>
            </SidebarGroupHeader>
            <SidebarGroupContent>
              {sidebarError && (
                <InlineNotice
                  className="mx-2 mb-2 group-data-[state=collapsed]/sidebar:hidden"
                  message={sidebarError}
                  onDismiss={() => setSidebarError(null)}
                />
              )}
              <SidebarMenu>
                {showProjectListSkeleton ? (
                  <li className="px-2 py-1 group-data-[state=collapsed]/sidebar:hidden">
                    <ProjectListSkeleton />
                  </li>
                ) : projects.length === 0 ? (
                  <li className="px-2 py-4 group-data-[state=collapsed]/sidebar:hidden">
                    <div className="rounded-[var(--radius-md)] border border-dashed border-sidebar-border bg-[var(--surface-card)] px-3 py-3 text-[length:var(--font-size-sm)] text-muted-foreground">
                      Add a Git project to begin.
                    </div>
                  </li>
                ) : (
                  projects.map((project) => {
                    const isProjectExpanded = expandedProjectIds.has(
                      project.id,
                    );
                    const projectWorktrees =
                      worktreesByProject[project.id] ?? [];
                    const isProjectDataLoading =
                      loadingProjectIds.has(project.id) &&
                      worktreesByProject[project.id] === undefined;

                    return (
                      <SidebarMenuItem key={project.id}>
                        <div className="group/project flex items-center gap-0.5 rounded-[var(--radius-sm)]">
                          <button
                            aria-expanded={isProjectExpanded}
                            aria-label={`${isProjectExpanded ? "Collapse" : "Expand"} ${project.name}`}
                            className="inline-flex size-7 shrink-0 items-center justify-center rounded-[var(--radius-sm)] text-[var(--icon-color-default)] outline-none transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:shadow-[var(--state-focus-ring)] group-data-[state=collapsed]/sidebar:hidden"
                            onClick={() => toggleProject(project.id)}
                            title={isProjectExpanded ? "Collapse" : "Expand"}
                            type="button"
                          >
                            <ChevronRight
                              className={cn(
                                "size-4 transition-transform duration-[var(--motion-duration-fast)]",
                                isProjectExpanded && "rotate-90",
                              )}
                            />
                          </button>
                          <SidebarMenuButton
                            className="min-h-8 flex-1 group-data-[state=collapsed]/sidebar:flex-none"
                            isActive={
                              selectedProjectId === project.id && !selectedChat
                            }
                            onClick={() => selectProject(project.id)}
                            title={project.name}
                            type="button"
                          >
                            <FolderGit2 className="size-4 text-[var(--icon-color-default)]" />
                            <span className="min-w-0 flex-1 group-data-[state=collapsed]/sidebar:hidden">
                              <span className="block truncate font-medium">
                                {project.name}
                              </span>
                            </span>
                          </SidebarMenuButton>
                          <Button
                            aria-label={`Create worktree in ${project.name}`}
                            className="size-7 text-[var(--icon-color-default)] group-data-[state=collapsed]/sidebar:hidden"
                            disabled={isBusy}
                            onClick={() => void createChat(project.id)}
                            size="icon"
                            title="Create worktree"
                            type="button"
                            variant="ghost"
                          >
                            {creatingProjectId === project.id ? (
                              <LoadingSpinner className="size-4" />
                            ) : (
                              <MessageSquarePlus className="size-4" />
                            )}
                          </Button>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button
                                aria-label={`Open actions for ${project.name}`}
                                className={cn(
                                  "mr-1 size-7 text-[var(--icon-color-default)] opacity-100 data-[state=open]:opacity-100 group-data-[state=collapsed]/sidebar:hidden sm:opacity-0 sm:group-focus-within/project:opacity-100 sm:group-hover/project:opacity-100",
                                  selectedProjectId === project.id &&
                                    "sm:opacity-100",
                                )}
                                disabled={isBusy}
                                size="icon"
                                title="Project actions"
                                type="button"
                                variant="ghost"
                              >
                                <MoreHorizontal className="size-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem
                                disabled={isBusy}
                                onSelect={() => openDeleteProject(project)}
                                variant="destructive"
                              >
                                <Trash2 className="size-4" />
                                <span>Delete project</span>
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>
                        {isProjectExpanded && (
                          <SidebarMenuSub>
                            {isProjectDataLoading ? (
                              <li className="px-2 py-1.5">
                                <WorktreeListSkeleton />
                              </li>
                            ) : projectWorktrees.length === 0 ? (
                              <li className="px-2 py-1.5 text-[length:var(--font-size-xs)] text-[var(--text-tertiary)]">
                                No worktrees
                              </li>
                            ) : (
                              projectWorktrees.map((worktree) => {
                                const isSelectedWorktree =
                                  selectedProjectId === project.id &&
                                  selectedWorktree?.path === worktree.path;
                                const worktreeChats =
                                  chatsByWorktreeByProject[project.id]?.get(
                                    worktree.path,
                                  ) ?? [];
                                const activeWorktreeChat =
                                  worktreeChats.find(
                                    (chat) =>
                                      chat.status === "running" ||
                                      chat.status === "waitingForApproval" ||
                                      Boolean(chat.activeTurnId),
                                  ) ?? null;
                                const isWorktreeSending =
                                  isSendingMessage &&
                                  selectedChat?.projectId === project.id &&
                                  selectedChat.worktreePath === worktree.path;
                                const worktreeActivityLabel = isWorktreeSending
                                  ? "Sending message"
                                  : activeWorktreeChat
                                    ? statusMeta[activeWorktreeChat.status]
                                        .label
                                    : null;
                                const worktreeKey = getWorktreeExpansionKey(
                                  project.id,
                                  worktree.path,
                                );
                                const isCreatingWorktreeChat =
                                  creatingWorktreeKey === worktreeKey;
                                const isWorktreeExpanded =
                                  expandedWorktreeKeys.has(worktreeKey);
                                const isChatListLoading =
                                  loadingChatProjectIds.has(project.id) &&
                                  worktreeChats.length === 0;
                                const title = `${worktree.name} (${worktree.path})${
                                  worktree.isClean ? "" : " [dirty]"
                                }${
                                  worktree.isMainWorktree
                                    ? " [main worktree]"
                                    : ""
                                }${
                                  worktreeActivityLabel
                                    ? ` [${worktreeActivityLabel}]`
                                    : ""
                                }`;
                                const canDeleteWorktree =
                                  worktree.isManagedByPhantom;
                                const canShowActions =
                                  canDeleteWorktree || Boolean(worktree.path);
                                return (
                                  <SidebarMenuSubItem key={worktree.path}>
                                    <div className="group/worktree flex items-center gap-0.5 rounded-[var(--radius-sm)]">
                                      <button
                                        aria-expanded={isWorktreeExpanded}
                                        aria-label={`${isWorktreeExpanded ? "Collapse" : "Expand"} chats for ${worktree.name}`}
                                        className="inline-flex size-7 shrink-0 items-center justify-center rounded-[var(--radius-sm)] text-[var(--icon-color-default)] outline-none transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:shadow-[var(--state-focus-ring)]"
                                        onClick={() =>
                                          toggleWorktreeChats(
                                            project.id,
                                            worktree.path,
                                          )
                                        }
                                        title={
                                          isWorktreeExpanded
                                            ? "Collapse chats"
                                            : "Expand chats"
                                        }
                                        type="button"
                                      >
                                        <ChevronRight
                                          className={cn(
                                            "size-3.5 transition-transform duration-[var(--motion-duration-fast)]",
                                            isWorktreeExpanded && "rotate-90",
                                          )}
                                        />
                                      </button>
                                      <SidebarMenuSubButton
                                        className="flex-1"
                                        disabled={!worktree.chatId}
                                        isActive={isSelectedWorktree}
                                        onClick={() =>
                                          selectWorktree(project.id, worktree)
                                        }
                                        title={title}
                                        type="button"
                                      >
                                        {worktree.isMainWorktree ? (
                                          <FolderGit2 className="size-3.5 text-[var(--icon-color-default)]" />
                                        ) : (
                                          <GitBranch className="size-3.5 text-[var(--icon-color-default)]" />
                                        )}
                                        <span className="min-w-0 flex-1">
                                          <span className="flex min-w-0 items-center gap-1.5">
                                            <span className="block min-w-0 truncate font-medium">
                                              {worktree.name}
                                            </span>
                                          </span>
                                        </span>
                                        {!worktree.isClean && (
                                          <span className="size-1.5 shrink-0 rounded-full bg-[var(--semantic-warning-fg)]" />
                                        )}
                                        {worktreeActivityLabel && (
                                          <WorktreeActivityIndicator
                                            label={worktreeActivityLabel}
                                            status={
                                              isWorktreeSending
                                                ? "running"
                                                : (activeWorktreeChat?.status ??
                                                  "running")
                                            }
                                          />
                                        )}
                                      </SidebarMenuSubButton>
                                      <Button
                                        aria-label={`Start new chat in ${worktree.name}`}
                                        className={cn(
                                          "size-7 text-[var(--icon-color-default)] opacity-100 sm:opacity-0 sm:group-focus-within/worktree:opacity-100 sm:group-hover/worktree:opacity-100",
                                          (isSelectedWorktree ||
                                            isCreatingWorktreeChat) &&
                                            "sm:opacity-100",
                                        )}
                                        disabled={isBusy}
                                        onClick={() =>
                                          void createChat(project.id, worktree)
                                        }
                                        size="icon"
                                        title="New chat"
                                        type="button"
                                        variant="ghost"
                                      >
                                        {isCreatingWorktreeChat ? (
                                          <LoadingSpinner className="size-4" />
                                        ) : (
                                          <MessageSquarePlus className="size-4" />
                                        )}
                                      </Button>
                                      {canShowActions && (
                                        <DropdownMenu>
                                          <DropdownMenuTrigger asChild>
                                            <Button
                                              aria-label={`Open actions for ${worktree.name}`}
                                              className={cn(
                                                "mr-1 size-7 text-[var(--icon-color-default)] opacity-100 data-[state=open]:opacity-100 sm:opacity-0 sm:group-focus-within/worktree:opacity-100 sm:group-hover/worktree:opacity-100",
                                                isSelectedWorktree &&
                                                  "sm:opacity-100",
                                              )}
                                              disabled={isBusy}
                                              size="icon"
                                              title="Worktree actions"
                                              type="button"
                                              variant="ghost"
                                            >
                                              <MoreHorizontal className="size-4" />
                                            </Button>
                                          </DropdownMenuTrigger>
                                          <DropdownMenuContent align="end">
                                            <DropdownMenuItem
                                              disabled={isBusy}
                                              onSelect={() =>
                                                void syncWorktreeBranch(
                                                  project.id,
                                                  worktree,
                                                )
                                              }
                                            >
                                              <RefreshCw className="size-4" />
                                              <span>Sync branch</span>
                                            </DropdownMenuItem>
                                            {canDeleteWorktree && (
                                              <DropdownMenuItem
                                                disabled={isBusy}
                                                onSelect={() =>
                                                  void openDeleteWorktree(
                                                    project.id,
                                                    worktree,
                                                  )
                                                }
                                                variant="destructive"
                                              >
                                                <Trash2 className="size-4" />
                                                <span>Delete worktree</span>
                                              </DropdownMenuItem>
                                            )}
                                          </DropdownMenuContent>
                                        </DropdownMenu>
                                      )}
                                    </div>
                                    {isWorktreeExpanded && (
                                      <SidebarChatList
                                        chats={worktreeChats}
                                        isLoading={isChatListLoading}
                                        selectedChatId={selectedChatId}
                                        onSelectChat={(chatId) =>
                                          selectChat(
                                            project.id,
                                            worktree,
                                            chatId,
                                          )
                                        }
                                        onSetChatArchived={(chat, archived) =>
                                          void setChatArchived(chat, archived)
                                        }
                                      />
                                    )}
                                  </SidebarMenuSubItem>
                                );
                              })
                            )}
                          </SidebarMenuSub>
                        )}
                      </SidebarMenuItem>
                    );
                  })
                )}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>

        <SidebarRail />
      </Sidebar>

      <Dialog
        open={isAddProjectOpen}
        onOpenChange={(open) => {
          if (open) {
            openAddProjectDialog();
          } else {
            closeAddProjectDialog();
          }
        }}
      >
        <DialogContent aria-labelledby="add-project-title">
          <DialogHeader>
            <DialogTitle id="add-project-title">Add project</DialogTitle>
            <DialogDescription>
              Add a local Git project to the Phantom sidebar.
            </DialogDescription>
          </DialogHeader>
          <form className="grid gap-4" onSubmit={addProject}>
            <div className="grid gap-2">
              <Label htmlFor="project-path">Project path</Label>
              <Input
                id="project-path"
                placeholder="/Users/me/project"
                value={projectPath}
                onChange={(event) => setProjectPath(event.target.value)}
              />
            </div>
            {addProjectError && (
              <InlineNotice
                message={addProjectError}
                onDismiss={() => setAddProjectError(null)}
              />
            )}
            <DialogFooter>
              <Button
                onClick={closeAddProjectDialog}
                type="button"
                variant="outline"
              >
                Cancel
              </Button>
              <Button disabled={isBusy || !projectPath.trim()} type="submit">
                {isBusy && <LoadingSpinner />}
                Add project
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(deleteProjectTarget)}
        onOpenChange={(open) => {
          if (!open) {
            closeDeleteProjectDialog();
          }
        }}
      >
        <DialogContent aria-labelledby="delete-project-title">
          <DialogHeader>
            <DialogTitle id="delete-project-title">Delete project</DialogTitle>
            <DialogDescription>
              Remove this project from the Phantom sidebar and delete its
              Phantom chat history and messages. Local repository files and
              worktrees are not deleted.
            </DialogDescription>
          </DialogHeader>
          <form className="grid gap-4" onSubmit={deleteSelectedProject}>
            <div className="grid gap-2 rounded-[var(--radius-sm)] bg-[var(--surface-code)] px-3 py-2">
              <p className="truncate text-[length:var(--font-size-sm)] font-medium">
                {pendingDeleteProject?.name ?? "Unknown project"}
              </p>
              {pendingDeleteProject && (
                <p className="truncate font-mono text-[length:var(--font-size-xs)] text-muted-foreground">
                  {pendingDeleteProject.rootPath}
                </p>
              )}
            </div>
            <p className="text-[length:var(--font-size-sm)] text-muted-foreground">
              Projects with running, approval-blocked, or queued chats cannot be
              deleted.
            </p>
            {pendingDeleteProjectBlockingChat && (
              <div className="rounded-[var(--radius-sm)] border border-[var(--semantic-warning-border)] bg-[var(--semantic-warning-bg)] px-3 py-2 text-[length:var(--font-size-sm)] text-[var(--semantic-warning-fg)]">
                Stop running, approval-blocked, or queued chats before deleting
                this project.
              </div>
            )}
            {deleteProjectError && (
              <InlineNotice
                message={deleteProjectError}
                onDismiss={() => setDeleteProjectError(null)}
              />
            )}
            <DialogFooter>
              <Button
                onClick={closeDeleteProjectDialog}
                type="button"
                variant="outline"
              >
                Cancel
              </Button>
              <Button
                disabled={
                  isBusy ||
                  !pendingDeleteProject ||
                  Boolean(pendingDeleteProjectBlockingChat)
                }
                type="submit"
                variant="destructive"
              >
                {isBusy && <LoadingSpinner />}
                Delete project
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(deleteWorktreeTarget)}
        onOpenChange={(open) => {
          if (!open) {
            closeDeleteWorktreeDialog();
          }
        }}
      >
        <DialogContent aria-labelledby="delete-worktree-title">
          <DialogHeader>
            <DialogTitle id="delete-worktree-title">
              Delete worktree
            </DialogTitle>
            <DialogDescription>
              {isDeleteWorktreeForceRequired
                ? "This worktree has uncommitted changes. Force deletion is required to remove it from "
                : "This will remove the worktree and its chat history from "}
              {pendingDeleteWorktreeProject?.name ?? "the project"}.
            </DialogDescription>
          </DialogHeader>
          <form className="grid gap-4" onSubmit={deleteSelectedWorktree}>
            <div className="grid gap-2 rounded-[var(--radius-sm)] bg-[var(--surface-code)] px-3 py-2">
              <p className="truncate text-[length:var(--font-size-sm)] font-medium">
                {pendingDeleteWorktree?.name ?? "Unknown worktree"}
              </p>
              {pendingDeleteWorktree && (
                <p className="truncate font-mono text-[length:var(--font-size-xs)] text-muted-foreground">
                  {pendingDeleteWorktree.path}
                </p>
              )}
            </div>
            <div className="grid gap-2">
              <Label htmlFor="delete-worktree-branch-mode">
                Branch handling
              </Label>
              <select
                className="h-9 rounded-[var(--radius-sm)] border border-input bg-[var(--surface-input)] px-3 text-[length:var(--font-size-sm)] shadow-[var(--shadow-xs)] outline-none transition-[border-color,box-shadow] focus-visible:border-ring focus-visible:shadow-[var(--state-focus-ring)] disabled:cursor-not-allowed disabled:opacity-[var(--opacity-disabled)]"
                id="delete-worktree-branch-mode"
                onChange={(event) =>
                  setDeleteWorktreeBranchMode(
                    event.target.value as DeleteWorktreeBranchMode,
                  )
                }
                value={deleteWorktreeBranchMode}
              >
                <option value="default">Use project preference</option>
                <option value="keep">Keep branch</option>
                <option value="delete">Delete branch</option>
              </select>
            </div>
            {isDeleteWorktreeForceRequired && (
              <label className="flex items-start gap-2 text-[length:var(--font-size-sm)] text-[var(--semantic-danger-fg)]">
                <input
                  checked={deleteWorktreeForce}
                  className="mt-0.5 size-4 accent-[var(--semantic-danger-fg)]"
                  onChange={(event) =>
                    setDeleteWorktreeForce(event.target.checked)
                  }
                  type="checkbox"
                />
                <span>Force delete uncommitted changes</span>
              </label>
            )}
            {deleteWorktreeError && (
              <InlineNotice
                message={deleteWorktreeError}
                onDismiss={() => setDeleteWorktreeError(null)}
              />
            )}
            <DialogFooter>
              <Button
                onClick={closeDeleteWorktreeDialog}
                type="button"
                variant="outline"
              >
                Cancel
              </Button>
              <Button
                disabled={
                  isBusy ||
                  !pendingDeleteWorktree ||
                  (isDeleteWorktreeForceRequired && !deleteWorktreeForce)
                }
                type="submit"
                variant="destructive"
              >
                {isBusy && <LoadingSpinner />}
                Delete
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <ToastViewport toasts={toasts} onDismiss={dismissToast} />

      <SidebarInset>
        <header className="flex min-h-[var(--layout-topbar-height)] items-center gap-3 border-b border-border bg-[var(--surface-panel)] px-4">
          <SidebarTrigger className="-ml-1" />
          <div className="h-5 w-px bg-[var(--border-divider)]" />
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2">
              <p className="truncate text-[length:var(--font-size-xl)] font-semibold leading-tight">
                {selectedChat
                  ? (selectedWorktree?.name ?? selectedChat.worktreeName)
                  : selectedProject
                    ? "New chat"
                    : "Workspace"}
              </p>
              {selectedChat && <StatusBadge status={selectedChat.status} />}
            </div>
            <p className="flex min-w-0 text-[length:var(--font-size-xs)] text-muted-foreground">
              <span className="shrink-0">
                {selectedProject?.name ?? "No project selected"}
                {selectedWorktree ? " / " : ""}
              </span>
              {selectedWorktree && (
                <LeadingEllipsisText text={selectedWorktree.path} />
              )}
            </p>
          </div>
          {selectedChat && (
            <Button
              aria-label={
                selectedChat.status === "archived"
                  ? "Restore chat"
                  : "Archive chat"
              }
              className="size-8 text-[var(--icon-color-default)]"
              disabled={
                isBusy ||
                archiveChatRequest.isPending ||
                (selectedChat.status !== "archived" &&
                  !canArchiveChat(selectedChat))
              }
              onClick={() =>
                void setChatArchived(
                  selectedChat,
                  selectedChat.status !== "archived",
                )
              }
              size="icon"
              title={
                selectedChat.status === "archived"
                  ? "Restore chat"
                  : "Archive chat"
              }
              type="button"
              variant="ghost"
            >
              {archiveChatRequest.isPending ? (
                <LoadingSpinner />
              ) : selectedChat.status === "archived" ? (
                <ArchiveRestore />
              ) : (
                <Archive />
              )}
            </Button>
          )}
          {selectedWorktree && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  aria-label={`Open worktree actions for ${selectedWorktree.name}`}
                  className="size-8 shrink-0 text-[var(--icon-color-default)]"
                  disabled={isBusy}
                  size="icon"
                  title="Worktree actions"
                  type="button"
                  variant="ghost"
                >
                  <MoreHorizontal className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  disabled={isBusy}
                  onSelect={createSelectedWorktreeChat}
                >
                  <MessageSquarePlus className="size-4" />
                  <span>New chat</span>
                </DropdownMenuItem>
                {selectedWorktree.isManagedByPhantom && (
                  <DropdownMenuItem
                    disabled={isBusy}
                    onSelect={openDeleteSelectedWorktree}
                    variant="destructive"
                  >
                    <Trash2 className="size-4" />
                    <span>Delete worktree</span>
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </header>

        {visiblePendingApproval && (
          <div className="border-b border-[var(--semantic-warning-border)] bg-[var(--semantic-warning-bg)] px-4 py-3 text-[var(--semantic-warning-fg)]">
            <div className="mx-auto flex max-w-[var(--layout-max-content-width)] flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <p className="flex items-center gap-2 text-[length:var(--font-size-md)] font-semibold">
                  <Clock3 className="size-4" />
                  Approval requested
                </p>
                <p className="mt-1 truncate font-mono text-[length:var(--font-size-xs)]">
                  {visiblePendingApproval.method}
                </p>
                {approvalError && (
                  <InlineNotice
                    className="mt-2"
                    message={approvalError}
                    onDismiss={() => setApprovalError(null)}
                  />
                )}
              </div>
              <div className="flex shrink-0 flex-wrap gap-2">
                <Button
                  onClick={() => void answerApproval("accept")}
                  size="sm"
                  type="button"
                >
                  Accept
                </Button>
                <Button
                  onClick={() => void answerApproval("acceptForSession")}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  Accept for session
                </Button>
                <Button
                  onClick={() => void answerApproval("decline")}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  Decline
                </Button>
              </div>
            </div>
          </div>
        )}

        <section
          aria-busy={
            isMessagesLoading ||
            isSendingMessage ||
            hasActiveTurn ||
            Boolean(creatingProjectId)
          }
          className="min-h-0 flex-1 overflow-y-auto px-4 py-4"
          ref={chatTimelineRef}
          onScroll={scheduleSelectedChatScrollPositionSave}
        >
          {timelineError && (
            <div className="mx-auto mb-3 max-w-[var(--layout-max-content-width)]">
              <InlineNotice
                message={timelineError}
                onDismiss={() => setTimelineError(null)}
              />
            </div>
          )}
          {showTimelineSkeleton ? (
            <TimelineSkeleton />
          ) : visibleMessages.length === 0 ? (
            <EmptyTimeline
              githubTargets={selectedProjectGitHubTargets}
              hasChat={Boolean(selectedChat)}
              hasWorktree={Boolean(selectedWorktree)}
              isGitHubTargetsLoading={isSelectedProjectGitHubTargetsLoading}
              selectedProject={selectedProject}
              selectedGitHubTargetNumber={selectedGitHubTargetNumber}
              onOpenProjectDialog={openAddProjectDialog}
              onSelectGitHubTarget={setSelectedGitHubTargetNumber}
            />
          ) : (
            <div className="mx-auto flex max-w-[var(--layout-max-content-width)] flex-col gap-2">
              {visibleMessages.map((message) => (
                <MessageCard
                  isPendingActionBusy={deletePendingMessageRequest.isPending}
                  key={message.id}
                  message={message}
                  onDeletePendingMessage={(pendingMessage) =>
                    void deletePendingMessage(pendingMessage)
                  }
                  onEditPendingMessage={(pendingMessage) =>
                    void editPendingMessage(pendingMessage)
                  }
                />
              ))}
            </div>
          )}
        </section>

        <form
          className="chat-composer border-t border-border bg-[var(--surface-floating)] backdrop-blur"
          onSubmit={sendMessage}
        >
          <div className="mx-auto flex max-w-[var(--layout-max-content-width)] flex-col gap-2">
            {composerError && (
              <InlineNotice
                message={composerError}
                onDismiss={() => setComposerError(null)}
              />
            )}
            {fileSearchError && (
              <InlineNotice
                message={fileSearchError}
                onDismiss={() => setFileSearchError(null)}
              />
            )}
            {modelError && (
              <InlineNotice
                message={modelError}
                onDismiss={() => setModelError(null)}
              />
            )}
            {(selectedFiles.length > 0 || selectedSkills.length > 0) && (
              <div className="flex min-h-8 flex-wrap items-center gap-2 px-1">
                {selectedFiles.map((file) => (
                  <ContextChip
                    icon={<FileText className="size-3.5" />}
                    key={file.path}
                    label={file.relativePath}
                    onRemove={() =>
                      setSelectedFiles((current) =>
                        current.filter(
                          (selectedFile) => selectedFile.path !== file.path,
                        ),
                      )
                    }
                  />
                ))}
                {selectedSkills.map((skill) => (
                  <ContextChip
                    icon={<Sparkles className="size-3.5" />}
                    key={skill.path}
                    label={skill.displayName}
                    onRemove={() =>
                      setSelectedSkillPaths((current) => {
                        const next = new Set(current);
                        next.delete(skill.path);
                        return next;
                      })
                    }
                  />
                ))}
              </div>
            )}
            <div className="flex items-end gap-2">
              <div className="min-w-0 flex-1">
                <Label className="sr-only" htmlFor="composer">
                  Message
                </Label>
                <Textarea
                  className="min-h-12 border-0 bg-transparent px-2 py-2 shadow-none focus-visible:shadow-none"
                  disabled={!selectedProject || isComposerBlocked}
                  enterKeyHint="enter"
                  id="composer"
                  placeholder={
                    isSelectedChatArchived
                      ? "Restore this chat to continue"
                      : hasSelectedChat
                        ? "Ask Codex to work in this worktree"
                        : selectedProject
                          ? "Ask Codex to create a worktree and start"
                          : "Select a project to start"
                  }
                  rows={2}
                  ref={composerTextareaRef}
                  value={composerText}
                  onChange={(event) => {
                    setComposerText(event.target.value);
                    if (composerError) {
                      setComposerError(null);
                    }
                  }}
                  onKeyDown={handleComposerKeyDown}
                />
              </div>
              <div className="flex shrink-0 items-end gap-1.5">
                {hasSelectedChat && primaryComposerMode !== "queue" && (
                  <Button
                    aria-label={
                      pendingComposerMode === "queue"
                        ? "Queueing message"
                        : "Queue message"
                    }
                    className="size-10"
                    disabled={!canQueueComposerMessage}
                    onClick={() => void submitComposer("queue")}
                    size="icon"
                    title="Queue message"
                    type="button"
                    variant="outline"
                  >
                    {pendingComposerMode === "queue" ? (
                      <LoadingSpinner />
                    ) : (
                      <Clock3 />
                    )}
                  </Button>
                )}
                <Button
                  aria-label={primaryComposerButtonLabel}
                  className="size-10"
                  disabled={!canSubmitPrimaryComposerAction}
                  onClick={
                    hasActiveTurn
                      ? () => void submitComposer(primaryComposerMode)
                      : undefined
                  }
                  size="icon"
                  title={primaryComposerActionLabel}
                  type={hasActiveTurn ? "button" : "submit"}
                >
                  {pendingComposerMode === primaryComposerMode ? (
                    <LoadingSpinner />
                  ) : primaryComposerMode === "queue" ? (
                    <Clock3 />
                  ) : (
                    <Send />
                  )}
                </Button>
                {hasActiveTurn && (
                  <Button
                    aria-label={isInterrupting ? "Stopping turn" : "Stop turn"}
                    className="size-10"
                    disabled={!canInterruptActiveTurn}
                    onClick={interruptChat}
                    size="icon"
                    title="Stop turn"
                    type="button"
                    variant="destructive"
                  >
                    {isInterrupting ? <LoadingSpinner /> : <Square />}
                  </Button>
                )}
              </div>
            </div>
            <div className="flex min-h-8 flex-wrap items-center gap-2 border-t border-[var(--border-divider)] px-1 pt-2">
              <Combobox
                aria-label="Select model"
                className="w-36 max-w-full sm:w-40"
                disabled={
                  isModelsLoading || models.length === 0 || isComposerBlocked
                }
                emptyMessage={isModelsLoading ? "Loading models" : "No models"}
                icon={<Bot className="size-3.5" />}
                isLoading={isModelsLoading}
                options={modelOptions}
                placeholder={isModelsLoading ? "Loading" : "Model"}
                searchPlaceholder="Search models"
                side="top"
                triggerClassName="w-full justify-between"
                value={selectedModel?.id ?? null}
                onValueChange={(value) =>
                  setSearchParamValue(searchParamKeys.model, value)
                }
              />
              <Combobox
                aria-label="Select reasoning effort"
                className="w-28 max-w-full"
                disabled={!selectedModel || isComposerBlocked}
                icon={<Brain className="size-3.5" />}
                options={effortOptions}
                placeholder="Effort"
                searchPlaceholder="Search effort"
                side="top"
                triggerClassName="w-full justify-between"
                value={selectedEffort ?? "auto"}
                onValueChange={(value) =>
                  setSearchParamValue(
                    searchParamKeys.effort,
                    value === "auto" ? null : value,
                  )
                }
              />
              <Combobox
                aria-label="Attach file"
                className="w-32 max-w-full"
                disabled={areComposerOptionsDisabled}
                emptyMessage={
                  isFileSearchLoading
                    ? "Searching files"
                    : fileSearchQuery.trim()
                      ? "No files"
                      : "Type to search"
                }
                icon={<FileText className="size-3.5" />}
                isLoading={isFileSearchLoading}
                options={fileOptions}
                placeholder="Files"
                query={fileSearchQuery}
                searchPlaceholder="Search files"
                shouldFilter={false}
                side="top"
                triggerClassName="w-full justify-between"
                value={null}
                onQueryChange={setFileSearchQuery}
                onValueChange={selectFile}
              />
              <Combobox
                aria-label="Select skill"
                align="end"
                className="w-32 max-w-full"
                disabled={areComposerOptionsDisabled || isChatContextLoading}
                emptyMessage={
                  isChatContextLoading ? "Loading skills" : "No skills"
                }
                icon={<Sparkles className="size-3.5" />}
                isLoading={isChatContextLoading}
                options={skillOptions}
                placeholder={isChatContextLoading ? "Loading" : "Skills"}
                searchPlaceholder="Search skills"
                side="top"
                triggerClassName="w-full justify-between"
                value={null}
                onValueChange={selectSkill}
              />
            </div>
          </div>
        </form>
      </SidebarInset>
    </SidebarProvider>
  );
}

function SidebarChatList({
  chats,
  isLoading,
  onSetChatArchived,
  onSelectChat,
  selectedChatId,
}: {
  chats: ChatRecord[];
  isLoading: boolean;
  onSetChatArchived: (chat: ChatRecord, archived: boolean) => void;
  onSelectChat: (chatId: string) => void;
  selectedChatId: string | null;
}) {
  const activeChats = chats.filter((chat) => chat.status !== "archived");
  const renderChat = (chat: ChatRecord) => {
    const isSelected = chat.id === selectedChatId;

    return (
      <li className="group/chat min-w-0" key={chat.id}>
        <div
          className={cn(
            "flex min-h-7 min-w-0 items-center gap-0.5 rounded-[var(--radius-sm)] transition-colors duration-[var(--motion-duration-fast)] hover:bg-sidebar-accent",
            isSelected && "bg-sidebar-accent text-sidebar-accent-foreground",
          )}
        >
          <button
            aria-current={isSelected ? "page" : undefined}
            className={cn(
              "flex min-w-0 flex-1 items-center gap-2 rounded-[var(--radius-sm)] px-2 py-1 text-left text-[length:var(--font-size-xs)] outline-none focus-visible:shadow-[var(--state-focus-ring)]",
              isSelected
                ? "text-sidebar-accent-foreground"
                : "text-[var(--text-secondary)]",
            )}
            onClick={() => onSelectChat(chat.id)}
            title={chat.title}
            type="button"
          >
            <MessageSquare className="size-3.5 shrink-0 text-[var(--icon-color-default)]" />
            <span className="min-w-0 flex-1 truncate">{chat.title}</span>
            <span
              aria-hidden="true"
              className={cn(
                "size-1.5 shrink-0 rounded-full",
                statusMeta[chat.status].dot,
              )}
            />
            <span className="sr-only">
              Status: {statusMeta[chat.status].label}
            </span>
          </button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                aria-label={`Open actions for ${chat.title}`}
                className={cn(
                  "mr-0.5 size-6 text-[var(--icon-color-default)] opacity-100 data-[state=open]:opacity-100 sm:opacity-0 sm:group-focus-within/chat:opacity-100 sm:group-hover/chat:opacity-100",
                  isSelected && "sm:opacity-100",
                )}
                size="icon"
                title="Chat actions"
                type="button"
                variant="ghost"
              >
                <MoreHorizontal className="size-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                disabled={!canArchiveChat(chat)}
                onSelect={() => onSetChatArchived(chat, true)}
              >
                <Archive className="size-4" />
                <span>Archive chat</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </li>
    );
  };

  return (
    <ul
      aria-label="Chat history"
      className="ml-7 mt-1 space-y-1 border-l border-sidebar-border pl-2"
    >
      {isLoading ? (
        <li className="px-2 py-1.5">
          <InlineLoading label="Loading chats" />
        </li>
      ) : activeChats.length === 0 ? (
        <li className="px-2 py-1.5 text-[length:var(--font-size-xs)] text-[var(--text-tertiary)]">
          No chat history
        </li>
      ) : (
        activeChats.map(renderChat)
      )}
    </ul>
  );
}

function WorktreeActivityIndicator({
  label,
  status,
}: {
  label: string;
  status: ChatStatus;
}) {
  const meta = statusMeta[status];
  const isActiveTurn = status === "running";

  return (
    <span
      aria-label={label}
      className={cn(
        "flex size-4 shrink-0 items-center justify-center rounded-full",
        isActiveTurn
          ? "text-[var(--semantic-info-fg)]"
          : "bg-[var(--surface-card)]",
      )}
      role="status"
      title={label}
    >
      {isActiveTurn ? (
        <LoadingSpinner className="size-3" />
      ) : (
        <span className={cn("size-1.5 rounded-full", meta.dot)} />
      )}
    </span>
  );
}

function StatusBadge({ status }: { status: ChatStatus }) {
  const meta = statusMeta[status];
  return (
    <Badge variant={meta.badge}>
      <span className={cn("size-1.5 rounded-full", meta.dot)} />
      {meta.label}
    </Badge>
  );
}

function LeadingEllipsisText({ text }: { text: string }) {
  return (
    <span className="block min-w-0 truncate" title={text}>
      {formatLeadingEllipsisPath(text)}
    </span>
  );
}

function ContextChip({
  icon,
  label,
  onRemove,
}: {
  icon: ReactNode;
  label: string;
  onRemove: () => void;
}) {
  return (
    <span className="inline-flex h-8 max-w-52 items-center gap-1.5 rounded-[var(--radius-sm)] border border-[var(--border-divider)] bg-[var(--surface-code)] px-2 text-[length:var(--font-size-sm)] text-[var(--text-secondary)]">
      {icon}
      <span className="min-w-0 truncate">{label}</span>
      <button
        aria-label={`Remove ${label}`}
        className="rounded-[var(--radius-xs)] text-[var(--icon-color-muted)] outline-none transition-colors hover:bg-[var(--state-hover-bg)] hover:text-[var(--icon-color-active)] focus-visible:shadow-[var(--state-focus-ring)]"
        onClick={onRemove}
        title={`Remove ${label}`}
        type="button"
      >
        <X className="size-3.5" />
      </button>
    </span>
  );
}

function formatReasoningEffort(effort: string): string {
  return effort
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function formatComposerModeAction(mode: ComposerSubmitMode): string {
  switch (mode) {
    case "queue":
      return "Queue message";
    case "steer":
      return "Steer turn";
    case "send":
      return "Send message";
  }
}

function formatComposerModeBusy(mode: ComposerSubmitMode): string {
  switch (mode) {
    case "queue":
      return "Queueing message";
    case "steer":
      return "Steering turn";
    case "send":
      return "Sending message";
  }
}

function getContextOnlyMessage({
  hasFiles,
  hasSkills,
}: {
  hasFiles: boolean;
  hasSkills: boolean;
}): string {
  if (hasFiles && hasSkills) {
    return "Use the selected files and skills as context.";
  }
  if (hasFiles) {
    return "Use the selected files as context.";
  }
  return "Use the selected skills as context.";
}

function getNoticeToneClass(tone: ToastTone): string {
  switch (tone) {
    case "danger":
      return "border-[var(--semantic-danger-border)] bg-[var(--semantic-danger-bg)] text-[var(--semantic-danger-fg)]";
    case "info":
      return "border-[var(--semantic-info-border)] bg-[var(--semantic-info-bg)] text-[var(--semantic-info-fg)]";
    case "warning":
      return "border-[var(--semantic-warning-border)] bg-[var(--semantic-warning-bg)] text-[var(--semantic-warning-fg)]";
  }
}

function InlineNotice({
  className,
  message,
  onDismiss,
  tone = "danger",
}: {
  className?: string;
  message: string;
  onDismiss?: () => void;
  tone?: ToastTone;
}) {
  return (
    <div
      className={cn(
        "flex min-w-0 items-start gap-2 rounded-[var(--radius-sm)] border px-3 py-2 text-left text-[length:var(--font-size-sm)]",
        getNoticeToneClass(tone),
        className,
      )}
      role={tone === "danger" ? "alert" : "status"}
    >
      <AlertTriangle className="mt-0.5 size-4 shrink-0" />
      <span className="min-w-0 flex-1 break-words">{message}</span>
      {onDismiss && (
        <button
          aria-label="Dismiss"
          className="rounded-[var(--radius-xs)] p-0.5 outline-none transition-colors hover:bg-[var(--state-hover-bg)] focus-visible:shadow-[var(--state-focus-ring)]"
          onClick={onDismiss}
          type="button"
        >
          <X className="size-3.5" />
        </button>
      )}
    </div>
  );
}

function ToastViewport({
  onDismiss,
  toasts,
}: {
  onDismiss: (id: number) => void;
  toasts: ToastMessage[];
}) {
  if (toasts.length === 0) {
    return null;
  }

  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-[min(360px,calc(100vw-2rem))] flex-col gap-2"
    >
      {toasts.map((toast) => (
        <InlineNotice
          className="pointer-events-auto shadow-[var(--shadow-md)]"
          key={toast.id}
          message={toast.message}
          tone={toast.tone}
          onDismiss={() => onDismiss(toast.id)}
        />
      ))}
    </div>
  );
}

function EmptyTimeline({
  githubTargets,
  hasChat,
  hasWorktree,
  isGitHubTargetsLoading,
  onOpenProjectDialog,
  onSelectGitHubTarget,
  selectedGitHubTargetNumber,
  selectedProject,
}: {
  githubTargets: GitHubCheckoutTargetsResult | null;
  hasChat: boolean;
  hasWorktree: boolean;
  isGitHubTargetsLoading: boolean;
  onOpenProjectDialog: () => void;
  onSelectGitHubTarget: (number: number | null) => void;
  selectedGitHubTargetNumber: number | null;
  selectedProject: ProjectRecord | null;
}) {
  const showGitHubTargets =
    Boolean(selectedProject) && !hasChat && githubTargets?.available;

  return (
    <div className="mx-auto flex h-full max-w-[var(--layout-max-content-width)] items-center justify-center py-8">
      <section className="grid w-full max-w-2xl gap-4 px-5 py-6 text-center">
        <div className="mx-auto flex size-10 items-center justify-center rounded-[var(--radius-md)] bg-[var(--surface-code)] text-[var(--icon-color-default)]">
          <Inbox className="size-5" />
        </div>
        <div>
          <h2 className="text-[length:var(--font-size-xl)] font-semibold">
            {hasChat
              ? "No messages yet"
              : selectedProject
                ? "New chat"
                : hasWorktree
                  ? "Select chat history"
                  : "Select a project"}
          </h2>
          <p className="mt-1 text-[length:var(--font-size-md)] text-muted-foreground">
            {hasChat
              ? "Send a message to start a focused Codex session."
              : selectedProject
                ? "Send a message to create a named worktree and start Codex."
                : hasWorktree
                  ? "Choose a chat history for this worktree."
                  : "Select a project to begin a Codex session."}
          </p>
        </div>
        {!selectedProject && (
          <div className="flex justify-center gap-2">
            <Button onClick={onOpenProjectDialog} type="button">
              <Plus className="size-4" />
              Add project
            </Button>
          </div>
        )}
        {showGitHubTargets && githubTargets && (
          <GitHubTargetPicker
            isLoading={isGitHubTargetsLoading}
            selectedNumber={selectedGitHubTargetNumber}
            targets={githubTargets.targets}
            onSelectTarget={onSelectGitHubTarget}
          />
        )}
      </section>
    </div>
  );
}

function GitHubTargetPicker({
  isLoading,
  onSelectTarget,
  selectedNumber,
  targets,
}: {
  isLoading: boolean;
  onSelectTarget: (number: number | null) => void;
  selectedNumber: number | null;
  targets: GitHubCheckoutTargetRecord[];
}) {
  return (
    <div className="mx-auto mt-2 grid w-full gap-2 text-left">
      <div className="flex items-center justify-between gap-3 px-1">
        <p className="text-[length:var(--font-size-sm)] font-medium text-[var(--text-secondary)]">
          GitHub
        </p>
        {isLoading && <InlineLoading label="Refreshing" />}
      </div>
      {targets.length === 0 ? (
        <p className="rounded-[var(--radius-sm)] border border-dashed border-[var(--border-divider)] bg-[var(--surface-code)] px-3 py-2 text-[length:var(--font-size-sm)] text-muted-foreground">
          No open issues or pull requests.
        </p>
      ) : (
        <ul className="max-h-72 overflow-y-auto rounded-[var(--radius-sm)] border border-[var(--border-divider)] bg-[var(--surface-code)]">
          {targets.map((target) => (
            <GitHubTargetOption
              isSelected={selectedNumber === target.number}
              key={`${target.kind}-${target.number}`}
              target={target}
              onSelectTarget={onSelectTarget}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function GitHubTargetOption({
  isSelected,
  onSelectTarget,
  target,
}: {
  isSelected: boolean;
  onSelectTarget: (number: number | null) => void;
  target: GitHubCheckoutTargetRecord;
}) {
  const label = `${target.kind === "pullRequest" ? "PR" : "Issue"} #${target.number}: ${target.title}`;

  return (
    <li className="border-b border-[var(--border-divider)] last:border-b-0">
      <label
        className={cn(
          "grid cursor-pointer grid-cols-[auto_1fr] gap-3 px-3 py-2.5 text-[length:var(--font-size-sm)] transition-colors hover:bg-[var(--state-hover-bg)]",
          isSelected && "bg-[var(--state-selected-bg)]",
        )}
      >
        <input
          aria-label={label}
          checked={isSelected}
          className="mt-0.5 size-4 accent-[var(--button-primary-bg)]"
          type="checkbox"
          onChange={(event) =>
            onSelectTarget(event.target.checked ? target.number : null)
          }
        />
        <span className="grid min-w-0 gap-1">
          <span className="flex min-w-0 items-center gap-2">
            {target.kind === "pullRequest" ? (
              <GitPullRequest className="size-3.5 shrink-0 text-[var(--semantic-info-fg)]" />
            ) : (
              <CircleDot className="size-3.5 shrink-0 text-[var(--semantic-success-fg)]" />
            )}
            <span className="shrink-0 font-mono text-[length:var(--font-size-xs)] text-[var(--text-tertiary)]">
              #{target.number}
            </span>
            <span className="truncate font-medium text-[var(--text-primary)]">
              {target.title}
            </span>
          </span>
          <span className="truncate text-[length:var(--font-size-xs)] text-muted-foreground">
            {target.kind === "pullRequest" ? "Pull request" : "Issue"}
            {target.author ? ` by ${target.author}` : ""}
          </span>
        </span>
      </label>
    </li>
  );
}

function MessageCard({
  isPendingActionBusy,
  message,
  onDeletePendingMessage,
  onEditPendingMessage,
}: {
  isPendingActionBusy: boolean;
  message: VisibleMessageRecord;
  onDeletePendingMessage: (message: VisibleMessageRecord) => void;
  onEditPendingMessage: (message: VisibleMessageRecord) => void;
}) {
  if (message.role === "event") {
    return <RichEventCard message={message} />;
  }

  const isUser = message.role === "user";
  const isError = message.role === "error";
  const deliveryState = getMessageDeliveryState(message);

  return (
    <article
      className={cn(
        isUser &&
          "ml-auto max-w-[78%] rounded-[var(--radius-lg)] border px-4 py-3 shadow-[var(--shadow-xs)]",
        isUser &&
          !deliveryState &&
          "border-transparent bg-[var(--chat-user-bg)] text-[var(--chat-user-fg)]",
        deliveryState === "queued" &&
          "border-[var(--semantic-warning-border)] bg-[var(--semantic-warning-bg)] text-[var(--semantic-warning-fg)]",
        deliveryState === "steered" &&
          "border-[var(--semantic-info-border)] bg-[var(--semantic-info-bg)] text-[var(--semantic-info-fg)]",
        message.role === "assistant" &&
          "mr-auto max-w-[82%] px-2 py-1 text-[var(--text-primary)]",
        isError &&
          "rounded-[var(--radius-lg)] border border-[var(--semantic-danger-border)] bg-[var(--semantic-danger-bg)] px-4 py-3 text-[var(--semantic-danger-fg)] shadow-[var(--shadow-xs)]",
      )}
    >
      {message.role === "assistant" && message.textHtml !== undefined ? (
        <div
          className="markdown-message"
          dangerouslySetInnerHTML={{ __html: message.textHtml }}
        />
      ) : (
        <pre className="whitespace-pre-wrap break-words font-sans text-[length:var(--font-size-md)] leading-[var(--line-height-relaxed)]">
          {message.text}
        </pre>
      )}
      {deliveryState && (
        <MessageDeliveryBadge
          isActionBusy={isPendingActionBusy}
          message={message}
          state={deliveryState}
          onDelete={onDeletePendingMessage}
          onEdit={onEditPendingMessage}
        />
      )}
    </article>
  );
}

function RichEventCard({ message }: { message: VisibleMessageRecord }) {
  const kind = getRichEventKind(message);
  if (kind === "plan") {
    return <PlanEventCard message={message} />;
  }
  if (kind === "diff") {
    return <DiffEventCard message={message} />;
  }
  if (kind === "command") {
    return <CommandEventCard message={message} />;
  }
  if (kind === "file") {
    return <FileEventCard message={message} />;
  }
  if (kind === "reasoning") {
    return <ReasoningEventCard message={message} />;
  }
  if (kind === "warning") {
    return <WarningEventCard message={message} />;
  }
  return null;
}

function PlanEventCard({ message }: { message: VisibleMessageRecord }) {
  const { explanation, plan } = getPlanEventData(message);
  const text = getRichEventText(message);
  return (
    <RichEventShell
      icon={<ListChecks className="size-4" />}
      meta={`${plan.length} step${plan.length === 1 ? "" : "s"}`}
      title="Plan updated"
    >
      {explanation && (
        <p className="text-[length:var(--font-size-sm)] text-muted-foreground">
          {explanation}
        </p>
      )}
      {plan.length > 0 && (
        <ol className="mt-2 space-y-1">
          {plan.map((step, index) => {
            const Icon =
              step.status === "completed"
                ? CheckCircle2
                : step.status === "inProgress"
                  ? Clock3
                  : Circle;
            return (
              <li
                className="grid grid-cols-[1rem_minmax(0,1fr)] items-start gap-2 text-[length:var(--font-size-sm)]"
                key={`${step.step}-${index}`}
              >
                <Icon
                  className={cn(
                    "mt-0.5 size-3.5",
                    step.status === "completed" &&
                      "text-[var(--semantic-success-fg)]",
                    step.status === "inProgress" &&
                      "text-[var(--semantic-info-fg)]",
                    step.status === "pending" && "text-muted-foreground",
                  )}
                />
                <span className="min-w-0 break-words">{step.step}</span>
              </li>
            );
          })}
        </ol>
      )}
      {!explanation && plan.length === 0 && text && (
        <p className="whitespace-pre-wrap break-words text-[length:var(--font-size-sm)] text-muted-foreground">
          {text}
        </p>
      )}
    </RichEventShell>
  );
}

function DiffEventCard({ message }: { message: VisibleMessageRecord }) {
  const { diff, files } = getDiffEventData(message);
  return (
    <RichEventShell
      icon={<FileDiff className="size-4" />}
      meta={`${files.length} file${files.length === 1 ? "" : "s"}`}
      title="Diff updated"
    >
      {files.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {files.slice(0, 6).map((file) => (
            <span
              className="max-w-full truncate rounded-[var(--radius-sm)] border border-[var(--border-subtle)] bg-[var(--surface-panel)] px-1.5 py-0.5 font-mono text-[length:var(--font-size-xs)] text-muted-foreground"
              key={file}
            >
              {file}
            </span>
          ))}
          {files.length > 6 && (
            <span className="text-[length:var(--font-size-xs)] text-muted-foreground">
              +{files.length - 6}
            </span>
          )}
        </div>
      )}
      <CollapsibleCode title="Unified diff" value={diff || message.text} />
    </RichEventShell>
  );
}

function CommandEventCard({ message }: { message: VisibleMessageRecord }) {
  const output = getRichEventText(message);
  const meta = getCommandEventMeta(message);
  return (
    <RichEventShell
      icon={<Terminal className="size-4" />}
      meta={meta.status ?? meta.stream ?? "output"}
      title={meta.command ? "Command execution" : "Command output"}
    >
      {meta.command && (
        <p
          className="mb-2 min-w-0 break-words font-mono text-[length:var(--font-size-xs)] text-muted-foreground"
          title={meta.cwd ?? undefined}
        >
          {meta.command}
        </p>
      )}
      {(meta.status || meta.exitCode !== null || meta.durationMs !== null) && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {meta.status && (
            <Badge variant={getStatusBadgeVariant(meta.status)}>
              {meta.status}
            </Badge>
          )}
          {meta.exitCode !== null && (
            <Badge variant={meta.exitCode === 0 ? "success" : "danger"}>
              exit {meta.exitCode}
            </Badge>
          )}
          {meta.durationMs !== null && (
            <Badge variant="secondary">
              {formatDurationMs(meta.durationMs)}
            </Badge>
          )}
        </div>
      )}
      <CollapsibleCode
        title={meta.capReached ? "Output truncated" : "Output"}
        value={output}
      />
    </RichEventShell>
  );
}

function FileEventCard({ message }: { message: VisibleMessageRecord }) {
  const changes = getFilePatchEventData(message);
  const meta = getFileEventMeta(message);
  const output = getRichEventText(message);
  if (message.eventType === "item/fileChange/outputDelta") {
    return (
      <RichEventShell
        icon={<FileText className="size-4" />}
        meta="output"
        title="File change output"
      >
        <CollapsibleCode title="Output" value={output} />
      </RichEventShell>
    );
  }
  return (
    <RichEventShell
      icon={<FileText className="size-4" />}
      meta={
        meta.status ??
        `${changes.length} file${changes.length === 1 ? "" : "s"}`
      }
      title="File patch updated"
    >
      {meta.status && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          <Badge variant={getStatusBadgeVariant(meta.status)}>
            {meta.status}
          </Badge>
          <Badge variant="secondary">
            {changes.length} file{changes.length === 1 ? "" : "s"}
          </Badge>
        </div>
      )}
      {changes.length === 0 ? (
        <p className="text-[length:var(--font-size-sm)] text-muted-foreground">
          {message.text}
        </p>
      ) : (
        <div className="space-y-2">
          {changes.map((change) => (
            <div
              className="rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--surface-panel)]"
              key={`${change.kind}:${change.path}`}
            >
              <div className="flex min-w-0 items-center gap-2 px-2 py-1.5">
                <Badge className="shrink-0" variant="secondary">
                  {change.kind}
                </Badge>
                <span className="truncate font-mono text-[length:var(--font-size-xs)]">
                  {change.path}
                </span>
              </div>
              {change.diff && (
                <div className="border-t border-[var(--border-subtle)]">
                  <CollapsibleCode title="Patch" value={change.diff} />
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </RichEventShell>
  );
}

function getStatusBadgeVariant(
  status: string,
): "danger" | "info" | "secondary" | "success" | "warning" {
  if (status === "completed") {
    return "success";
  }
  if (status === "failed") {
    return "danger";
  }
  if (status === "declined") {
    return "warning";
  }
  if (status === "inProgress") {
    return "info";
  }
  return "secondary";
}

function formatDurationMs(durationMs: number): string {
  return durationMs >= 1000
    ? `${(durationMs / 1000).toFixed(1)}s`
    : `${durationMs}ms`;
}

function ReasoningEventCard({ message }: { message: VisibleMessageRecord }) {
  const text = getRichEventText(message);
  return (
    <RichEventShell
      icon={<Brain className="size-4" />}
      meta="collapsed"
      title="Reasoning updated"
    >
      <details>
        <summary className="cursor-pointer text-[length:var(--font-size-sm)] text-muted-foreground">
          Show reasoning
        </summary>
        <pre className="mt-2 whitespace-pre-wrap break-words rounded-[var(--radius-md)] bg-[var(--surface-code)] p-2 font-mono text-[length:var(--font-size-xs)] leading-[var(--line-height-relaxed)]">
          {text}
        </pre>
      </details>
    </RichEventShell>
  );
}

function WarningEventCard({ message }: { message: VisibleMessageRecord }) {
  const warning = getWarningEventText(message);
  return (
    <RichEventShell
      icon={<AlertTriangle className="size-4" />}
      tone="warning"
      title="Warning"
    >
      <p className="text-[length:var(--font-size-sm)]">{warning.summary}</p>
      {warning.details && (
        <p className="mt-1 text-[length:var(--font-size-xs)] text-muted-foreground">
          {warning.details}
        </p>
      )}
    </RichEventShell>
  );
}

function RichEventShell({
  children,
  icon,
  meta,
  title,
  tone = "neutral",
}: {
  children: ReactNode;
  icon: ReactNode;
  meta?: string;
  title: string;
  tone?: "neutral" | "warning";
}) {
  return (
    <article
      className={cn(
        "w-full rounded-[var(--radius-md)] border bg-[var(--surface-card)] px-3 py-2 text-[var(--text-primary)]",
        tone === "neutral" && "border-[var(--border-subtle)]",
        tone === "warning" &&
          "border-[var(--semantic-warning-border)] bg-[var(--semantic-warning-bg)] text-[var(--semantic-warning-fg)]",
      )}
    >
      <div className="mb-2 flex min-w-0 items-center gap-2">
        <span className="shrink-0 text-muted-foreground">{icon}</span>
        <p className="min-w-0 flex-1 truncate text-[length:var(--font-size-sm)] font-semibold">
          {title}
        </p>
        {meta && (
          <span className="shrink-0 text-[length:var(--font-size-xs)] text-muted-foreground">
            {meta}
          </span>
        )}
      </div>
      {children}
    </article>
  );
}

function CollapsibleCode({ title, value }: { title: string; value: string }) {
  const trimmedValue = value.trimEnd();
  if (!trimmedValue) {
    return (
      <p className="text-[length:var(--font-size-sm)] text-muted-foreground">
        No output
      </p>
    );
  }
  return (
    <details open={trimmedValue.length < 1200}>
      <summary className="cursor-pointer text-[length:var(--font-size-sm)] text-muted-foreground">
        {title}
      </summary>
      <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-[var(--radius-md)] bg-[var(--surface-code)] p-2 font-mono text-[length:var(--font-size-xs)] leading-[var(--line-height-relaxed)]">
        {trimmedValue}
      </pre>
    </details>
  );
}

function MessageDeliveryBadge({
  isActionBusy,
  message,
  onDelete,
  onEdit,
  state,
}: {
  isActionBusy: boolean;
  message: VisibleMessageRecord;
  onDelete: (message: VisibleMessageRecord) => void;
  onEdit: (message: VisibleMessageRecord) => void;
  state: "queued" | "steered";
}) {
  const isQueued = state === "queued";
  const label = isQueued ? "Queued for next turn" : "Steered into active turn";
  const Icon = isQueued ? Clock3 : Send;

  return (
    <div className="mt-2 flex flex-wrap justify-end gap-1.5">
      <span className="inline-flex h-6 max-w-full items-center gap-1.5 rounded-[var(--radius-sm)] border border-current/20 bg-[var(--surface-floating)] px-2 text-[length:var(--font-size-xs)] font-medium text-current">
        <Icon className="size-3.5 shrink-0" />
        <span className="truncate">{label}</span>
      </span>
      {isQueued && (
        <>
          <Button
            aria-label="Edit pending message"
            className="size-6 border-current/20 bg-[var(--surface-floating)] text-current hover:bg-[var(--state-hover-bg)]"
            disabled={isActionBusy}
            size="icon"
            title="Edit pending message"
            type="button"
            variant="outline"
            onClick={() => onEdit(message)}
          >
            <Pencil className="size-3.5" />
          </Button>
          <Button
            aria-label="Delete pending message"
            className="size-6 border-current/20 bg-[var(--surface-floating)] text-current hover:bg-[var(--state-hover-bg)]"
            disabled={isActionBusy}
            size="icon"
            title="Delete pending message"
            type="button"
            variant="outline"
            onClick={() => onDelete(message)}
          >
            <Trash2 className="size-3.5" />
          </Button>
        </>
      )}
    </div>
  );
}

function getMessageDeliveryState(
  message: VisibleMessageRecord,
): "queued" | "steered" | null {
  if (message.role !== "user") {
    return null;
  }
  if (message.eventType === "chat.message.queued") {
    return "queued";
  }
  if (message.eventType === "chat.message.steered") {
    return "steered";
  }
  return null;
}

function contextItemToSelectedFile(
  item: CodexTurnContextItem,
): CodexFileRecord {
  return {
    name: item.name,
    path: item.path,
    relativePath: item.name,
    root: "",
    score: 0,
  };
}
