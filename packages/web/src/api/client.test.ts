import { strictEqual } from "node:assert";
import { describe, it } from "vitest";
import { joinApiPath } from "./client";

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
