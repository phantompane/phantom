import { createFileRoute } from "@tanstack/react-router";
import {
  handleApiError,
  json,
  type ServerRouteContext,
} from "../../../server/http";
import { getServeServices } from "../../../server/services";

export const Route = createFileRoute("/api/projects/$projectId")({
  server: {
    handlers: {
      DELETE: async ({ params }: ServerRouteContext) => {
        try {
          if (!params.projectId) {
            throw new Error("Project id is required");
          }
          await getServeServices().removeProject(params.projectId);
          return json({});
        } catch (error) {
          return handleApiError(error);
        }
      },
    },
  },
});
