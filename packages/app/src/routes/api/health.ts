import { createFileRoute } from "@tanstack/react-router";
import { handleApiError, json } from "../../server/http";
import { getServeServices } from "../../server/services";

export const Route = createFileRoute("/api/health")({
  server: {
    handlers: {
      GET: async () => {
        try {
          return json(await getServeServices().getHealth());
        } catch (error) {
          return handleApiError(error);
        }
      },
    },
  },
});
