import { createFileRoute } from "@tanstack/react-router";
import { handleApiError, json } from "../../server/http";
import { getServeServices } from "../../server/services";

export const Route = createFileRoute("/api/auth")({
  server: {
    handlers: {
      GET: async () => {
        try {
          return json({ auth: await getServeServices().readAuth() });
        } catch (error) {
          return handleApiError(error);
        }
      },
    },
  },
});
