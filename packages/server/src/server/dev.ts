import { serve } from "@hono/node-server";
import { api } from "./api.ts";

const port = Number(process.env.PORT ?? "3001");

console.log(`Hono API listening on http://127.0.0.1:${port}`);

serve({
  fetch: api.fetch,
  port,
  hostname: "127.0.0.1",
});
