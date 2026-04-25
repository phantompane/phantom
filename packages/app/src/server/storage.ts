import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type {
  ChatMessageRecord,
  ChatRecord,
  ProjectRecord,
  ServeState,
} from "./types";

const STATE_FILE_NAME = "state.json";

function now(): string {
  return new Date().toISOString();
}

export function createEmptyState(): ServeState {
  return {
    version: 1,
    projects: [],
    chats: [],
    messages: [],
    selectedProjectId: null,
    selectedChatId: null,
  };
}

export function getDefaultServeDataDir(
  platform = process.platform,
  env = process.env,
): string {
  if (platform === "darwin") {
    return join(
      homedir(),
      "Library",
      "Application Support",
      "phantom",
      "serve",
    );
  }

  if (platform === "win32") {
    const appData = env.APPDATA ?? join(homedir(), "AppData", "Roaming");
    return join(appData, "phantom", "serve");
  }

  const stateHome = env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
  return join(stateHome, "phantom", "serve");
}

export function getServeDataDir(): string {
  return process.env.PHANTOM_SERVE_DATA_DIR ?? getDefaultServeDataDir();
}

function getStatePath(dataDir: string): string {
  return join(dataDir, STATE_FILE_NAME);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function validateProject(value: unknown): value is ProjectRecord {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    isString(record.id) &&
    isString(record.name) &&
    isString(record.rootPath) &&
    isString(record.createdAt) &&
    isString(record.updatedAt) &&
    isString(record.lastOpenedAt)
  );
}

function validateChat(value: unknown): value is ChatRecord {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    isString(record.id) &&
    isString(record.projectId) &&
    isString(record.worktreeName) &&
    isString(record.worktreePath) &&
    isString(record.branchName) &&
    (isString(record.codexThreadId) || record.codexThreadId === null) &&
    isString(record.title) &&
    isString(record.status) &&
    isString(record.createdAt) &&
    isString(record.updatedAt)
  );
}

function validateMessage(value: unknown): value is ChatMessageRecord {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    isString(record.id) &&
    isString(record.chatId) &&
    isString(record.role) &&
    isString(record.text) &&
    isString(record.createdAt)
  );
}

function validateState(value: unknown): ServeState {
  if (!value || typeof value !== "object") {
    throw new Error("Serve state is not a JSON object");
  }

  const state = value as Record<string, unknown>;
  if (state.version !== 1) {
    throw new Error("Unsupported serve state version");
  }
  if (
    !Array.isArray(state.projects) ||
    !state.projects.every(validateProject) ||
    !Array.isArray(state.chats) ||
    !state.chats.every(validateChat) ||
    !Array.isArray(state.messages) ||
    !state.messages.every(validateMessage)
  ) {
    throw new Error("Serve state has an invalid shape");
  }

  return {
    version: 1,
    projects: state.projects,
    chats: state.chats,
    messages: state.messages,
    selectedProjectId: isString(state.selectedProjectId)
      ? state.selectedProjectId
      : null,
    selectedChatId: isString(state.selectedChatId)
      ? state.selectedChatId
      : null,
  };
}

export class ServeStateStore {
  private state: ServeState | null = null;
  private updateChain: Promise<unknown> = Promise.resolve();

  constructor(private readonly dataDir = getServeDataDir()) {}

  async load(): Promise<ServeState> {
    if (this.state) {
      return this.state;
    }

    const statePath = getStatePath(this.dataDir);
    try {
      const content = await readFile(statePath, "utf8");
      this.state = validateState(JSON.parse(content));
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        this.state = createEmptyState();
      } else {
        throw error;
      }
    }

    return this.state;
  }

  async save(state: ServeState): Promise<void> {
    const statePath = getStatePath(this.dataDir);
    const temporaryPath = `${statePath}.tmp-${process.pid}-${Date.now()}`;
    await mkdir(dirname(statePath), { recursive: true });
    await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`);
    await rename(temporaryPath, statePath);
    this.state = state;
  }

  async update(
    updater: (state: ServeState) => ServeState | Promise<ServeState>,
  ): Promise<ServeState> {
    const nextUpdate = this.updateChain.then(async () => {
      const state = await this.load();
      const nextState = await updater({
        ...state,
        projects: [...state.projects],
        chats: [...state.chats],
        messages: [...state.messages],
      });
      await this.save(nextState);
      return nextState;
    });
    this.updateChain = nextUpdate.catch(() => undefined);
    return nextUpdate;
  }
}

export function touchProject(project: ProjectRecord): ProjectRecord {
  const timestamp = now();
  return {
    ...project,
    updatedAt: timestamp,
    lastOpenedAt: timestamp,
  };
}

export function createRecordId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

export function createTimestamp(): string {
  return now();
}
