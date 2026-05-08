import { describe, expect, it } from "vitest";
import {
  dedupeChatThreads,
  findValidatedSelectedProjectChat,
  findValidatedSelectedChat,
  getSelectableReasoningEfforts,
  getSelectedServiceTierForTurn,
  getSelectedSkillContextItems,
  isKnownWorktreeChat,
  isShareableFileSearchQuery,
  mergeWorktreesWithChats,
  modelSupportsFastMode,
  retainRecordsForProjects,
  resolveRefreshedWorktreeChatId,
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

describe("modelSupportsFastMode", () => {
  it("uses model-advertised speed tiers", () => {
    expect(modelSupportsFastMode({ additionalSpeedTiers: ["fast"] })).toBe(
      true,
    );
    expect(modelSupportsFastMode({ additionalSpeedTiers: ["flex"] })).toBe(
      false,
    );
    expect(modelSupportsFastMode(null)).toBe(false);
  });
});

describe("getSelectedServiceTierForTurn", () => {
  it("selects fast only for fast-capable models and fast URL state", () => {
    expect(
      getSelectedServiceTierForTurn(
        { additionalSpeedTiers: ["fast"] },
        "fast",
        null,
      ),
    ).toBe("fast");
  });

  it("clears fast mode for models that do not advertise fast support", () => {
    expect(
      getSelectedServiceTierForTurn({ additionalSpeedTiers: [] }, "fast", null),
    ).toBeNull();
  });

  it("preserves restored fast pending context before model metadata loads", () => {
    expect(getSelectedServiceTierForTurn(null, null, "fast")).toBe("fast");
    expect(getSelectedServiceTierForTurn(null, null, "flex")).toBeNull();
  });
});

describe("getSelectedSkillContextItems", () => {
  it("keeps only selected skills that are currently enabled", () => {
    expect(
      getSelectedSkillContextItems(
        [
          { enabled: true, name: "review", path: "/skills/review/SKILL.md" },
          { enabled: false, name: "stale", path: "/skills/stale/SKILL.md" },
          { enabled: true, name: "unused", path: "/skills/unused/SKILL.md" },
        ],
        new Set([
          "/skills/review/SKILL.md",
          "/skills/stale/SKILL.md",
          "/skills/removed/SKILL.md",
        ]),
      ),
    ).toEqual([{ name: "review", path: "/skills/review/SKILL.md" }]);
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

  it("prefers a non-archived chat over a newer archived chat", () => {
    const worktrees = [
      {
        name: "feature",
        path: "/repo/feature",
        chatId: null,
        chatStatus: null,
        chatTitle: "feature",
      },
    ];
    const chats = [
      {
        id: "chat-current",
        worktreePath: "/repo/feature",
        title: "current",
        status: "idle",
        updatedAt: "2026-04-25T00:00:00.000Z",
      },
      {
        id: "chat-archived",
        worktreePath: "/repo/feature",
        title: "archived",
        status: "archived",
        updatedAt: "2026-04-25T00:01:00.000Z",
      },
    ];

    expect(mergeWorktreesWithChats(worktrees, chats)).toEqual([
      {
        name: "feature",
        path: "/repo/feature",
        chatId: "chat-current",
        chatStatus: "idle",
        chatTitle: "current",
      },
    ]);
  });

  it("clears worktree chat selection when only archived chats remain", () => {
    const worktrees = [
      {
        name: "feature",
        path: "/repo/feature",
        chatId: "chat-stale",
        chatStatus: "archived",
        chatTitle: "archived",
      },
    ];
    const chats = [
      {
        id: "chat-archived",
        worktreePath: "/repo/feature",
        title: "archived",
        status: "archived",
        updatedAt: "2026-04-25T00:01:00.000Z",
      },
    ];

    expect(mergeWorktreesWithChats(worktrees, chats)).toEqual([
      {
        name: "feature",
        path: "/repo/feature",
        chatId: null,
        chatStatus: null,
        chatTitle: "feature",
      },
    ]);
  });
});

describe("dedupeChatThreads", () => {
  it("prefers a non-archived chat over a newer archived duplicate thread", () => {
    expect(
      dedupeChatThreads([
        {
          codexThreadId: "thread-1",
          id: "chat-active",
          status: "idle",
          updatedAt: "2026-04-25T00:00:00.000Z",
        },
        {
          codexThreadId: "thread-1",
          id: "chat-archived",
          status: "archived",
          updatedAt: "2026-04-25T00:01:00.000Z",
        },
      ]),
    ).toEqual([
      {
        codexThreadId: "thread-1",
        id: "chat-active",
        status: "idle",
        updatedAt: "2026-04-25T00:00:00.000Z",
      },
    ]);
  });

  it("keeps the latest archived chat when a thread has no active duplicate", () => {
    expect(
      dedupeChatThreads([
        {
          codexThreadId: "thread-1",
          id: "chat-archived-old",
          status: "archived",
          updatedAt: "2026-04-25T00:00:00.000Z",
        },
        {
          codexThreadId: "thread-1",
          id: "chat-archived-new",
          status: "archived",
          updatedAt: "2026-04-25T00:01:00.000Z",
        },
      ]),
    ).toEqual([
      {
        codexThreadId: "thread-1",
        id: "chat-archived-new",
        status: "archived",
        updatedAt: "2026-04-25T00:01:00.000Z",
      },
    ]);
  });
});

describe("isKnownWorktreeChat", () => {
  it("accepts a selected chat exposed by refreshed worktree metadata", () => {
    expect(
      isKnownWorktreeChat(
        [{ chatId: "chat-main" }, { chatId: "chat-feature" }],
        "chat-feature",
      ),
    ).toBe(true);
  });

  it("rejects absent and empty selected chat ids", () => {
    const worktrees = [{ chatId: "chat-main" }, { chatId: null }];

    expect(isKnownWorktreeChat(worktrees, "chat-feature")).toBe(false);
    expect(isKnownWorktreeChat(worktrees, null)).toBe(false);
  });
});

describe("resolveRefreshedWorktreeChatId", () => {
  it("defers fallback while project chats are still loading", () => {
    expect(
      resolveRefreshedWorktreeChatId(
        undefined,
        [{ chatId: "chat-latest" }],
        "chat-older",
        "chat-main",
      ),
    ).toBe("chat-older");
  });

  it("keeps the selected chat when refreshed worktrees still reference it", () => {
    expect(
      resolveRefreshedWorktreeChatId(
        [],
        [{ chatId: "chat-main" }, { chatId: "chat-feature" }],
        "chat-feature",
        "chat-main",
      ),
    ).toBe("chat-feature");
  });

  it("keeps older selected chat history when the chat list contains it", () => {
    expect(
      resolveRefreshedWorktreeChatId(
        [{ id: "chat-older" }],
        [{ chatId: "chat-feature-latest" }],
        "chat-older",
        "chat-main",
      ),
    ).toBe("chat-older");
  });

  it("falls back only when the selected chat is no longer known", () => {
    expect(
      resolveRefreshedWorktreeChatId(
        [{ id: "chat-main" }],
        [{ chatId: "chat-main" }],
        "chat-deleted",
        "chat-main",
      ),
    ).toBe("chat-main");
  });
});
