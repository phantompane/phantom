import { deepEqual, equal, rejects } from "node:assert/strict";
import { test, vi } from "vitest";

const githubCheckoutMock = vi.fn();

vi.doMock("@phantompane/core", () => ({
  githubCheckout: githubCheckoutMock,
}));

const { githubCheckoutTool } = await import("./github-checkout.ts");

const handlerExtra = {} as never;

test("githubCheckoutTool has correct metadata", () => {
  equal(githubCheckoutTool.name, "phantom_github_checkout");
  equal(
    githubCheckoutTool.description,
    "Checkout a GitHub issue or pull request by number into a new worktree",
  );
});

test("githubCheckoutTool schema validates number parameter", () => {
  const validInput = { number: "123" };
  const result = githubCheckoutTool.inputSchema.safeParse(validInput);
  equal(result.success, true);
  if (result.success) {
    deepEqual(result.data, { number: "123" });
  }
});

test("githubCheckoutTool schema validates with optional base parameter", () => {
  const validInput = { number: "456", base: "develop" };
  const result = githubCheckoutTool.inputSchema.safeParse(validInput);
  equal(result.success, true);
  if (result.success) {
    deepEqual(result.data, { number: "456", base: "develop" });
  }
});

test("githubCheckoutTool schema rejects invalid input", () => {
  const invalidInput = { notANumber: "foo" };
  const result = githubCheckoutTool.inputSchema.safeParse(invalidInput);
  equal(result.success, false);
});

test("githubCheckoutTool schema rejects missing number", () => {
  const invalidInput = { base: "main" };
  const result = githubCheckoutTool.inputSchema.safeParse(invalidInput);
  equal(result.success, false);
});

test("githubCheckoutTool handler checks out a GitHub target", async () => {
  githubCheckoutMock.mockClear();
  githubCheckoutMock.mockImplementation(async () => ({
    ok: true,
    value: {
      message: "Checked out issue #123",
      worktree: "issues/123",
      path: "/repo/.git/phantom/worktrees/issues/123",
    },
  }));

  const result = await githubCheckoutTool.handler(
    { number: "123", base: "develop" },
    handlerExtra,
  );

  deepEqual(githubCheckoutMock.mock.calls, [
    [{ number: "123", base: "develop" }],
  ]);

  equal(result.content.length, 1);
  const [content] = result.content;
  equal(content.type, "text");
  if (content.type !== "text") {
    throw new Error("Expected text content");
  }

  deepEqual(JSON.parse(content.text), {
    success: true,
    message: "Successfully checked out #123 to worktree 'issues/123'.",
    worktree: "issues/123",
    path: "/repo/.git/phantom/worktrees/issues/123",
    note: "You can now switch to the worktree using 'cd /repo/.git/phantom/worktrees/issues/123'",
  });
});

test("githubCheckoutTool handler reports checkout errors", async () => {
  githubCheckoutMock.mockClear();
  githubCheckoutMock.mockImplementation(async () => ({
    ok: false,
    error: new Error("GitHub API error"),
  }));

  await rejects(
    async () =>
      await githubCheckoutTool.handler({ number: "123" }, handlerExtra),
    /GitHub API error/,
  );
});
