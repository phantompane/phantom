import { describe, expect, it } from "vitest";
import { app } from "./app.ts";

describe("server app", () => {
  it("exposes the RPC status endpoint", async () => {
    const response = await app.request("/api/rpc/status");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({});
  });
});
