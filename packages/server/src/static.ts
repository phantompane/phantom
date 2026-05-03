import { access, readFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Hono } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";

const contentTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};

export function mountStaticWebAssets(app: Hono): void {
  const webDistDirectory = getWebDistDirectory();

  app.get(
    "/*",
    serveStatic({
      root: webDistDirectory,
    }),
  );

  app.get("/*", async (c) => {
    if (c.req.path.startsWith("/api/")) {
      return c.json({ error: { message: "Not found" } }, 404);
    }

    const indexPath = join(webDistDirectory, "index.html");
    try {
      const html = await readFile(indexPath, "utf8");
      return c.html(html);
    } catch {
      return c.json(
        {
          error: {
            message:
              "Phantom web assets are missing. Build packages/web first.",
          },
        },
        500,
      );
    }
  });
}

export async function assertWebAssetsAvailable(): Promise<void> {
  await access(join(getWebDistDirectory(), "index.html"));
}

function getWebDistDirectory(): string {
  if (process.env.PHANTOM_WEB_DIST_DIR) {
    return process.env.PHANTOM_WEB_DIST_DIR;
  }

  return fileURLToPath(new URL("../web/", import.meta.url));
}

export function getContentType(path: string): string {
  return contentTypes[extname(path)] ?? "application/octet-stream";
}

export function getServerDirectory(): string {
  return dirname(fileURLToPath(import.meta.url));
}
