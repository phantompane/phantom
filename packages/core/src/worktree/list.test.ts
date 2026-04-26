import { deepStrictEqual, ok } from "node:assert";
import { normalize } from "node:path";
import { describe, it, vi } from "vitest";

const gitListWorktreesMock = vi.fn();
const getStatusMock = vi.fn();

const mockCwd = () =>
  vi.spyOn(process, "cwd").mockImplementation(() => "/test/repo");

vi.doMock("@phantompane/git", () => ({
  listWorktrees: gitListWorktreesMock,
  getStatus: getStatusMock,
  getCurrentBranch: vi.fn(),
}));

const { listWorktrees } = await import("./list.ts");

const normalizeWorktrees = (
  worktrees: Array<{
    name: string;
    path: string;
    pathToDisplay: string;
    branch: string;
    isClean: boolean;
  }>,
) =>
  worktrees.map((worktree) => ({
    ...worktree,
    path: normalize(worktree.path),
    pathToDisplay: normalize(worktree.pathToDisplay),
  }));

const cleanStatus = () => ({
  entries: [],
  isClean: true,
});

const dirtyStatus = (path: string) => ({
  entries: [
    {
      indexStatus: "M",
      workingTreeStatus: " ",
      path,
      originalPath: undefined,
    },
  ],
  isClean: false,
});

