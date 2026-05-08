import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";

export interface CodexHistoryOptions {
  branchName: string;
  codexHome?: string;
  projectId: string;
  worktreeName: string;
  worktreePath: string;
}

export interface CodexHistoryWorktree {
  branchName: string;
  worktreeName: string;
  worktreePath: string;
}

export interface CodexProjectHistoryOptions {
  codexHome?: string;
  projectId: string;
  worktrees: CodexHistoryWorktree[];
}

export interface ImportedCodexSession {
  chat: ImportedCodexChatRecord;
  messages: ImportedCodexChatMessageRecord[];
}

export interface ImportedCodexChatRecord {
  id: string;
  projectId: string;
  worktreeName: string;
  worktreePath: string;
  branchName: string;
  codexThreadId: string;
  title: string;
  status: "idle";
  activeTurnId: null;
  createdAt: string;
  updatedAt: string;
}

export interface ImportedCodexChatMessageRecord {
  id: string;
  chatId: string;
  role: "assistant" | "user";
  text: string;
  createdAt: string;
}

interface ParsedCodexSession {
  createdAt: string;
  messages: Array<{
    createdAt: string;
    role: "assistant" | "user";
    text: string;
  }>;
  sessionId: string;
  title: string;
  updatedAt: string;
  worktreePath: string;
}

export async function listCodexSessionsForWorktree({
  branchName,
  codexHome = getDefaultCodexHome(),
  projectId,
  worktreeName,
  worktreePath,
}: CodexHistoryOptions): Promise<ImportedCodexSession[]> {
  return await listCodexSessionsForWorktrees({
    codexHome,
    projectId,
    worktrees: [{ branchName, worktreeName, worktreePath }],
  });
}

export async function listCodexSessionsForWorktrees({
  codexHome = getDefaultCodexHome(),
  projectId,
  worktrees,
}: CodexProjectHistoryOptions): Promise<ImportedCodexSession[]> {
  const files = await listCodexSessionFiles(codexHome);
  const worktreeByPath = new Map(
    worktrees.map((worktree) => [worktree.worktreePath, worktree]),
  );
  const parsedSessionsById = new Map<string, ParsedCodexSession>();

  for (const file of files) {
    const session = await parseCodexSession(file);
    if (!session || !worktreeByPath.has(session.worktreePath)) {
      continue;
    }

    const existingSession = parsedSessionsById.get(session.sessionId);
    if (
      !existingSession ||
      existingSession.updatedAt.localeCompare(session.updatedAt) < 0
    ) {
      parsedSessionsById.set(session.sessionId, session);
    }
  }

  return Array.from(parsedSessionsById.values())
    .map((session) =>
      createImportedCodexSession({
        projectId,
        session,
        worktree: worktreeByPath.get(session.worktreePath)!,
      }),
    )
    .sort((left, right) =>
      right.chat.updatedAt.localeCompare(left.chat.updatedAt),
    );
}

function getDefaultCodexHome(): string {
  return process.env.CODEX_HOME ?? join(homedir(), ".codex");
}

async function listCodexSessionFiles(codexHome: string): Promise<string[]> {
  const roots = [
    join(codexHome, "sessions"),
    join(codexHome, "archived_sessions"),
  ];
  const files = await Promise.all(roots.map((root) => listJsonlFiles(root)));
  return files.flat();
}

async function listJsonlFiles(root: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (isIgnorableHistoryRootError(error)) {
      return [];
    }
    throw error;
  }

  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = join(root, entry.name);
      if (entry.isDirectory()) {
        return await listJsonlFiles(path);
      }
      return entry.isFile() && entry.name.endsWith(".jsonl") ? [path] : [];
    }),
  );
  return files.flat();
}

