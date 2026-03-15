import assert from "node:assert";
import { describe, test } from "node:test";
import { isErr, isOk } from "@phantompane/shared";
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

  test("should accept config with empty postCreate", () => {
    const config = {
      postCreate: {},
    };

    const result = validateConfig(config);

    assert.strictEqual(isOk(result), true);
    if (isOk(result)) {
      assert.deepStrictEqual(result.value, config);
    }
  });

  test("should accept config with empty copyFiles array", () => {
    const config = {
      postCreate: {
        copyFiles: [],
      },
    };

    const result = validateConfig(config);

    assert.strictEqual(isOk(result), true);
    if (isOk(result)) {
      assert.deepStrictEqual(result.value, config);
    }
  });

  test("should accept valid config with postCreate and commands", () => {
    const config = {
      postCreate: {
        commands: ["pnpm install", "pnpm build"],
      },
    };

    const result = validateConfig(config);

    assert.strictEqual(isOk(result), true);
    if (isOk(result)) {
      assert.deepStrictEqual(result.value, config);
    }
  });

  test("should accept config with both copyFiles and commands", () => {
    const config = {
      postCreate: {
        copyFiles: [".env"],
        commands: ["pnpm install"],
      },
    };

    const result = validateConfig(config);

    assert.strictEqual(isOk(result), true);
    if (isOk(result)) {
      assert.deepStrictEqual(result.value, config);
    }
  });

  test("should accept valid config with preDelete commands", () => {
    const config = {
      preDelete: {
        commands: ["docker compose down", "rm -rf temp"],
      },
    };

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

  test("should accept config with empty preDelete", () => {
    const config = {
      preDelete: {},
    };

    const result = validateConfig(config);

    assert.strictEqual(isOk(result), true);
    if (isOk(result)) {
      assert.deepStrictEqual(result.value, config);
    }
  });

  test("should accept config with empty preDelete commands array", () => {
    const config = {
      preDelete: {
        commands: [],
      },
    };

    const result = validateConfig(config);

    assert.strictEqual(isOk(result), true);
    if (isOk(result)) {
      assert.deepStrictEqual(result.value, config);
    }
  });

  test("should accept config with worktreesDirectory", () => {
    const config = {
      worktreesDirectory: "../phantom-worktrees",
    };

    const result = validateConfig(config);

    assert.strictEqual(isOk(result), true);
    if (isOk(result)) {
      assert.deepStrictEqual(result.value, config);
    }
  });

  test("should accept config with absolute worktreesDirectory", () => {
    const config = {
      worktreesDirectory: "/tmp/phantom-worktrees",
    };

    const result = validateConfig(config);

    assert.strictEqual(isOk(result), true);
    if (isOk(result)) {
      assert.deepStrictEqual(result.value, config);
    }
  });

  test("should accept config with worktreesDirectory and postCreate", () => {
    const config = {
      worktreesDirectory: "../custom-phantom",
      postCreate: {
        copyFiles: [".env"],
        commands: ["pnpm install"],
      },
    };

    const result = validateConfig(config);

    assert.strictEqual(isOk(result), true);
    if (isOk(result)) {
      assert.deepStrictEqual(result.value, config);
    }
  });

  test("should accept config with empty commands array", () => {
    const config = {
      postCreate: {
        commands: [],
      },
    };

    const result = validateConfig(config);

    assert.strictEqual(isOk(result), true);
    if (isOk(result)) {
      assert.deepStrictEqual(result.value, config);
    }
  });

  describe("error cases", () => {
    test("should reject string config", () => {
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

    test("should reject number config", () => {
      const result = validateConfig(123);

      assert.strictEqual(isErr(result), true);
      if (isErr(result)) {
        assert.ok(result.error instanceof ConfigValidationError);
        assert.strictEqual(
          result.error.message,
          "Invalid phantom.config.json: Invalid input: expected object, received number",
        );
      }
    });

    test("should reject boolean config", () => {
      const result = validateConfig(true);

      assert.strictEqual(isErr(result), true);
      if (isErr(result)) {
        assert.ok(result.error instanceof ConfigValidationError);
        assert.strictEqual(
          result.error.message,
          "Invalid phantom.config.json: Invalid input: expected object, received boolean",
        );
      }
    });

    test("should reject null config", () => {
      const result = validateConfig(null);

      assert.strictEqual(isErr(result), true);
      if (isErr(result)) {
        assert.ok(result.error instanceof ConfigValidationError);
        assert.strictEqual(
          result.error.message,
          "Invalid phantom.config.json: Invalid input: expected object, received null",
        );
      }
    });

    test("should reject undefined config", () => {
      const result = validateConfig(undefined);

      assert.strictEqual(isErr(result), true);
      if (isErr(result)) {
        assert.ok(result.error instanceof ConfigValidationError);
        assert.strictEqual(
          result.error.message,
          "Invalid phantom.config.json: Invalid input: expected object, received undefined",
        );
      }
    });

    test("should reject array config", () => {
      const result = validateConfig([]);

      assert.strictEqual(isErr(result), true);
      if (isErr(result)) {
        assert.ok(result.error instanceof ConfigValidationError);
        assert.strictEqual(
          result.error.message,
          "Invalid phantom.config.json: Invalid input: expected object, received array",
        );
      }
    });

    test("should reject when postCreate is string", () => {
      const result = validateConfig({ postCreate: "invalid" });

      assert.strictEqual(isErr(result), true);
      if (isErr(result)) {
        assert.ok(result.error instanceof ConfigValidationError);
        assert.strictEqual(
          result.error.message,
          "Invalid phantom.config.json: postCreate: Invalid input: expected object, received string",
        );
      }
    });

    test("should reject when postCreate is number", () => {
      const result = validateConfig({ postCreate: 123 });

      assert.strictEqual(isErr(result), true);
      if (isErr(result)) {
        assert.ok(result.error instanceof ConfigValidationError);
        assert.strictEqual(
          result.error.message,
          "Invalid phantom.config.json: postCreate: Invalid input: expected object, received number",
        );
      }
    });

    test("should reject when postCreate is array", () => {
      const result = validateConfig({ postCreate: [] });

      assert.strictEqual(isErr(result), true);
      if (isErr(result)) {
        assert.ok(result.error instanceof ConfigValidationError);
        assert.strictEqual(
          result.error.message,
          "Invalid phantom.config.json: postCreate: Invalid input: expected object, received array",
        );
      }
    });

    test("should reject when postCreate is null", () => {
      const result = validateConfig({ postCreate: null });

      assert.strictEqual(isErr(result), true);
      if (isErr(result)) {
        assert.ok(result.error instanceof ConfigValidationError);
        assert.strictEqual(
          result.error.message,
          "Invalid phantom.config.json: postCreate: Invalid input: expected object, received null",
        );
      }
    });

    test("should reject when copyFiles is string", () => {
      const result = validateConfig({ postCreate: { copyFiles: "invalid" } });

      assert.strictEqual(isErr(result), true);
      if (isErr(result)) {
        assert.ok(result.error instanceof ConfigValidationError);
        assert.strictEqual(
          result.error.message,
          "Invalid phantom.config.json: postCreate.copyFiles: Invalid input: expected array, received string",
        );
      }
    });

    test("should reject when copyFiles is number", () => {
      const result = validateConfig({ postCreate: { copyFiles: 123 } });

      assert.strictEqual(isErr(result), true);
      if (isErr(result)) {
        assert.ok(result.error instanceof ConfigValidationError);
        assert.strictEqual(
          result.error.message,
          "Invalid phantom.config.json: postCreate.copyFiles: Invalid input: expected array, received number",
        );
      }
    });

    test("should reject when copyFiles is object", () => {
      const result = validateConfig({ postCreate: { copyFiles: {} } });

      assert.strictEqual(isErr(result), true);
      if (isErr(result)) {
        assert.ok(result.error instanceof ConfigValidationError);
        assert.strictEqual(
          result.error.message,
          "Invalid phantom.config.json: postCreate.copyFiles: Invalid input: expected array, received object",
        );
      }
    });

    test("should reject when copyFiles contains non-string values", () => {
      const result = validateConfig({
        postCreate: { copyFiles: ["file1", 123] },
      });

      assert.strictEqual(isErr(result), true);
      if (isErr(result)) {
        assert.ok(result.error instanceof ConfigValidationError);
        assert.strictEqual(
          result.error.message,
          "Invalid phantom.config.json: postCreate.copyFiles.1: Invalid input: expected string, received number",
        );
      }
    });

    test("should reject when copyFiles contains null", () => {
      const result = validateConfig({
        postCreate: { copyFiles: ["file1", null] },
      });

      assert.strictEqual(isErr(result), true);
      if (isErr(result)) {
        assert.ok(result.error instanceof ConfigValidationError);
        assert.strictEqual(
          result.error.message,
          "Invalid phantom.config.json: postCreate.copyFiles.1: Invalid input: expected string, received null",
        );
      }
    });

    test("should reject when copyFiles contains undefined", () => {
      const result = validateConfig({
        postCreate: { copyFiles: ["file1", undefined] },
      });

      assert.strictEqual(isErr(result), true);
      if (isErr(result)) {
        assert.ok(result.error instanceof ConfigValidationError);
        assert.strictEqual(
          result.error.message,
          "Invalid phantom.config.json: postCreate.copyFiles.1: Invalid input: expected string, received undefined",
        );
      }
    });

    test("should reject when copyFiles contains objects", () => {
      const result = validateConfig({
        postCreate: { copyFiles: ["file1", {}] },
      });

      assert.strictEqual(isErr(result), true);
      if (isErr(result)) {
        assert.ok(result.error instanceof ConfigValidationError);
        assert.strictEqual(
          result.error.message,
          "Invalid phantom.config.json: postCreate.copyFiles.1: Invalid input: expected string, received object",
        );
      }
    });

    test("should reject when copyFiles contains arrays", () => {
      const result = validateConfig({
        postCreate: { copyFiles: [[]] },
      });

      assert.strictEqual(isErr(result), true);
      if (isErr(result)) {
        assert.ok(result.error instanceof ConfigValidationError);
        assert.strictEqual(
          result.error.message,
          "Invalid phantom.config.json: postCreate.copyFiles.0: Invalid input: expected string, received array",
        );
      }
    });

    test("should reject when commands is string", () => {
      const result = validateConfig({ postCreate: { commands: "invalid" } });

      assert.strictEqual(isErr(result), true);
      if (isErr(result)) {
        assert.ok(result.error instanceof ConfigValidationError);
        assert.strictEqual(
          result.error.message,
          "Invalid phantom.config.json: postCreate.commands: Invalid input: expected array, received string",
        );
      }
    });

    test("should reject when commands is number", () => {
      const result = validateConfig({ postCreate: { commands: 123 } });

      assert.strictEqual(isErr(result), true);
      if (isErr(result)) {
        assert.ok(result.error instanceof ConfigValidationError);
        assert.strictEqual(
          result.error.message,
          "Invalid phantom.config.json: postCreate.commands: Invalid input: expected array, received number",
        );
      }
    });

    test("should reject when commands is object", () => {
      const result = validateConfig({ postCreate: { commands: {} } });

      assert.strictEqual(isErr(result), true);
      if (isErr(result)) {
        assert.ok(result.error instanceof ConfigValidationError);
        assert.strictEqual(
          result.error.message,
          "Invalid phantom.config.json: postCreate.commands: Invalid input: expected array, received object",
        );
      }
    });

    test("should reject when commands contains non-string values", () => {
      const result = validateConfig({
        postCreate: { commands: ["pnpm install", 123] },
      });

      assert.strictEqual(isErr(result), true);
      if (isErr(result)) {
        assert.ok(result.error instanceof ConfigValidationError);
        assert.strictEqual(
          result.error.message,
          "Invalid phantom.config.json: postCreate.commands.1: Invalid input: expected string, received number",
        );
      }
    });

    test("should reject when commands contains null", () => {
      const result = validateConfig({
        postCreate: { commands: ["pnpm install", null] },
      });

      assert.strictEqual(isErr(result), true);
      if (isErr(result)) {
        assert.ok(result.error instanceof ConfigValidationError);
        assert.strictEqual(
          result.error.message,
          "Invalid phantom.config.json: postCreate.commands.1: Invalid input: expected string, received null",
        );
      }
    });

    test("should reject when commands contains objects", () => {
      const result = validateConfig({
        postCreate: { commands: ["pnpm install", {}] },
      });

      assert.strictEqual(isErr(result), true);
      if (isErr(result)) {
        assert.ok(result.error instanceof ConfigValidationError);
        assert.strictEqual(
          result.error.message,
          "Invalid phantom.config.json: postCreate.commands.1: Invalid input: expected string, received object",
        );
      }
    });

    test("should reject when preDelete is string", () => {
      const result = validateConfig({ preDelete: "invalid" });

      assert.strictEqual(isErr(result), true);
      if (isErr(result)) {
        assert.ok(result.error instanceof ConfigValidationError);
        assert.strictEqual(
          result.error.message,
          "Invalid phantom.config.json: preDelete: Invalid input: expected object, received string",
        );
      }
    });

    test("should reject when preDelete is number", () => {
      const result = validateConfig({ preDelete: 123 });

      assert.strictEqual(isErr(result), true);
      if (isErr(result)) {
        assert.ok(result.error instanceof ConfigValidationError);
        assert.strictEqual(
          result.error.message,
          "Invalid phantom.config.json: preDelete: Invalid input: expected object, received number",
        );
      }
    });

    test("should reject when preDelete is array", () => {
      const result = validateConfig({ preDelete: [] });

      assert.strictEqual(isErr(result), true);
      if (isErr(result)) {
        assert.ok(result.error instanceof ConfigValidationError);
        assert.strictEqual(
          result.error.message,
          "Invalid phantom.config.json: preDelete: Invalid input: expected object, received array",
        );
      }
    });

    test("should reject when preDelete is null", () => {
      const result = validateConfig({ preDelete: null });

      assert.strictEqual(isErr(result), true);
      if (isErr(result)) {
        assert.ok(result.error instanceof ConfigValidationError);
        assert.strictEqual(
          result.error.message,
          "Invalid phantom.config.json: preDelete: Invalid input: expected object, received null",
        );
      }
    });

    test("should reject when preDelete commands is string", () => {
      const result = validateConfig({ preDelete: { commands: "invalid" } });

      assert.strictEqual(isErr(result), true);
      if (isErr(result)) {
        assert.ok(result.error instanceof ConfigValidationError);
        assert.strictEqual(
          result.error.message,
          "Invalid phantom.config.json: preDelete.commands: Invalid input: expected array, received string",
        );
      }
    });

    test("should reject when preDelete commands is number", () => {
      const result = validateConfig({ preDelete: { commands: 123 } });

      assert.strictEqual(isErr(result), true);
      if (isErr(result)) {
        assert.ok(result.error instanceof ConfigValidationError);
        assert.strictEqual(
          result.error.message,
          "Invalid phantom.config.json: preDelete.commands: Invalid input: expected array, received number",
        );
      }
    });

    test("should reject when preDelete commands is object", () => {
      const result = validateConfig({ preDelete: { commands: {} } });

      assert.strictEqual(isErr(result), true);
      if (isErr(result)) {
        assert.ok(result.error instanceof ConfigValidationError);
        assert.strictEqual(
          result.error.message,
          "Invalid phantom.config.json: preDelete.commands: Invalid input: expected array, received object",
        );
      }
    });

    test("should reject when preDelete commands contains non-string values", () => {
      const result = validateConfig({
        preDelete: { commands: ["docker compose down", 123] },
      });

      assert.strictEqual(isErr(result), true);
      if (isErr(result)) {
        assert.ok(result.error instanceof ConfigValidationError);
        assert.strictEqual(
          result.error.message,
          "Invalid phantom.config.json: preDelete.commands.1: Invalid input: expected string, received number",
        );
      }
    });

    test("should reject when preDelete commands contains null", () => {
      const result = validateConfig({
        preDelete: { commands: ["docker compose down", null] },
      });

      assert.strictEqual(isErr(result), true);
      if (isErr(result)) {
        assert.ok(result.error instanceof ConfigValidationError);
        assert.strictEqual(
          result.error.message,
          "Invalid phantom.config.json: preDelete.commands.1: Invalid input: expected string, received null",
        );
      }
    });

    test("should reject when preDelete commands contains objects", () => {
      const result = validateConfig({
        preDelete: { commands: ["docker compose down", {}] },
      });

      assert.strictEqual(isErr(result), true);
      if (isErr(result)) {
        assert.ok(result.error instanceof ConfigValidationError);
        assert.strictEqual(
          result.error.message,
          "Invalid phantom.config.json: preDelete.commands.1: Invalid input: expected string, received object",
        );
      }
    });

    test("should reject when worktreesDirectory is number", () => {
      const result = validateConfig({ worktreesDirectory: 123 });

      assert.strictEqual(isErr(result), true);
      if (isErr(result)) {
        assert.ok(result.error instanceof ConfigValidationError);
        assert.strictEqual(
          result.error.message,
          "Invalid phantom.config.json: worktreesDirectory: Invalid input: expected string, received number",
        );
      }
    });

    test("should reject when worktreesDirectory is object", () => {
      const result = validateConfig({ worktreesDirectory: {} });

      assert.strictEqual(isErr(result), true);
      if (isErr(result)) {
        assert.ok(result.error instanceof ConfigValidationError);
        assert.strictEqual(
          result.error.message,
          "Invalid phantom.config.json: worktreesDirectory: Invalid input: expected string, received object",
        );
      }
    });

    test("should reject when worktreesDirectory is array", () => {
      const result = validateConfig({ worktreesDirectory: [] });

      assert.strictEqual(isErr(result), true);
      if (isErr(result)) {
        assert.ok(result.error instanceof ConfigValidationError);
        assert.strictEqual(
          result.error.message,
          "Invalid phantom.config.json: worktreesDirectory: Invalid input: expected string, received array",
        );
      }
    });

    test("should reject when worktreesDirectory is null", () => {
      const result = validateConfig({ worktreesDirectory: null });

      assert.strictEqual(isErr(result), true);
      if (isErr(result)) {
        assert.ok(result.error instanceof ConfigValidationError);
        assert.strictEqual(
          result.error.message,
          "Invalid phantom.config.json: worktreesDirectory: Invalid input: expected string, received null",
        );
      }
    });

    test("should reject when worktreesDirectory is boolean", () => {
      const result = validateConfig({ worktreesDirectory: true });

      assert.strictEqual(isErr(result), true);
      if (isErr(result)) {
        assert.ok(result.error instanceof ConfigValidationError);
        assert.strictEqual(
          result.error.message,
          "Invalid phantom.config.json: worktreesDirectory: Invalid input: expected string, received boolean",
        );
      }
    });
  });

  describe("edge cases", () => {
    test("should accept config with unknown properties", () => {
      const config = {
        postCreate: {
          copyFiles: [".env", "config/local.json"],
        },
        unknownProperty: "should be ignored",
      };

      const result = validateConfig(config);

      assert.strictEqual(isOk(result), true);
      if (isOk(result)) {
        assert.deepStrictEqual(result.value, config);
      }
    });

    test("should accept postCreate with unknown properties", () => {
      const config = {
        postCreate: {
          copyFiles: [".env", "config/local.json"],
          unknownProperty: "should be ignored",
        },
      };

      const result = validateConfig(config);

      assert.strictEqual(isOk(result), true);
      if (isOk(result)) {
        assert.deepStrictEqual(result.value, config);
      }
    });

    test("should accept preDelete with unknown properties", () => {
      const config = {
        preDelete: {
          commands: ["docker compose down"],
          unknownProperty: "should be ignored",
        },
      };

      const result = validateConfig(config);

      assert.strictEqual(isOk(result), true);
      if (isOk(result)) {
        assert.deepStrictEqual(result.value, config);
      }
    });

    test("should accept copyFiles with empty strings", () => {
      const config = {
        postCreate: {
          copyFiles: ["", " "],
        },
      };

      const result = validateConfig(config);

      assert.strictEqual(isOk(result), true);
      if (isOk(result)) {
        assert.deepStrictEqual(result.value, config);
      }
    });

    test("should accept copyFiles with special characters", () => {
      const config = {
        postCreate: {
          copyFiles: [
            "file-with-dash.txt",
            "file_with_underscore.js",
            "file.with.dots.md",
          ],
        },
      };

      const result = validateConfig(config);

      assert.strictEqual(isOk(result), true);
      if (isOk(result)) {
        assert.deepStrictEqual(result.value, config);
      }
    });

    test("should accept worktreesDirectory with empty string", () => {
      const config = {
        worktreesDirectory: "",
      };

      const result = validateConfig(config);

      assert.strictEqual(isOk(result), true);
      if (isOk(result)) {
        assert.deepStrictEqual(result.value, config);
      }
    });

    test("should accept worktreesDirectory with special characters", () => {
      const config = {
        worktreesDirectory: "../phantom-worktrees/custom_dir",
      };

      const result = validateConfig(config);

      assert.strictEqual(isOk(result), true);
      if (isOk(result)) {
        assert.deepStrictEqual(result.value, config);
      }
    });

    test("should accept worktreesDirectory with Windows-style path", () => {
      const config = {
        worktreesDirectory: "C:\\temp\\phantom-worktrees",
      };

      const result = validateConfig(config);

      assert.strictEqual(isOk(result), true);
      if (isOk(result)) {
        assert.deepStrictEqual(result.value, config);
      }
    });
  });
});
