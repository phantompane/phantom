import { Hono } from "hono";
import { rpcRoutes } from "./rpc.ts";
import { mountStaticWebAssets } from "./static.ts";

export function createApp(): Hono {
  const app = new Hono();
  app.route("/api", rpcRoutes);
  mountStaticWebAssets(app);
  return app;
}
