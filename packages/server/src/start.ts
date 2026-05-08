import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";

export function startServer() {
  const host = process.env.HOST ?? process.env.NITRO_HOST ?? "127.0.0.1";
  const port = Number.parseInt(
    process.env.PORT ?? process.env.NITRO_PORT ?? "9640",
    10,
  );

  return serve({
    fetch: createApp().fetch,
    hostname: host,
    port: Number.isFinite(port) ? port : 9640,
  });
}

startServer();
