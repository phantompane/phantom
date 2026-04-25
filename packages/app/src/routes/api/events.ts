import { createFileRoute } from "@tanstack/react-router";
import { createSseResponse, parseLastEventId } from "../../server/event-hub";
import type { ServerRouteContext } from "../../server/http";
import { getServeServices } from "../../server/services";

export const Route = createFileRoute("/api/events")({
  server: {
    handlers: {
      GET: async ({ request }: ServerRouteContext) => {
        const services = getServeServices();
        const stream = services.eventHub.subscribe(
          (event) => event.scope === "global",
          parseLastEventId(request),
        );
        return createSseResponse(stream);
      },
    },
  },
});
