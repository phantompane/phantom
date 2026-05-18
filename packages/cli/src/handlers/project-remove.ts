import { realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { parseArgs } from "node:util";
import { getGitRoot } from "@phantompane/git";
import {
  ServeStateStore,
  type ProjectRecord,
  type ServeState,
} from "@phantompane/state";
import { exitCodes, exitWithError, exitWithSuccess } from "../errors.ts";
import { output } from "../output.ts";

export async function projectRemoveHandler(args: string[] = []): Promise<void> {
  const { positionals } = parseArgs({
    args,
    options: {},
    strict: true,
    allowPositionals: true,
  });

  const identifier = positionals[0];
  if (!identifier) {
    exitWithError(
      "Usage: phantom project remove <project>",
      exitCodes.validationError,
    );
  }
  if (positionals.length > 1) {
    exitWithError(
      "Usage: phantom project remove <project>",
      exitCodes.validationError,
    );
  }

  const store = new ServeStateStore();
  const state = await store.load();
  const project = await findProject(state, identifier);
  if (!project) {
    exitWithError(`Project '${identifier}' not found`, exitCodes.notFound);
  }

  if (hasBlockingProjectChat(state, project.id)) {
    exitWithError(
      "Cannot remove project while it has running, approval, or queued chats",
      exitCodes.validationError,
    );
  }

  let removedProject: ProjectRecord | null = null;
  await store.update((currentState) => {
    const currentProject = currentState.projects.find(
      (candidate) => candidate.id === project.id,
    );
    if (!currentProject) {
      throw new Error(`Project '${identifier}' not found`);
    }
    if (hasBlockingProjectChat(currentState, currentProject.id)) {
      throw new Error(
        "Cannot remove project while it has running, approval, or queued chats",
      );
    }

    removedProject = currentProject;
    const removedChatIds = new Set(
      currentState.chats
        .filter((chat) => chat.projectId === currentProject.id)
        .map((chat) => chat.id),
    );
    return {
      ...currentState,
      projects: currentState.projects.filter(
        (candidate) => candidate.id !== currentProject.id,
      ),
      chats: currentState.chats.filter(
        (chat) => chat.projectId !== currentProject.id,
      ),
      messages: currentState.messages.filter(
        (message) => !removedChatIds.has(message.chatId),
      ),
      queuedMessages: currentState.queuedMessages.filter(
        (message) => !removedChatIds.has(message.chatId),
      ),
      recentProjectSkills: Object.fromEntries(
        Object.entries(currentState.recentProjectSkills).filter(
          ([projectId]) => projectId !== currentProject.id,
        ),
      ),
      selectedProjectId:
        currentState.selectedProjectId === currentProject.id
          ? null
          : currentState.selectedProjectId,
      selectedChatId:
        currentState.selectedChatId &&
        removedChatIds.has(currentState.selectedChatId)
          ? null
          : currentState.selectedChatId,
    };
  });

  output.log(
    `Removed project '${removedProject!.name}' (${removedProject!.rootPath})`,
  );

  exitWithSuccess();
}

async function findProject(
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

async function resolveProjectRootPath(path: string): Promise<string> {
  const absolutePath = isAbsolute(path) ? path : resolve(path);
  const resolvedPath = await realpath(absolutePath);
  return await getGitRoot({ cwd: resolvedPath });
}

function hasBlockingProjectChat(state: ServeState, projectId: string): boolean {
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
