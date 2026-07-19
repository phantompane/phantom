import { deepStrictEqual, strictEqual } from "node:assert";
import { afterEach, describe, it } from "vitest";
import { createApp, isAllowedWebOrigin } from "./app.ts";

const originalAllowedOrigins = process.env.PHANTOM_SERVE_ALLOWED_ORIGINS;

afterEach(() => {
  if (originalAllowedOrigins === undefined) {
    delete process.env.PHANTOM_SERVE_ALLOWED_ORIGINS;
  } else {
    process.env.PHANTOM_SERVE_ALLOWED_ORIGINS = originalAllowedOrigins;
  }
});

describe("createApp", () => {
  it("returns JSON API errors with CORS headers for the hosted Web UI", async () => {
    const response = await createApp().request("/api/projects", {
      method: "POST",
      body: "{",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://phantompane.dev",
      },
    });

    strictEqual(response.status, 400);
    strictEqual(response.headers.get("Content-Type")?.includes("json"), true);
    strictEqual(
      response.headers.get("Access-Control-Allow-Origin"),
      "https://phantompane.dev",
    );
    deepStrictEqual(await response.json(), {
      error: {
        message: "Malformed JSON in request body",
      },
    });
  });

  it("handles preflight requests from the hosted Web UI", async () => {
    const response = await createApp().request("/api/projects", {
      method: "OPTIONS",
      headers: {
        "Access-Control-Request-Headers": "content-type",
        "Access-Control-Request-Method": "POST",
        Origin: "https://phantompane.dev",
      },
    });

    strictEqual(response.status, 204);
    strictEqual(
      response.headers.get("Access-Control-Allow-Origin"),
      "https://phantompane.dev",
    );
    strictEqual(
      response.headers.get("Access-Control-Allow-Headers"),
      "Content-Type,Last-Event-ID",
    );
    strictEqual(
      response.headers.get("Access-Control-Allow-Methods"),
      "GET,POST,DELETE,OPTIONS",
    );
  });

  it("rejects browser requests from untrusted origins", async () => {
    const response = await createApp().request("/api/health", {
      headers: { Origin: "https://attacker.example" },
    });

    strictEqual(response.status, 403);
    strictEqual(response.headers.get("Access-Control-Allow-Origin"), null);
    deepStrictEqual(await response.json(), {
      error: { message: "Origin is not allowed" },
    });
  });

  it("does not serve the Web application", async () => {
    const response = await createApp().request("/", {
      headers: { Accept: "text/html" },
    });

    strictEqual(response.status, 404);
  });

  it("allows exact additional origins from the environment", () => {
    process.env.PHANTOM_SERVE_ALLOWED_ORIGINS =
      "https://phantom.example, https://second.example:8443";

    strictEqual(isAllowedWebOrigin("https://phantom.example"), true);
    strictEqual(isAllowedWebOrigin("https://second.example:8443"), true);
    strictEqual(isAllowedWebOrigin("https://second.example"), false);
  });

  it("allows local Vite and Portless development origins", () => {
    strictEqual(isAllowedWebOrigin("http://localhost:3000"), true);
    strictEqual(isAllowedWebOrigin("http://127.0.0.1:4173"), true);
    strictEqual(isAllowedWebOrigin("https://phantom.localhost"), true);
    strictEqual(isAllowedWebOrigin("https://feature.phantom.localhost"), true);
  });
});
