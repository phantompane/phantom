import { deepStrictEqual, strictEqual } from "node:assert";
import { describe, it } from "vitest";
import {
  getCommandEventMeta,
  getDiffEventData,
  getDiffLineDelta,
  getFileChangesLineDelta,
  getFileEventMeta,
  getPlanEventData,
  getRichEventKind,
  getRichEventText,
  getTextLineCount,
  isHiddenRichEventMessage,
  isRichEventMessage,
} from "./rich-events";
import type { ChatMessageRecord } from "@phantompane/server";

function createMessage(
  overrides: Partial<ChatMessageRecord> = {},
): ChatMessageRecord {
  return {
    id: "msg_1",
    chatId: "chat_1",
    role: "event",
    text: "event",
    createdAt: "2026-04-25T00:00:00.000Z",
    ...overrides,
  };
}

describe("rich event helpers", () => {
  it("recognizes renderable Codex rich events", () => {
    strictEqual(
      getRichEventKind(
        createMessage({ eventType: "item/commandExecution/outputDelta" }),
      ),
      "command",
    );
    strictEqual(
      getRichEventKind(createMessage({ eventType: "item/plan/delta" })),
      "plan",
    );
    strictEqual(
      getRichEventKind(
        createMessage({ eventType: "item/reasoning/summaryTextDelta" }),
      ),
      "reasoning",
    );
    strictEqual(
      isRichEventMessage(
        createMessage({ eventType: "item/reasoning/summaryPartAdded" }),
      ),
      false,
    );
    strictEqual(
      isRichEventMessage(createMessage({ eventType: "item/completed" })),
      false,
    );
  });

  it("hides approved automatic approval review warnings", () => {
    strictEqual(
      isHiddenRichEventMessage(
        createMessage({
          eventType: "warning",
          eventData: { message: "Automatic approval review approved" },
          text: "Automatic approval review approved",
        }),
      ),
      true,
    );
    strictEqual(
      isHiddenRichEventMessage(
        createMessage({
          eventType: "warning",
          eventData: { message: "Review this warning" },
          text: "Review this warning",
        }),
      ),
      false,
    );
  });

  it("normalizes plan event payloads", () => {
    const data = getPlanEventData(
      createMessage({
        eventType: "turn/plan/updated",
        eventData: {
          explanation: "working",
          plan: [
            { step: "Read code", status: "completed" },
            { step: "Patch UI", status: "inProgress" },
            { step: "", status: "pending" },
          ],
        },
      }),
    );

    deepStrictEqual(data, {
      explanation: "working",
      plan: [
        { step: "Read code", status: "completed" },
        { step: "Patch UI", status: "inProgress" },
      ],
    });
  });

  it("returns diff files and appended stream text", () => {
    deepStrictEqual(
      getDiffEventData(
        createMessage({
          eventType: "turn/diff/updated",
          eventData: {
            diff: "diff --git a/a.ts b/a.ts",
            files: ["a.ts"],
          },
        }),
      ),
      {
        diff: "diff --git a/a.ts b/a.ts",
        files: ["a.ts"],
        hasDiff: true,
      },
    );
    deepStrictEqual(
      getDiffEventData(
        createMessage({
          eventType: "turn/diff/updated",
          eventData: {
            files: [],
            hasDiff: false,
          },
          text: "Diff cleared",
        }),
      ),
      {
        diff: "",
        files: [],
        hasDiff: false,
      },
    );
    strictEqual(
      getRichEventText(
        createMessage({
          eventType: "item/commandExecution/outputDelta",
          text: "fallback",
          eventData: { text: "hello\nworld\n" },
        }),
      ),
      "hello\nworld\n",
    );
  });

  it("returns lifecycle metadata for command and file events", () => {
    deepStrictEqual(
      getCommandEventMeta(
        createMessage({
          eventType: "item/commandExecution/outputDelta",
          eventData: {
            command: "pnpm test",
            cwd: "/repo",
            durationMs: 42,
            exitCode: 0,
            status: "completed",
            text: "",
          },
        }),
      ),
      {
        capReached: false,
        command: "pnpm test",
        cwd: "/repo",
        durationMs: 42,
        exitCode: 0,
        status: "completed",
        stream: null,
      },
    );
    deepStrictEqual(
      getFileEventMeta(
        createMessage({
          eventType: "item/fileChange/patchUpdated",
          eventData: { changes: [], status: "failed" },
        }),
      ),
      { status: "failed" },
    );
  });

  it("summarizes compact event line counts without dropping hunk content", () => {
    strictEqual(getTextLineCount("one\ntwo\n"), 2);
    deepStrictEqual(
      getDiffLineDelta(
        [
          "diff --git a/a.ts b/a.ts",
          "--- a/a.ts",
          "+++ b/a.ts",
          "@@ -1,2 +1,2 @@",
          "+++ valid added content",
          "--- valid removed content",
          "+normal add",
          "-normal remove",
        ].join("\n"),
      ),
      { added: 2, removed: 2 },
    );
    deepStrictEqual(
      getFileChangesLineDelta([
        {
          diff: "@@ -1 +1 @@\n-old\n+new",
          kind: "modify",
          path: "a.ts",
        },
        {
          diff: "@@ -1 +1 @@\n--- removed heading\n+++ added heading",
          kind: "modify",
          path: "b.ts",
        },
      ]),
      { added: 2, removed: 2 },
    );
  });
});
