import { deepStrictEqual, strictEqual } from "node:assert";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";
import { ServeStateStore, getDefaultServeDataDir } from "./store.ts";
import type { ServeState } from "./types.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "phantom-state-"));
  temporaryDirectories.push(directory);
  return directory;
}

function createTestState(overrides: Partial<ServeState> = {}): ServeState {
  return {
    version: 1,
    projects: [],
    chats: [],
    messages: [],
    selectedProjectId: null,
    selectedChatId: null,
    ...overrides,
  };
}

function createDeferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

class DelayedInitialEmptyStateStore extends ServeStateStore {
  private delayedInitialSave = false;

  constructor(
    dataDir: string,
    private readonly initialSaveStarted: () => void,
    private readonly releaseInitialSave: Promise<void>,
  ) {
    super(dataDir);
  }

  override async save(state: ServeState): Promise<void> {
    if (
      !this.delayedInitialSave &&
      state.projects.length === 0 &&
      state.chats.length === 0 &&
      state.messages.length === 0
    ) {
      this.delayedInitialSave = true;
      this.initialSaveStarted();
      await this.releaseInitialSave;
    }

    await super.save(state);
  }
}

describe("ServeStateStore", () => {
  it("uses the XDG state directory by default", () => {
    strictEqual(
      getDefaultServeDataDir({ XDG_STATE_HOME: "/xdg/state" }),
      "/xdg/state/phantom",
    );
  });

  it("falls back to the XDG default state directory", () => {
    strictEqual(
      getDefaultServeDataDir({ XDG_STATE_HOME: "" }),
      join(homedir(), ".local", "state", "phantom"),
    );
  });

  it("ignores a relative XDG state directory", () => {
    strictEqual(
      getDefaultServeDataDir({ XDG_STATE_HOME: "relative/state" }),
      join(homedir(), ".local", "state", "phantom"),
    );
  });

  it("creates missing state on load", async () => {
    const directory = await createTemporaryDirectory();
    const store = new ServeStateStore(directory);

    deepStrictEqual(await store.load(), createTestState());
    deepStrictEqual(
      JSON.parse(await readFile(join(directory, "state.json"), "utf8")),
      createTestState(),
    );
  });

  it("persists updates atomically", async () => {
    const directory = await createTemporaryDirectory();
    const store = new ServeStateStore(directory);

    await store.update((state) => ({
      ...state,
      projects: [
        {
          id: "proj_1",
          name: "repo",
          rootPath: "/repo",
          createdAt: "2026-04-25T00:00:00.000Z",
          updatedAt: "2026-04-25T00:00:00.000Z",
          lastOpenedAt: "2026-04-25T00:00:00.000Z",
        },
      ],
    }));

    const reloaded = await new ServeStateStore(directory).load();
    strictEqual(reloaded.projects[0]?.rootPath, "/repo");
  });

  it("serializes missing state creation with updates", async () => {
    const directory = await createTemporaryDirectory();
    const initialSaveStarted = createDeferred();
    const releaseInitialSave = createDeferred();
    const store = new DelayedInitialEmptyStateStore(
      directory,
      initialSaveStarted.resolve,
      releaseInitialSave.promise,
    );

    const loadPromise = store.load();
    await initialSaveStarted.promise;

    const updatePromise = store.update((state) => ({
      ...state,
      projects: [
        {
          id: "proj_1",
          name: "repo",
          rootPath: "/repo",
          createdAt: "2026-04-25T00:00:00.000Z",
          updatedAt: "2026-04-25T00:00:00.000Z",
          lastOpenedAt: "2026-04-25T00:00:00.000Z",
        },
      ],
    }));
    let updateResolved = false;
    const updateCompletion = updatePromise.then(() => {
      updateResolved = true;
    });

    await Promise.resolve();
    await Promise.resolve();
    strictEqual(updateResolved, false);

    releaseInitialSave.resolve();
    await Promise.all([loadPromise, updateCompletion]);

    const savedState = JSON.parse(
      await readFile(join(directory, "state.json"), "utf8"),
    );
    strictEqual(savedState.projects[0]?.id, "proj_1");
  });

  it("preserves unknown state fields across updates", async () => {
    const directory = await createTemporaryDirectory();
    const persistedState = {
      version: 1,
      projects: [
        {
          id: "proj_1",
          name: "repo",
          rootPath: "/repo",
          createdAt: "2026-04-25T00:00:00.000Z",
          updatedAt: "2026-04-25T00:00:00.000Z",
          lastOpenedAt: "2026-04-25T00:00:00.000Z",
          customProjectField: "project metadata",
        },
      ],
      chats: [
        {
          id: "chat_1",
          projectId: "proj_1",
          worktreeName: "repo",
          worktreePath: "/repo",
          branchName: "main",
          codexThreadId: null,
          title: "repo",
          status: "idle",
          createdAt: "2026-04-25T00:00:00.000Z",
          updatedAt: "2026-04-25T00:00:00.000Z",
          customChatField: "chat metadata",
        },
      ],
      messages: [
        {
          id: "msg_1",
          chatId: "chat_1",
          role: "event",
          text: "created",
          createdAt: "2026-04-25T00:00:00.000Z",
          customMessageField: "message metadata",
        },
      ],
      selectedProjectId: null,
      selectedChatId: null,
      customTopLevelField: "state metadata",
    };

    await writeFile(
      join(directory, "state.json"),
      `${JSON.stringify(persistedState)}\n`,
    );

    const store = new ServeStateStore(directory);
    await store.update((state) => state);
    const savedState = JSON.parse(
      await readFile(join(directory, "state.json"), "utf8"),
    );

    strictEqual(savedState.projects[0]?.customProjectField, "project metadata");
    strictEqual(savedState.chats[0]?.customChatField, "chat metadata");
    strictEqual(savedState.messages[0]?.customMessageField, "message metadata");
    strictEqual(savedState.customTopLevelField, "state metadata");
  });

  it("rejects malformed state", async () => {
    const directory = await createTemporaryDirectory();
    await writeFile(join(directory, "state.json"), '{"version":1}');
    const store = new ServeStateStore(directory);

    strictEqual(
      await store.load().then(
        () => "resolved",
        (error: Error) => error.message,
      ),
      "Serve state has an invalid shape",
    );
  });
});
