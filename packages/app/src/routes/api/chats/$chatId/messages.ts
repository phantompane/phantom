import { createFileRoute } from "@tanstack/react-router";
import {
  getString,
  handleApiError,
  json,
  readJsonObject,
  type ServerRouteContext,
} from "../../../../server/http";
import { getServeServices } from "../../../../server/services";

export const Route = createFileRoute("/api/chats/$chatId/messages")({
  server: {
    handlers: {
      GET: async ({ params }: ServerRouteContext) => {
        try {
          if (!params.chatId) {
            throw new Error("Chat id is required");
          }
          const messages = await getServeServices().getMessages(params.chatId);
          return json({ messages });
        } catch (error) {
          return handleApiError(error);
        }
      },
      POST: async ({ request, params }: ServerRouteContext) => {
        try {
          if (!params.chatId) {
            throw new Error("Chat id is required");
          }
          const body = await readJsonObject(request);
          const text = getString(body, "text");
          if (!text) {
            throw new Error("Message text is required");
          }
          const chat = await getServeServices().sendMessage(params.chatId, {
            effort: getString(body, "effort"),
            files: getContextItems(body, "files"),
            model: getString(body, "model"),
            skills: getContextItems(body, "skills"),
            text,
          });
          return json({ chat });
        } catch (error) {
          return handleApiError(error);
        }
      },
    },
  },
});

function getContextItems(
  body: Record<string, unknown>,
  key: string,
): Array<{ name: string; path: string }> | undefined {
  const value = body[key];
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value
    .map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        return null;
      }
      const record = item as Record<string, unknown>;
      return {
        name: typeof record.name === "string" ? record.name : "",
        path: typeof record.path === "string" ? record.path : "",
      };
    })
    .filter((item): item is { name: string; path: string } =>
      Boolean(item?.name && item.path),
    );
}
