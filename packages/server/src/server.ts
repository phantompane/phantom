import { extname, relative, resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { rpcApp } from "./app.ts";

export interface StartServerOptions {
  port?: number;
  staticDir?: string;
}

const MIME_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

export function createServerApp(staticDir?: string) {
  const serverApp = new Hono();

  serverApp.route("/api/rpc", rpcApp);

  if (staticDir) {
    const rootDir = resolve(staticDir);

    serverApp.get("*", async (c) => {
      const requestPath = c.req.path === "/" ? "/index.html" : c.req.path;
      const hasExtension = extname(requestPath) !== "";

      const fileResponse = await readStaticFile(rootDir, requestPath);

      if (fileResponse) {
        return fileResponse;
      }

      if (!hasExtension) {
        const indexResponse = await readStaticFile(rootDir, "/index.html");
        if (indexResponse) {
          return indexResponse;
        }
      }

      return c.notFound();
    });
  }

  return serverApp;
}

export function startServer(options: StartServerOptions = {}) {
  const port = options.port ?? 3001;
  const serverApp = createServerApp(options.staticDir);

  return serve({
    fetch: serverApp.fetch,
    port,
  });
}

async function readStaticFile(
  rootDir: string,
  requestPath: string,
): Promise<Response | null> {
  const normalizedPath = requestPath.startsWith("/")
    ? requestPath.slice(1)
    : requestPath;
  const filePath = resolve(rootDir, normalizedPath);

  const relativePath = relative(rootDir, filePath);

  if (relativePath.startsWith("..")) {
    return null;
  }

  try {
    const file = await readFile(filePath);
    return new Response(file, {
      headers: {
        "content-type":
          MIME_TYPES[extname(filePath).toLowerCase()] ??
          "application/octet-stream",
      },
    });
  } catch {
    return null;
  }
}
