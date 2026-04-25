export type CodexServerRequestId = number | string;

export function getParamObject(
  params: unknown,
): Record<string, unknown> | null {
  return params && typeof params === "object" && !Array.isArray(params)
    ? (params as Record<string, unknown>)
    : null;
}

export function extractThreadId(result: unknown): string {
  const object = getParamObject(result);
  const thread = getParamObject(object?.thread);
  const threadId = thread?.id;
  if (typeof threadId !== "string") {
    throw new Error("Codex response did not include a thread id");
  }
  return threadId;
}

export function extractTurnId(result: unknown): string | null {
  const object = getParamObject(result);
  const turn = getParamObject(object?.turn);
  const turnId = turn?.id;
  return typeof turnId === "string" ? turnId : null;
}

export function extractThreadIdFromParams(params: unknown): string | null {
  const object = getParamObject(params);
  if (!object) {
    return null;
  }
  if (typeof object.threadId === "string") {
    return object.threadId;
  }
  const thread = getParamObject(object.thread);
  return typeof thread?.id === "string" ? thread.id : null;
}

export function extractTurnIdFromParams(params: unknown): string | null {
  const object = getParamObject(params);
  if (!object) {
    return null;
  }
  if (typeof object.turnId === "string") {
    return object.turnId;
  }
  const turn = getParamObject(object.turn);
  return typeof turn?.id === "string" ? turn.id : null;
}

export function getServerRequestId(
  requestId: unknown,
): CodexServerRequestId | null {
  if (typeof requestId === "string" || typeof requestId === "number") {
    return requestId;
  }
  return null;
}

export function extractServerRequestIdFromParams(
  params: unknown,
): CodexServerRequestId | null {
  const object = getParamObject(params);
  if (!object) {
    return null;
  }
  return (
    getServerRequestId(object.requestId) ??
    getServerRequestId(object.serverRequestId) ??
    getServerRequestId(object.id)
  );
}

export function mapCodexMethodToEvent(method: string): string {
  if (method === "thread/started") {
    return "agent.thread.started";
  }
  if (method === "turn/started") {
    return "agent.turn.started";
  }
  if (method === "turn/completed") {
    return "agent.turn.completed";
  }
  if (method.startsWith("item/") && method.endsWith("/requestApproval")) {
    return "agent.approval.requested";
  }
  if (method.startsWith("item/")) {
    return method.includes("delta") ? "agent.item.delta" : "agent.item.updated";
  }
  if (method === "serverRequest/resolved") {
    return "agent.approval.resolved";
  }
  if (method === "account/updated") {
    return "auth.updated";
  }
  if (method === "error") {
    return "agent.error";
  }
  return "agent.event";
}

export function summarizeCodexEvent(method: string, params: unknown): string {
  const object = getParamObject(params);
  if (method === "item/started" || method === "item/completed") {
    const item = getParamObject(object?.item);
    const type = typeof item?.type === "string" ? item.type : "item";
    return `${method}: ${type}`;
  }
  if (method === "turn/completed") {
    const turn = getParamObject(object?.turn);
    const status = typeof turn?.status === "string" ? turn.status : "unknown";
    return `turn completed: ${status}`;
  }
  if (method === "error") {
    const error = getParamObject(object?.error);
    return typeof error?.message === "string" ? error.message : "Codex error";
  }
  return method;
}
