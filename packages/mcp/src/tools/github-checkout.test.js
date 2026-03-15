import { deepEqual, equal } from "node:assert/strict";
import { test } from "vitest";
import { githubCheckoutTool } from "./github-checkout.ts";

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
