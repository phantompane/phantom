import { describe, expect, it } from "vitest";
import {
  findValidatedSelectedChat,
  getSelectableReasoningEfforts,
  isShareableFileSearchQuery,
} from "./home-url-state";

describe("isShareableFileSearchQuery", () => {
  it("allows simple file search text", () => {
    expect(isShareableFileSearchQuery("button component")).toBe(true);
  });

  it("rejects path-like and encoded path-like queries", () => {
    expect(isShareableFileSearchQuery("/Users/alice/project")).toBe(false);
    expect(isShareableFileSearchQuery("C:\\Users\\alice")).toBe(false);
    expect(isShareableFileSearchQuery("src%252Froutes")).toBe(false);
    expect(isShareableFileSearchQuery("%u002FUsers%u002Falice")).toBe(false);
  });
});

describe("findValidatedSelectedChat", () => {
  const chats = [
    { id: "chat-1", projectId: "project-1" },
    { id: "chat-2", projectId: "project-2" },
  ];

  it("accepts a selected chat from the requested project", () => {
    expect(findValidatedSelectedChat(chats, "chat-1", "project-1")).toBe(
      chats[0],
    );
  });

  it("rejects a selected chat from a different requested project", () => {
    expect(findValidatedSelectedChat(chats, "chat-1", "project-2")).toBeNull();
  });

  it("accepts an existing chat when the URL has no project parameter", () => {
    expect(findValidatedSelectedChat(chats, "chat-1", null)).toBe(chats[0]);
  });
});

describe("getSelectableReasoningEfforts", () => {
  it("uses fallback efforts before model metadata is available", () => {
    expect(getSelectableReasoningEfforts(null)).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
  });

  it("does not invent efforts for models with no advertised support", () => {
    expect(
      getSelectableReasoningEfforts({ supportedReasoningEfforts: [] }),
    ).toEqual([]);
  });
});
