import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { Hono } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import { api } from "./api.ts";

const assetMatcher = /\.(?:css|js|ico|json|map|png|svg|txt|woff2?)$/;

export function createApp(publicDir: string) {
  const app = new Hono();

  app.route("/", api);

  app.use(
    "*",
    serveStatic({
      root: publicDir,
      rewriteRequestPath: (path) => path.replace(/^\//, ""),
    }),
  );

  app.get("*", async (c) => {
    const requestPath = c.req.path === "/" ? "/index.html" : c.req.path;

    if (assetMatcher.test(extname(requestPath))) {
      return c.notFound();
    }

    const indexHtml = await readFile(join(publicDir, "index.html"), "utf8");
    return c.html(indexHtml);
  });

  return app;
}
