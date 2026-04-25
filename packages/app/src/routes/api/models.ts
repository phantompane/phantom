import { createFileRoute } from "@tanstack/react-router";
import { handleApiError, json } from "../../server/http";
import { getServeServices } from "../../server/services";

export const Route = createFileRoute("/api/models")({
  server: {
    handlers: {
      GET: async () => {
        try {
          return json({ models: await getServeServices().listModels() });
        } catch (error) {
          return handleApiError(error);
        }
      },
    },
  },
});
