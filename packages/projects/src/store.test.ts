import { deepStrictEqual, match, rejects, strictEqual } from "node:assert";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";
import { getDefaultProjectsDataDir, ProjectRegistryStore } from "./store.ts";
import { PROJECT_REGISTRY_VERSION } from "./types.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "phantom-projects-"));
  temporaryDirectories.push(directory);
  return directory;
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

describe("getDefaultProjectsDataDir", () => {
  it("uses an absolute XDG state directory", () => {
    strictEqual(
      getDefaultProjectsDataDir(
        { XDG_STATE_HOME: "/xdg/state" },
        "/users/example",
      ),
      "/xdg/state/phantom",
    );
  });

  it("uses the home fallback when XDG state is missing or relative", () => {
    strictEqual(
      getDefaultProjectsDataDir({}, "/users/example"),
      "/users/example/.local/state/phantom",
    );
    strictEqual(
      getDefaultProjectsDataDir(
        { XDG_STATE_HOME: "relative/state" },
        "/users/example",
      ),
      "/users/example/.local/state/phantom",
    );
  });
});

describe("ProjectRegistryStore", () => {
  it("returns an empty registry when the file does not exist", async () => {
    const dataDirectory = await createTemporaryDirectory();
    const store = new ProjectRegistryStore(dataDirectory);

    deepStrictEqual(await store.list(), []);
  });

  it("rejects malformed JSON, invalid shapes, and unsupported versions", async () => {
    const dataDirectory = await createTemporaryDirectory();
    const registryPath = join(dataDirectory, "projects.json");
    const store = new ProjectRegistryStore(dataDirectory);

    await writeFile(registryPath, "{broken");
    await rejects(store.list(), /Projects registry contains invalid JSON/);

    await writeFile(registryPath, '{"version":2,"projects":[]}');
    await rejects(store.list(), /Unsupported projects registry version: 2/);

    await writeFile(registryPath, '{"version":1,"projects":[{}]}');
    await rejects(store.list(), /Projects registry has an invalid shape/);

    const duplicate = {
      version: 1,
      projects: [
        {
          id: "proj_550e8400-e29b-41d4-a716-446655440000",
          name: "phantom",
          rootPath: "/work/phantom",
          createdAt: "2026-07-20T00:00:00.000Z",
        },
        {
          id: "proj_550e8400-e29b-41d4-a716-446655440000",
          name: "other",
          rootPath: "/work/other",
          createdAt: "2026-07-20T00:00:00.000Z",
        },
      ],
    };
    await writeFile(registryPath, JSON.stringify(duplicate));
    await rejects(store.list(), /Duplicate project id/);

    const nonCanonicalPath = {
      version: 1,
      projects: [
        {
          ...duplicate.projects[0],
          rootPath: "/work/client/../phantom",
        },
      ],
    };
    await writeFile(registryPath, JSON.stringify(nonCanonicalPath));
    await rejects(store.list(), /Expected a canonical path/);

    const mismatchedName = {
      version: 1,
      projects: [
        {
          ...duplicate.projects[0],
          name: "other",
        },
      ],
    };
    await writeFile(registryPath, JSON.stringify(mismatchedName));
    await rejects(store.list(), /Expected name to match/);
  });

  it("adds a versioned project record and writes it privately", async () => {
    const dataDirectory = await createTemporaryDirectory();
    const store = new ProjectRegistryStore(dataDirectory);

    const result = await store.add("/work/phantom");

    strictEqual(result.added, true);
    match(
      result.project.id,
      /^proj_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    strictEqual(result.project.name, "phantom");
    strictEqual(result.project.rootPath, "/work/phantom");
    match(result.project.createdAt, /^\d{4}-\d{2}-\d{2}T/);

    const persisted = JSON.parse(
      await readFile(join(dataDirectory, "projects.json"), "utf8"),
    );
    strictEqual(persisted.version, PROJECT_REGISTRY_VERSION);
    deepStrictEqual(persisted.projects, [result.project]);

    if (process.platform !== "win32") {
      const registryStat = await stat(join(dataDirectory, "projects.json"));
      strictEqual(registryStat.mode & 0o777, 0o600);
    }
  });

  it("adds the same root path idempotently", async () => {
    const dataDirectory = await createTemporaryDirectory();
    const store = new ProjectRegistryStore(dataDirectory);

    const first = await store.add("/work/phantom/");
    const second = await store.add("/work/phantom");

    strictEqual(first.added, true);
    strictEqual(second.added, false);
    strictEqual(second.project.id, first.project.id);
    strictEqual(second.project.createdAt, first.project.createdAt);
    deepStrictEqual(await store.list(), [first.project]);
  });

  it("allows projects with the same name at different paths", async () => {
    const dataDirectory = await createTemporaryDirectory();
    const store = new ProjectRegistryStore(dataDirectory);

    const first = await store.add("/work/client/phantom");
    const second = await store.add("/work/upstream/phantom");

    strictEqual(first.project.name, "phantom");
    strictEqual(second.project.name, "phantom");
    strictEqual((await store.list()).length, 2);
  });

  it("requires an absolute, named project root", async () => {
    const dataDirectory = await createTemporaryDirectory();
    const store = new ProjectRegistryStore(dataDirectory);

    await rejects(store.add("relative/repo"), /must be absolute/);
    await rejects(store.add("/"), /must have a name/);
  });

  it("removes a project by id and reports a missing id", async () => {
    const dataDirectory = await createTemporaryDirectory();
    const store = new ProjectRegistryStore(dataDirectory);
    const { project } = await store.add("/work/phantom");

    deepStrictEqual(await store.remove(project.id), project);
    strictEqual(await store.remove(project.id), null);
    deepStrictEqual(await store.list(), []);
  });

  it("does not lose concurrent updates from separate store instances", async () => {
    const dataDirectory = await createTemporaryDirectory();
    const stores = Array.from(
      { length: 12 },
      () =>
        new ProjectRegistryStore(dataDirectory, {
          lockRetryMs: 1,
          lockTimeoutMs: 2_000,
        }),
    );

    await Promise.all(
      stores.map((store, index) => store.add(`/work/project-${index}`)),
    );

    const projects = await stores[0]!.list();
    strictEqual(projects.length, stores.length);
    deepStrictEqual(
      new Set(projects.map((project) => project.rootPath)),
      new Set(stores.map((_, index) => `/work/project-${index}`)),
    );
  });

  it("serializes concurrent add and remove operations", async () => {
    const dataDirectory = await createTemporaryDirectory();
    const firstStore = new ProjectRegistryStore(dataDirectory, {
      lockRetryMs: 1,
    });
    const secondStore = new ProjectRegistryStore(dataDirectory, {
      lockRetryMs: 1,
    });
    const existing = await firstStore.add("/work/existing");

    await Promise.all([
      firstStore.remove(existing.project.id),
      secondStore.add("/work/new"),
    ]);

    const projects = await firstStore.list();
    deepStrictEqual(
      projects.map((project) => project.rootPath),
      ["/work/new"],
    );
  });

  it("recovers a stale lock owned by a dead process", async () => {
    const dataDirectory = await createTemporaryDirectory();
    const lockPath = join(dataDirectory, "projects.lock");
    await mkdir(lockPath);
    await writeFile(
      join(lockPath, "owner.json"),
      JSON.stringify({
        token: "abandoned",
        pid: 2_147_483_647,
        createdAt: "2000-01-01T00:00:00.000Z",
      }),
    );
    const oldTimestamp = new Date(Date.now() - 60_000);
    await utimes(lockPath, oldTimestamp, oldTimestamp);

    const store = new ProjectRegistryStore(dataDirectory, {
      lockRetryMs: 1,
      lockTimeoutMs: 200,
      staleLockMs: 10,
    });
    const result = await store.add("/work/phantom");

    strictEqual(result.added, true);
    deepStrictEqual(await store.list(), [result.project]);
  });

  it("serializes multiple contenders recovering the same stale lock", async () => {
    const dataDirectory = await createTemporaryDirectory();
    const lockPath = join(dataDirectory, "projects.lock");
    await mkdir(lockPath);
    await writeFile(
      join(lockPath, "owner.json"),
      JSON.stringify({
        token: "abandoned",
        pid: 2_147_483_647,
        createdAt: "2000-01-01T00:00:00.000Z",
      }),
    );
    const oldTimestamp = new Date(Date.now() - 60_000);
    await utimes(lockPath, oldTimestamp, oldTimestamp);

    const options = {
      lockRetryMs: 1,
      lockTimeoutMs: 500,
      staleLockMs: 10,
    };
    const firstStore = new ProjectRegistryStore(dataDirectory, options);
    const secondStore = new ProjectRegistryStore(dataDirectory, options);

    await Promise.all([
      firstStore.add("/work/first"),
      secondStore.add("/work/second"),
    ]);

    strictEqual((await firstStore.list()).length, 2);
  });

  it("fences a replacement lock during stale recovery", async () => {
    const dataDirectory = await createTemporaryDirectory();
    const lockPath = join(dataDirectory, "projects.lock");
    await mkdir(lockPath);
    await writeFile(
      join(lockPath, "owner.json"),
      JSON.stringify({
        token: "abandoned",
        pid: 2_147_483_647,
        createdAt: "2000-01-01T00:00:00.000Z",
      }),
    );
    const oldTimestamp = new Date(Date.now() - 60_000);
    await utimes(lockPath, oldTimestamp, oldTimestamp);

    const replacementPrechecked = createDeferred();
    const allowReplacementAcquire = createDeferred();
    const replacementAcquired = createDeferred();
    const allowReplacementPostcheck = createDeferred();
    const recoveryReady = createDeferred();
    const allowRecovery = createDeferred();
    let replacementAcquireCount = 0;
    let replacementLockCount = 0;

    const replacementStore = new ProjectRegistryStore(dataDirectory, {
      lockRetryMs: 1,
      lockTimeoutMs: 2_000,
      staleLockMs: 10,
      onBeforeLockAcquire: async () => {
        if (replacementAcquireCount++ === 0) {
          replacementPrechecked.resolve();
          await allowReplacementAcquire.promise;
        }
      },
      onLockAcquired: async () => {
        if (replacementLockCount++ === 0) {
          replacementAcquired.resolve();
          await allowReplacementPostcheck.promise;
        }
      },
    });
    const recoveringStore = new ProjectRegistryStore(dataDirectory, {
      lockRetryMs: 1,
      lockTimeoutMs: 2_000,
      staleLockMs: 10,
      onBeforeStaleLockRemoval: async () => {
        recoveryReady.resolve();
        await allowRecovery.promise;
      },
    });

    const replacementUpdate = replacementStore.add("/work/replacement");
    await replacementPrechecked.promise;
    const recoveryUpdate = recoveringStore.add("/work/recovery");
    await recoveryReady.promise;

    await rm(lockPath, { recursive: true, force: true });
    allowReplacementAcquire.resolve();
    await replacementAcquired.promise;
    allowRecovery.resolve();
    await recoveryUpdate;
    allowReplacementPostcheck.resolve();
    await replacementUpdate;

    deepStrictEqual(
      new Set(
        (await recoveringStore.list()).map((project) => project.rootPath),
      ),
      new Set(["/work/recovery", "/work/replacement"]),
    );
  });

  it("recovers a stale lock after its PID has been reused", async () => {
    const dataDirectory = await createTemporaryDirectory();
    const lockPath = join(dataDirectory, "projects.lock");
    await mkdir(lockPath);
    await writeFile(
      join(lockPath, "owner.json"),
      JSON.stringify({
        token: "previous-process",
        pid: process.pid,
        createdAt: "2000-01-01T00:00:00.000Z",
        processIdentity: "different-process-start",
      }),
    );
    const oldTimestamp = new Date(Date.now() - 60_000);
    await utimes(lockPath, oldTimestamp, oldTimestamp);

    const store = new ProjectRegistryStore(dataDirectory, {
      lockRetryMs: 1,
      lockTimeoutMs: 500,
      staleLockMs: 10,
    });
    const result = await store.add("/work/phantom");

    strictEqual(result.added, true);
  });

  it("does not recover a stale-looking lock owned by a live process", async () => {
    const dataDirectory = await createTemporaryDirectory();
    const lockPath = join(dataDirectory, "projects.lock");
    await mkdir(lockPath);
    await writeFile(
      join(lockPath, "owner.json"),
      JSON.stringify({
        token: "live",
        pid: process.pid,
        createdAt: "2000-01-01T00:00:00.000Z",
      }),
    );
    const oldTimestamp = new Date(Date.now() - 60_000);
    await utimes(lockPath, oldTimestamp, oldTimestamp);

    const store = new ProjectRegistryStore(dataDirectory, {
      lockRetryMs: 1,
      lockTimeoutMs: 20,
      staleLockMs: 10,
    });

    await rejects(store.add("/work/phantom"), /Timed out waiting/);
  });
});
