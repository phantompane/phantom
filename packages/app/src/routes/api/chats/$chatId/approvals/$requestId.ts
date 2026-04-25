import { createFileRoute } from "@tanstack/react-router";
import {
  getString,
  handleApiError,
  json,
  readJsonObject,
  type ServerRouteContext,
} from "../../../../../server/http";
import { getServeServices } from "../../../../../server/services";

const allowedDecisions = new Set([
  "accept",
  "acceptForSession",
  "decline",
  "cancel",
]);

export const Route = createFileRoute("/api/chats/$chatId/approvals/$requestId")(
  {
    server: {
      handlers: {
        POST: async ({ request, params }: ServerRouteContext) => {
          try {
            if (!params.chatId || !params.requestId) {
              throw new Error("Chat id and request id are required");
            }
            const body = await readJsonObject(request);
            const decision = getString(body, "decision");
            if (!decision || !allowedDecisions.has(decision)) {
              throw new Error("Approval decision is invalid");
            }
            await getServeServices().answerApproval(
              params.chatId,
              params.requestId,
              {
                decision: decision as
                  | "accept"
                  | "acceptForSession"
                  | "decline"
                  | "cancel",
              },
            );
            return json({});
          } catch (error) {
            return handleApiError(error);
          }
        },
      },
    },
  },
);
