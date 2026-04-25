import { createFileRoute } from "@tanstack/react-router";
import {
  AlertTriangle,
  ChevronRight,
  Clock3,
  FolderGit2,
  GitBranch,
  Inbox,
  MessageSquare,
  MessageSquarePlus,
  Plus,
  Send,
  Square,
} from "lucide-react";
import type { ReactNode } from "react";
import {
  FormEvent,
  KeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
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
  ProjectWorktreeRecord,
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

function firstProjectWorktree(
  projectId: string | null,
  worktreesByProject: Record<string, ProjectWorktreeRecord[]>,
): ProjectWorktreeRecord | null {
  if (!projectId) {
    return null;
  }
  return worktreesByProject[projectId]?.[0] ?? null;
}

function formatLeadingEllipsisPath(path: string, maxLength = 44): string {
  if (path.length <= maxLength) {
    return path;
  }

  const suffixLength = maxLength - 3;
  const suffix = path.slice(-suffixLength);
  const slashIndex = suffix.indexOf("/");
  return `...${slashIndex > 0 ? suffix.slice(slashIndex) : suffix}`;
}

function dedupeChatThreads(chats: ChatRecord[]): ChatRecord[] {
  const chatsWithThreads = chats.filter((chat) => chat.codexThreadId);
  const source = chatsWithThreads.length > 0 ? chatsWithThreads : chats;
  const chatsByThread = new Map<string, ChatRecord>();

  for (const chat of source) {
    const key = chat.codexThreadId ?? chat.id;
    const current = chatsByThread.get(key);
    if (!current || chat.updatedAt.localeCompare(current.updatedAt) > 0) {
      chatsByThread.set(key, chat);
    }
  }

  return [...chatsByThread.values()].sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt),
  );
}

