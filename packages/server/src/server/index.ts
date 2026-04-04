import { resolve } from "node:path";
import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";

const port = Number(process.env.PORT ?? "9640");
const publicDir = resolve(import.meta.dirname, "public");
const app = createApp(publicDir);

console.log(`Phantom server listening on http://0.0.0.0:${port}`);

serve({
  fetch: app.fetch,
  port,
  hostname: "0.0.0.0",
});
