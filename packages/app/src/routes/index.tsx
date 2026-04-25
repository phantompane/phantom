import { createFileRoute } from "@tanstack/react-router";
import {
  FolderGit2,
  Loader2,
  MessageSquarePlus,
  Plus,
  Send,
  Square,
} from "lucide-react";
import { FormEvent, useEffect, useMemo, useState } from "react";
import type {
  ChatMessageRecord,
  ChatRecord,
  PhantomEvent,
  ProjectRecord,
} from "../server/types";

export const Route = createFileRoute("/")({
  component: Home,
});

const chatEventNames = [
  "chat.created",
  "chat.updated",
  "chat.message.created",
  "agent.thread.started",
  "agent.turn.started",
  "agent.item.updated",
  "agent.item.delta",
  "agent.approval.requested",
  "agent.approval.resolved",
  "agent.turn.completed",
  "agent.error",
  "agent.event",
  "auth.updated",
];

interface PendingApproval {
  requestId: string;
  method: string;
  params: unknown;
}

function Home() {
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(
    null,
  );
  const [chats, setChats] = useState<ChatRecord[]>([]);
  const [selectedChatId, setSelectedChatId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessageRecord[]>([]);
  const [projectPath, setProjectPath] = useState("");
  const [newChatName, setNewChatName] = useState("");
  const [composerText, setComposerText] = useState("");
  const [status, setStatus] = useState("Starting");
  const [error, setError] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [pendingApproval, setPendingApproval] =
    useState<PendingApproval | null>(null);

  const selectedProject = useMemo(
    () => projects.find((project) => project.id === selectedProjectId) ?? null,
    [projects, selectedProjectId],
  );
  const selectedChat = useMemo(
    () => chats.find((chat) => chat.id === selectedChatId) ?? null,
    [chats, selectedChatId],
  );

  useEffect(() => {
    void refreshProjects();
    void fetchJson("/api/auth")
      .then(() => setStatus("Ready"))
      .catch((err: Error) => setStatus(err.message));
  }, []);

  useEffect(() => {
    if (!selectedProjectId) {
      setChats([]);
      setSelectedChatId(null);
      return;
    }
    void refreshChats(selectedProjectId);
  }, [selectedProjectId]);

  useEffect(() => {
    if (!selectedChatId) {
      setMessages([]);
      setPendingApproval(null);
      return;
    }

    void refreshMessages(selectedChatId);
    void refreshSelectedChat(selectedChatId);

    const source = new EventSource(`/api/chats/${selectedChatId}/events`);
    const handleEvent = (event: MessageEvent<string>) => {
      const phantomEvent = JSON.parse(event.data) as PhantomEvent;
      if (phantomEvent.type === "agent.approval.requested") {
        const data = phantomEvent.data as PendingApproval;
        setPendingApproval(data);
      }
      if (phantomEvent.type === "agent.approval.resolved") {
        setPendingApproval(null);
      }
      void refreshMessages(selectedChatId);
      void refreshSelectedChat(selectedChatId);
      if (selectedProjectId) {
        void refreshChats(selectedProjectId);
      }
    };

    for (const eventName of chatEventNames) {
      source.addEventListener(eventName, handleEvent);
    }
    source.onerror = () => setStatus("Event stream disconnected");

    return () => {
      for (const eventName of chatEventNames) {
        source.removeEventListener(eventName, handleEvent);
      }
      source.close();
    };
  }, [selectedChatId, selectedProjectId]);

  async function refreshProjects() {
    const data = await fetchJson<{ projects: ProjectRecord[] }>(
      "/api/projects",
    );
    setProjects(data.projects);
    setSelectedProjectId((current) => current ?? data.projects[0]?.id ?? null);
  }

  async function refreshChats(projectId: string) {
    const data = await fetchJson<{ chats: ChatRecord[] }>(
      `/api/projects/${projectId}/chats`,
    );
    setChats(data.chats);
    setSelectedChatId((current) => current ?? data.chats[0]?.id ?? null);
  }

  async function refreshSelectedChat(chatId: string) {
    const data = await fetchJson<{ chat: ChatRecord }>(`/api/chats/${chatId}`);
    setChats((current) =>
      current.map((chat) => (chat.id === chatId ? data.chat : chat)),
    );
  }

  async function refreshMessages(chatId: string) {
    const data = await fetchJson<{ messages: ChatMessageRecord[] }>(
      `/api/chats/${chatId}/messages`,
    );
    setMessages(data.messages);
  }

  async function addProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setIsBusy(true);
    try {
      const data = await fetchJson<{ project: ProjectRecord }>(
        "/api/projects",
        {
          method: "POST",
          body: JSON.stringify({ path: projectPath }),
        },
      );
      setProjectPath("");
      await refreshProjects();
      setSelectedProjectId(data.project.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsBusy(false);
    }
  }

  async function createChat() {
    if (!selectedProjectId) {
      return;
    }
    setError(null);
    setIsBusy(true);
    try {
      const data = await fetchJson<{ chat: ChatRecord }>(
        `/api/projects/${selectedProjectId}/chats`,
        {
          method: "POST",
          body: JSON.stringify({ name: newChatName || undefined }),
        },
      );
      setNewChatName("");
      await refreshChats(selectedProjectId);
      setSelectedChatId(data.chat.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsBusy(false);
    }
  }

  async function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedChatId || !composerText.trim()) {
      return;
    }
    setError(null);
    const text = composerText;
    setComposerText("");
    try {
      await fetchJson(`/api/chats/${selectedChatId}/messages`, {
        method: "POST",
        body: JSON.stringify({ text }),
      });
      await refreshMessages(selectedChatId);
    } catch (err) {
      setComposerText(text);
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function interruptChat() {
    if (!selectedChatId) {
      return;
    }
    setError(null);
    try {
      await fetchJson(`/api/chats/${selectedChatId}/interrupt`, {
        method: "POST",
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function answerApproval(decision: string) {
    if (!selectedChatId || !pendingApproval) {
      return;
    }
    setError(null);
    try {
      await fetchJson(
        `/api/chats/${selectedChatId}/approvals/${pendingApproval.requestId}`,
        {
          method: "POST",
          body: JSON.stringify({ decision }),
        },
      );
      setPendingApproval(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <main className="grid h-screen min-h-0 grid-cols-[260px_300px_1fr] bg-slate-50 text-slate-950">
      <aside className="flex min-h-0 flex-col border-r border-slate-200 bg-white">
        <div className="flex h-12 items-center gap-2 border-b border-slate-200 px-3">
          <FolderGit2 className="size-4 text-slate-600" />
          <h1 className="text-sm font-semibold">Phantom</h1>
          <span className="ml-auto text-xs text-slate-500">{status}</span>
        </div>

        <form className="border-b border-slate-200 p-3" onSubmit={addProject}>
          <label className="text-xs font-medium text-slate-600">
            Project path
          </label>
          <div className="mt-2 flex gap-2">
            <input
              className="min-w-0 flex-1 rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm outline-none focus:border-slate-500"
              placeholder="/Users/me/project"
              value={projectPath}
              onChange={(event) => setProjectPath(event.target.value)}
            />
            <button
              className="inline-flex size-8 items-center justify-center rounded-md border border-slate-300 bg-white text-slate-700 hover:bg-slate-100 disabled:opacity-50"
              disabled={isBusy || !projectPath}
              title="Add project"
              type="submit"
            >
              {isBusy ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Plus className="size-4" />
              )}
            </button>
          </div>
        </form>

        <nav className="min-h-0 flex-1 overflow-y-auto p-2">
          {projects.length === 0 ? (
            <p className="px-2 py-3 text-sm text-slate-500">
              Add a Git project to begin.
            </p>
          ) : (
            projects.map((project) => (
              <button
                className={`mb-1 block w-full rounded-md px-2 py-2 text-left text-sm ${
                  project.id === selectedProjectId
                    ? "bg-slate-900 text-white"
                    : "text-slate-700 hover:bg-slate-100"
                }`}
                key={project.id}
                onClick={() => setSelectedProjectId(project.id)}
                type="button"
              >
                <span className="block truncate font-medium">
                  {project.name}
                </span>
                <span className="block truncate text-xs opacity-70">
                  {project.rootPath}
                </span>
              </button>
            ))
          )}
        </nav>
      </aside>

      <section className="flex min-h-0 flex-col border-r border-slate-200 bg-white">
        <div className="flex h-12 items-center border-b border-slate-200 px-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">
              {selectedProject?.name ?? "No project"}
            </p>
            <p className="truncate text-xs text-slate-500">
              {selectedProject?.rootPath ?? "Select or add a project"}
            </p>
          </div>
        </div>

        <div className="border-b border-slate-200 p-3">
          <label className="text-xs font-medium text-slate-600">New chat</label>
          <div className="mt-2 flex gap-2">
            <input
              className="min-w-0 flex-1 rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm outline-none focus:border-slate-500"
              placeholder="optional-name"
              value={newChatName}
              onChange={(event) => setNewChatName(event.target.value)}
            />
            <button
              className="inline-flex size-8 items-center justify-center rounded-md border border-slate-300 bg-white text-slate-700 hover:bg-slate-100 disabled:opacity-50"
              disabled={!selectedProjectId || isBusy}
              onClick={createChat}
              title="Create chat"
              type="button"
            >
              <MessageSquarePlus className="size-4" />
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {chats.map((chat) => (
            <button
              className={`mb-1 block w-full rounded-md px-2 py-2 text-left text-sm ${
                chat.id === selectedChatId
                  ? "bg-slate-900 text-white"
                  : "text-slate-700 hover:bg-slate-100"
              }`}
              key={chat.id}
              onClick={() => setSelectedChatId(chat.id)}
              type="button"
            >
              <span className="block truncate font-medium">{chat.title}</span>
              <span className="block truncate text-xs opacity-70">
                {chat.status} / {chat.branchName}
              </span>
            </button>
          ))}
        </div>
      </section>

      <section className="flex min-h-0 flex-col">
        <header className="flex h-12 items-center gap-3 border-b border-slate-200 bg-white px-4">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">
              {selectedChat?.title ?? "No chat selected"}
            </p>
            <p className="truncate text-xs text-slate-500">
              {selectedChat?.worktreePath ??
                "Create a chat to create a worktree"}
            </p>
          </div>
          <button
            className="inline-flex items-center gap-2 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-100 disabled:opacity-50"
            disabled={!selectedChat?.activeTurnId}
            onClick={interruptChat}
            type="button"
          >
            <Square className="size-3" />
            Stop
          </button>
        </header>

        {error && (
          <div className="border-b border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
            {error}
          </div>
        )}

        {pendingApproval && (
          <div className="border-b border-amber-200 bg-amber-50 px-4 py-3">
            <p className="text-sm font-medium text-amber-900">
              Approval requested
            </p>
            <p className="mt-1 text-xs text-amber-800">
              {pendingApproval.method}
            </p>
            <div className="mt-3 flex gap-2">
              <button
                className="rounded-md bg-slate-900 px-3 py-1.5 text-sm text-white"
                onClick={() => void answerApproval("accept")}
                type="button"
              >
                Accept
              </button>
              <button
                className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm"
                onClick={() => void answerApproval("acceptForSession")}
                type="button"
              >
                Accept for session
              </button>
              <button
                className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm"
                onClick={() => void answerApproval("decline")}
                type="button"
              >
                Decline
              </button>
            </div>
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {messages.length === 0 ? (
            <div className="flex h-full items-center justify-center text-sm text-slate-500">
              Send a message to start working with Codex.
            </div>
          ) : (
            <div className="mx-auto flex max-w-4xl flex-col gap-3">
              {messages.map((message) => (
                <article
                  className={`rounded-md border px-3 py-2 text-sm ${
                    message.role === "user"
                      ? "ml-auto max-w-[75%] border-slate-900 bg-slate-900 text-white"
                      : message.role === "assistant"
                        ? "mr-auto max-w-[80%] border-slate-200 bg-white"
                        : message.role === "error"
                          ? "border-red-200 bg-red-50 text-red-800"
                          : "border-slate-200 bg-slate-100 text-slate-600"
                  }`}
                  key={message.id}
                >
                  <pre className="whitespace-pre-wrap break-words font-sans">
                    {message.text}
                  </pre>
                </article>
              ))}
            </div>
          )}
        </div>

        <form
          className="border-t border-slate-200 bg-white p-3"
          onSubmit={sendMessage}
        >
          <div className="mx-auto flex max-w-4xl gap-2">
            <textarea
              className="min-h-11 flex-1 resize-none rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-500"
              disabled={!selectedChatId}
              placeholder={
                selectedChatId
                  ? "Ask Codex to work in this worktree"
                  : "Create a chat first"
              }
              rows={2}
              value={composerText}
              onChange={(event) => setComposerText(event.target.value)}
            />
            <button
              className="inline-flex h-11 w-11 items-center justify-center rounded-md bg-slate-900 text-white hover:bg-slate-700 disabled:opacity-50"
              disabled={!selectedChatId || !composerText.trim()}
              title="Send"
              type="submit"
            >
              <Send className="size-4" />
            </button>
          </div>
        </form>
      </section>
    </main>
  );
}

async function fetchJson<T = unknown>(
  input: RequestInfo | URL,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(input, {
    headers: {
      "Content-Type": "application/json",
      ...init.headers,
    },
    ...init,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const errorBody = data as { error?: { message?: string } };
    const message = errorBody.error?.message
      ? errorBody.error.message
      : `Request failed with status ${response.status}`;
    throw new Error(message);
  }
  return data as T;
}
