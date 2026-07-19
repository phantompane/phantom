import { strictEqual } from "node:assert";
import { describe, it } from "vitest";
import {
  apiUrl,
  configureApiBaseUrl,
  getApiBaseUrl,
  joinApiPath,
  normalizeApiBaseUrl,
  routeParam,
} from "./client";

describe("joinApiPath", () => {
  it("joins the default API base with a path", () => {
    strictEqual(
      joinApiPath("/api", "/chats/chat_1/events"),
      "/api/chats/chat_1/events",
    );
  });

  it("preserves configured absolute API origins", () => {
    strictEqual(
      joinApiPath("https://example.test/custom-api/", "chats/chat_1/events"),
      "https://example.test/custom-api/chats/chat_1/events",
    );
  });
});

describe("routeParam", () => {
  it("encodes reserved URL characters for Hono RPC path params", () => {
    strictEqual(routeParam("request/with#hash"), "request%2Fwith%23hash");
  });
});

describe("runtime API configuration", () => {
  it("reconfigures API URLs without rebuilding the web application", () => {
    const originalApiBaseUrl = getApiBaseUrl();
    try {
      configureApiBaseUrl("https://phantom.example.test:9640/api/");
      strictEqual(
        apiUrl("/health"),
        "https://phantom.example.test:9640/api/health",
      );
    } finally {
      configureApiBaseUrl(originalApiBaseUrl);
    }
  });

  it("normalizes empty and trailing-slash bases", () => {
    strictEqual(normalizeApiBaseUrl(""), "/api");
    strictEqual(normalizeApiBaseUrl(" /api/// "), "/api");
  });
});
