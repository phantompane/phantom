import { strictEqual } from "node:assert";
import { afterEach, describe, it, vi } from "vitest";
import {
  answerApprovalMutation,
  queueMessageMutation,
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
});
