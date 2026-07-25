import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  PROJECT_REGISTRY_VERSION,
  projectRegistryStateSchema,
  type ProjectRecord,
  type ProjectRegistryState,
} from "./types.ts";

const REGISTRY_FILE_NAME = "projects.json";
const LOCK_DIRECTORY_NAME = "projects.lock";
const LOCK_OWNER_FILE_NAME = "owner.json";
const LOCK_RECOVERY_DIRECTORY_NAME = "projects.lock.recovery";
const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_LOCK_RETRY_MS = 20;
const DEFAULT_STALE_LOCK_MS = 30_000;
const execFileAsync = promisify(execFile);

interface LockOwner {
  token: string;
  pid: number;
  createdAt: string;
  processIdentity: string | null;
}

export interface ProjectRegistryStoreOptions {
  lockTimeoutMs?: number;
  lockRetryMs?: number;
  staleLockMs?: number;
  /** @internal Synchronizes lock-race regression tests. */
  onLockAcquired?: () => void | Promise<void>;
  /** @internal Synchronizes lock-race regression tests. */
  onBeforeLockAcquire?: () => void | Promise<void>;
  /** @internal Synchronizes stale-recovery regression tests. */
  onBeforeStaleLockRemoval?: () => void | Promise<void>;
}

export class ProjectRegistryError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ProjectRegistryError";
  }
}

export function getDefaultProjectsDataDir(
  env: NodeJS.ProcessEnv = process.env,
  userHome = homedir(),
): string {
  const stateHome = env.XDG_STATE_HOME;
  const baseStateDirectory =
    stateHome && isAbsolute(stateHome)
      ? stateHome
      : join(userHome, ".local", "state");
  return join(baseStateDirectory, "phantom");
}

export class ProjectRegistryStore {
  private readonly dataDir: string;
  private readonly lockRetryMs: number;
  private readonly lockTimeoutMs: number;
  private readonly onBeforeLockAcquire?: () => void | Promise<void>;
  private readonly onBeforeStaleLockRemoval?: () => void | Promise<void>;
  private readonly onLockAcquired?: () => void | Promise<void>;
  private readonly staleLockMs: number;

  constructor(
    dataDir = getDefaultProjectsDataDir(),
    options: ProjectRegistryStoreOptions = {},
  ) {
    this.dataDir = dataDir;
    this.lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
    this.lockRetryMs = options.lockRetryMs ?? DEFAULT_LOCK_RETRY_MS;
    this.staleLockMs = options.staleLockMs ?? DEFAULT_STALE_LOCK_MS;
    this.onLockAcquired = options.onLockAcquired;
    this.onBeforeLockAcquire = options.onBeforeLockAcquire;
    this.onBeforeStaleLockRemoval = options.onBeforeStaleLockRemoval;
  }

  async list(): Promise<ProjectRecord[]> {
    const state = await this.load();
    return state.projects.map((project) => ({ ...project }));
  }

  async add(
    rootPath: string,
  ): Promise<{ project: ProjectRecord; added: boolean }> {
    const normalizedRootPath = normalizeRootPath(rootPath);
    let result: { project: ProjectRecord; added: boolean } | undefined;

    await this.update((state) => {
      const existingProject = state.projects.find(
        (project) => project.rootPath === normalizedRootPath,
      );
      if (existingProject) {
        result = { project: existingProject, added: false };
        return state;
      }

      const project: ProjectRecord = {
        id: `proj_${randomUUID()}`,
        name: basename(normalizedRootPath),
        rootPath: normalizedRootPath,
        createdAt: new Date().toISOString(),
      };
      result = { project, added: true };
      return {
        ...state,
        projects: [...state.projects, project],
      };
    });

    return result!;
  }

  async remove(id: string): Promise<ProjectRecord | null> {
    let removedProject: ProjectRecord | null = null;

    await this.update((state) => {
      const project = state.projects.find((candidate) => candidate.id === id);
      if (!project) {
        return state;
      }

      removedProject = project;
      return {
        ...state,
        projects: state.projects.filter((candidate) => candidate.id !== id),
      };
    });

    return removedProject;
  }

  private async load(): Promise<ProjectRegistryState> {
    const registryPath = join(this.dataDir, REGISTRY_FILE_NAME);
    let content: string;
    try {
      content = await readFile(registryPath, "utf8");
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) {
        return createEmptyRegistry();
      }
      throw error;
    }

