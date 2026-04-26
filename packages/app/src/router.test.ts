import { describe, expect, it } from "vitest";
import { getRouter } from "./router";
import { routeTree } from "./routeTree.gen";

describe("getRouter", () => {
  it("creates a router with the generated root and index routes", () => {
    const router = getRouter();

    expect(router.routeTree.id).toBe("__root__");
    expect(router.options.defaultPendingComponent).toBeDefined();
    expect(router.options.defaultPendingMs).toBe(300);
    expect(router.options.defaultPendingMinMs).toBe(350);
    expect(router.options.routeTree).toBe(routeTree);
    expect(router.options.scrollRestoration).toBe(true);
  });
});
