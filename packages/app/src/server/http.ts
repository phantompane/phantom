import type { ApiErrorBody } from "./types";

export function json(data: unknown, init?: ResponseInit): Response {
  return Response.json(data, init);
}

export function jsonError(message: string, status = 400): Response {
  return Response.json(
    {
      error: {
        message,
      },
    } satisfies ApiErrorBody,
    { status },
  );
}

export async function readJsonObject(
  request: Request,
): Promise<Record<string, unknown>> {
  const body = await request.json().catch(() => undefined);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("Expected a JSON object request body");
  }
  return body as Record<string, unknown>;
}

export function getString(
  body: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = body[key];
  return typeof value === "string" ? value : undefined;
}

export type ServerRouteContext = {
  request: Request;
  params: Record<string, string | undefined>;
};

export function handleApiError(error: unknown): Response {
  const message = error instanceof Error ? error.message : String(error);
  const status =
    message.includes("not found") || message.includes("Not found") ? 404 : 400;
  return jsonError(message, status);
}
