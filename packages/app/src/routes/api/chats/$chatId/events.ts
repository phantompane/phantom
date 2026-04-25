import { createFileRoute } from "@tanstack/react-router";
import {
  createSseResponse,
  parseLastEventId,
} from "../../../../server/event-hub";
import type { ServerRouteContext } from "../../../../server/http";
import { getServeServices } from "../../../../server/services";

export const Route = createFileRoute("/api/chats/$chatId/events")({
  server: {
    handlers: {
      GET: async ({ request, params }: ServerRouteContext) => {
        const chatId = params.chatId;
        const services = getServeServices();
        const stream = services.eventHub.subscribe(
          (event) =>
            event.scope === "global" ||
            (Boolean(chatId) && event.chatId === chatId),
          parseLastEventId(request),
        );
        return createSseResponse(stream);
      },
    },
  },
});
