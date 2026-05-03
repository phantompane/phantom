import { strictEqual } from "node:assert";
import { describe, it } from "vitest";
import { createTestRouter } from "./router";

describe("createTestRouter", () => {
  it("creates a SPA router at the root route", () => {
    const router = createTestRouter(["/"]);

    strictEqual(router.state.location.pathname, "/");
  });
});
