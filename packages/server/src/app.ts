import { Hono } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { rpcRoutes } from "./rpc.ts";
import type { ApiErrorBody } from "./types.ts";

const hostedWebOrigin = "https://phantompane.dev";
const developmentWebPorts = new Set(["3000", "4173"]);

export function createApp(): Hono {
  const app = new Hono();
  app.onError((error, c) => {
    const status = error instanceof HTTPException ? error.status : 500;
    return c.json(
      {
        error: {
          message: error.message || "Internal server error",
        },
      } satisfies ApiErrorBody,
      status as ContentfulStatusCode,
    );
  });
  app.use("/api/*", async (c, next) => {
    const origin = c.req.header("Origin");
    if (origin && !isAllowedWebOrigin(origin)) {
      return c.json(
        { error: { message: "Origin is not allowed" } } satisfies ApiErrorBody,
        403,
      );
    }
    await next();
  });
  app.use(
    "/api/*",
    cors({
      allowHeaders: ["Content-Type", "Last-Event-ID"],
      allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
      maxAge: 86400,
      origin: (origin) => (isAllowedWebOrigin(origin) ? origin : undefined),
    }),
  );
  app.route("/api", rpcRoutes);
  return app;
}

export function isAllowedWebOrigin(origin: string): boolean {
  if (origin === hostedWebOrigin) {
    return true;
  }

  if (getConfiguredWebOrigins().has(origin)) {
    return true;
  }

  try {
    const url = new URL(origin);
    if (
      (url.protocol === "http:" || url.protocol === "https:") &&
      (url.hostname === "phantom.localhost" ||
        url.hostname.endsWith(".phantom.localhost"))
    ) {
      return true;
    }

    return (
      url.protocol === "http:" &&
      (url.hostname === "localhost" ||
        url.hostname === "127.0.0.1" ||
        url.hostname === "[::1]") &&
      developmentWebPorts.has(url.port)
    );
  } catch {
    return false;
  }
}

function getConfiguredWebOrigins(): Set<string> {
  const origins = new Set<string>();
  for (const value of (process.env.PHANTOM_SERVE_ALLOWED_ORIGINS ?? "").split(
    ",",
  )) {
    const origin = normalizeOrigin(value);
    if (origin) {
      origins.add(origin);
    }
  }
  return origins;
}

function normalizeOrigin(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const url = new URL(trimmed);
    if (
      url.origin === "null" ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}
