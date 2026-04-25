import { createFileRoute } from "@tanstack/react-router";
import {
  getString,
  handleApiError,
  json,
  readJsonObject,
  type ServerRouteContext,
} from "../../../../server/http";
import { getServeServices } from "../../../../server/services";

export const Route = createFileRoute("/api/chats/$chatId/steer")({
  server: {
    handlers: {
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
