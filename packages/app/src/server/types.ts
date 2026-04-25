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
