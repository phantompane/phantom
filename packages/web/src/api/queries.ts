import { queryOptions } from "@tanstack/react-query";
import { api, readRpcJson } from "./client";
import { queryKeys } from "./query-keys";
import type {
  ChatMessageRecord,
  ChatRecord,
  CodexFileRecord,
  CodexModelRecord,
  CodexSkillRecord,
  ProjectRecord,
  ProjectWorktreeRecord,
} from "@phantompane/server";

export interface ProjectData {
  chats: ChatRecord[];
  worktrees: ProjectWorktreeRecord[];
}

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

export function projectDataQueryOptions(projectId: string, sync = false) {
  return queryOptions({
    queryKey: queryKeys.projectData(projectId, sync),
    queryFn: async () =>
      readRpcJson<ProjectData>(
        await api.projects[":projectId"].chats.$get({
          param: { projectId },
          query: sync ? { sync: "1" } : {},
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
          param: { chatId },
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
          param: { chatId },
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
            param: { chatId },
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
            param: { chatId },
            query: { fileQuery },
          },
          {
            init: { signal },
          },
        ),
      ),
  });
}
