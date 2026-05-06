import type { ChatMessageRecord, ChatStatus } from "@phantompane/state";

export type {
  ChatMessageRecord,
  ChatRecord,
  ChatStatus,
  ProjectRecord,
  QueuedMessageRecord,
  ServeState,
} from "@phantompane/state";

export type RenderedChatMessageRecord = ChatMessageRecord & {
  textHtml?: string;
};

export interface ProjectWorktreeRecord {
  name: string;
  path: string;
  pathToDisplay: string;
  branch: string;
  isClean: boolean;
  isMainWorktree: boolean;
  isManagedByPhantom: boolean;
  chatId: string | null;
  chatStatus: ChatStatus | null;
  chatTitle: string;
}

export interface GitHubCheckoutTargetRecord {
  author: string | null;
  htmlUrl: string;
  kind: "issue" | "pullRequest";
  number: number;
  title: string;
  updatedAt: string;
}

export interface GitHubCheckoutTargetsResult {
  available: boolean;
  targets: GitHubCheckoutTargetRecord[];
}

export interface CodexFileRecord {
  name: string;
  path: string;
  relativePath: string;
  root: string;
  score: number;
}

export interface CodexModelRecord {
  id: string;
  model: string;
  displayName: string;
  description: string;
  additionalSpeedTiers: string[];
  defaultReasoningEffort: string | null;
  inputModalities: string[];
  isDefault: boolean;
  supportedReasoningEfforts: string[];
}

export type CodexServiceTier = "fast" | "flex";

export interface CodexSkillRecord {
  name: string;
  path: string;
  displayName: string;
  description: string;
  shortDescription: string | null;
  enabled: boolean;
}

export interface PendingApprovalRecord {
  requestId: string;
  method: string;
  params: unknown;
}

export interface CodexTurnContextItem {
  name: string;
  path: string;
}

export interface PhantomEvent {
  id: number;
  type: string;
  scope: "global" | "chat";
  chatId?: string;
  data: unknown;
  createdAt: string;
}

export interface ApiErrorBody {
  error: {
    message: string;
  };
}
