import { deepStrictEqual } from "node:assert";
import { describe, it } from "vitest";
import { mergeStreamingMessagesForDisplay } from "./chat-message-stream-order";
import type { ChatMessageRecord } from "@phantompane/server";

function createMessage(
  id: string,
  role: ChatMessageRecord["role"],
  text: string,
  overrides: Partial<ChatMessageRecord> = {},
): ChatMessageRecord {
  return {
    id,
    chatId: "chat_1",
    role,
    text,
    createdAt: "2026-05-05T00:00:00.000Z",
    ...overrides,
  };
}

describe("mergeStreamingMessagesForDisplay", () => {
  it("appends new stream messages instead of accepting a server-prepended event", () => {
    const currentMessages = [
      createMessage("msg_user", "user", "fix chat"),
      createMessage("msg_assistant", "assistant", "working"),
    ];
    const incomingMessages = [
      createMessage("msg_event", "event", "pnpm test", {
        eventType: "item/commandExecution/outputDelta",
        itemId: "cmd_1",
      }),
      currentMessages[0]!,
      currentMessages[1]!,
    ];

    const mergedMessages = mergeStreamingMessagesForDisplay(
      currentMessages,
      incomingMessages,
    );

    deepStrictEqual(
      mergedMessages.map((message) => message.id),
      ["msg_user", "msg_assistant", "msg_event"],
    );
  });

  it("moves updated stream events to the bottom while preserving other message order", () => {
    const currentMessages = [
      createMessage("msg_user", "user", "fix chat"),
      createMessage("msg_event", "event", "first", {
        eventData: { text: "first" },
        eventType: "item/commandExecution/outputDelta",
        itemId: "cmd_1",
      }),
      createMessage("msg_assistant", "assistant", "working"),
    ];
    const incomingMessages = [
      currentMessages[0]!,
      createMessage("msg_event", "event", "first second", {
        eventData: { text: "first second" },
        eventType: "item/commandExecution/outputDelta",
        itemId: "cmd_1",
      }),
      currentMessages[2]!,
    ];

    const mergedMessages = mergeStreamingMessagesForDisplay(
      currentMessages,
      incomingMessages,
    );

    deepStrictEqual(
      mergedMessages.map((message) => [message.id, message.text]),
      [
        ["msg_user", "fix chat"],
        ["msg_assistant", "working"],
        ["msg_event", "first second"],
      ],
    );
  });

  it("moves hidden output stream events when only lightweight metadata changes", () => {
    const currentMessages = [
      createMessage("msg_user", "user", "fix chat"),
      createMessage("msg_event", "event", "", {
        eventData: {
          hiddenContentDeltaCount: 1,
          kind: "commandExecutionOutput",
        },
        eventType: "item/commandExecution/outputDelta",
        itemId: "cmd_1",
      }),
      createMessage("msg_assistant", "assistant", "working"),
    ];
    const incomingMessages = [
      currentMessages[0]!,
      createMessage("msg_event", "event", "", {
        eventData: {
          hiddenContentDeltaCount: 2,
          kind: "commandExecutionOutput",
        },
        eventType: "item/commandExecution/outputDelta",
        itemId: "cmd_1",
      }),
      currentMessages[2]!,
    ];

    const mergedMessages = mergeStreamingMessagesForDisplay(
      currentMessages,
      incomingMessages,
    );

    deepStrictEqual(
      mergedMessages.map((message) => [message.id, message.text]),
      [
        ["msg_user", "fix chat"],
        ["msg_assistant", "working"],
        ["msg_event", ""],
      ],
    );
  });

  it("moves hidden diff and patch events when only lightweight metadata changes", () => {
    const currentMessages = [
      createMessage("msg_user", "user", "fix chat"),
      createMessage("msg_diff", "event", "Diff updated: 1 file", {
        eventData: {
          files: ["src/app.ts"],
          hasDiff: true,
          hiddenContentUpdateCount: 1,
        },
        eventType: "turn/diff/updated",
        itemId: "turn_1",
      }),
      createMessage("msg_patch", "event", "File patch updated: 1 file", {
        eventData: {
          changes: [{ kind: "modify", path: "src/app.ts" }],
          hiddenContentUpdateCount: 1,
        },
        eventType: "item/fileChange/patchUpdated",
        itemId: "patch_1",
      }),
      createMessage("msg_assistant", "assistant", "working"),
    ];
    const incomingMessages = [
      currentMessages[0]!,
      createMessage("msg_diff", "event", "Diff updated: 1 file", {
        eventData: {
          files: ["src/app.ts"],
          hasDiff: true,
          hiddenContentUpdateCount: 2,
        },
        eventType: "turn/diff/updated",
        itemId: "turn_1",
      }),
      createMessage("msg_patch", "event", "File patch updated: 1 file", {
        eventData: {
          changes: [{ kind: "modify", path: "src/app.ts" }],
          hiddenContentUpdateCount: 2,
        },
        eventType: "item/fileChange/patchUpdated",
        itemId: "patch_1",
      }),
      currentMessages[3]!,
    ];

    const mergedMessages = mergeStreamingMessagesForDisplay(
      currentMessages,
      incomingMessages,
    );

    deepStrictEqual(
      mergedMessages.map((message) => message.id),
      ["msg_user", "msg_assistant", "msg_diff", "msg_patch"],
    );
  });

  it("keeps updated stream events below new assistant messages from the same refresh", () => {
    const currentMessages = [
      createMessage("msg_user", "user", "fix chat"),
      createMessage("msg_event", "event", "first", {
        eventData: { text: "first" },
        eventType: "item/commandExecution/outputDelta",
        itemId: "cmd_1",
      }),
    ];
    const incomingMessages = [
      currentMessages[0]!,
      createMessage("msg_event", "event", "first second", {
        eventData: { text: "first second" },
        eventType: "item/commandExecution/outputDelta",
        itemId: "cmd_1",
      }),
      createMessage("msg_assistant", "assistant", "working"),
    ];

    const mergedMessages = mergeStreamingMessagesForDisplay(
      currentMessages,
      incomingMessages,
    );

    deepStrictEqual(
      mergedMessages.map((message) => [message.id, message.text]),
      [
        ["msg_user", "fix chat"],
        ["msg_assistant", "working"],
        ["msg_event", "first second"],
      ],
    );
  });

  it("drops messages removed by the incoming refresh", () => {
    const currentMessages = [
      createMessage("msg_user", "user", "fix chat"),
      createMessage("msg_deleted", "user", "queued"),
    ];
    const incomingMessages = [currentMessages[0]!];

    const mergedMessages = mergeStreamingMessagesForDisplay(
      currentMessages,
      incomingMessages,
    );

    deepStrictEqual(
      mergedMessages.map((message) => message.id),
      ["msg_user"],
    );
  });
});
