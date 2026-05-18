import { realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { getGitRoot } from "@phantompane/git";
import type { ProjectRecord, ServeState } from "@phantompane/state";

export function sortProjects(projects: ProjectRecord[]): ProjectRecord[] {
  return [...projects].sort((left, right) =>
    right.lastOpenedAt.localeCompare(left.lastOpenedAt),
  );
}

export async function resolveProjectRootPath(path: string): Promise<string> {
  const absolutePath = isAbsolute(path) ? path : resolve(path);
  const resolvedPath = await realpath(absolutePath);
  return await getGitRoot({ cwd: resolvedPath });
}

export async function findProject(
  state: ServeState,
  identifier: string,
): Promise<ProjectRecord | null> {
  const directMatches = state.projects.filter(
    (project) =>
      project.id === identifier ||
      project.name === identifier ||
      project.rootPath === identifier,
  );

  if (directMatches.length === 1) {
    return directMatches[0]!;
  }

  if (directMatches.length > 1) {
    throw new Error(`Project '${identifier}' is ambiguous`);
  }

  try {
    const rootPath = await resolveProjectRootPath(identifier);
    return (
      state.projects.find((project) => project.rootPath === rootPath) ?? null
    );
  } catch {
    return null;
  }
}

export function hasBlockingProjectChat(
  state: ServeState,
  projectId: string,
): boolean {
  const queuedChatIds = new Set(
    state.queuedMessages.map((message) => message.chatId),
  );
  return state.chats.some(
    (chat) =>
      chat.projectId === projectId &&
      (Boolean(chat.activeTurnId) ||
        chat.status === "running" ||
        chat.status === "waitingForApproval" ||
        queuedChatIds.has(chat.id)),
  );
}
