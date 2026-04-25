export type ChatStatus =
  | "idle"
  | "running"
  | "waitingForApproval"
  | "failed"
  | "archived";

export interface ProjectRecord {
  id: string;
  name: string;
  rootPath: string;
  createdAt: string;
  updatedAt: string;
  lastOpenedAt: string;
}

export interface ChatMessageRecord {
  id: string;
  chatId: string;
  role: "user" | "assistant" | "event" | "error";
  text: string;
  eventType?: string;
  itemId?: string;
  createdAt: string;
}

export interface ChatRecord {
  id: string;
  projectId: string;
  worktreeName: string;
  worktreePath: string;
  branchName: string;
  codexThreadId: string | null;
  title: string;
  status: ChatStatus;
  activeTurnId?: string | null;
  createdAt: string;
  updatedAt: string;
}

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

export interface ServeState {
  version: 1;
  projects: ProjectRecord[];
  chats: ChatRecord[];
  messages: ChatMessageRecord[];
  selectedProjectId: string | null;
  selectedChatId: string | null;
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
