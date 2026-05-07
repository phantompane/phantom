export const fallbackReasoningEfforts = ["low", "medium", "high", "xhigh"];

const percentEncodedPathMarkerPattern = /%(?:2f|3a|5c|7e)/i;
const windowsDrivePathPrefixPattern = /^[A-Za-z]:/;

interface ChatSelectionRecord {
  id: string;
  projectId: string;
}

interface ProjectSelectionRecord {
  id: string;
}

interface ModelReasoningEffortRecord {
  supportedReasoningEfforts: string[];
}

interface ModelSpeedTierRecord {
  additionalSpeedTiers: string[];
}

interface SkillSelectionRecord {
  enabled: boolean;
  name: string;
  path: string;
}

interface WorktreeChatMergeRecord<TStatus extends string> {
  id: string;
  status: TStatus;
  title: string;
  updatedAt: string;
  worktreePath: string;
}

interface ChatThreadDedupeRecord<TStatus extends string> {
  codexThreadId: string | null;
  id: string;
  status: TStatus;
  updatedAt: string;
}

interface WorktreeMergeRecord<TStatus extends string> {
  chatId: string | null;
  chatStatus: TStatus | null;
  chatTitle: string;
  name: string;
  path: string;
}

interface WorktreeSelectionRecord {
  chatId: string | null;
}

export function isShareableFileSearchQuery(value: string): boolean {
  let query = value.trim();
  if (!query) {
    return false;
  }

  for (let index = 0; index < 8; index += 1) {
    if (
      percentEncodedPathMarkerPattern.test(query) ||
      query.includes("/") ||
      query.includes("\\") ||
      query.startsWith("~") ||
      windowsDrivePathPrefixPattern.test(query)
    ) {
      return false;
    }

    try {
      const decodedQuery = decodeURIComponent(query);
      if (decodedQuery === query) {
        return true;
      }
      query = decodedQuery;
    } catch {
      return false;
    }
  }

  return false;
}

export function findValidatedSelectedChat<TChat extends ChatSelectionRecord>(
  chats: TChat[],
  selectedChatId: string | null,
  requestedProjectId: string | null,
): TChat | null {
  if (!selectedChatId) {
    return null;
  }

  const selectedChat = chats.find((chat) => chat.id === selectedChatId) ?? null;
  if (
    selectedChat &&
    (!requestedProjectId || selectedChat.projectId === requestedProjectId)
  ) {
    return selectedChat;
  }

  return null;
}

export function findValidatedSelectedProjectChat<
  TChat extends ChatSelectionRecord,
  TProject extends ProjectSelectionRecord,
>(
  chatsByProject: Record<string, TChat[]>,
  projects: TProject[],
  selectedChatId: string | null,
  requestedProjectId: string | null,
): TChat | null {
  const projectIds = new Set(projects.map((project) => project.id));
  return findValidatedSelectedChat(
    Object.values(chatsByProject)
      .flat()
      .filter((chat) => projectIds.has(chat.projectId)),
    selectedChatId,
    requestedProjectId,
  );
}

export function retainRecordsForProjects<TRecord>(
  recordsByProject: Record<string, TRecord[]>,
  projectIds: ReadonlySet<string>,
): Record<string, TRecord[]> {
  return Object.fromEntries(
    Object.entries(recordsByProject).filter(([projectId]) =>
      projectIds.has(projectId),
    ),
  );
}

export function mergeWorktreesWithChats<
  TStatus extends string,
  TWorktree extends WorktreeMergeRecord<TStatus>,
  TChat extends WorktreeChatMergeRecord<TStatus>,
>(worktrees: TWorktree[], chats: TChat[]): TWorktree[] {
  const latestChatsByPath = new Map<string, TChat>();
  for (const chat of chats) {
    if (chat.status === "archived") {
      continue;
    }

    const current = latestChatsByPath.get(chat.worktreePath);
    if (!current || chat.updatedAt.localeCompare(current.updatedAt) > 0) {
      latestChatsByPath.set(chat.worktreePath, chat);
    }
  }
  return worktrees.map((worktree) => {
    const chat = latestChatsByPath.get(worktree.path);
    if (!chat) {
      return {
        ...worktree,
        chatId: null,
        chatStatus: null,
        chatTitle: worktree.name,
      };
    }
    return {
      ...worktree,
      chatId: chat.id,
      chatStatus: chat.status,
      chatTitle: chat.title,
    };
  });
}

export function dedupeChatThreads<
  TStatus extends string,
  TChat extends ChatThreadDedupeRecord<TStatus>,
>(chats: TChat[]): TChat[] {
  const chatsWithThreads = chats.filter((chat) => chat.codexThreadId);
  const source = chatsWithThreads.length > 0 ? chatsWithThreads : chats;
  const chatsByThread = new Map<string, TChat>();

  for (const chat of source) {
    const key = chat.codexThreadId ?? chat.id;
    const current = chatsByThread.get(key);
    if (
      !current ||
      (current.status === "archived" && chat.status !== "archived") ||
      (current.status === chat.status &&
        chat.updatedAt.localeCompare(current.updatedAt) > 0) ||
      (current.status !== "archived" &&
        chat.status !== "archived" &&
        chat.updatedAt.localeCompare(current.updatedAt) > 0)
    ) {
      chatsByThread.set(key, chat);
    }
  }

  return [...chatsByThread.values()].sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt),
  );
}

export function isKnownWorktreeChat<TWorktree extends WorktreeSelectionRecord>(
  worktrees: TWorktree[],
  selectedChatId: string | null,
): boolean {
  return Boolean(
    selectedChatId &&
    worktrees.some((worktree) => worktree.chatId === selectedChatId),
  );
}

export function resolveRefreshedWorktreeChatId<
  TChat extends Pick<ChatSelectionRecord, "id">,
  TWorktree extends WorktreeSelectionRecord,
>(
  chats: TChat[] | undefined,
  worktrees: TWorktree[],
  selectedChatId: string | null,
  fallbackChatId: string | null,
): string | null {
  if (!selectedChatId) {
    return null;
  }

  if (!chats) {
    return selectedChatId;
  }

  if (
    chats.some((chat) => chat.id === selectedChatId) ||
    isKnownWorktreeChat(worktrees, selectedChatId)
  ) {
    return selectedChatId;
  }

  return fallbackChatId ?? selectedChatId;
}

export function getSelectableReasoningEfforts(
  selectedModel: ModelReasoningEffortRecord | null,
): string[] {
  return selectedModel
    ? selectedModel.supportedReasoningEfforts
    : fallbackReasoningEfforts;
}

export function modelSupportsFastMode(
  selectedModel: ModelSpeedTierRecord | null,
): boolean {
  return Boolean(selectedModel?.additionalSpeedTiers.includes("fast"));
}

export function getSelectedServiceTierForTurn(
  selectedModel: ModelSpeedTierRecord | null,
  selectedServiceTier: string | null,
  restoredPendingServiceTier: "fast" | "flex" | null,
): "fast" | null {
  if (!selectedModel) {
    return restoredPendingServiceTier === "fast" ? "fast" : null;
  }
  return selectedServiceTier === "fast" && modelSupportsFastMode(selectedModel)
    ? "fast"
    : null;
}

export function getSelectedSkillContextItems<
  TSkill extends SkillSelectionRecord,
>(
  skills: TSkill[],
  selectedSkillPaths: ReadonlySet<string>,
): Array<{ name: string; path: string }> {
  return skills
    .filter((skill) => skill.enabled && selectedSkillPaths.has(skill.path))
    .map((skill) => ({
      name: skill.name,
      path: skill.path,
    }));
}