function Home() {
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(
    null,
  );
  const [chatsByProject, setChatsByProject] = useState<
    Record<string, ChatRecord[]>
  >({});
  const [worktreesByProject, setWorktreesByProject] = useState<
    Record<string, ProjectWorktreeRecord[]>
  >({});
  const [expandedProjectIds, setExpandedProjectIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [selectedWorktreePath, setSelectedWorktreePath] = useState<
    string | null
  >(null);
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
  const isChatRunning = Boolean(selectedChat?.activeTurnId);

  const selectedWorktree = useMemo(() => {
    if (!selectedProjectId || !selectedWorktreePath) {
      return null;
    }
    return (
      (worktreesByProject[selectedProjectId] ?? []).find(
        (worktree) => worktree.path === selectedWorktreePath,
      ) ?? null
    );
  }, [selectedProjectId, selectedWorktreePath, worktreesByProject]);

  const selectedWorktreeChats = useMemo(() => {
    if (!selectedProjectId || !selectedWorktree) {
      return [];
    }
    return dedupeChatThreads(
      (chatsByProject[selectedProjectId] ?? []).filter(
        (chat) => chat.worktreePath === selectedWorktree.path,
      ),
    );
  }, [chatsByProject, selectedProjectId, selectedWorktree]);

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
    void refreshChats(selectedProjectId, { sync: true });
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

  useEffect(() => {
    if (
      selectedWorktreeChats.length === 0 ||
      selectedWorktreeChats.some((chat) => chat.id === selectedChatId)
    ) {
      return;
    }
    setSelectedChatId(selectedWorktreeChats[0]?.id ?? null);
  }, [selectedChatId, selectedWorktreeChats]);

  async function refreshProjects() {
    const data = await fetchJson<{ projects: ProjectRecord[] }>(
      "/api/projects",
    );
    setProjects(data.projects);
    const projectDataEntries = await Promise.all(
      data.projects.map(
        async (project) =>
          [
            project.id,
            await loadProjectData(project.id, { sync: true }),
          ] as const,
      ),
    );
    const nextChatsByProject = Object.fromEntries(
      projectDataEntries.map(([projectId, projectData]) => [
        projectId,
        projectData.chats,
      ]),
    );
    const nextWorktreesByProject = Object.fromEntries(
      projectDataEntries.map(([projectId, projectData]) => [
        projectId,
        projectData.worktrees,
      ]),
    );
    setChatsByProject(nextChatsByProject);
    setWorktreesByProject(nextWorktreesByProject);
    const fallbackProjectId = selectedProjectId ?? data.projects[0]?.id ?? null;
    const fallbackWorktree = firstProjectWorktree(
      fallbackProjectId,
      nextWorktreesByProject,
    );
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
    setSelectedWorktreePath((current) => {
      if (
        fallbackProjectId &&
        current &&
        (nextWorktreesByProject[fallbackProjectId] ?? []).some(
          (worktree) => worktree.path === current,
        )
      ) {
        return current;
      }
      return fallbackWorktree?.path ?? null;
    });
    setSelectedChatId((current) =>
      Object.values(nextChatsByProject)
        .flat()
        .some((chat) => chat.id === current)
        ? current
        : (fallbackWorktree?.chatId ?? null),
    );
  }

  async function loadProjectData(
    projectId: string,
    options: { sync?: boolean } = {},
  ) {
    return await fetchJson<{
      chats: ChatRecord[];
      worktrees: ProjectWorktreeRecord[];
    }>(`/api/projects/${projectId}/chats${options.sync ? "?sync=1" : ""}`);
  }

  async function refreshChats(
    projectId: string,
    options: { sync?: boolean } = {},
  ) {
    const projectData = await loadProjectData(projectId, options);
    setChatsByProject((current) => ({
      ...current,
      [projectId]: projectData.chats,
    }));
    setWorktreesByProject((current) => ({
      ...current,
      [projectId]: projectData.worktrees,
    }));
    const fallbackWorktree = firstProjectWorktree(projectId, {
      ...worktreesByProject,
      [projectId]: projectData.worktrees,
    });
    setSelectedWorktreePath((current) =>
      current &&
      projectData.worktrees.some((worktree) => worktree.path === current)
        ? current
        : (fallbackWorktree?.path ?? null),
    );
    setSelectedChatId((current) =>
      projectData.chats.some((chat) => chat.id === current)
        ? current
        : (fallbackWorktree?.chatId ?? null),
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
    setWorktreesByProject((current) => ({
      ...current,
      [data.chat.projectId]: (current[data.chat.projectId] ?? []).map(
        (worktree) =>
          worktree.chatId === chatId
            ? {
                ...worktree,
                chatStatus: data.chat.status,
                chatTitle: data.chat.title,
              }
            : worktree,
      ),
    }));
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
      await refreshChats(projectId, { sync: true });
      setSelectedWorktreePath(data.chat.worktreePath);
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

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    const isImeComposing =
      event.nativeEvent.isComposing || event.keyCode === 229;
    if (
      event.key !== "Enter" ||
      event.shiftKey ||
      event.metaKey ||
      event.ctrlKey ||
      event.altKey ||
      isImeComposing
    ) {
      return;
    }
    if (!selectedChatId || !composerText.trim() || isChatRunning) {
      return;
    }
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
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

  function selectWorktree(projectId: string, worktree: ProjectWorktreeRecord) {
    setSelectedProjectId(projectId);
    setSelectedWorktreePath(worktree.path);
    setSelectedChatId(worktree.chatId);
    setExpandedProjectIds((current) => new Set(current).add(projectId));
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
                    const projectWorktrees =
                      worktreesByProject[project.id] ?? [];

                    return (
                      <SidebarMenuItem key={project.id}>
                        <div className="group/project flex items-center rounded-[var(--radius-sm)]">
                          <SidebarMenuButton
                            aria-expanded={isProjectExpanded}
                            className="min-h-8 flex-1 group-data-[state=collapsed]/sidebar:flex-none"
                            onClick={() => toggleProject(project.id)}
                            title={project.name}
                            type="button"
                          >
                            <ChevronRight
                              className={cn(
                                "size-4 shrink-0 text-[var(--icon-color-default)] transition-transform duration-[var(--motion-duration-fast)] group-data-[state=collapsed]/sidebar:hidden",
                                isProjectExpanded && "rotate-90",
                              )}
                            />
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
                            {projectWorktrees.length === 0 ? (
                              <li className="px-2 py-1.5 text-[length:var(--font-size-xs)] text-[var(--text-tertiary)]">
                                No worktrees
                              </li>
                            ) : (
                              projectWorktrees.map((worktree) => {
                                const title = `${worktree.name} (${worktree.path})${
                                  worktree.isClean ? "" : " [dirty]"
                                }`;
                                return (
                                  <SidebarMenuSubItem key={worktree.path}>
                                    <SidebarMenuSubButton
                                      disabled={!worktree.chatId}
                                      isActive={
                                        worktree.path === selectedWorktreePath
                                      }
                                      onClick={() =>
                                        selectWorktree(project.id, worktree)
                                      }
                                      title={title}
                                      type="button"
                                    >
                                      <GitBranch className="size-3.5 text-[var(--icon-color-default)]" />
                                      <span className="min-w-0 flex-1">
                                        <span className="block truncate font-medium">
                                          {worktree.name}
                                        </span>
                                      </span>
                                      {!worktree.isClean && (
                                        <span className="size-1.5 shrink-0 rounded-full bg-[var(--semantic-warning-fg)]" />
                                      )}
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
                {selectedWorktree?.name ?? selectedProject?.name ?? "Workspace"}
              </p>
              {selectedChat && <StatusBadge status={selectedChat.status} />}
            </div>
            <p className="flex min-w-0 text-[length:var(--font-size-xs)] text-muted-foreground">
              <span className="shrink-0">
                {selectedProject?.name ?? "No project selected"}
                {selectedWorktree ? " / " : ""}
              </span>
              {selectedWorktree && (
                <LeadingEllipsisText text={selectedWorktree.path} />
              )}
            </p>
          </div>
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

        {selectedWorktree && (
          <ChatHistoryBar
            chats={selectedWorktreeChats}
            selectedChatId={selectedChatId}
            onSelectChat={setSelectedChatId}
          />
        )}

        <section className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          {visibleMessages.length === 0 ? (
            <EmptyTimeline
              hasChat={Boolean(selectedChat)}
              hasWorktree={Boolean(selectedWorktree)}
              selectedProject={selectedProject}
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
                onKeyDown={handleComposerKeyDown}
              />
            </div>
            <Button
              aria-label={isChatRunning ? "Stop turn" : "Send message"}
              className="size-10"
              disabled={
                isChatRunning
                  ? !selectedChat?.activeTurnId
                  : !selectedChatId || !composerText.trim()
              }
              onClick={isChatRunning ? interruptChat : undefined}
              size="icon"
              title={isChatRunning ? "Stop turn" : "Send"}
              type={isChatRunning ? "button" : "submit"}
              variant={isChatRunning ? "destructive" : "default"}
            >
              {isChatRunning ? <Square /> : <Send />}
            </Button>
          </div>
        </form>
      </SidebarInset>
    </SidebarProvider>
  );
}

function ChatHistoryBar({
  chats,
  onSelectChat,
  selectedChatId,
}: {
  chats: ChatRecord[];
  onSelectChat: (chatId: string) => void;
  selectedChatId: string | null;
}) {
  return (
    <div className="border-b border-border bg-[var(--surface-panel)] px-4 py-2">
      <div className="mx-auto flex max-w-[var(--layout-max-content-width)] items-center gap-2">
        <div className="shrink-0 text-[length:var(--font-size-xs)] font-medium text-[var(--text-secondary)]">
          Chat history
        </div>
        <div
          aria-label="Chat history"
          className="flex min-w-0 flex-1 gap-1 overflow-x-auto"
          role="tablist"
        >
          {chats.length === 0 ? (
            <span className="px-2 py-1 text-[length:var(--font-size-xs)] text-[var(--text-tertiary)]">
              No chat history
            </span>
          ) : (
            chats.map((chat) => {
              const isSelected = chat.id === selectedChatId;
              return (
                <button
                  aria-selected={isSelected}
                  className={cn(
                    "inline-flex max-w-44 shrink-0 items-center gap-1.5 rounded-[var(--radius-sm)] px-2 py-1 text-[length:var(--font-size-xs)] outline-none transition-colors hover:bg-sidebar-accent focus-visible:shadow-[var(--state-focus-ring)]",
                    isSelected
                      ? "bg-sidebar-accent text-sidebar-accent-foreground"
                      : "text-[var(--text-secondary)]",
                  )}
                  key={chat.id}
                  onClick={() => onSelectChat(chat.id)}
                  role="tab"
                  title={chat.title}
                  type="button"
                >
                  <MessageSquare className="size-3.5 shrink-0" />
                  <span className="truncate">{chat.title}</span>
                </button>
              );
            })
          )}
        </div>
      </div>
    </div>
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

function LeadingEllipsisText({ text }: { text: string }) {
  return (
    <span className="block min-w-0 truncate" title={text}>
      {formatLeadingEllipsisPath(text)}
    </span>
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
  hasWorktree,
  onOpenProjectDialog,
  selectedProject,
}: {
  hasChat: boolean;
  hasWorktree: boolean;
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
            {hasChat
              ? "No messages yet"
              : hasWorktree
                ? "Select chat history"
                : "Select a worktree"}
          </h2>
          <p className="mt-1 text-[length:var(--font-size-md)] text-muted-foreground">
            {hasChat
              ? "Send a message to start a focused Codex session."
              : hasWorktree
                ? "Choose a chat history for this worktree."
                : "Create a worktree under a project to begin a Codex session."}
          </p>
        </div>
        {!selectedProject && (
          <div className="flex justify-center gap-2">
            <Button onClick={onOpenProjectDialog} type="button">
              <Plus className="size-4" />
              Add project
            </Button>
          </div>
        )}
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
