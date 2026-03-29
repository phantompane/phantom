import { deepStrictEqual, rejects, strictEqual } from "node:assert";
import { describe, it, vi } from "vitest";
import { z } from "zod";

const listWorktreesMock = vi.fn();
const getGitRootMock = vi.fn();
const isOkMock = vi.fn((result) => {
  return result && result.ok === true;
});
const okMock = vi.fn((value) => ({ ok: true, value }));
const errMock = vi.fn((error) => ({ ok: false, error }));

vi.doMock("@phantompane/core", () => ({
  listWorktrees: listWorktreesMock,
}));

vi.doMock("@phantompane/git", () => ({
  getGitRoot: getGitRootMock,
}));

vi.doMock("@phantompane/utils", () => ({
  isOk: isOkMock,
  ok: okMock,
  err: errMock,
}));

const { listWorktreesTool } = await import("./list-worktrees.ts");

const handlerExtra = {} as never;

function getTextContent(result: {
  content: Array<{ type: "text"; text: string } | { type: string }>;
}) {
  const [content] = result.content;
  strictEqual(content.type, "text");

  if (content.type !== "text") {
    throw new Error("Expected text content");
  }

  return (content as { type: "text"; text: string }).text;
}

describe("listWorktreesTool", () => {
  const resetMocks = () => {
    listWorktreesMock.mockClear();
    getGitRootMock.mockClear();
    isOkMock.mockClear();
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

    getGitRootMock.mockImplementation(() => Promise.resolve(gitRoot));
    listWorktreesMock.mockImplementation(() =>
      Promise.resolve(okMock({ worktrees: mockWorktrees })),
    );

    const result = await listWorktreesTool.handler({}, handlerExtra);

    strictEqual(getGitRootMock.mock.calls.length, 1);
    strictEqual(listWorktreesMock.mock.calls.length, 1);
    deepStrictEqual(listWorktreesMock.mock.calls[0], [gitRoot]);

    strictEqual(result.content.length, 1);
    strictEqual(result.content[0].type, "text");

    const parsedContent = JSON.parse(getTextContent(result));
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

    getGitRootMock.mockImplementation(() => Promise.resolve(gitRoot));
    listWorktreesMock.mockImplementation(() =>
      Promise.resolve(okMock({ worktrees: [] })),
    );
    isOkMock.mockImplementation((result) => result.ok === true);

    const result = await listWorktreesTool.handler({}, handlerExtra);

    const parsedContent = JSON.parse(getTextContent(result));
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

    getGitRootMock.mockImplementation(() => Promise.resolve(gitRoot));
    listWorktreesMock.mockImplementation(() => Promise.resolve(errorResult));

    await rejects(async () => listWorktreesTool.handler({}, handlerExtra), {
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
