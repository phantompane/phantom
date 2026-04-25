import { createFileRoute } from "@tanstack/react-router";
import {
  getString,
  handleApiError,
  json,
  readJsonObject,
  type ServerRouteContext,
} from "../../server/http";
import { getServeServices } from "../../server/services";

export const Route = createFileRoute("/api/projects")({
  server: {
    handlers: {
      GET: async () => {
        try {
          return json({ projects: await getServeServices().listProjects() });
        } catch (error) {
          return handleApiError(error);
        }
      },
      POST: async ({ request }: ServerRouteContext) => {
        try {
          const body = await readJsonObject(request);
          const path = getString(body, "path");
          if (!path) {
            throw new Error("Project path is required");
          }
          const project = await getServeServices().addProject(path);
          return json({ project }, { status: 201 });
        } catch (error) {
          return handleApiError(error);
        }
      },
    },
  },
});