    let value: unknown;
    try {
      value = JSON.parse(content);
    } catch (error) {
      throw new ProjectRegistryError(
        "Projects registry contains invalid JSON",
        {
          cause: error,
        },
      );
    }

    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new ProjectRegistryError("Projects registry is not a JSON object");
    }

    const version = (value as Record<string, unknown>).version;
    if (version !== PROJECT_REGISTRY_VERSION) {
      throw new ProjectRegistryError(
        `Unsupported projects registry version: ${String(version)}`,
      );
    }

    const parsed = projectRegistryStateSchema.safeParse(value);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const location = issue?.path.length ? ` at ${issue.path.join(".")}` : "";
      throw new ProjectRegistryError(
        `Projects registry has an invalid shape${location}: ${issue?.message ?? parsed.error.message}`,
      );
    }

    return parsed.data;
  }

  private async update(
    updater: (
      state: ProjectRegistryState,
    ) => ProjectRegistryState | Promise<ProjectRegistryState>,
  ): Promise<void> {
    await this.withLock(async () => {
      const currentState = await this.load();
      const nextState = await updater({
        ...currentState,
        projects: currentState.projects.map((project) => ({ ...project })),
      });
      const parsed = projectRegistryStateSchema.safeParse(nextState);
      if (!parsed.success) {
        throw new ProjectRegistryError(
          `Refusing to save an invalid projects registry: ${parsed.error.message}`,
        );
      }
      await this.save(parsed.data);
    });
  }

  private async save(state: ProjectRegistryState): Promise<void> {
    await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    const registryPath = join(this.dataDir, REGISTRY_FILE_NAME);
    const temporaryPath = join(
      this.dataDir,
      `.${REGISTRY_FILE_NAME}.tmp-${process.pid}-${randomUUID()}`,
    );
    let temporaryFile: Awaited<ReturnType<typeof open>> | undefined;

    try {
      temporaryFile = await open(temporaryPath, "wx", 0o600);
      await temporaryFile.writeFile(`${JSON.stringify(state, null, 2)}\n`);
      await temporaryFile.sync();
      await temporaryFile.close();
      temporaryFile = undefined;
      await rename(temporaryPath, registryPath);
      await syncDirectory(this.dataDir);
    } finally {
      await temporaryFile?.close().catch(() => undefined);
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    const lockPath = join(this.dataDir, LOCK_DIRECTORY_NAME);
    const recoveryDirectoryPath = join(
      this.dataDir,
      LOCK_RECOVERY_DIRECTORY_NAME,
    );
    const deadline = Date.now() + this.lockTimeoutMs;
    let owner: LockOwner | undefined;

    while (true) {
      if (await this.hasActiveRecoveryMarkers(recoveryDirectoryPath)) {
        await this.waitForLock(deadline, lockPath, recoveryDirectoryPath);
        continue;
      }

      await this.onBeforeLockAcquire?.();
      const candidate = await createLockOwner();
      try {
        await mkdir(lockPath, { mode: 0o700 });
        try {
          await writeFile(
            join(lockPath, LOCK_OWNER_FILE_NAME),
            `${JSON.stringify(candidate)}\n`,
            { flag: "wx", mode: 0o600 },
          );
        } catch (error) {
          await this.releaseMainLock(
            lockPath,
            candidate.token,
            recoveryDirectoryPath,
          );
          throw error;
        }
      } catch (error) {
        if (!hasErrorCode(error, "EEXIST")) {
          throw error;
        }

        if (await this.recoverStaleLock(lockPath, recoveryDirectoryPath)) {
          continue;
        }
        await this.waitForLock(deadline, lockPath, recoveryDirectoryPath);
        continue;
      }

      try {
        await this.onLockAcquired?.();
      } catch (error) {
        await this.releaseMainLock(
          lockPath,
          candidate.token,
          recoveryDirectoryPath,
        );
        throw error;
      }

      const recoveryIsActive = await this.hasActiveRecoveryMarkers(
        recoveryDirectoryPath,
      );
      const stillOwnsLock = await isDirectoryOwnedBy(lockPath, candidate.token);
      if (recoveryIsActive || !stillOwnsLock) {
        if (stillOwnsLock) {
          await this.releaseMainLock(
            lockPath,
            candidate.token,
            recoveryDirectoryPath,
          );
        }
        await this.waitForLock(deadline, lockPath, recoveryDirectoryPath);
        continue;
      }

      owner = candidate;
      break;
    }

    const heartbeat = setInterval(
      () => {
        const timestamp = new Date();
        void utimes(lockPath, timestamp, timestamp).catch(() => undefined);
      },
      Math.max(10, Math.floor(this.staleLockMs / 3)),
    );
    heartbeat.unref();

    try {
      return await operation();
    } finally {
      clearInterval(heartbeat);
      await this.releaseMainLock(lockPath, owner.token, recoveryDirectoryPath);
    }
  }

  private async recoverStaleLock(
    lockPath: string,
    recoveryDirectoryPath: string,
  ): Promise<boolean> {
    try {
      const initialLockStat = await stat(lockPath);
      if (Date.now() - initialLockStat.mtimeMs <= this.staleLockMs) {
        return false;
      }
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) {
        return true;
      }
      throw error;
    }

    const recoveryOwner = await createLockOwner();
    const recoveryMarkerPath = join(recoveryDirectoryPath, recoveryOwner.token);

    await mkdir(recoveryDirectoryPath, { recursive: true, mode: 0o700 });
    await mkdir(recoveryMarkerPath, { mode: 0o700 });
    try {
      await writeFile(
        join(recoveryMarkerPath, LOCK_OWNER_FILE_NAME),
        `${JSON.stringify(recoveryOwner)}\n`,
        { flag: "wx", mode: 0o600 },
      );
    } catch (error) {
      await rm(recoveryMarkerPath, { recursive: true, force: true });
      throw error;
    }

    try {
      return await this.recoverStaleLockWithMarker(
        lockPath,
        recoveryMarkerPath,
        recoveryOwner.token,
      );
    } finally {
      await releaseOwnedDirectory(recoveryMarkerPath, recoveryOwner.token);
    }
  }

  private async recoverStaleLockWithMarker(
    lockPath: string,
    recoveryMarkerPath: string,
    recoveryToken: string,
  ): Promise<boolean> {
    let lockStat;
    try {
      lockStat = await stat(lockPath);
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) {
        return true;
      }
      throw error;
    }

    if (Date.now() - lockStat.mtimeMs <= this.staleLockMs) {
      return false;
    }

    const owner = await readLockOwner(lockPath);
    if (owner && (await isLockOwnerAlive(owner))) {
      return false;
    }

    await this.onBeforeStaleLockRemoval?.();
    if (!(await isDirectoryOwnedBy(recoveryMarkerPath, recoveryToken))) {
      return false;
    }

    const stalePath = `${lockPath}.stale-${randomUUID()}`;
    try {
      await rename(lockPath, stalePath);
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) {
        return true;
      }
      throw error;
    }
    await rm(stalePath, { recursive: true, force: true });
    return true;
  }

  private async hasActiveRecoveryMarkers(
    recoveryDirectoryPath: string,
  ): Promise<boolean> {
    await mkdir(recoveryDirectoryPath, { recursive: true, mode: 0o700 });
    const entries = await readdir(recoveryDirectoryPath, {
      withFileTypes: true,
    });

    for (const entry of entries) {
      const markerPath = join(recoveryDirectoryPath, entry.name);
      let markerStat;
      try {
        markerStat = await stat(markerPath);
      } catch (error) {
        if (hasErrorCode(error, "ENOENT")) {
          continue;
        }
        throw error;
      }

      if (Date.now() - markerStat.mtimeMs <= this.staleLockMs) {
        return true;
      }

      const markerOwner = entry.isDirectory()
        ? await readLockOwner(markerPath)
        : null;
      if (markerOwner && (await isLockOwnerAlive(markerOwner))) {
        return true;
      }

      await rm(markerPath, { recursive: true, force: true });
    }

    return (await readdir(recoveryDirectoryPath)).length > 0;
  }

  private async releaseMainLock(
    lockPath: string,
    lockToken: string,
    recoveryDirectoryPath: string,
  ): Promise<void> {
    const releaseOwner = await createLockOwner();
    const releaseMarkerPath = join(recoveryDirectoryPath, releaseOwner.token);

    await mkdir(recoveryDirectoryPath, { recursive: true, mode: 0o700 });
    await mkdir(releaseMarkerPath, { mode: 0o700 });
    try {
      await writeFile(
        join(releaseMarkerPath, LOCK_OWNER_FILE_NAME),
        `${JSON.stringify(releaseOwner)}\n`,
        { flag: "wx", mode: 0o600 },
      );

      if (await isDirectoryOwnedBy(lockPath, lockToken)) {
        await rm(lockPath, { recursive: true, force: true });
      }
    } finally {
      await releaseOwnedDirectory(releaseMarkerPath, releaseOwner.token);
    }
  }

  private async waitForLock(
    deadline: number,
    lockPath: string,
    recoveryDirectoryPath: string,
  ): Promise<void> {
    if (Date.now() >= deadline) {
      throw new ProjectRegistryError(
        `Timed out waiting for projects registry lock at ${lockPath}. ` +
          `Inspect ${recoveryDirectoryPath} for abandoned recovery markers.`,
      );
    }
    await delay(this.lockRetryMs);
  }
}

