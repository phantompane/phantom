import { deepStrictEqual, strictEqual } from "node:assert";
import { beforeEach, describe, it, vi } from "vitest";

const services = vi.hoisted(() => ({
  addProject: vi.fn(),
  createChat: vi.fn(),
  getMessages: vi.fn(),
  listProjectGitHubCheckoutTargets: vi.fn(),
  listProjects: vi.fn(),
}));

vi.mock("./services", () => ({
  getServeServices: () => services,
}));

const { rpcRoutes } = await import("./rpc");

describe("rpcRoutes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("lists projects through Hono RPC", async () => {
    services.listProjects.mockResolvedValueOnce([
      {
        id: "proj_1",
        name: "phantom",
        rootPath: "/repo/phantom",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        lastOpenedAt: "2026-01-01T00:00:00.000Z",
      },
    ]);

    const response = await rpcRoutes.request("/projects");

    strictEqual(response.status, 200);
    deepStrictEqual(await response.json(), {
      projects: [
        {
          id: "proj_1",
          name: "phantom",
          rootPath: "/repo/phantom",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          lastOpenedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });
  });

  it("renders message Markdown in chat message responses", async () => {
    services.getMessages.mockResolvedValueOnce([
      {
        chatId: "chat_1",
        createdAt: "2026-05-05T00:00:00.000Z",
        id: "msg_1",
        role: "assistant",
        text: "**hello**",
      },
      {
        chatId: "chat_1",
        createdAt: "2026-05-05T00:00:01.000Z",
        eventType: "item/commandExecution/outputDelta",
        id: "msg_2",
        role: "event",
        text: "**raw output**",
      },
    ]);

    const response = await rpcRoutes.request("/chats/chat_1/messages");

    strictEqual(response.status, 200);
    deepStrictEqual(services.getMessages.mock.calls[0], ["chat_1"]);
    deepStrictEqual(await response.json(), {
      messages: [
        {
          chatId: "chat_1",
          createdAt: "2026-05-05T00:00:00.000Z",
          id: "msg_1",
          role: "assistant",
          text: "**hello**",
          textHtml: "<p><strong>hello</strong></p>\n",
        },
        {
          chatId: "chat_1",
          createdAt: "2026-05-05T00:00:01.000Z",
          eventType: "item/commandExecution/outputDelta",
          id: "msg_2",
          role: "event",
          text: "**raw output**",
        },
      ],
    });
  });

  it("validates project creation bodies before calling services", async () => {
    const response = await rpcRoutes.request("/projects", {
      method: "POST",
      body: JSON.stringify({}),
      headers: {
        "Content-Type": "application/json",
      },
    });

    strictEqual(response.status, 400);
    strictEqual(services.addProject.mock.calls.length, 0);
    deepStrictEqual(await response.json(), {
      error: {
        message: "Invalid input: expected string, received undefined",
      },
    });
  });

  it("rejects partial existing-worktree chat creation bodies", async () => {
    const response = await rpcRoutes.request("/projects/proj_1/chats", {
      method: "POST",
      body: JSON.stringify({ worktreeName: "feature" }),
      headers: {
        "Content-Type": "application/json",
      },
    });

    strictEqual(response.status, 400);
    strictEqual(services.createChat.mock.calls.length, 0);
    deepStrictEqual(await response.json(), {
      error: {
        message: "Worktree path is required",
      },
    });
  });

  it("rejects blank existing-worktree chat paths", async () => {
    const response = await rpcRoutes.request("/projects/proj_1/chats", {
      method: "POST",
      body: JSON.stringify({ worktreeName: "feature", worktreePath: " " }),
      headers: {
        "Content-Type": "application/json",
      },
    });

    strictEqual(response.status, 400);
    strictEqual(services.createChat.mock.calls.length, 0);
    deepStrictEqual(await response.json(), {
      error: {
        message: "Worktree path is required",
      },
    });
  });

  it("lists GitHub checkout targets through Hono RPC", async () => {
    services.listProjectGitHubCheckoutTargets.mockResolvedValueOnce({
      available: true,
      targets: [
        {
          author: "alice",
          htmlUrl: "https://github.com/owner/repo/pull/42",
          kind: "pullRequest",
          number: 42,
          title: "Fix checkout",
          updatedAt: "2026-05-04T00:00:00Z",
        },
      ],
    });

    const response = await rpcRoutes.request(
      "/projects/proj_1/github/checkout-targets",
    );

    strictEqual(response.status, 200);
    deepStrictEqual(services.listProjectGitHubCheckoutTargets.mock.calls[0], [
      "proj_1",
    ]);
    deepStrictEqual(await response.json(), {
      github: {
        available: true,
        targets: [
          {
            author: "alice",
            htmlUrl: "https://github.com/owner/repo/pull/42",
            kind: "pullRequest",
            number: 42,
            title: "Fix checkout",
            updatedAt: "2026-05-04T00:00:00Z",
          },
        ],
      },
    });
  });

  it("accepts GitHub checkout targets in chat creation bodies", async () => {
    services.createChat.mockResolvedValueOnce({
      id: "chat_1",
    });

    const response = await rpcRoutes.request("/projects/proj_1/chats", {
      method: "POST",
      body: JSON.stringify({
        githubTargetNumber: 42,
        initialMessage: "Start from the selected target",
        serviceTier: "fast",
      }),
      headers: {
        "Content-Type": "application/json",
      },
    });

    strictEqual(response.status, 201);
    deepStrictEqual(services.createChat.mock.calls[0], [
      "proj_1",
      {
        name: undefined,
        base: undefined,
        githubTargetNumber: 42,
        initialMessage: "Start from the selected target",
        serviceTier: "fast",
        worktreeName: undefined,
        worktreePath: undefined,
      },
    ]);
  });
});
