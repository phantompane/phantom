import assert from "node:assert";
import { describe, test } from "vitest";
import { isErr, isOk } from "@phantompane/utils";
import { ConfigValidationError, validateConfig } from "./validate.ts";

describe("validateConfig", () => {
  test("should accept valid config with postCreate and copyFiles", () => {
    const config = {
      postCreate: {
        copyFiles: [".env", "config/local.json"],
      },
    };

    const result = validateConfig(config);

    assert.strictEqual(isOk(result), true);
    if (isOk(result)) {
      assert.deepStrictEqual(result.value, config);
    }
  });

  test("should accept empty config object", () => {
    const config = {};

    const result = validateConfig(config);

    assert.strictEqual(isOk(result), true);
    if (isOk(result)) {
      assert.deepStrictEqual(result.value, config);
    }
  });

  test("should accept config with both postCreate and preDelete", () => {
    const config = {
      postCreate: {
        copyFiles: [".env"],
        commands: ["pnpm install"],
      },
      preDelete: {
        commands: ["docker stop my-container"],
      },
    };

    const result = validateConfig(config);

    assert.strictEqual(isOk(result), true);
    if (isOk(result)) {
      assert.deepStrictEqual(result.value, config);
    }
  });

  test("should accept config with worktreesDirectory and separator", () => {
    const config = {
      worktreesDirectory: "../phantom-worktrees",
      directoryNameSeparator: "-",
    };

    const result = validateConfig(config);

    assert.strictEqual(isOk(result), true);
    if (isOk(result)) {
      assert.deepStrictEqual(result.value, config);
    }
  });

  test("should reject non-object config", () => {
    const result = validateConfig("not an object");

    assert.strictEqual(isErr(result), true);
    if (isErr(result)) {
      assert.ok(result.error instanceof ConfigValidationError);
      assert.strictEqual(
        result.error.message,
        "Invalid phantom.config.json: Invalid input: expected object, received string",
      );
    }
  });

  test("should reject invalid nested properties", () => {
    const result = validateConfig({
      postCreate: {
        copyFiles: [123],
      },
    });

    assert.strictEqual(isErr(result), true);
    if (isErr(result)) {
      assert.ok(result.error instanceof ConfigValidationError);
      assert.strictEqual(
        result.error.message,
        "Invalid phantom.config.json: postCreate.copyFiles.0: Invalid input: expected string, received number",
      );
    }
  });
});
