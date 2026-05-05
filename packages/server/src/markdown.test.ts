import { ok, strictEqual } from "node:assert";
import { describe, it } from "vitest";
import { renderChatMessage, renderMarkdownToHtml } from "./markdown.ts";
import type { ChatMessageRecord } from "@phantompane/state";

describe("renderMarkdownToHtml", () => {
  it("renders GitHub-flavored Markdown to HTML", () => {
    const html = renderMarkdownToHtml(
      "## Result\n\n- **Done**\n\n```ts\nconst ok = true;\n```",
    );

    ok(html.includes("<h2>Result</h2>"));
    ok(html.includes("<strong>Done</strong>"));
    ok(html.includes('<pre><code class="language-ts">'));
  });

  it("escapes unsafe HTML and removes unsafe URL schemes", () => {
    const html = renderMarkdownToHtml(
      "[bad](javascript:alert(1))\n\n<script>alert(1)</script>",
    );

    ok(!html.includes("javascript:"));
    ok(!html.includes("<script>"));
    ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
  });

  it("preserves raw HTML and JSX snippets as escaped text", () => {
    const html = renderMarkdownToHtml(
      'Use <Button disabled>Save</Button> or <div data-id="1">content</div>.',
    );

    ok(html.includes("&lt;Button disabled&gt;Save&lt;/Button&gt;"));
    ok(html.includes('&lt;div data-id="1"&gt;content&lt;/div&gt;'));
    ok(!html.includes("<Button"));
    ok(!html.includes("<div"));
  });

  it("renders safe links with external navigation attributes", () => {
    const html = renderMarkdownToHtml(
      "[safe](https://example.com) [bad](javascript:alert(1))",
    );

    ok(
      html.includes(
        '<a href="https://example.com" rel="noopener noreferrer" target="_blank">safe</a>',
      ),
    );
    ok(html.includes("bad"));
    ok(!html.includes("javascript:"));
  });
});

describe("renderChatMessage", () => {
  it("adds rendered HTML without mutating the Markdown text", () => {
    const message: ChatMessageRecord = {
      chatId: "chat_1",
      createdAt: "2026-05-05T00:00:00.000Z",
      id: "msg_1",
      role: "assistant",
      text: "**hello**",
    };

    strictEqual(renderChatMessage(message).text, "**hello**");
    strictEqual(
      renderChatMessage(message).textHtml,
      "<p><strong>hello</strong></p>\n",
    );
  });

  it("does not render HTML for non-assistant messages", () => {
    const message: ChatMessageRecord = {
      chatId: "chat_1",
      createdAt: "2026-05-05T00:00:00.000Z",
      id: "msg_1",
      role: "event",
      text: "**event output**",
    };

    strictEqual("textHtml" in renderChatMessage(message), false);
  });
});
