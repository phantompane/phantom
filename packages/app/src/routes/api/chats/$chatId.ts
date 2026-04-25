import { createFileRoute } from "@tanstack/react-router";
import {
  handleApiError,
  json,
  type ServerRouteContext,
} from "../../../server/http";
import { getServeServices } from "../../../server/services";

export const Route = createFileRoute("/api/chats/$chatId")({
  server: {
    handlers: {
      GET: async ({ params }: ServerRouteContext) => {
        try {
          if (!params.chatId) {
            throw new Error("Chat id is required");
          }
          const chat = await getServeServices().getChat(params.chatId);
          return json({ chat });
        } catch (error) {
          return handleApiError(error);
        }
      },
    },
  },
});
