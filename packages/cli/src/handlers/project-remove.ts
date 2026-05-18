import { parseArgs } from "node:util";
import { ServeStateStore, type ProjectRecord } from "@phantompane/state";
import { exitCodes, exitWithError, exitWithSuccess } from "../errors.ts";
import { output } from "../output.ts";
import { findProject, hasBlockingProjectChat } from "./project-utils.ts";

export async function projectRemoveHandler(args: string[] = []): Promise<void> {
  const { positionals, values } = parseArgs({
    args,
    options: {
      json: {
        type: "boolean",
        default: false,
      },
    },
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

  if (values.json) {
    output.log(JSON.stringify({ removedProject }, null, 2));
  } else {
    output.log(
      `Removed project '${removedProject!.name}' (${removedProject!.rootPath})`,
    );
  }

  exitWithSuccess();
}
