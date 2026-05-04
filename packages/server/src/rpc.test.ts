import { deepStrictEqual, strictEqual } from "node:assert";
import { beforeEach, describe, it, vi } from "vitest";

const services = vi.hoisted(() => ({
  addProject: vi.fn(),
  createChat: vi.fn(),
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
});
