export const fallbackReasoningEfforts = ["low", "medium", "high", "xhigh"];

const percentEncodedPathMarkerPattern = /%(?:2f|3a|5c|7e)/i;
const windowsDrivePathPrefixPattern = /^[A-Za-z]:/;

interface ChatSelectionRecord {
  id: string;
  projectId: string;
}

interface ModelReasoningEffortRecord {
  supportedReasoningEfforts: string[];
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

export function getSelectableReasoningEfforts(
  selectedModel: ModelReasoningEffortRecord | null,
): string[] {
  return selectedModel
    ? selectedModel.supportedReasoningEfforts
    : fallbackReasoningEfforts;
}
