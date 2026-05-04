import { strictEqual } from "node:assert";
import { afterEach, describe, it, vi } from "vitest";
import {
  answerApprovalMutation,
  createChatMutation,
  deletePendingMessageMutation,
  queueMessageMutation,
  restorePendingMessageMutation,
  steerMessageMutation,
} from "./mutations";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("answerApprovalMutation", () => {
  it("encodes approval route params before calling Hono RPC", async () => {
    let requestUrl: string | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        requestUrl =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;
        return new Response("{}", {
          headers: {
            "Content-Type": "application/json",
          },
          status: 200,
        });
      }),
    );

    await answerApprovalMutation(
      "chat/with#hash",
      "request/with#hash",
      "accept",
    );

    strictEqual(
      requestUrl,
      "/api/chats/chat%2Fwith%23hash/approvals/request%2Fwith%23hash",
    );
  });
});

describe("createChatMutation", () => {
  it("sends target worktree data when starting a chat in an existing worktree", async () => {
    let requestBody: string | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        requestBody = init?.body?.toString();
        return new Response('{"chat":{"id":"chat_1"}}', {
          headers: {
            "Content-Type": "application/json",
          },
          status: 201,
        });
      }),
    );

    await createChatMutation("proj_1", {
      worktreeName: "feature",
      worktreePath: "/repo/.git/phantom/worktrees/feature",
    });

    strictEqual(
      requestBody,
      JSON.stringify({
        worktreeName: "feature",
        worktreePath: "/repo/.git/phantom/worktrees/feature",
      }),
    );
  });

  it("sends a GitHub checkout target when starting a chat from an issue or PR", async () => {
    let requestBody: string | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        requestBody = init?.body?.toString();
        return new Response('{"chat":{"id":"chat_1"}}', {
          headers: {
            "Content-Type": "application/json",
          },
          status: 201,
        });
      }),
    );

    await createChatMutation("proj_1", {
      githubTargetNumber: 42,
      initialMessage: "Start here",
    });

    strictEqual(
      requestBody,
      JSON.stringify({
        githubTargetNumber: 42,
        initialMessage: "Start here",
      }),
    );
  });
});

describe("message control mutations", () => {
  it("encodes steer route params before calling Hono RPC", async () => {
    let requestUrl: string | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        requestUrl =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;
        return new Response('{"chat":{"id":"chat_1"}}', {
          headers: {
            "Content-Type": "application/json",
          },
          status: 200,
        });
      }),
    );

    await steerMessageMutation("chat/with#hash", { text: "adjust" });

    strictEqual(requestUrl, "/api/chats/chat%2Fwith%23hash/steer");
  });

  it("encodes queue route params before calling Hono RPC", async () => {
    let requestUrl: string | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        requestUrl =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;
        return new Response('{"chat":{"id":"chat_1"}}', {
          headers: {
            "Content-Type": "application/json",
          },
          status: 200,
        });
      }),
    );

    await queueMessageMutation("chat/with#hash", { text: "later" });

    strictEqual(requestUrl, "/api/chats/chat%2Fwith%23hash/queue");
  });

  it("encodes pending message delete route params before calling Hono RPC", async () => {
    let requestUrl: string | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        requestUrl =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;
        return new Response('{"message":{"id":"msg_1","text":"draft"}}', {
          headers: {
            "Content-Type": "application/json",
          },
          status: 200,
        });
      }),
    );

    await deletePendingMessageMutation("chat/with#hash", "msg/with#hash");

    strictEqual(
      requestUrl,
      "/api/chats/chat%2Fwith%23hash/messages/msg%2Fwith%23hash",
    );
  });

  it("encodes pending message restore route params before calling Hono RPC", async () => {
    let requestUrl: string | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        requestUrl =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;
        return new Response('{"message":{"id":"msg_1","text":"draft"}}', {
          headers: {
            "Content-Type": "application/json",
          },
          status: 200,
        });
      }),
    );

    await restorePendingMessageMutation("chat/with#hash", {
      message: {
        id: "msg/with#hash",
        chatId: "chat/with#hash",
        role: "user",
        text: "draft",
        eventType: "chat.message.queued",
        createdAt: "2026-05-04T00:00:00.000Z",
      },
      messageIndex: 0,
      queuedMessage: {
        id: "queue_1",
        chatId: "chat/with#hash",
        messageId: "msg/with#hash",
        text: "draft",
        createdAt: "2026-05-04T00:00:00.000Z",
      },
      queuedMessageIndex: 0,
    });

    strictEqual(
      requestUrl,
      "/api/chats/chat%2Fwith%23hash/messages/msg%2Fwith%23hash/restore",
    );
  });
});
