import { createFileRoute } from "@tanstack/react-router";
import {
  getString,
  handleApiError,
  json,
  readJsonObject,
  type ServerRouteContext,
} from "../../../../server/http";
import { getServeServices } from "../../../../server/services";

export const Route = createFileRoute("/api/projects/$projectId/chats")({
  server: {
    handlers: {
      GET: async ({ request, params }: ServerRouteContext) => {
        try {
          if (!params.projectId) {
            throw new Error("Project id is required");
          }
          const services = getServeServices();
          const shouldSync =
            new URL(request.url).searchParams.get("sync") === "1";
          const worktrees = await services.listProjectWorktrees(
            params.projectId,
            {
              sync: shouldSync,
            },
          );
          const chats = await services.listChats(params.projectId);
          return json({ chats, worktrees });
        } catch (error) {
          return handleApiError(error);
        }
      },
      POST: async ({ request, params }: ServerRouteContext) => {
        try {
          if (!params.projectId) {
            throw new Error("Project id is required");
          }
          const body = await readJsonObject(request);
          const chat = await getServeServices().createChat(params.projectId, {
            name: getString(body, "name"),
            base: getString(body, "base"),
          });
          return json({ chat }, { status: 201 });
        } catch (error) {
          return handleApiError(error);
        }
      },
    },
  },
});
