import { queryOptions } from "@tanstack/react-query";
import { api, readRpcJson, routeParam } from "./client";
import { queryKeys } from "./query-keys";
import type {
  ChatRecord,
  CodexFileRecord,
  CodexModelRecord,
  CodexSkillRecord,
  GitHubCheckoutTargetsResult,
  PendingApprovalRecord,
  ProjectRecord,
  ProjectWorktreeRecord,
  RecentProjectSkillRecord,
  RenderedChatMessageRecord,
} from "@phantompane/server";

export function authQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.auth,
    queryFn: async () => readRpcJson<{ auth: unknown }>(await api.auth.$get()),
  });
}

export function projectsQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.projects,
    queryFn: async () =>
      readRpcJson<{ projects: ProjectRecord[] }>(await api.projects.$get()),
  });
}

export function modelsQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.models,
    queryFn: async () =>
      readRpcJson<{ models: CodexModelRecord[] }>(await api.models.$get()),
  });
}

export function projectWorktreesQueryOptions(projectId: string) {
  return queryOptions({
    queryKey: queryKeys.projectWorktrees(projectId),
    queryFn: async () =>
      readRpcJson<{ worktrees: ProjectWorktreeRecord[] }>(
        await api.projects[":projectId"].worktrees.$get({
          param: { projectId: routeParam(projectId) },
        }),
      ),
  });
}

export function projectChatsQueryOptions(projectId: string) {
  return queryOptions({
    queryKey: queryKeys.projectChats(projectId),
    queryFn: async () =>
      readRpcJson<{ chats: ChatRecord[] }>(
        await api.projects[":projectId"].chats.$get({
          param: { projectId: routeParam(projectId) },
        }),
      ),
  });
}

export function projectGitHubCheckoutTargetsQueryOptions(projectId: string) {
  return queryOptions({
    queryKey: queryKeys.projectGitHubCheckoutTargets(projectId),
    queryFn: async () =>
      readRpcJson<{ github: GitHubCheckoutTargetsResult }>(
        await api.projects[":projectId"].github["checkout-targets"].$get({
          param: { projectId: routeParam(projectId) },
        }),
      ),
  });
}

export function projectRecentSkillsQueryOptions(
  projectId: string,
  signal?: AbortSignal,
) {
  return queryOptions({
    queryKey: queryKeys.projectRecentSkills(projectId),
    queryFn: async () =>
      readRpcJson<{ recentSkills: RecentProjectSkillRecord[] }>(
        await api.projects[":projectId"]["recent-skills"].$get(
          {
            param: { projectId: routeParam(projectId) },
          },
          {
            init: { signal },
          },
        ),
      ),
  });
}

export function projectSkillsQueryOptions(
  projectId: string,
  signal?: AbortSignal,
) {
  return queryOptions({
    queryKey: queryKeys.projectSkills(projectId),
    queryFn: async () =>
      readRpcJson<{ skills: CodexSkillRecord[] }>(
        await api.projects[":projectId"].skills.$get(
          {
            param: { projectId: routeParam(projectId) },
          },
          {
            init: { signal },
          },
        ),
      ),
  });
}

export function chatQueryOptions(chatId: string) {
  return queryOptions({
    queryKey: queryKeys.chat(chatId),
    queryFn: async () =>
      readRpcJson<{ chat: ChatRecord }>(
        await api.chats[":chatId"].$get({
          param: { chatId: routeParam(chatId) },
          query: {},
        }),
      ),
  });
}

export function chatApprovalQueryOptions(chatId: string, signal?: AbortSignal) {
  return queryOptions({
    queryKey: queryKeys.chatApproval(chatId),
    queryFn: async () =>
      readRpcJson<{ approval: PendingApprovalRecord | null }>(
        await api.chats[":chatId"].$get(
          {
            param: { chatId: routeParam(chatId) },
            query: { context: "approval" },
          },
          {
            init: { signal },
          },
        ),
      ),
  });
}

