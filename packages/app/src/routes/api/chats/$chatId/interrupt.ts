import { createFileRoute } from "@tanstack/react-router";
import {
  handleApiError,
  json,
  type ServerRouteContext,
} from "../../../../server/http";
import { getServeServices } from "../../../../server/services";

export const Route = createFileRoute("/api/chats/$chatId/interrupt")({
  server: {
    handlers: {
      POST: async ({ params }: ServerRouteContext) => {
        try {
          if (!params.chatId) {
            throw new Error("Chat id is required");
          }
          await getServeServices().interruptChat(params.chatId);
          return json({});
        } catch (error) {
          return handleApiError(error);
        }
      },
    },
  },
});
