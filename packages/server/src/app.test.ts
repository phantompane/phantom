import { deepStrictEqual, strictEqual } from "node:assert";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it } from "vitest";
import { createApp } from "./app.ts";
import { getWebDistDirectory } from "./static.ts";

const originalWebDistDir = process.env.PHANTOM_WEB_DIST_DIR;
const temporaryDirectories: string[] = [];

afterEach(async () => {
  if (originalWebDistDir === undefined) {
    delete process.env.PHANTOM_WEB_DIST_DIR;
  } else {
    process.env.PHANTOM_WEB_DIST_DIR = originalWebDistDir;
  }

  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function createWebDistFixture(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "phantom-web-dist-"));
  temporaryDirectories.push(directory);
  await mkdir(join(directory, "assets"), { recursive: true });
  await writeFile(join(directory, "index.html"), "<!doctype html><div></div>");
  await writeFile(join(directory, "assets", "app.js"), "export {};\n");
  return directory;
}

describe("createApp", () => {
  it("returns JSON API errors for malformed JSON bodies", async () => {
    process.env.PHANTOM_WEB_DIST_DIR = await createWebDistFixture();

    const response = await createApp().request("/api/projects", {
      method: "POST",
      body: "{",
      headers: {
        "Content-Type": "application/json",
      },
    });

    strictEqual(response.status, 400);
    strictEqual(response.headers.get("Content-Type")?.includes("json"), true);
    deepStrictEqual(await response.json(), {
      error: {
        message: "Malformed JSON in request body",
      },
    });
  });

  it("serves the SPA fallback for HTML navigations", async () => {
    process.env.PHANTOM_WEB_DIST_DIR = await createWebDistFixture();

    const response = await createApp().request("/worktrees/example", {
      headers: {
        Accept: "text/html",
      },
    });

    strictEqual(response.status, 200);
    strictEqual(await response.text(), "<!doctype html><div></div>");
  });

  it("does not serve the SPA fallback for missing static assets", async () => {
    process.env.PHANTOM_WEB_DIST_DIR = await createWebDistFixture();

    const response = await createApp().request("/assets/missing.js", {
      headers: {
        Accept: "*/*",
      },
    });

    strictEqual(response.status, 404);
  });

  it("does not serve the SPA fallback for the API namespace root", async () => {
    process.env.PHANTOM_WEB_DIST_DIR = await createWebDistFixture();

    const response = await createApp().request("/api", {
      headers: {
        Accept: "text/html",
      },
    });

    strictEqual(response.status, 404);
    deepStrictEqual(await response.json(), {
      error: {
        message: "Not found",
      },
    });
  });
});

describe("getWebDistDirectory", () => {
  it("defaults to the workspace web dist directory", () => {
    delete process.env.PHANTOM_WEB_DIST_DIR;

    strictEqual(
      getWebDistDirectory(),
      fileURLToPath(new URL("../../web/dist/", import.meta.url)),
    );
  });
});
