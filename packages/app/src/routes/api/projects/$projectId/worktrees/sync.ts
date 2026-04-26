import { createFileRoute } from "@tanstack/react-router";
import {
  getString,
  handleApiError,
  json,
  readJsonObject,
  type ServerRouteContext,
} from "../../../../../server/http";
import { getServeServices } from "../../../../../server/services";

export const Route = createFileRoute("/api/projects/$projectId/worktrees/sync")(
  {
    server: {
      handlers: {
        POST: async ({ request, params }: ServerRouteContext) => {
          try {
            if (!params.projectId) {
              throw new Error("Project id is required");
            }
            const body = await readJsonObject(request);
            const name = getString(body, "name");
            if (!name) {
              throw new Error("Worktree name is required");
            }

            const result = await getServeServices().syncProjectWorktreeBranch(
              params.projectId,
              {
                name,
                path: getString(body, "path"),
              },
            );
            return json(result);
          } catch (error) {
            return handleApiError(error);
          }
        },
      },
    },
  },
);
