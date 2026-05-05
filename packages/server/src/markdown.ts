import { marked } from "marked";
import sanitizeHtml from "sanitize-html";
import type { ChatMessageRecord } from "@phantompane/state";
import type { RenderedChatMessageRecord } from "./types.ts";

const allowedTags = [
  "a",
  "blockquote",
  "br",
  "code",
  "del",
  "em",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "li",
  "ol",
  "p",
  "pre",
  "strong",
  "table",
  "tbody",
  "td",
  "th",
  "thead",
  "tr",
  "ul",
];

export function renderMarkdownToHtml(markdown: string): string {
  const html = marked.parse(markdown, {
    async: false,
    breaks: true,
    gfm: true,
  }) as string;
  return sanitizeHtml(html, {
    allowedAttributes: {
      a: ["href", "rel", "target", "title"],
      code: ["class"],
    },
    allowedClasses: {
      code: [/^language-[\w-]+$/],
    },
    allowedSchemes: ["http", "https", "mailto"],
    allowedTags,
    transformTags: {
      a: (_tagName, attribs) => ({
        attribs: {
          ...attribs,
          rel: "noopener noreferrer",
          target: "_blank",
        },
        tagName: "a",
      }),
    },
  });
}

export function renderChatMessage(
  message: ChatMessageRecord,
): RenderedChatMessageRecord {
  if (message.role !== "assistant") {
    return message;
  }
  return {
    ...message,
    textHtml: renderMarkdownToHtml(message.text),
  };
}

export function renderChatMessages(
  messages: ChatMessageRecord[],
): RenderedChatMessageRecord[] {
  return messages.map(renderChatMessage);
}