async function parseCodexSession(
  path: string,
): Promise<ParsedCodexSession | null> {
  let content;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if (isIgnorableHistoryFileError(error)) {
      return null;
    }
    throw error;
  }

  let sessionId = sessionIdFromPath(path);
  let worktreePath: string | null = null;
  let createdAt: string | null = null;
  let updatedAt: string | null = null;
  let title: string | null = null;
  let isSubagentSession = false;
  const messages: ParsedCodexSession["messages"] = [];

  for (const line of content.split(/\n/)) {
    if (!line.trim()) {
      continue;
    }

    const event = parseJsonObject(line);
    const timestamp = getString(event?.timestamp);
    if (timestamp) {
      createdAt ??= timestamp;
      updatedAt = timestamp;
    }

    if (event?.type === "session_meta") {
      const payload = getObject(event.payload);
      sessionId = getString(payload?.id) ?? sessionId;
      worktreePath = getString(payload?.cwd) ?? worktreePath;
      createdAt = getString(payload?.timestamp) ?? createdAt;
      isSubagentSession = Boolean(getObject(payload?.source)?.subagent);
      continue;
    }

    if (event?.type === "event_msg") {
      const payload = getObject(event.payload);
      if (payload?.type === "thread_name_updated") {
        title = getString(payload.thread_name) ?? title;
      }
      continue;
    }

    if (event?.type !== "response_item") {
      continue;
    }

    const payload = getObject(event.payload);
    if (payload?.type !== "message") {
      continue;
    }

    const role = payload.role;
    if (role !== "assistant" && role !== "user") {
      continue;
    }

    const text =
      role === "user"
        ? stripCodexContextPreamble(extractMessageText(payload.content))
        : extractMessageText(payload.content);
    if (!text) {
      continue;
    }

    messages.push({
      createdAt:
        timestamp ?? updatedAt ?? createdAt ?? new Date(0).toISOString(),
      role,
      text,
    });
    title ??= role === "user" ? truncateTitle(text) : null;
  }

  if (isSubagentSession || !sessionId || !worktreePath) {
    return null;
  }

  return {
    createdAt: createdAt ?? new Date(0).toISOString(),
    messages,
    sessionId,
    title: title ?? sessionId.slice(0, 8),
    updatedAt: updatedAt ?? createdAt ?? new Date(0).toISOString(),
    worktreePath,
  };
}

function createImportedCodexSession({
  projectId,
  session,
  worktree,
}: {
  projectId: string;
  session: ParsedCodexSession;
  worktree: CodexHistoryWorktree;
}): ImportedCodexSession {
  const chatId = createImportedChatId(session.sessionId);
  return {
    chat: {
      id: chatId,
      projectId,
      worktreeName: worktree.worktreeName,
      worktreePath: worktree.worktreePath,
      branchName: worktree.branchName,
      codexThreadId: session.sessionId,
      title: session.title,
      status: "idle",
      activeTurnId: null,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    },
    messages: session.messages.map((message, index) => ({
      id: `${chatId}_msg_${index}`,
      chatId,
      role: message.role,
      text: message.text,
      createdAt: message.createdAt,
    })),
  };
}

function createImportedChatId(sessionId: string): string {
  return `chat_codex_${sessionId}`;
}

function sessionIdFromPath(path: string): string {
  return basename(path)
    .replace(/^rollout-/, "")
    .replace(/\.jsonl$/, "");
}

function extractMessageText(content: unknown): string {
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((item) => {
      const object = getObject(item);
      return getString(object?.text) ?? "";
    })
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

function stripCodexContextPreamble(text: string): string {
  let strippedText = text.trimStart();

  while (true) {
    if (strippedText.startsWith("# AGENTS.md instructions")) {
      const instructionsEnd = strippedText.indexOf("</INSTRUCTIONS>");
      if (instructionsEnd === -1) {
        return "";
      }
      strippedText = strippedText
        .slice(instructionsEnd + "</INSTRUCTIONS>".length)
        .trimStart();
      continue;
    }

    if (strippedText.startsWith("<environment_context>")) {
      const contextEnd = strippedText.indexOf("</environment_context>");
      if (contextEnd === -1) {
        return "";
      }
      strippedText = strippedText
        .slice(contextEnd + "</environment_context>".length)
        .trimStart();
      continue;
    }

    return strippedText.trim();
  }
}

function truncateTitle(text: string): string {
  const firstLine = text.trim().split(/\n/)[0] ?? "";
  return firstLine.length > 32 ? `${firstLine.slice(0, 31)}...` : firstLine;
}

function parseJsonObject(line: string): Record<string, unknown> | null {
  try {
    return getObject(JSON.parse(line));
  } catch {
    return null;
  }
}

function getObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function getString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function isIgnorableHistoryFileError(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    (error.code === "ENOENT" ||
      error.code === "ENOTDIR" ||
      error.code === "EACCES" ||
      error.code === "EPERM"),
  );
}

function isIgnorableHistoryRootError(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    (error.code === "ENOENT" ||
      error.code === "ENOTDIR" ||
      error.code === "EACCES" ||
      error.code === "EPERM"),
  );
}
