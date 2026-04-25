import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { serveStateSchema } from "./types.ts";
import type { ProjectRecord, ServeState } from "./types.ts";

const STATE_FILE_NAME = "state.json";

function now(): string {
  return new Date().toISOString();
}

function createEmptyState(): ServeState {
  return {
    version: 1,
    projects: [],
    chats: [],
    messages: [],
    selectedProjectId: null,
    selectedChatId: null,
  };
}

export function getDefaultServeDataDir(env = process.env): string {
  const stateHome = env.XDG_STATE_HOME;
  const baseStateDir =
    stateHome && isAbsolute(stateHome)
      ? stateHome
      : join(homedir(), ".local", "state");
  return join(baseStateDir, "phantom");
}

export function getServeDataDir(): string {
  return process.env.PHANTOM_SERVE_DATA_DIR ?? getDefaultServeDataDir();
}

function getStatePath(dataDir: string): string {
  return join(dataDir, STATE_FILE_NAME);
}

function validateState(value: unknown): ServeState {
  if (!value || typeof value !== "object") {
    throw new Error("Serve state is not a JSON object");
  }

  const state = value as Record<string, unknown>;
  if (state.version !== 1) {
    throw new Error("Unsupported serve state version");
  }
  const result = serveStateSchema.safeParse(value);
  if (!result.success) {
    throw new Error("Serve state has an invalid shape");
  }

  return result.data;
}

export class ServeStateStore {
  private state: ServeState | null = null;
  private updateChain: Promise<unknown> = Promise.resolve();

  constructor(private readonly dataDir = getServeDataDir()) {}

  private async loadOrCreateState(): Promise<ServeState> {
    if (this.state) {
      return this.state;
    }

    const statePath = getStatePath(this.dataDir);
    try {
      const content = await readFile(statePath, "utf8");
      const state = validateState(JSON.parse(content));
      this.state = state;
      return state;
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        const state = createEmptyState();
        await this.save(state);
        return state;
      } else {
        throw error;
      }
    }
  }

  async load(): Promise<ServeState> {
    if (this.state) {
      return this.state;
    }

    const nextLoad = this.updateChain.then(() => this.loadOrCreateState());
    this.updateChain = nextLoad.catch(() => undefined);
    return nextLoad;
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
      const state = await this.loadOrCreateState();
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
