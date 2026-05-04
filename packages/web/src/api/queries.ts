import { queryOptions } from "@tanstack/react-query";
import { api, readRpcJson, routeParam } from "./client";
import { queryKeys } from "./query-keys";
import type {
  ChatMessageRecord,
  ChatRecord,
  CodexFileRecord,
  CodexModelRecord,
  CodexSkillRecord,
  GitHubCheckoutTargetsResult,
  ProjectRecord,
  ProjectWorktreeRecord,
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

export function messagesQueryOptions(chatId: string) {
  return queryOptions({
    queryKey: queryKeys.messages(chatId),
    queryFn: async () =>
      readRpcJson<{ messages: ChatMessageRecord[] }>(
        await api.chats[":chatId"].messages.$get({
          param: { chatId: routeParam(chatId) },
        }),
      ),
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
