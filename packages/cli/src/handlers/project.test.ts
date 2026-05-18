import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rejects, strictEqual } from "node:assert";
import { afterAll, afterEach, beforeEach, describe, it, vi } from "vitest";

const exitMock = vi.fn();
const consoleLogMock = vi.fn();
const consoleErrorMock = vi.fn();
const getGitRootMock = vi.fn();

const originalProcessExit = process.exit;
const originalProcessEnv = process.env;

process.exit = (code): never => {
  exitMock(code);
  throw new Error(`Exit with code ${code ?? 0}`);
};

vi.doMock("@phantompane/git", () => ({
  getGitRoot: getGitRootMock,
}));

vi.doMock("../output.ts", () => ({
  output: {
    log: consoleLogMock,
    error: consoleErrorMock,
  },
}));

const { projectAddHandler } = await import("./project-add.ts");
const { projectListHandler } = await import("./project-list.ts");
const { projectRemoveHandler } = await import("./project-remove.ts");

let dataDir: string;
let repoDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "phantom-cli-project-state-"));
  repoDir = await mkdtemp(join(tmpdir(), "phantom-cli-project-repo-"));
  process.env = {
    ...originalProcessEnv,
    PHANTOM_SERVE_DATA_DIR: dataDir,
  };
  exitMock.mockClear();
  consoleLogMock.mockClear();
  consoleErrorMock.mockClear();
  getGitRootMock.mockClear();
  getGitRootMock.mockImplementation(async () => repoDir);
});

afterEach(async () => {
  process.env = originalProcessEnv;
  await rm(dataDir, { recursive: true, force: true });
  await rm(repoDir, { recursive: true, force: true });
});

afterAll(() => {
  process.exit = originalProcessExit;
});

async function readState() {
  return JSON.parse(await readFile(join(dataDir, "state.json"), "utf8"));
}

describe("project handlers", () => {
  it("lists an empty project state", async () => {
    await rejects(async () => await projectListHandler([]), /Exit with code 0/);

    strictEqual(consoleLogMock.mock.calls[0][0], "No projects found.");
    strictEqual(exitMock.mock.calls[0][0], 0);
  });

  it("adds the current repository as a project", async () => {
    await rejects(async () => await projectAddHandler([]), /Exit with code 0/);

    const state = await readState();
    strictEqual(state.projects.length, 1);
    strictEqual(state.projects[0].rootPath, repoDir);
    strictEqual(state.projects[0].name, repoDir.split("/").at(-1));
    strictEqual(state.selectedProjectId, state.projects[0].id);
    strictEqual(
      consoleLogMock.mock.calls[0][0],
      `Added project '${state.projects[0].name}' (${repoDir})`,
    );
  });

  it("prints projects as paths", async () => {
    await rejects(async () => await projectAddHandler([]), /Exit with code 0/);
    exitMock.mockClear();
    consoleLogMock.mockClear();

    await rejects(
      async () => await projectListHandler(["--paths"]),
      /Exit with code 0/,
    );

    strictEqual(consoleLogMock.mock.calls[0][0], repoDir);
    strictEqual(exitMock.mock.calls[0][0], 0);
  });

  it("removes a project and associated chat records", async () => {
    await rejects(async () => await projectAddHandler([]), /Exit with code 0/);
    const state = await readState();
    const project = state.projects[0];
    state.chats = [
      {
        id: "chat_1",
        projectId: project.id,
        worktreeName: "main",
        worktreePath: repoDir,
        branchName: "main",
        codexThreadId: null,
        title: "Chat",
        status: "idle",
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
      },
    ];
    state.messages = [
      {
        id: "msg_1",
        chatId: "chat_1",
        role: "user",
        text: "hello",
        createdAt: project.createdAt,
      },
    ];
    state.recentProjectSkills = {
      [project.id]: [{ path: "/skill", lastUsedAt: project.updatedAt }],
    };
    await writeFile(join(dataDir, "state.json"), `${JSON.stringify(state)}\n`);
    exitMock.mockClear();
    consoleLogMock.mockClear();

    await rejects(
      async () => await projectRemoveHandler([project.id]),
      /Exit with code 0/,
    );

    const nextState = await readState();
    strictEqual(nextState.projects.length, 0);
    strictEqual(nextState.chats.length, 0);
    strictEqual(nextState.messages.length, 0);
    strictEqual(Object.keys(nextState.recentProjectSkills).length, 0);
    strictEqual(
      consoleLogMock.mock.calls[0][0],
      `Removed project '${project.name}' (${repoDir})`,
    );
  });

  it("refuses to remove a project with a running chat", async () => {
    await rejects(async () => await projectAddHandler([]), /Exit with code 0/);
    const state = await readState();
    const project = state.projects[0];
    state.chats = [
      {
        id: "chat_1",
        projectId: project.id,
        worktreeName: "main",
        worktreePath: repoDir,
        branchName: "main",
        codexThreadId: null,
        title: "Chat",
        status: "running",
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
      },
    ];
    await writeFile(join(dataDir, "state.json"), `${JSON.stringify(state)}\n`);
    exitMock.mockClear();

    await rejects(
      async () => await projectRemoveHandler([project.id]),
      /Exit with code 3/,
    );

    strictEqual(
      consoleErrorMock.mock.calls[0][0],
      "Cannot remove project while it has running, approval, or queued chats",
    );
  });
});
