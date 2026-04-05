import { extname, relative, resolve } from "node:path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { rpcApp } from "./app.ts";

export interface StartServerOptions {
  port?: number;
  staticDir?: string;
}

export function createServerApp(staticDir?: string) {
  const serverApp = new Hono();

  serverApp.route("/api/rpc", rpcApp);

  if (staticDir) {
    const root = toStaticRoot(staticDir);
    const serveIndex = serveStatic({
      path: "./index.html",
      root,
    });

    serverApp.use(
      "*",
      serveStatic({
        root,
        rewriteRequestPath: (path) => (path === "/" ? "/index.html" : path),
      }),
    );

    serverApp.get("*", async (c) => {
      if (extname(c.req.path) === "") {
        await serveIndex(c, async () => {});
        return c.finalized ? c.res : c.notFound();
      }

      return c.notFound();
    });
  }

  return serverApp;
}

function toStaticRoot(staticDir: string): string {
  const root = relative(process.cwd(), resolve(staticDir));

  if (root === "") {
    return ".";
  }

  if (root.startsWith("..")) {
    throw new Error(
      `Static directory must be inside the current working directory: ${staticDir}`,
    );
  }

  return root;
}

export function startServer(options: StartServerOptions = {}) {
  const port = options.port ?? 3001;
  const serverApp = createServerApp(options.staticDir);

  return serve({
    fetch: serverApp.fetch,
    port,
  });
}
