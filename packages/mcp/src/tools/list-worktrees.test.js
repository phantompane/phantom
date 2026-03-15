import { deepStrictEqual, rejects, strictEqual } from "node:assert";
import { describe, it, mock } from "node:test";
import { z } from "zod";

const listWorktreesMock = mock.fn();
const getGitRootMock = mock.fn();
const isOkMock = mock.fn((result) => {
  return result && result.ok === true;
});
const okMock = mock.fn((value) => ({ ok: true, value }));
const errMock = mock.fn((error) => ({ ok: false, error }));

mock.module("@phantompane/core", {
  namedExports: {
    listWorktrees: listWorktreesMock,
  },
});

mock.module("@phantompane/git", {
  namedExports: {
    getGitRoot: getGitRootMock,
  },
});

mock.module("@phantompane/shared", {
  namedExports: {
    isOk: isOkMock,
    ok: okMock,
    err: errMock,
  },
});

const { listWorktreesTool } = await import("./list-worktrees.ts");

describe("listWorktreesTool", () => {
  const resetMocks = () => {
    listWorktreesMock.mock.resetCalls();
    getGitRootMock.mock.resetCalls();
    isOkMock.mock.resetCalls();
  };

  it("should have correct name and description", () => {
    strictEqual(listWorktreesTool.name, "phantom_list_worktrees");
    strictEqual(
      listWorktreesTool.description,
      "List all Git worktrees (phantoms)",
    );
  });

  it("should have empty input schema", () => {
    const schema = listWorktreesTool.inputSchema;
    strictEqual(schema instanceof z.ZodObject, true);
    deepStrictEqual(Object.keys(schema.shape), []);
  });

  it("should list worktrees successfully", async () => {
    resetMocks();
    const gitRoot = "/path/to/repo";
    const mockWorktrees = [
      {
        name: "main",
        path: "/path/to/repo",
        branch: "main",
        isClean: true,
        isLocked: false,
      },
      {
        name: "feature-1",
        path: "/path/to/repo/.git/phantom/worktrees/feature-1",
        branch: "feature-1",
        isClean: false,
        isLocked: false,
      },
      {
        name: "hotfix-1",
        path: "/path/to/repo/.git/phantom/worktrees/hotfix-1",
        branch: "hotfix-1",
        isClean: true,
        isLocked: true,
      },
    ];

    getGitRootMock.mock.mockImplementation(() => Promise.resolve(gitRoot));
    listWorktreesMock.mock.mockImplementation(() =>
      Promise.resolve(okMock({ worktrees: mockWorktrees })),
    );

    const result = await listWorktreesTool.handler({});

    strictEqual(getGitRootMock.mock.calls.length, 1);
    strictEqual(listWorktreesMock.mock.calls.length, 1);
    deepStrictEqual(listWorktreesMock.mock.calls[0].arguments, [gitRoot]);

    strictEqual(result.content.length, 1);
    strictEqual(result.content[0].type, "text");

    const parsedContent = JSON.parse(result.content[0].text);
    deepStrictEqual(parsedContent, {
      worktrees: [
        {
          name: "main",
          path: "/path/to/repo",
          branch: "main",
          isClean: true,
        },
        {
          name: "feature-1",
          path: "/path/to/repo/.git/phantom/worktrees/feature-1",
          branch: "feature-1",
          isClean: false,
        },
        {
          name: "hotfix-1",
          path: "/path/to/repo/.git/phantom/worktrees/hotfix-1",
          branch: "hotfix-1",
          isClean: true,
        },
      ],
      note: "You can switch to a worktree using 'cd <path>'",
    });
  });

  it("should handle empty worktree list", async () => {
    resetMocks();
    const gitRoot = "/path/to/repo";

    getGitRootMock.mock.mockImplementation(() => Promise.resolve(gitRoot));
    listWorktreesMock.mock.mockImplementation(() =>
      Promise.resolve(okMock({ worktrees: [] })),
    );
    isOkMock.mock.mockImplementation((result) => result.ok === true);

    const result = await listWorktreesTool.handler({});

    const parsedContent = JSON.parse(result.content[0].text);
    deepStrictEqual(parsedContent.worktrees, []);
    strictEqual(
      parsedContent.note,
      "You can switch to a worktree using 'cd <path>'",
    );
  });

  it("should throw error when listWorktrees fails", async () => {
    resetMocks();
    const gitRoot = "/path/to/repo";
    const errorResult = { ok: false, error: { message: "Git command failed" } };

    getGitRootMock.mock.mockImplementation(() => Promise.resolve(gitRoot));
    listWorktreesMock.mock.mockImplementation(() =>
      Promise.resolve(errorResult),
    );

    await rejects(() => listWorktreesTool.handler({}), {
      message: "Failed to list worktrees",
    });
  });

  it("should not require any input parameters", () => {
    const emptyInput = {};
    const parsed = listWorktreesTool.inputSchema.safeParse(emptyInput);
    strictEqual(parsed.success, true);

    const extraInput = { extra: "parameter" };
    const parsedExtra = listWorktreesTool.inputSchema.safeParse(extraInput);
    strictEqual(parsedExtra.success, true);
  });
});
