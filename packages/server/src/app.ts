import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { rpcRoutes } from "./rpc.ts";
import { mountStaticWebAssets } from "./static.ts";
import type { ApiErrorBody } from "./types.ts";

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
  app.route("/api", rpcRoutes);
  mountStaticWebAssets(app);
  return app;
}