describe("listWorktrees", () => {
  const resetMocks = () => {
    gitListWorktreesMock.mockReset();
    getStatusMock.mockReset();
  };

  it("includes the root worktree when only the main worktree exists", async () => {
    resetMocks();
    const cwdMock = mockCwd();
    gitListWorktreesMock.mockResolvedValue([
      {
        path: "/test/repo",
        branch: "main",
        head: "abc123",
        isLocked: false,
        isPrunable: false,
      },
    ]);
    getStatusMock.mockResolvedValue(cleanStatus());

    const result = await listWorktrees("/test/repo");

    ok(result.ok);
    if (result.ok) {
      deepStrictEqual(
        normalizeWorktrees(result.value.worktrees),
        normalizeWorktrees([
          {
            name: "main",
            path: "/test/repo",
            pathToDisplay: ".",
            branch: "main",
            isClean: true,
          },
        ]),
      );
    }

    cwdMock.mockRestore();
  });

  it("returns an empty list when excluding the default worktree", async () => {
    resetMocks();
    gitListWorktreesMock.mockResolvedValue([
      {
        path: "/test/repo",
        branch: "main",
        head: "abc123",
        isLocked: false,
        isPrunable: false,
      },
    ]);

    const result = await listWorktrees("/test/repo", {
      excludeDefault: true,
    });

    ok(result.ok);
    if (result.ok) {
      deepStrictEqual(result.value.worktrees, []);
      deepStrictEqual(result.value.message, "No sub worktrees found");
    }
  });

  it("maps clean and dirty worktrees", async () => {
    resetMocks();
    const cwdMock = mockCwd();
    gitListWorktreesMock.mockResolvedValue([
      {
        path: "/test/repo",
        branch: "main",
        head: "abc123",
        isLocked: false,
        isPrunable: false,
      },
      {
        path: "/test/repo/.git/phantom/worktrees/feature-1",
        branch: "feature-1",
        head: "def456",
        isLocked: false,
        isPrunable: false,
      },
      {
        path: "/test/repo/.git/phantom/worktrees/dirty-feature",
        branch: "dirty-feature",
        head: "ghi789",
        isLocked: false,
        isPrunable: false,
      },
    ]);
    getStatusMock.mockImplementation(({ cwd }: { cwd: string }) =>
      Promise.resolve(
        cwd.endsWith("/dirty-feature")
          ? dirtyStatus("file.txt")
          : cleanStatus(),
      ),
    );

    const result = await listWorktrees("/test/repo");

    ok(result.ok);
    if (result.ok) {
      deepStrictEqual(
        normalizeWorktrees(result.value.worktrees),
        normalizeWorktrees([
          {
            name: "main",
            path: "/test/repo",
            pathToDisplay: ".",
            branch: "main",
            isClean: true,
          },
          {
            name: "feature-1",
            path: "/test/repo/.git/phantom/worktrees/feature-1",
            pathToDisplay: ".git/phantom/worktrees/feature-1",
            branch: "feature-1",
            isClean: true,
          },
          {
            name: "dirty-feature",
            path: "/test/repo/.git/phantom/worktrees/dirty-feature",
            pathToDisplay: ".git/phantom/worktrees/dirty-feature",
            branch: "dirty-feature",
            isClean: false,
          },
        ]),
      );
    }

    cwdMock.mockRestore();
  });

  it("uses the short HEAD for detached worktrees", async () => {
    resetMocks();
    const cwdMock = mockCwd();
    gitListWorktreesMock.mockResolvedValue([
      {
        path: "/test/repo",
        branch: "main",
        head: "abc123",
        isLocked: false,
        isPrunable: false,
      },
      {
        path: "/test/repo/.git/phantom/worktrees/detached",
        branch: "(detached HEAD)",
        head: "def4567890",
        isLocked: false,
        isPrunable: false,
      },
    ]);
    getStatusMock.mockResolvedValue(cleanStatus());

    const result = await listWorktrees("/test/repo");

    ok(result.ok);
    if (result.ok) {
      deepStrictEqual(
        normalizeWorktrees(result.value.worktrees),
        normalizeWorktrees([
          {
            name: "main",
            path: "/test/repo",
            pathToDisplay: ".",
            branch: "main",
            isClean: true,
          },
          {
            name: "def4567",
            path: "/test/repo/.git/phantom/worktrees/detached",
            pathToDisplay: ".git/phantom/worktrees/detached",
            branch: "def4567",
            isClean: true,
          },
        ]),
      );
    }

    cwdMock.mockRestore();
  });

  it("includes prunable worktrees by default for validation and cleanup flows", async () => {
    resetMocks();
    const cwdMock = mockCwd();
    gitListWorktreesMock.mockResolvedValue([
      {
        path: "/test/repo",
        branch: "main",
        head: "abc123",
        isLocked: false,
        isPrunable: false,
      },
      {
        path: "/test/repo/.git/phantom/worktrees/stale-feature",
        branch: "stale-feature",
        head: "def456",
        isLocked: false,
        isPrunable: true,
      },
      {
        path: "/test/repo/.git/phantom/worktrees/active-feature",
        branch: "active-feature",
        head: "ghi789",
        isLocked: false,
        isPrunable: false,
      },
    ]);
    getStatusMock.mockResolvedValue(cleanStatus());

    const result = await listWorktrees("/test/repo");

    ok(result.ok);
    if (result.ok) {
      deepStrictEqual(
        normalizeWorktrees(result.value.worktrees),
        normalizeWorktrees([
          {
            name: "main",
            path: "/test/repo",
            pathToDisplay: ".",
            branch: "main",
            isClean: true,
          },
          {
            name: "stale-feature",
            path: "/test/repo/.git/phantom/worktrees/stale-feature",
            pathToDisplay: ".git/phantom/worktrees/stale-feature",
            branch: "stale-feature",
            isClean: true,
          },
          {
            name: "active-feature",
            path: "/test/repo/.git/phantom/worktrees/active-feature",
            pathToDisplay: ".git/phantom/worktrees/active-feature",
            branch: "active-feature",
            isClean: true,
          },
        ]),
      );
    }

    cwdMock.mockRestore();
  });

  it("excludes prunable worktrees from display-oriented lists", async () => {
    resetMocks();
    const cwdMock = mockCwd();
    gitListWorktreesMock.mockResolvedValue([
      {
        path: "/test/repo",
        branch: "main",
        head: "abc123",
        isLocked: false,
        isPrunable: false,
      },
      {
        path: "/test/repo/.git/phantom/worktrees/stale-feature",
        branch: "stale-feature",
        head: "def456",
        isLocked: false,
        isPrunable: true,
      },
      {
        path: "/test/repo/.git/phantom/worktrees/active-feature",
        branch: "active-feature",
        head: "ghi789",
        isLocked: false,
        isPrunable: false,
      },
    ]);
    getStatusMock.mockResolvedValue(cleanStatus());

    const result = await listWorktrees("/test/repo", {
      includePrunable: false,
    });

    ok(result.ok);
    if (result.ok) {
      deepStrictEqual(
        normalizeWorktrees(result.value.worktrees),
        normalizeWorktrees([
          {
            name: "main",
            path: "/test/repo",
            pathToDisplay: ".",
            branch: "main",
            isClean: true,
          },
          {
            name: "active-feature",
            path: "/test/repo/.git/phantom/worktrees/active-feature",
            pathToDisplay: ".git/phantom/worktrees/active-feature",
            branch: "active-feature",
            isClean: true,
          },
        ]),
      );
    }

    cwdMock.mockRestore();
  });

  it("includes non-phantom worktrees and sibling paths", async () => {
    resetMocks();
    const cwdMock = mockCwd();
    gitListWorktreesMock.mockResolvedValue([
      {
        path: "/test/repo",
        branch: "main",
        head: "abc123",
        isLocked: false,
        isPrunable: false,
      },
      {
        path: "/test/repo/.git/phantom/worktrees/phantom-feature",
        branch: "phantom-feature",
        head: "def456",
        isLocked: false,
        isPrunable: false,
      },
      {
        path: "/test/repo/other-worktree",
        branch: "other-feature",
        head: "ghi789",
        isLocked: false,
        isPrunable: false,
      },
      {
        path: "/test/other-worktree-sibling",
        branch: "sibling-feature",
        head: "jkl012",
        isLocked: false,
        isPrunable: false,
      },
    ]);
    getStatusMock.mockResolvedValue(cleanStatus());

    const result = await listWorktrees("/test/repo");

    ok(result.ok);
    if (result.ok) {
      deepStrictEqual(
        normalizeWorktrees(result.value.worktrees),
        normalizeWorktrees([
          {
            name: "main",
            path: "/test/repo",
            pathToDisplay: ".",
            branch: "main",
            isClean: true,
          },
          {
            name: "phantom-feature",
            path: "/test/repo/.git/phantom/worktrees/phantom-feature",
            pathToDisplay: ".git/phantom/worktrees/phantom-feature",
            branch: "phantom-feature",
            isClean: true,
          },
          {
            name: "other-feature",
            path: "/test/repo/other-worktree",
            pathToDisplay: "other-worktree",
            branch: "other-feature",
            isClean: true,
          },
          {
            name: "sibling-feature",
            path: "/test/other-worktree-sibling",
            pathToDisplay: "../other-worktree-sibling",
            branch: "sibling-feature",
            isClean: true,
          },
        ]),
      );
    }

    cwdMock.mockRestore();
  });

  it("returns a message when no worktrees are returned", async () => {
    resetMocks();
    gitListWorktreesMock.mockResolvedValue([]);

    const result = await listWorktrees("/test/repo");

    ok(result.ok);
    if (result.ok) {
      deepStrictEqual(result.value.worktrees, []);
      deepStrictEqual(result.value.message, "No worktrees found");
    }
  });
});
