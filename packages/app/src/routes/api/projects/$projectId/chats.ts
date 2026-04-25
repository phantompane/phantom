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
      GET: async ({ params }: ServerRouteContext) => {
        try {
          if (!params.projectId) {
            throw new Error("Project id is required");
          }
          const chats = await getServeServices().listChats(params.projectId);
          return json({ chats });
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
