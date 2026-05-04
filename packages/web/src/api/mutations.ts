import { api, readRpcJson, routeParam } from "./client";
import type {
  ChatRecord,
  CodexTurnContextItem,
  ProjectRecord,
} from "@phantompane/server";

export interface DeleteWorktreeInput {
  force: boolean;
  keepBranch?: boolean;
  name: string;
  path: string;
}

export interface SendMessageInput {
  effort?: string | null;
  files?: CodexTurnContextItem[];
  model?: string | null;
  skills?: CodexTurnContextItem[];
  text: string;
}

export interface CreateChatInput {
  worktreeName?: string;
  worktreePath?: string;
}

export async function addProjectMutation(path: string) {
  return readRpcJson<{ project: ProjectRecord }>(
    await api.projects.$post({
      json: { path },
    }),
  );
}

export async function createChatMutation(
  projectId: string,
  input: CreateChatInput = {},
) {
  return readRpcJson<{ chat: ChatRecord }>(
    await api.projects[":projectId"].chats.$post({
      param: { projectId: routeParam(projectId) },
      json: input,
    }),
  );
}

export async function deleteWorktreeMutation(
  projectId: string,
  input: DeleteWorktreeInput,
) {
  return readRpcJson<unknown>(
    await api.projects[":projectId"].worktrees.$delete({
      param: { projectId: routeParam(projectId) },
      json: input,
    }),
  );
}

export async function syncWorktreeMutation(
  projectId: string,
  input: { name: string; path: string },
) {
  return readRpcJson<unknown>(
    await api.projects[":projectId"].worktrees.sync.$post({
      param: { projectId: routeParam(projectId) },
      json: input,
    }),
  );
}

export async function sendMessageMutation(
  chatId: string,
  input: SendMessageInput,
) {
  return readRpcJson<{ chat: ChatRecord }>(
    await api.chats[":chatId"].messages.$post({
      param: { chatId: routeParam(chatId) },
      json: input,
    }),
  );
}

export async function steerMessageMutation(
  chatId: string,
  input: SendMessageInput,
) {
  return readRpcJson<{ chat: ChatRecord }>(
    await api.chats[":chatId"].steer.$post({
      param: { chatId: routeParam(chatId) },
      json: input,
    }),
  );
}

export async function queueMessageMutation(
  chatId: string,
  input: SendMessageInput,
) {
  return readRpcJson<{ chat: ChatRecord }>(
    await api.chats[":chatId"].queue.$post({
      param: { chatId: routeParam(chatId) },
      json: input,
    }),
  );
}

export async function interruptChatMutation(chatId: string) {
  return readRpcJson<unknown>(
    await api.chats[":chatId"].interrupt.$post({
      param: { chatId: routeParam(chatId) },
    }),
  );
}

export async function answerApprovalMutation(
  chatId: string,
  requestId: string,
  decision: "accept" | "acceptForSession" | "decline" | "cancel",
) {
  return readRpcJson<unknown>(
    await api.chats[":chatId"].approvals[":requestId"].$post({
      param: {
        chatId: routeParam(chatId),
        requestId: routeParam(requestId),
      },
      json: { decision },
    }),
  );
}
