import type { ChatMessageRecord } from "@phantompane/server";

export function mergeStreamingMessagesForDisplay(
  currentMessages: ChatMessageRecord[],
  incomingMessages: ChatMessageRecord[],
): ChatMessageRecord[] {
  if (currentMessages.length === 0) {
    return incomingMessages;
  }

  const currentIds = new Set(currentMessages.map((message) => message.id));
  const incomingMessagesById = new Map(
    incomingMessages.map((message) => [message.id, message]),
  );
  const updatedStreamEventIds = new Set<string>();
  const retainedMessages: ChatMessageRecord[] = [];

  for (const currentMessage of currentMessages) {
    const incomingMessage = incomingMessagesById.get(currentMessage.id);
    if (!incomingMessage) {
      continue;
    }

    if (isUpdatedStreamEvent(currentMessage, incomingMessage)) {
      updatedStreamEventIds.add(incomingMessage.id);
      continue;
    }

    retainedMessages.push(incomingMessage);
  }

  const newMessages = incomingMessages.filter(
    (message) => !currentIds.has(message.id),
  );
  const updatedStreamEvents = incomingMessages.filter(
    (message) =>
      currentIds.has(message.id) && updatedStreamEventIds.has(message.id),
  );

  return [...retainedMessages, ...newMessages, ...updatedStreamEvents];
}

function isUpdatedStreamEvent(
  currentMessage: ChatMessageRecord,
  incomingMessage: ChatMessageRecord,
): boolean {
  return (
    incomingMessage.role === "event" &&
    currentMessage.role === "event" &&
    currentMessage.id === incomingMessage.id &&
    hasStreamEventContentChanged(currentMessage, incomingMessage)
  );
}

function hasStreamEventContentChanged(
  currentMessage: ChatMessageRecord,
  incomingMessage: ChatMessageRecord,
): boolean {
  return (
    currentMessage.text !== incomingMessage.text ||
    currentMessage.eventType !== incomingMessage.eventType ||
    currentMessage.itemId !== incomingMessage.itemId ||
    stableSerialize(currentMessage.eventData) !==
      stableSerialize(incomingMessage.eventData)
  );
}

function stableSerialize(value: unknown): string {
  if (value === undefined) {
    return "";
  }
  try {
    return JSON.stringify(sortRecordKeys(value)) ?? "";
  } catch {
    return "";
  }
}

function sortRecordKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortRecordKeys);
  }
  if (!isRecord(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
      .map(([key, item]) => [key, sortRecordKeys(item)]),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
