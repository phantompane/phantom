import type { ChatStatus } from "@phantompane/state";

export type {
  ChatMessageRecord,
  ChatRecord,
  ChatStatus,
  ProjectRecord,
  ServeState,
} from "@phantompane/state";

export interface ProjectWorktreeRecord {
  name: string;
  path: string;
  pathToDisplay: string;
  branch: string;
  isClean: boolean;
  chatId: string | null;
  chatStatus: ChatStatus | null;
  chatTitle: string;
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
  defaultReasoningEffort: string | null;
  inputModalities: string[];
  isDefault: boolean;
  supportedReasoningEfforts: string[];
}

export interface CodexSkillRecord {
  name: string;
  path: string;
  displayName: string;
  description: string;
  shortDescription: string | null;
  enabled: boolean;
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
