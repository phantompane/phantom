import { createFileRoute } from "@tanstack/react-router";
import {
  handleApiError,
  json,
  type ServerRouteContext,
} from "../../../server/http";
import { getServeServices } from "../../../server/services";

export const Route = createFileRoute("/api/chats/$chatId")({
  server: {
    handlers: {
      GET: async ({ request, params }: ServerRouteContext) => {
        try {
          if (!params.chatId) {
            throw new Error("Chat id is required");
          }
          const services = getServeServices();
          const searchParams = new URL(request.url).searchParams;
          if (searchParams.get("context") === "skills") {
            const skills = await services.listSkills(params.chatId);
            return json({ skills });
          }
          const fileQuery = searchParams.get("fileQuery");
          if (fileQuery !== null) {
            const files = await services.searchFiles(params.chatId, fileQuery);
            return json({ files });
          }
          const chat = await services.getChat(params.chatId);
          return json({ chat });
        } catch (error) {
          return handleApiError(error);
        }
      },
    },
  },
});