export function messagesQueryOptions(chatId: string) {
  return queryOptions({
    queryKey: queryKeys.messages(chatId),
    queryFn: async () => {
      const data = await readRpcJson<{
        messages: RenderedChatMessageRecord[];
      }>(
        await api.chats[":chatId"].messages.$get({
          param: { chatId: routeParam(chatId) },
        }),
      );
      return {
        messages: stripHiddenRichEventContentFromMessages(data.messages),
      };
    },
  });
}

export function chatSkillsQueryOptions(chatId: string, signal?: AbortSignal) {
  return queryOptions({
    queryKey: queryKeys.chatSkills(chatId),
    queryFn: async () =>
      readRpcJson<{ skills: CodexSkillRecord[] }>(
        await api.chats[":chatId"].$get(
          {
            param: { chatId: routeParam(chatId) },
            query: { context: "skills" },
          },
          {
            init: { signal },
          },
        ),
      ),
  });
}

export function fileSearchQueryOptions(
  chatId: string,
  fileQuery: string,
  signal?: AbortSignal,
) {
  return queryOptions({
    queryKey: queryKeys.fileSearch(chatId, fileQuery),
    queryFn: async () =>
      readRpcJson<{ files: CodexFileRecord[] }>(
        await api.chats[":chatId"].$get(
          {
            param: { chatId: routeParam(chatId) },
            query: { fileQuery },
          },
          {
            init: { signal },
          },
        ),
      ),
  });
}

export function stripHiddenRichEventContentFromMessages(
  messages: RenderedChatMessageRecord[],
): RenderedChatMessageRecord[] {
  return messages.map(stripHiddenRichEventContent);
}

function stripHiddenRichEventContent(
  message: RenderedChatMessageRecord,
): RenderedChatMessageRecord {
  if (message.role !== "event") {
    return message;
  }

  if (
    message.eventType === "item/commandExecution/outputDelta" ||
    message.eventType === "command/exec/outputDelta" ||
    message.eventType === "item/fileChange/outputDelta"
  ) {
    const hiddenText = getHiddenOutputText(message);
    return {
      ...message,
      eventData: withHiddenContentLength(
        stripRecordKey(message.eventData, "text"),
        hiddenText,
      ),
      text: "",
      textHtml: "",
    };
  }

  if (message.eventType === "turn/diff/updated") {
    return {
      ...message,
      eventData: stripDiffEventData(message.eventData),
    };
  }

  if (message.eventType === "item/fileChange/patchUpdated") {
    return {
      ...message,
      eventData: stripFilePatchDiffs(message.eventData),
    };
  }

  return message;
}

function stripRecordKey(value: unknown, key: string): unknown {
  if (!isRecord(value)) {
    return value;
  }
  const nextValue = { ...value };
  delete nextValue[key];
  return nextValue;
}

function getHiddenOutputText(message: RenderedChatMessageRecord): string {
  if (
    isRecord(message.eventData) &&
    typeof message.eventData.text === "string"
  ) {
    return message.eventData.text;
  }
  return message.text;
}

function withHiddenContentLength(value: unknown, hiddenText: string): unknown {
  if (!hiddenText) {
    return value;
  }
  if (!isRecord(value)) {
    return {
      hiddenContentLength: hiddenText.length,
    };
  }
  if (
    typeof value.hiddenContentDeltaCount === "number" ||
    typeof value.hiddenContentLength === "number"
  ) {
    return value;
  }
  return {
    ...value,
    hiddenContentLength: hiddenText.length,
  };
}

function stripDiffEventData(value: unknown): unknown {
  if (!isRecord(value)) {
    return value;
  }
  const diff = typeof value.diff === "string" ? value.diff : "";
  const nextValue = { ...value };
  delete nextValue.diff;
  if (diff && typeof nextValue.hasDiff !== "boolean") {
    nextValue.hasDiff = true;
  }
  return nextValue;
}

function stripFilePatchDiffs(value: unknown): unknown {
  if (!isRecord(value)) {
    return value;
  }
  const changes = value.changes;
  if (!Array.isArray(changes)) {
    return value;
  }
  return {
    ...value,
    changes: changes.map((change) => stripRecordKey(change, "diff")),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
