import { deepStrictEqual, strictEqual } from "node:assert";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";
import { listCodexSessionsForWorktrees } from "./history.ts";

const temporaryDirectories: string[] = [];

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "phantom-codex-history-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function writeCodexSessionFile(
  codexHome: string,
  fileName: string,
  lines: Array<Record<string, unknown>>,
): Promise<string> {
  const directory = join(codexHome, "archived_sessions");
  await mkdir(directory, { recursive: true });
  const path = join(directory, fileName);
  await writeFile(
    path,
    `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
  );
  return path;
}

function createSessionLines({
  message,
  sessionId,
  timestamp,
  title,
  worktreePath,
}: {
  message: string;
  sessionId: string;
  timestamp: string;
  title: string;
  worktreePath: string;
}): Array<Record<string, unknown>> {
  return [
    {
      timestamp,
      type: "session_meta",
      payload: {
        id: sessionId,
        timestamp,
        cwd: worktreePath,
        source: "vscode",
      },
    },
    {
      timestamp,
      type: "event_msg",
      payload: {
        type: "thread_name_updated",
        thread_name: title,
      },
    },
    {
      timestamp,
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: message }],
      },
    },
  ];
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("listCodexSessionsForWorktrees", () => {
  it("deduplicates multiple history files for the same Codex thread", async () => {
    const codexHome = await createTemporaryDirectory();
    const sessionId = "019dc000-0000-7000-8000-000000000001";
    const worktreePath = "/repo/.git/phantom/worktrees/feature";
    await writeCodexSessionFile(
      codexHome,
      "rollout-2026-04-25T00-00-00-019dc000-0000-7000-8000-000000000001.jsonl",
      createSessionLines({
        message: "old message",
        sessionId,
        timestamp: "2026-04-25T00:00:00.000Z",
        title: "old title",
        worktreePath,
      }),
    );
    await writeCodexSessionFile(
      codexHome,
      "rollout-2026-04-25T00-05-00-019dc000-0000-7000-8000-000000000001.jsonl",
      createSessionLines({
        message: "new message",
        sessionId,
        timestamp: "2026-04-25T00:05:00.000Z",
        title: "new title",
        worktreePath,
      }),
    );

    const sessions = await listCodexSessionsForWorktrees({
      codexHome,
      projectId: "proj_1",
      worktrees: [
        {
          branchName: "feature",
          worktreeName: "feature",
          worktreePath,
        },
      ],
    });

    strictEqual(sessions.length, 1);
    strictEqual(sessions[0]?.chat.id, `chat_codex_${sessionId}`);
    strictEqual(sessions[0]?.chat.title, "new title");
    deepStrictEqual(
      sessions[0]?.messages.map((message) => message.text),
      ["new message"],
    );
  });

  it("skips unreadable Codex history files", async () => {
    const codexHome = await createTemporaryDirectory();
    const worktreePath = "/repo/.git/phantom/worktrees/feature";
    const unreadablePath = await writeCodexSessionFile(
      codexHome,
      "rollout-2026-04-25T00-00-00-019dc000-0000-7000-8000-000000000001.jsonl",
      createSessionLines({
        message: "unreadable message",
        sessionId: "019dc000-0000-7000-8000-000000000001",
        timestamp: "2026-04-25T00:00:00.000Z",
        title: "unreadable",
        worktreePath,
      }),
    );
    await writeCodexSessionFile(
      codexHome,
      "rollout-2026-04-25T00-05-00-019dc000-0000-7000-8000-000000000002.jsonl",
      createSessionLines({
        message: "readable message",
        sessionId: "019dc000-0000-7000-8000-000000000002",
        timestamp: "2026-04-25T00:05:00.000Z",
        title: "readable",
        worktreePath,
      }),
    );
    await chmod(unreadablePath, 0);

    const sessions = await listCodexSessionsForWorktrees({
      codexHome,
      projectId: "proj_1",
      worktrees: [
        {
          branchName: "feature",
          worktreeName: "feature",
          worktreePath,
        },
      ],
    });

    strictEqual(sessions.length, 1);
    strictEqual(sessions[0]?.chat.title, "readable");
  });

  it("strips Codex context preambles without dropping the user prompt", async () => {
    const codexHome = await createTemporaryDirectory();
    const worktreePath = "/repo/.git/phantom/worktrees/feature";
    await writeCodexSessionFile(
      codexHome,
      "rollout-2026-04-25T00-00-00-019dc000-0000-7000-8000-000000000001.jsonl",
      createSessionLines({
        message: [
          "# AGENTS.md instructions for /repo",
          "",
          "<INSTRUCTIONS>",
          "Do the project-specific setup.",
          "</INSTRUCTIONS>",
          "<environment_context>",
          "<cwd>/repo</cwd>",
          "</environment_context>",
          "Please implement the feature.",
        ].join("\n"),
        sessionId: "019dc000-0000-7000-8000-000000000001",
        timestamp: "2026-04-25T00:00:00.000Z",
        title: "Context import",
        worktreePath,
      }),
    );

    const sessions = await listCodexSessionsForWorktrees({
      codexHome,
      projectId: "proj_1",
      worktrees: [
        {
          branchName: "feature",
          worktreeName: "feature",
          worktreePath,
        },
      ],
    });

    deepStrictEqual(
      sessions[0]?.messages.map((message) => message.text),
      ["Please implement the feature."],
    );
  });
});
