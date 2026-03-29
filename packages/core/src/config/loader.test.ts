import assert from "node:assert";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "vitest";
import { isErr, isOk } from "@phantompane/utils";
import { ConfigNotFoundError, ConfigParseError, loadConfig } from "./loader.ts";
import { ConfigValidationError } from "./validate.ts";

describe("loadConfig", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "phantom-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("should load valid config file", async () => {
    const config = {
      postCreate: {
        copyFiles: [".env", "config.json"],
      },
    };
    await writeFile(
      path.join(tempDir, "phantom.config.json"),
      JSON.stringify(config),
    );

    const result = await loadConfig(tempDir);

    assert.strictEqual(isOk(result), true);
    if (isOk(result)) {
      assert.deepStrictEqual(result.value, config);
    }
  });

  test("should return ConfigNotFoundError when file doesn't exist", async () => {
    const result = await loadConfig(tempDir);

    assert.strictEqual(isErr(result), true);
    if (isErr(result)) {
      assert.ok(result.error instanceof ConfigNotFoundError);
    }
  });

  test("should return ConfigParseError for invalid JSON", async () => {
    await writeFile(
      path.join(tempDir, "phantom.config.json"),
      "{ invalid json",
    );

    const result = await loadConfig(tempDir);

    assert.strictEqual(isErr(result), true);
    if (isErr(result)) {
      assert.ok(result.error instanceof ConfigParseError);
    }
  });

  test("should load config with only copyFiles", async () => {
    const config = {
      postCreate: {
        copyFiles: [".env", "config.json"],
      },
    };
    await writeFile(
      path.join(tempDir, "phantom.config.json"),
      JSON.stringify(config),
    );

    const result = await loadConfig(tempDir);

    assert.strictEqual(isOk(result), true);
    if (isOk(result)) {
      assert.deepStrictEqual(result.value, config);
    }
  });

  test("should load empty config", async () => {
    await writeFile(path.join(tempDir, "phantom.config.json"), "{}");

    const result = await loadConfig(tempDir);

    assert.strictEqual(isOk(result), true);
    if (isOk(result)) {
      assert.deepStrictEqual(result.value, {});
    }
  });

  describe("validation", () => {
    test("should return ConfigValidationError when config is not an object", async () => {
      await writeFile(
        path.join(tempDir, "phantom.config.json"),
        JSON.stringify("string config"),
      );

      const result = await loadConfig(tempDir);

      assert.strictEqual(isErr(result), true);
      if (isErr(result)) {
        assert.ok(result.error instanceof ConfigValidationError);
        assert.strictEqual(
          result.error.message,
          "Invalid phantom.config.json: Invalid input: expected object, received string",
        );
      }
    });

    test("should return ConfigValidationError when config is null", async () => {
      await writeFile(path.join(tempDir, "phantom.config.json"), "null");

      const result = await loadConfig(tempDir);

      assert.strictEqual(isErr(result), true);
      if (isErr(result)) {
        assert.ok(result.error instanceof ConfigValidationError);
        assert.strictEqual(
          result.error.message,
          "Invalid phantom.config.json: Invalid input: expected object, received null",
        );
      }
    });

    test("should return ConfigValidationError when postCreate is not an object", async () => {
      await writeFile(
        path.join(tempDir, "phantom.config.json"),
        JSON.stringify({ postCreate: "invalid" }),
      );

      const result = await loadConfig(tempDir);

      assert.strictEqual(isErr(result), true);
      if (isErr(result)) {
        assert.ok(result.error instanceof ConfigValidationError);
        assert.strictEqual(
          result.error.message,
          "Invalid phantom.config.json: postCreate: Invalid input: expected object, received string",
        );
      }
    });

    test("should return ConfigValidationError when postCreate is null", async () => {
      await writeFile(
        path.join(tempDir, "phantom.config.json"),
        JSON.stringify({ postCreate: null }),
      );

      const result = await loadConfig(tempDir);

      assert.strictEqual(isErr(result), true);
      if (isErr(result)) {
        assert.ok(result.error instanceof ConfigValidationError);
        assert.strictEqual(
          result.error.message,
          "Invalid phantom.config.json: postCreate: Invalid input: expected object, received null",
        );
      }
    });

    test("should return ConfigValidationError when copyFiles is not an array", async () => {
      await writeFile(
        path.join(tempDir, "phantom.config.json"),
        JSON.stringify({ postCreate: { copyFiles: "invalid" } }),
      );

      const result = await loadConfig(tempDir);

      assert.strictEqual(isErr(result), true);
      if (isErr(result)) {
        assert.ok(result.error instanceof ConfigValidationError);
        assert.strictEqual(
          result.error.message,
          "Invalid phantom.config.json: postCreate.copyFiles: Invalid input: expected array, received string",
        );
      }
    });

    test("should return ConfigValidationError when copyFiles contains non-string values", async () => {
      await writeFile(
        path.join(tempDir, "phantom.config.json"),
        JSON.stringify({ postCreate: { copyFiles: [123, true] } }),
      );

      const result = await loadConfig(tempDir);

      assert.strictEqual(isErr(result), true);
      if (isErr(result)) {
        assert.ok(result.error instanceof ConfigValidationError);
        assert.strictEqual(
          result.error.message,
          "Invalid phantom.config.json: postCreate.copyFiles.0: Invalid input: expected string, received number",
        );
      }
    });

    test("should accept valid config with postCreate but no copyFiles", async () => {
      await writeFile(
        path.join(tempDir, "phantom.config.json"),
        JSON.stringify({ postCreate: {} }),
      );

      const result = await loadConfig(tempDir);

      assert.strictEqual(isOk(result), true);
      if (isOk(result)) {
        assert.deepStrictEqual(result.value, { postCreate: {} });
      }
    });

    test("should return ConfigValidationError when config is an array", async () => {
      await writeFile(
        path.join(tempDir, "phantom.config.json"),
        JSON.stringify([]),
      );

      const result = await loadConfig(tempDir);

      assert.strictEqual(isErr(result), true);
      if (isErr(result)) {
        assert.ok(result.error instanceof ConfigValidationError);
        assert.strictEqual(
          result.error.message,
          "Invalid phantom.config.json: Invalid input: expected object, received array",
        );
      }
    });
  });
});
