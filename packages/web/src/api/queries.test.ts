import { deepStrictEqual, strictEqual } from "node:assert";
import { describe, it } from "vitest";
import { stripHiddenRichEventContentFromMessages } from "./queries";
import type { RenderedChatMessageRecord } from "@phantompane/server";

function createMessage(
  overrides: Partial<RenderedChatMessageRecord> = {},
): RenderedChatMessageRecord {
  return {
    chatId: "chat_1",
    createdAt: "2026-05-07T00:00:00.000Z",
    id: "msg_1",
    role: "event",
    text: "event",
    ...overrides,
  };
}

describe("stripHiddenRichEventContentFromMessages", () => {
  it("drops command and file output bodies while preserving metadata", () => {
    const [commandMessage, fileOutputMessage, textOnlyOutputMessage] =
      stripHiddenRichEventContentFromMessages([
        createMessage({
          eventData: {
            command: "pnpm test",
            exitCode: 0,
            status: "completed",
            text: "large command output",
          },
          eventType: "item/commandExecution/outputDelta",
          text: "large command output",
          textHtml: "<pre>large command output</pre>\n",
        }),
        createMessage({
          eventData: {
            kind: "fileChangeOutput",
            text: "large file output",
          },
          eventType: "item/fileChange/outputDelta",
          id: "msg_2",
          text: "large file output",
        }),
        createMessage({
          eventType: "item/commandExecution/outputDelta",
          id: "msg_3",
          text: "raw output without event data",
        }),
      ]);

    strictEqual(commandMessage?.text, "");
    strictEqual(commandMessage?.textHtml, "");
    deepStrictEqual(commandMessage?.eventData, {
      command: "pnpm test",
      exitCode: 0,
      hiddenContentLength: 20,
      status: "completed",
    });
    strictEqual(fileOutputMessage?.text, "");
    deepStrictEqual(fileOutputMessage?.eventData, {
      hiddenContentLength: 17,
      kind: "fileChangeOutput",
    });
    strictEqual(textOnlyOutputMessage?.text, "");
    deepStrictEqual(textOnlyOutputMessage?.eventData, {
      hiddenContentLength: 29,
    });
  });

  it("drops hidden diff and patch bodies while preserving summaries", () => {
    const [diffMessage, patchMessage] = stripHiddenRichEventContentFromMessages(
      [
        createMessage({
          eventData: {
            diff: "large diff",
            files: ["a.ts"],
          },
          eventType: "turn/diff/updated",
          text: "Diff updated: 1 file",
        }),
        createMessage({
          eventData: {
            changes: [
              {
                diff: "large patch",
                kind: "update",
                path: "a.ts",
              },
            ],
            status: "completed",
          },
          eventType: "item/fileChange/patchUpdated",
          id: "msg_2",
          text: "File patch updated: 1 file",
        }),
      ],
    );

    strictEqual(diffMessage?.text, "Diff updated: 1 file");
    deepStrictEqual(diffMessage?.eventData, {
      files: ["a.ts"],
      hasDiff: true,
    });
    strictEqual(patchMessage?.text, "File patch updated: 1 file");
    deepStrictEqual(patchMessage?.eventData, {
      changes: [
        {
          kind: "update",
          path: "a.ts",
        },
      ],
      status: "completed",
    });
  });

  it("keeps regular chat messages unchanged", () => {
    const assistantMessage = createMessage({
      id: "msg_3",
      role: "assistant",
      text: "hello",
      textHtml: "<p>hello</p>\n",
    });

    const [result] = stripHiddenRichEventContentFromMessages([
      assistantMessage,
    ]);

    strictEqual(result, assistantMessage);
  });
});
