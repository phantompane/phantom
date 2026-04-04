import { describe, expect, it } from "vitest";
import { api } from "./api.ts";

describe("api", () => {
  it("returns health payload", async () => {
    const response = await api.request("http://localhost/api/health");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      message: "Phantom server is healthy",
      runtime: "hono",
    });
  });
});