function createEmptyRegistry(): ProjectRegistryState {
  return {
    version: PROJECT_REGISTRY_VERSION,
    projects: [],
  };
}

function normalizeRootPath(rootPath: string): string {
  if (!isAbsolute(rootPath)) {
    throw new ProjectRegistryError("Project root path must be absolute");
  }
  const normalizedRootPath = resolve(rootPath);
  if (!basename(normalizedRootPath)) {
    throw new ProjectRegistryError("Project root path must have a name");
  }
  return normalizedRootPath;
}

async function createLockOwner(): Promise<LockOwner> {
  return {
    token: randomUUID(),
    pid: process.pid,
    createdAt: new Date().toISOString(),
    processIdentity: await currentProcessIdentity,
  };
}

async function readLockOwner(lockPath: string): Promise<LockOwner | null> {
  try {
    const value: unknown = JSON.parse(
      await readFile(join(lockPath, LOCK_OWNER_FILE_NAME), "utf8"),
    );
    if (
      !value ||
      typeof value !== "object" ||
      typeof (value as LockOwner).token !== "string" ||
      !Number.isSafeInteger((value as LockOwner).pid) ||
      (value as LockOwner).pid <= 0 ||
      typeof (value as LockOwner).createdAt !== "string" ||
      !(
        (value as Partial<LockOwner>).processIdentity === undefined ||
        (value as Partial<LockOwner>).processIdentity === null ||
        typeof (value as Partial<LockOwner>).processIdentity === "string"
      )
    ) {
      return null;
    }
    return {
      ...(value as LockOwner),
      processIdentity: (value as Partial<LockOwner>).processIdentity ?? null,
    };
  } catch {
    return null;
  }
}

