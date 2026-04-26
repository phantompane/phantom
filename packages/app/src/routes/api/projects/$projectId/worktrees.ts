import { createFileRoute } from "@tanstack/react-router";
import {
  getString,
  handleApiError,
  json,
  readJsonObject,
  type ServerRouteContext,
} from "../../../../server/http";
import { getServeServices } from "../../../../server/services";

function getBoolean(
  body: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const value = body[key];
  return typeof value === "boolean" ? value : undefined;
}

export const Route = createFileRoute("/api/projects/$projectId/worktrees")({
  server: {
    handlers: {
      DELETE: async ({ request, params }: ServerRouteContext) => {
        try {
          if (!params.projectId) {
            throw new Error("Project id is required");
          }
          const body = await readJsonObject(request);
          const name = getString(body, "name");
          if (!name) {
            throw new Error("Worktree name is required");
          }

          const result = await getServeServices().deleteProjectWorktree(
            params.projectId,
            {
              name,
              path: getString(body, "path"),
              force: getBoolean(body, "force"),
              keepBranch: getBoolean(body, "keepBranch"),
            },
          );
          return json(result);
        } catch (error) {
          return handleApiError(error);
        }
      },
    },
  },
});
