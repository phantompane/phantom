import { deepStrictEqual } from "node:assert";
import { describe, it } from "vitest";
import { validateWorktreeName } from "./validate.ts";

describe("validateWorktreeName", () => {
  it("should reject empty name", () => {
    const result = validateWorktreeName("");
    deepStrictEqual(result.ok, false);
    deepStrictEqual(result.error?.message, "Phantom name cannot be empty");
  });

  it("should reject whitespace-only name", () => {
    const result = validateWorktreeName("   ");
    deepStrictEqual(result.ok, false);
    deepStrictEqual(result.error?.message, "Phantom name cannot be empty");
  });

  it("should reject names with invalid characters", () => {
    const invalidNames = [
      "feature@branch",
      "feature#123",
      "feature branch",
      "feature!test",
      "feature~test",
      "feature$test",
      "feature%test",
      "feature^test",
      "feature&test",
      "feature*test",
      "feature(test)",
      "feature[test]",
      "feature{test}",
      "feature|test",
      "feature\\test",
      "feature:test",
      "feature;test",
      "feature'test",
      'feature"test',
      "feature<test>",
      "feature?test",
    ];

    for (const name of invalidNames) {
      const result = validateWorktreeName(name);
      deepStrictEqual(result.ok, false, `Should reject "${name}"`);
      deepStrictEqual(
        result.error?.message,
        "Phantom name can only contain letters, numbers, hyphens, underscores, dots, and slashes",
        `Should have correct error message for "${name}"`,
      );
    }
  });

  it("should reject consecutive dots", () => {
    const result = validateWorktreeName("feature..branch");
    deepStrictEqual(result.ok, false);
    deepStrictEqual(
      result.error?.message,
      "Phantom name cannot contain consecutive dots",
    );
  });

  it("should accept valid names", () => {
    const validNames = [
      "my-feature",
      "feature_123",
      "FEATURE-456",
      "feature.v2",
      "feature/user-authentication",
      "bugfix/header-layout",
      "release/v2.0.0",
      "hotfix/critical-bug",
      "chore/update-dependencies",
      "docs/readme-update",
      "feature/auth/login-page",
      "123-feature",
      "a",
      "A",
      "0",
      "_underscore",
      "-hyphen",
      ".hidden",
      "/slash/start",
      "slash/end/",
      "multiple//slashes",
      "dots.in.name",
      "mix-of_all.allowed/chars123",
    ];

    for (const name of validNames) {
      const result = validateWorktreeName(name);
      deepStrictEqual(result.ok, true, `Should accept "${name}"`);
    }
  });
});