async function isLockOwnerAlive(owner: LockOwner): Promise<boolean> {
  if (!isProcessAlive(owner.pid)) {
    return false;
  }
  if (!owner.processIdentity) {
    return true;
  }

  const identity = await readProcessIdentity(owner.pid);
  return identity === null || identity === owner.processIdentity;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return hasErrorCode(error, "EPERM");
  }
}

async function readProcessIdentity(pid: number): Promise<string | null> {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return null;
  }

  if (process.platform === "linux") {
    try {
      const processStat = await readFile(`/proc/${pid}/stat`, "utf8");
      const commandEnd = processStat.lastIndexOf(")");
      if (commandEnd !== -1) {
        const fields = processStat
          .slice(commandEnd + 1)
          .trim()
          .split(/\s+/);
        const startTime = fields[19];
        if (startTime) {
          return `linux:${startTime}`;
        }
      }
    } catch {
      return null;
    }
  }

  try {
    const { stdout } = await execFileAsync(
      "ps",
      ["-o", "lstart=", "-p", String(pid)],
      {
        encoding: "utf8",
        env: { ...process.env, LC_ALL: "C" },
      },
    );
    const startTime = stdout.trim();
    return startTime ? `${process.platform}:${startTime}` : null;
  } catch {
    return null;
  }
}

async function isDirectoryOwnedBy(
  directoryPath: string,
  token: string,
): Promise<boolean> {
  return (await readLockOwner(directoryPath))?.token === token;
}

async function releaseOwnedDirectory(
  directoryPath: string,
  token: string,
): Promise<void> {
  if (!(await isDirectoryOwnedBy(directoryPath, token))) {
    return;
  }
  await rm(directoryPath, { recursive: true, force: true });
}

async function syncDirectory(directoryPath: string): Promise<void> {
  const directory = await open(directoryPath, "r");
  try {
    await directory.sync();
  } catch (error) {
    if (!hasErrorCode(error, "EINVAL") && !hasErrorCode(error, "ENOTSUP")) {
      throw error;
    }
  } finally {
    await directory.close();
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    error.code === code
  );
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

const currentProcessIdentity = readProcessIdentity(process.pid);
