import { describe, expect, it } from "vitest";
import {
  findValidatedSelectedProjectChat,
  findValidatedSelectedChat,
  getSelectableReasoningEfforts,
  isShareableFileSearchQuery,
  mergeWorktreesWithChats,
  retainRecordsForProjects,
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

describe("findValidatedSelectedProjectChat", () => {
  it("rejects stale chats whose project is no longer present", () => {
    const chatsByProject = {
      "project-removed": [{ id: "chat-stale", projectId: "project-removed" }],
    };

    expect(
      findValidatedSelectedProjectChat(
        chatsByProject,
        [{ id: "project-current" }],
        "chat-stale",
        "project-removed",
      ),
    ).toBeNull();
  });

  it("accepts chats from the refreshed project list", () => {
    const chat = { id: "chat-current", projectId: "project-current" };
    const chatsByProject = {
      "project-current": [chat],
      "project-removed": [{ id: "chat-stale", projectId: "project-removed" }],
    };

    expect(
      findValidatedSelectedProjectChat(
        chatsByProject,
        [{ id: "project-current" }],
        "chat-current",
        "project-current",
      ),
    ).toBe(chat);
  });
});

describe("retainRecordsForProjects", () => {
  it("drops records for projects that are absent from the refreshed list", () => {
    expect(
      retainRecordsForProjects(
        {
          "project-current": ["current"],
          "project-removed": ["stale"],
        },
        new Set(["project-current"]),
      ),
    ).toEqual({ "project-current": ["current"] });
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

describe("mergeWorktreesWithChats", () => {
  it("attaches the latest chat for each worktree and clears stale chat fields", () => {
    const worktrees = [
      {
        name: "feature",
        path: "/repo/feature",
        chatId: null,
        chatStatus: null,
        chatTitle: "feature",
      },
      {
        name: "empty",
        path: "/repo/empty",
        chatId: "chat-stale",
        chatStatus: "failed",
        chatTitle: "stale",
      },
    ];
    const chats = [
      {
        id: "chat-old",
        worktreePath: "/repo/feature",
        title: "old",
        status: "idle",
        updatedAt: "2026-04-25T00:00:00.000Z",
      },
      {
        id: "chat-new",
        worktreePath: "/repo/feature",
        title: "new",
        status: "running",
        updatedAt: "2026-04-25T00:01:00.000Z",
      },
    ];

    expect(mergeWorktreesWithChats(worktrees, chats)).toEqual([
      {
        name: "feature",
        path: "/repo/feature",
        chatId: "chat-new",
        chatStatus: "running",
        chatTitle: "new",
      },
      {
        name: "empty",
        path: "/repo/empty",
        chatId: null,
        chatStatus: null,
        chatTitle: "empty",
      },
    ]);
  });
});
