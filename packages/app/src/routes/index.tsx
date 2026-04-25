import { createFileRoute } from "@tanstack/react-router";
import {
  AlertTriangle,
  ChevronRight,
  Clock3,
  FolderGit2,
  Inbox,
  MessageSquare,
  MessageSquarePlus,
  Plus,
  Send,
  Square,
} from "lucide-react";
import type { ReactNode } from "react";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupHeader,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
} from "../components/ui/sidebar";
import { Textarea } from "../components/ui/textarea";
import { cn } from "../lib/utils";
import type {
  ChatMessageRecord,
  ChatRecord,
  ChatStatus,
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

const statusMeta: Record<
  ChatStatus,
  {
    badge: "danger" | "info" | "secondary" | "success" | "warning";
    dot: string;
    label: string;
  }
> = {
  archived: {
    badge: "secondary",
    dot: "bg-[var(--color-gray-400)]",
    label: "Archived",
  },
  failed: {
    badge: "danger",
    dot: "bg-[var(--semantic-danger-fg)]",
    label: "Failed",
  },
  idle: {
    badge: "secondary",
    dot: "bg-[var(--color-gray-500)]",
    label: "Idle",
  },
  running: {
    badge: "info",
    dot: "bg-[var(--semantic-info-fg)]",
    label: "Running",
  },
  waitingForApproval: {
    badge: "warning",
    dot: "bg-[var(--semantic-warning-fg)]",
    label: "Approval",
  },
};

interface PendingApproval {
  requestId: string;
  method: string;
  params: unknown;
}

type VisibleMessageRecord = ChatMessageRecord & {
  role: "assistant" | "error" | "user";
};

function Home() {
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(
    null,
  );
  const [chatsByProject, setChatsByProject] = useState<
    Record<string, ChatRecord[]>
  >({});
  const [expandedProjectIds, setExpandedProjectIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [selectedChatId, setSelectedChatId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessageRecord[]>([]);
  const [isAddProjectOpen, setIsAddProjectOpen] = useState(false);
  const [projectPath, setProjectPath] = useState("");
  const [composerText, setComposerText] = useState("");
  const [status, setStatus] = useState("Starting");
  const [error, setError] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const createChatInFlightRef = useRef(false);
  const [pendingApproval, setPendingApproval] =
    useState<PendingApproval | null>(null);

  const selectedProject = useMemo(
    () => projects.find((project) => project.id === selectedProjectId) ?? null,
    [projects, selectedProjectId],
  );

  const selectedChat = useMemo(
    () =>
      Object.values(chatsByProject)
        .flat()
        .find((chat) => chat.id === selectedChatId) ?? null,
    [chatsByProject, selectedChatId],
  );

  const visibleMessages = useMemo(
    () =>
      messages.filter(
        (message): message is VisibleMessageRecord => message.role !== "event",
      ),
    [messages],
  );

  useEffect(() => {
    void refreshProjects();
    void fetchJson("/api/auth")
      .then(() => setStatus("Ready"))
      .catch((err: Error) => setStatus(err.message));
  }, []);

  useEffect(() => {
    if (!selectedProjectId) {
      setSelectedChatId(null);
      return;
    }
    setExpandedProjectIds((current) => {
      const next = new Set(current);
      next.add(selectedProjectId);
      return next;
    });
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
    const chatEntries = await Promise.all(
      data.projects.map(
        async (project) => [project.id, await loadChats(project.id)] as const,
      ),
    );
    const nextChatsByProject = Object.fromEntries(chatEntries);
    setChatsByProject(nextChatsByProject);
    setSelectedProjectId((current) => {
      const nextProjectId = current ?? data.projects[0]?.id ?? null;
      if (nextProjectId) {
        setExpandedProjectIds((expanded) => {
          const next = new Set(expanded);
          next.add(nextProjectId);
          return next;
        });
      }
      return nextProjectId;
    });
    setSelectedChatId((current) =>
      Object.values(nextChatsByProject)
        .flat()
        .some((chat) => chat.id === current)
        ? current
        : null,
    );
  }

  async function loadChats(projectId: string) {
    const data = await fetchJson<{ chats: ChatRecord[] }>(
      `/api/projects/${projectId}/chats`,
    );
    return data.chats;
  }

  async function refreshChats(projectId: string) {
    const nextChats = await loadChats(projectId);
    setChatsByProject((current) => ({
      ...current,
      [projectId]: nextChats,
    }));
    setSelectedChatId((current) =>
      nextChats.some((chat) => chat.id === current)
        ? current
        : (nextChats[0]?.id ?? null),
    );
  }

  async function refreshSelectedChat(chatId: string) {
    const data = await fetchJson<{ chat: ChatRecord }>(`/api/chats/${chatId}`);
    setChatsByProject((current) => {
      const projectChats = current[data.chat.projectId] ?? [];
      return {
        ...current,
        [data.chat.projectId]: projectChats.map((chat) =>
          chat.id === chatId ? data.chat : chat,
        ),
      };
    });
  }

  async function refreshMessages(chatId: string) {
    const data = await fetchJson<{ messages: ChatMessageRecord[] }>(
      `/api/chats/${chatId}/messages`,
    );
    setMessages(data.messages);
  }

  async function addProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedProjectPath = projectPath.trim();
    if (!trimmedProjectPath) {
      return;
    }

    setError(null);
    setIsBusy(true);
    try {
      const data = await fetchJson<{ project: ProjectRecord }>(
        "/api/projects",
        {
          method: "POST",
          body: JSON.stringify({ path: trimmedProjectPath }),
        },
      );
      setProjectPath("");
      setIsAddProjectOpen(false);
      await refreshProjects();
      setSelectedProjectId(data.project.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsBusy(false);
    }
  }

  async function createChat(projectId: string) {
    if (isBusy || createChatInFlightRef.current) {
      return;
    }

    setError(null);
    createChatInFlightRef.current = true;
    setIsBusy(true);
    try {
      const data = await fetchJson<{ chat: ChatRecord }>(
        `/api/projects/${projectId}/chats`,
        {
          method: "POST",
          body: JSON.stringify({}),
        },
      );
      setSelectedProjectId(projectId);
      setExpandedProjectIds((current) => new Set(current).add(projectId));
      await refreshChats(projectId);
      setSelectedChatId(data.chat.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      createChatInFlightRef.current = false;
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
      const chatPath = encodeURIComponent(selectedChatId);
      const requestPath = encodeURIComponent(pendingApproval.requestId);
      await fetchJson(`/api/chats/${chatPath}/approvals/${requestPath}`, {
        method: "POST",
        body: JSON.stringify({ decision }),
      });
      setPendingApproval(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function toggleProject(projectId: string) {
    setExpandedProjectIds((current) => {
      const next = new Set(current);
      if (next.has(projectId)) {
        next.delete(projectId);
      } else {
        next.add(projectId);
      }
      return next;
    });
  }

  function selectProject(projectId: string) {
    setSelectedProjectId(projectId);
    setExpandedProjectIds((current) => new Set(current).add(projectId));
    const projectChats = chatsByProject[projectId] ?? [];
    setSelectedChatId((current) =>
      projectChats.some((chat) => chat.id === current)
        ? current
        : (projectChats[0]?.id ?? null),
    );
  }

  function selectChat(chat: ChatRecord) {
    setSelectedProjectId(chat.projectId);
    setSelectedChatId(chat.id);
    setExpandedProjectIds((current) => new Set(current).add(chat.projectId));
  }

  return (
    <SidebarProvider className="h-screen min-h-0">
      <Sidebar collapsible="offcanvas" variant="inset">
        <SidebarHeader>
          <div className="flex size-8 shrink-0 items-center justify-center rounded-[var(--radius-sm)] bg-[var(--color-gray-900)] text-primary-foreground">
            <FolderGit2 className="size-4" />
          </div>
          <div className="min-w-0 flex-1 group-data-[state=collapsed]/sidebar:hidden">
            <h1 className="truncate text-[length:var(--font-size-lg)] font-semibold leading-tight">
              Phantom
            </h1>
          </div>
          <Badge
            className="max-w-24 truncate group-data-[state=collapsed]/sidebar:hidden"
            variant={status === "Ready" ? "success" : "warning"}
          >
            {status}
          </Badge>
        </SidebarHeader>

        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupHeader>
              <SidebarGroupLabel>Projects</SidebarGroupLabel>
              <SidebarGroupAction
                aria-label="Add project"
                onClick={() => setIsAddProjectOpen(true)}
                title="Add project"
              >
                <Plus className="size-4" />
              </SidebarGroupAction>
            </SidebarGroupHeader>
            <SidebarGroupContent>
              <SidebarMenu>
                {projects.length === 0 ? (
                  <li className="px-2 py-4 group-data-[state=collapsed]/sidebar:hidden">
                    <div className="rounded-[var(--radius-md)] border border-dashed border-sidebar-border bg-[var(--surface-card)] px-3 py-3 text-[length:var(--font-size-sm)] text-muted-foreground">
                      Add a Git project to begin.
                    </div>
                  </li>
                ) : (
                  projects.map((project) => {
                    const isProjectExpanded = expandedProjectIds.has(
                      project.id,
                    );
                    const isProjectSelected = project.id === selectedProjectId;
                    const projectChats = chatsByProject[project.id] ?? [];

                    return (
                      <SidebarMenuItem key={project.id}>
                        <div
                          className={cn(
                            "group/project flex items-center rounded-[var(--radius-sm)]",
                            isProjectSelected && "bg-sidebar-accent",
                          )}
                        >
                          <Button
                            aria-label={
                              isProjectExpanded
                                ? "Collapse project"
                                : "Expand project"
                            }
                            className="ml-1 size-7 text-[var(--icon-color-default)] group-data-[state=collapsed]/sidebar:hidden"
                            onClick={() => toggleProject(project.id)}
                            size="icon"
                            type="button"
                            variant="ghost"
                          >
                            <ChevronRight
                              className={cn(
                                "transition-transform duration-[var(--motion-duration-fast)]",
                                isProjectExpanded && "rotate-90",
                              )}
                            />
                          </Button>
                          <SidebarMenuButton
                            className="min-h-8 flex-1 group-data-[state=collapsed]/sidebar:flex-none"
                            isActive={isProjectSelected}
                            onClick={() => selectProject(project.id)}
                            title={project.name}
                            type="button"
                          >
                            <FolderGit2 className="size-4 text-[var(--icon-color-default)]" />
                            <span className="min-w-0 flex-1 group-data-[state=collapsed]/sidebar:hidden">
                              <span className="block truncate font-medium">
                                {project.name}
                              </span>
                            </span>
                          </SidebarMenuButton>
                          <Button
                            aria-label={`Create worktree in ${project.name}`}
                            className="mr-1 size-7 text-[var(--icon-color-default)] group-data-[state=collapsed]/sidebar:hidden"
                            disabled={isBusy}
                            onClick={() => void createChat(project.id)}
                            size="icon"
                            title="Create worktree"
                            type="button"
                            variant="ghost"
                          >
                            <MessageSquarePlus className="size-4" />
                          </Button>
                        </div>
                        {isProjectExpanded && (
                          <SidebarMenuSub>
                            {projectChats.length === 0 ? (
                              <li className="px-2 py-1.5 text-[length:var(--font-size-xs)] text-[var(--text-tertiary)]">
                                No worktrees
                              </li>
                            ) : (
                              projectChats.map((chat) => {
                                return (
                                  <SidebarMenuSubItem key={chat.id}>
                                    <SidebarMenuSubButton
                                      isActive={chat.id === selectedChatId}
                                      onClick={() => selectChat(chat)}
                                      title={chat.title}
                                      type="button"
                                    >
                                      <MessageSquare className="size-3.5 text-[var(--icon-color-default)]" />
                                      <span className="min-w-0 flex-1">
                                        <span className="block truncate font-medium">
                                          {chat.title}
                                        </span>
                                      </span>
                                    </SidebarMenuSubButton>
                                  </SidebarMenuSubItem>
                                );
                              })
                            )}
                          </SidebarMenuSub>
                        )}
                      </SidebarMenuItem>
                    );
                  })
                )}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>

        <SidebarRail />
      </Sidebar>

      <Dialog open={isAddProjectOpen} onOpenChange={setIsAddProjectOpen}>
        <DialogContent aria-labelledby="add-project-title">
          <DialogHeader>
            <DialogTitle id="add-project-title">Add project</DialogTitle>
            <DialogDescription>
              Add a local Git project to the Phantom sidebar.
            </DialogDescription>
          </DialogHeader>
          <form className="grid gap-4" onSubmit={addProject}>
            <div className="grid gap-2">
              <Label htmlFor="project-path">Project path</Label>
              <Input
                id="project-path"
                placeholder="/Users/me/project"
                value={projectPath}
                onChange={(event) => setProjectPath(event.target.value)}
              />
            </div>
            <DialogFooter>
              <Button
                onClick={() => setIsAddProjectOpen(false)}
                type="button"
                variant="outline"
              >
                Cancel
              </Button>
              <Button disabled={isBusy || !projectPath.trim()} type="submit">
                Add project
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <SidebarInset>
        <header className="flex min-h-[var(--layout-topbar-height)] items-center gap-3 border-b border-border bg-[var(--surface-panel)] px-4">
          <SidebarTrigger className="-ml-1" />
          <div className="h-5 w-px bg-[var(--border-divider)]" />
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2">
              <p className="truncate text-[length:var(--font-size-xl)] font-semibold leading-tight">
                {selectedChat?.title ?? "Workspace"}
              </p>
              {selectedChat && <StatusBadge status={selectedChat.status} />}
            </div>
            <p className="truncate text-[length:var(--font-size-xs)] text-muted-foreground">
              {selectedProject?.name ?? "No project selected"}
              {selectedChat ? ` / ${selectedChat.branchName}` : ""}
            </p>
          </div>
          <Button
            disabled={!selectedChat?.activeTurnId}
            onClick={interruptChat}
            size="sm"
            type="button"
            variant="outline"
          >
            <Square className="size-3" />
            Stop
          </Button>
        </header>

        {error && (
          <SystemBanner tone="danger">
            <AlertTriangle className="size-4" />
            <span>{error}</span>
          </SystemBanner>
        )}

        {pendingApproval && (
          <div className="border-b border-[var(--semantic-warning-border)] bg-[var(--semantic-warning-bg)] px-4 py-3 text-[var(--semantic-warning-fg)]">
            <div className="mx-auto flex max-w-[var(--layout-max-content-width)] flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <p className="flex items-center gap-2 text-[length:var(--font-size-md)] font-semibold">
                  <Clock3 className="size-4" />
                  Approval requested
                </p>
                <p className="mt-1 truncate font-mono text-[length:var(--font-size-xs)]">
                  {pendingApproval.method}
                </p>
              </div>
              <div className="flex shrink-0 flex-wrap gap-2">
                <Button
                  onClick={() => void answerApproval("accept")}
                  size="sm"
                  type="button"
                >
                  Accept
                </Button>
                <Button
                  onClick={() => void answerApproval("acceptForSession")}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  Accept for session
                </Button>
                <Button
                  onClick={() => void answerApproval("decline")}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  Decline
                </Button>
              </div>
            </div>
          </div>
        )}

        <section className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          {visibleMessages.length === 0 ? (
            <EmptyTimeline
              hasChat={Boolean(selectedChat)}
              isBusy={isBusy}
              selectedProject={selectedProject}
              onCreateChat={
                selectedProject
                  ? () => void createChat(selectedProject.id)
                  : undefined
              }
              onOpenProjectDialog={() => setIsAddProjectOpen(true)}
            />
          ) : (
            <div className="mx-auto flex max-w-[var(--layout-max-content-width)] flex-col gap-2">
              {visibleMessages.map((message) => (
                <MessageCard key={message.id} message={message} />
              ))}
            </div>
          )}
        </section>

        <form
          className="border-t border-border bg-[var(--surface-floating)] p-3 backdrop-blur"
          onSubmit={sendMessage}
        >
          <div className="mx-auto flex max-w-[var(--layout-max-content-width)] items-end gap-2 border border-transparent border-t-[var(--border-divider)] bg-transparent p-1">
            <div className="min-w-0 flex-1">
              <Label className="sr-only" htmlFor="composer">
                Message
              </Label>
              <Textarea
                className="min-h-12 border-0 bg-transparent px-2 py-2 shadow-none focus-visible:shadow-none"
                disabled={!selectedChatId}
                id="composer"
                placeholder={
                  selectedChatId
                    ? "Ask Codex to work in this worktree"
                    : "Create or select a worktree to start"
                }
                rows={2}
                value={composerText}
                onChange={(event) => setComposerText(event.target.value)}
              />
            </div>
            <Button
              aria-label="Send message"
              className="size-10"
              disabled={!selectedChatId || !composerText.trim()}
              size="icon"
              title="Send"
              type="submit"
            >
              <Send />
            </Button>
          </div>
        </form>
      </SidebarInset>
    </SidebarProvider>
  );
}

function StatusBadge({ status }: { status: ChatStatus }) {
  const meta = statusMeta[status];
  return (
    <Badge variant={meta.badge}>
      <span className={cn("size-1.5 rounded-full", meta.dot)} />
      {meta.label}
    </Badge>
  );
}

function SystemBanner({
  children,
  tone,
}: {
  children: ReactNode;
  tone: "danger" | "info";
}) {
  const toneClass =
    tone === "danger"
      ? "border-[var(--semantic-danger-border)] bg-[var(--semantic-danger-bg)] text-[var(--semantic-danger-fg)]"
      : "border-[var(--semantic-info-border)] bg-[var(--semantic-info-bg)] text-[var(--semantic-info-fg)]";

  return (
    <div
      className={cn(
        "border-b px-4 py-2 text-[length:var(--font-size-sm)]",
        toneClass,
      )}
      role="status"
    >
      <div className="mx-auto flex max-w-[var(--layout-max-content-width)] items-center gap-2">
        {children}
      </div>
    </div>
  );
}

function EmptyTimeline({
  hasChat,
  isBusy,
  onCreateChat,
  onOpenProjectDialog,
  selectedProject,
}: {
  hasChat: boolean;
  isBusy: boolean;
  onCreateChat?: () => void;
  onOpenProjectDialog: () => void;
  selectedProject: ProjectRecord | null;
}) {
  return (
    <div className="mx-auto flex h-full max-w-[var(--layout-max-content-width)] items-center justify-center py-8">
      <section className="grid w-full max-w-xl gap-4 px-5 py-6 text-center">
        <div className="mx-auto flex size-10 items-center justify-center rounded-[var(--radius-md)] bg-[var(--surface-code)] text-[var(--icon-color-default)]">
          <Inbox className="size-5" />
        </div>
        <div>
          <h2 className="text-[length:var(--font-size-xl)] font-semibold">
            {hasChat ? "No messages yet" : "Select a worktree"}
          </h2>
          <p className="mt-1 text-[length:var(--font-size-md)] text-muted-foreground">
            {hasChat
              ? "Send a message to start a focused Codex session."
              : "Create a worktree under a project to begin a Codex session."}
          </p>
        </div>
        <div className="flex justify-center gap-2">
          {selectedProject ? (
            <Button disabled={isBusy} onClick={onCreateChat} type="button">
              <MessageSquarePlus className="size-4" />
              Create worktree
            </Button>
          ) : (
            <Button onClick={onOpenProjectDialog} type="button">
              <Plus className="size-4" />
              Add project
            </Button>
          )}
        </div>
      </section>
    </div>
  );
}

function MessageCard({ message }: { message: VisibleMessageRecord }) {
  const isUser = message.role === "user";
  const isError = message.role === "error";

  return (
    <article
      className={cn(
        "rounded-[var(--radius-lg)] border px-4 py-3 shadow-[var(--shadow-xs)]",
        isUser &&
          "ml-auto max-w-[78%] border-transparent bg-[var(--color-gray-900)] text-primary-foreground",
        message.role === "assistant" &&
          "mr-auto max-w-[82%] border-border bg-card text-card-foreground",
        isError &&
          "border-[var(--semantic-danger-border)] bg-[var(--semantic-danger-bg)] text-[var(--semantic-danger-fg)]",
      )}
    >
      <pre className="whitespace-pre-wrap break-words font-sans text-[length:var(--font-size-md)] leading-[var(--line-height-relaxed)]">
        {message.text}
      </pre>
    </article>
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
