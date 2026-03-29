import assert from "node:assert";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { isOk } from "@phantompane/phantom-shared";
import { resolveGlobPatterns } from "./glob-resolver.ts";

describe("resolveGlobPatterns", () => {
  let tempDir;
  let gitRoot;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "phantom-glob-test-"));
    gitRoot = tempDir;
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("should expand simple wildcard patterns", async () => {
    // Create test files
    await writeFile(path.join(gitRoot, "test.env"), "");
    await writeFile(path.join(gitRoot, "app.env"), "");
    await writeFile(path.join(gitRoot, "config.json"), "");

    const result = await resolveGlobPatterns(gitRoot, ["*.env"]);

    assert.strictEqual(isOk(result), true);
    if (isOk(result)) {
      const { resolvedFiles } = result.value;
      // Should match files ending with .env
      assert.strictEqual(resolvedFiles.length, 2);
      assert.ok(resolvedFiles.includes("test.env"));
      assert.ok(resolvedFiles.includes("app.env"));
    }
  });

  test("should expand .env* pattern", async () => {
    // Create test files
    await writeFile(path.join(gitRoot, ".env"), "");
    await writeFile(path.join(gitRoot, ".env.local"), "");
    await writeFile(path.join(gitRoot, ".env.production"), "");
    await writeFile(path.join(gitRoot, "config.json"), "");

    const result = await resolveGlobPatterns(gitRoot, [".env*"]);

    assert.strictEqual(isOk(result), true);
    if (isOk(result)) {
      const { resolvedFiles } = result.value;
      assert.strictEqual(resolvedFiles.length, 3);
      assert.ok(resolvedFiles.includes(".env"));
      assert.ok(resolvedFiles.includes(".env.local"));
      assert.ok(resolvedFiles.includes(".env.production"));
    }
  });

  test("should expand recursive patterns", async () => {
    // Create nested directory structure
    await mkdir(path.join(gitRoot, "config", "db"), { recursive: true });
    await mkdir(path.join(gitRoot, "config", "api"), { recursive: true });

    await writeFile(path.join(gitRoot, "config", "db", "local.yml"), "");
    await writeFile(path.join(gitRoot, "config", "api", "local.yml"), "");
    await writeFile(path.join(gitRoot, "config", "settings.yml"), "");

    const result = await resolveGlobPatterns(gitRoot, [
      "config/**/*.local.yml",
    ]);

    assert.strictEqual(isOk(result), true);
    if (isOk(result)) {
      const { resolvedFiles } = result.value;
      // Should not match anything as files are named "local.yml" not "*.local.yml"
      assert.strictEqual(resolvedFiles.length, 0);
    }
  });

  test("should expand recursive patterns correctly", async () => {
    // Create nested directory structure with correct naming
    await mkdir(path.join(gitRoot, "config", "db"), { recursive: true });
    await mkdir(path.join(gitRoot, "config", "api"), { recursive: true });

    await writeFile(
      path.join(gitRoot, "config", "db", "database.local.yml"),
      "",
    );
    await writeFile(path.join(gitRoot, "config", "api", "api.local.yml"), "");
    await writeFile(path.join(gitRoot, "config", "settings.yml"), "");

    const result = await resolveGlobPatterns(gitRoot, [
      "config/**/*.local.yml",
    ]);

    assert.strictEqual(isOk(result), true);
    if (isOk(result)) {
      const { resolvedFiles } = result.value;
      assert.strictEqual(resolvedFiles.length, 2);
      assert.ok(
        resolvedFiles.includes(path.join("config", "db", "database.local.yml")),
      );
      assert.ok(
        resolvedFiles.includes(path.join("config", "api", "api.local.yml")),
      );
    }
  });

  test("should preserve exact file paths", async () => {
    await writeFile(path.join(gitRoot, ".env"), "");

    const result = await resolveGlobPatterns(gitRoot, [".env"]);

    assert.strictEqual(isOk(result), true);
    if (isOk(result)) {
      const { resolvedFiles } = result.value;
      assert.deepStrictEqual(resolvedFiles, [".env"]);
    }
  });

  test("should deduplicate overlapping patterns", async () => {
    await writeFile(path.join(gitRoot, ".env"), "");
    await writeFile(path.join(gitRoot, ".env.local"), "");

    const result = await resolveGlobPatterns(gitRoot, [".env*", ".env"]);

    assert.strictEqual(isOk(result), true);
    if (isOk(result)) {
      const { resolvedFiles } = result.value;
      // Should only include each file once
      assert.strictEqual(resolvedFiles.length, 2);
      assert.strictEqual(resolvedFiles.filter((f) => f === ".env").length, 1);
    }
  });

  test("should handle patterns with no matches", async () => {
    const result = await resolveGlobPatterns(gitRoot, ["*.nonexistent"]);

    assert.strictEqual(isOk(result), true);
    if (isOk(result)) {
      const { resolvedFiles } = result.value;
      assert.deepStrictEqual(resolvedFiles, []);
    }
  });

  test("should filter out directories", async () => {
    await mkdir(path.join(gitRoot, "config"), { recursive: true });
    await writeFile(path.join(gitRoot, "file.txt"), "");

    const result = await resolveGlobPatterns(gitRoot, ["*"]);

    assert.strictEqual(isOk(result), true);
    if (isOk(result)) {
      const { resolvedFiles } = result.value;
      // Should only include file.txt, not the config directory
      assert.strictEqual(resolvedFiles.length, 1);
      assert.deepStrictEqual(resolvedFiles, ["file.txt"]);
    }
  });

  test("should handle mixed patterns and exact paths", async () => {
    await writeFile(path.join(gitRoot, ".env"), "");
    await writeFile(path.join(gitRoot, ".env.local"), "");
    await writeFile(path.join(gitRoot, "config.json"), "");

    const result = await resolveGlobPatterns(gitRoot, [".env*", "config.json"]);

    assert.strictEqual(isOk(result), true);
    if (isOk(result)) {
      const { resolvedFiles } = result.value;
      assert.strictEqual(resolvedFiles.length, 3);
      assert.ok(resolvedFiles.includes(".env"));
      assert.ok(resolvedFiles.includes(".env.local"));
      assert.ok(resolvedFiles.includes("config.json"));
    }
  });

  test("should handle empty pattern array", async () => {
    const result = await resolveGlobPatterns(gitRoot, []);

    assert.strictEqual(isOk(result), true);
    if (isOk(result)) {
      const { resolvedFiles } = result.value;
      assert.deepStrictEqual(resolvedFiles, []);
    }
  });

  test("should return pattern resolution details", async () => {
    await writeFile(path.join(gitRoot, ".env"), "");
    await writeFile(path.join(gitRoot, ".env.local"), "");

    const result = await resolveGlobPatterns(gitRoot, [".env*"]);

    assert.strictEqual(isOk(result), true);
    if (isOk(result)) {
      const { patterns } = result.value;
      assert.strictEqual(patterns.length, 1);
      assert.strictEqual(patterns[0].pattern, ".env*");
      assert.strictEqual(patterns[0].resolvedFiles.length, 2);
    }
  });

  test("should handle bracket patterns", async () => {
    await writeFile(path.join(gitRoot, "file-a.txt"), "");
    await writeFile(path.join(gitRoot, "file-b.txt"), "");
    await writeFile(path.join(gitRoot, "file-c.txt"), "");

    const result = await resolveGlobPatterns(gitRoot, ["file-[ab].txt"]);

    assert.strictEqual(isOk(result), true);
    if (isOk(result)) {
      const { resolvedFiles } = result.value;
      assert.strictEqual(resolvedFiles.length, 2);
      assert.ok(resolvedFiles.includes("file-a.txt"));
      assert.ok(resolvedFiles.includes("file-b.txt"));
      assert.ok(!resolvedFiles.includes("file-c.txt"));
    }
  });

  test("should handle question mark patterns", async () => {
    await writeFile(path.join(gitRoot, "file1.txt"), "");
    await writeFile(path.join(gitRoot, "file2.txt"), "");
    await writeFile(path.join(gitRoot, "file10.txt"), "");

    const result = await resolveGlobPatterns(gitRoot, ["file?.txt"]);

    assert.strictEqual(isOk(result), true);
    if (isOk(result)) {
      const { resolvedFiles } = result.value;
      assert.strictEqual(resolvedFiles.length, 2);
      assert.ok(resolvedFiles.includes("file1.txt"));
      assert.ok(resolvedFiles.includes("file2.txt"));
      assert.ok(!resolvedFiles.includes("file10.txt"));
    }
  });

  test("should handle files that cannot be stat'd", async () => {
    // Create a file, then we'll rely on the glob finding it
    // but our stat might fail in edge cases
    await writeFile(path.join(gitRoot, ".env"), "");

    const result = await resolveGlobPatterns(gitRoot, [".env"]);

    assert.strictEqual(isOk(result), true);
    if (isOk(result)) {
      const { resolvedFiles } = result.value;
      // Exact paths are not stat'd, just passed through
      assert.deepStrictEqual(resolvedFiles, [".env"]);
    }
  });

  test("should handle literal filenames with square brackets", async () => {
    // Create a file with literal square brackets in the name
    await writeFile(path.join(gitRoot, "file[1].txt"), "");
    await writeFile(path.join(gitRoot, "file1.txt"), "");

    const result = await resolveGlobPatterns(gitRoot, ["file[1].txt"]);

    assert.strictEqual(isOk(result), true);
    if (isOk(result)) {
      const { resolvedFiles } = result.value;
      // Should match the literal file, not treat [1] as a glob pattern
      assert.strictEqual(resolvedFiles.length, 1);
      assert.deepStrictEqual(resolvedFiles, ["file[1].txt"]);
    }
  });

  test("should handle literal filenames with question marks", async () => {
    // Create a file with a literal question mark in the name
    await writeFile(path.join(gitRoot, "what?.txt"), "");
    await writeFile(path.join(gitRoot, "what1.txt"), "");

    const result = await resolveGlobPatterns(gitRoot, ["what?.txt"]);

    assert.strictEqual(isOk(result), true);
    if (isOk(result)) {
      const { resolvedFiles } = result.value;
      // Should match the literal file, not treat ? as a glob pattern
      assert.strictEqual(resolvedFiles.length, 1);
      assert.deepStrictEqual(resolvedFiles, ["what?.txt"]);
    }
  });

  test("should handle literal filenames with asterisks", async () => {
    // Create a file with a literal asterisk in the name
    await writeFile(path.join(gitRoot, "file*.txt"), "");
    await writeFile(path.join(gitRoot, "file1.txt"), "");

    const result = await resolveGlobPatterns(gitRoot, ["file*.txt"]);

    assert.strictEqual(isOk(result), true);
    if (isOk(result)) {
      const { resolvedFiles } = result.value;
      // Should match the literal file, not treat * as a glob pattern
      assert.strictEqual(resolvedFiles.length, 1);
      assert.deepStrictEqual(resolvedFiles, ["file*.txt"]);
    }
  });

  test("should use glob pattern when literal file does not exist", async () => {
    // Only create files that match the pattern
    await writeFile(path.join(gitRoot, "file1.txt"), "");
    await writeFile(path.join(gitRoot, "file2.txt"), "");
    // No literal "file[12].txt" file

    const result = await resolveGlobPatterns(gitRoot, ["file[12].txt"]);

    assert.strictEqual(isOk(result), true);
    if (isOk(result)) {
      const { resolvedFiles } = result.value;
      // Should use glob pattern since literal doesn't exist
      assert.strictEqual(resolvedFiles.length, 2);
      assert.ok(resolvedFiles.includes("file1.txt"));
      assert.ok(resolvedFiles.includes("file2.txt"));
    }
  });

  test("should match dotfiles in subdirectories with **/ pattern", async () => {
    // Create nested .env files
    await mkdir(
      path.join(gitRoot, "oa-application", "src", "test", "resources"),
      {
        recursive: true,
      },
    );
    await writeFile(path.join(gitRoot, ".env"), "root");
    await writeFile(
      path.join(gitRoot, "oa-application", "src", "test", "resources", ".env"),
      "nested",
    );
    await writeFile(path.join(gitRoot, "config.env"), "config");

    const result = await resolveGlobPatterns(gitRoot, ["**/.env"]);

    assert.strictEqual(isOk(result), true);
    if (isOk(result)) {
      const { resolvedFiles } = result.value;
      assert.strictEqual(resolvedFiles.length, 2);
      assert.ok(resolvedFiles.includes(".env"));
      assert.ok(
        resolvedFiles.includes(
          path.join("oa-application", "src", "test", "resources", ".env"),
        ),
      );
    }
  });

  test("should match dotfiles with **/.env* pattern", async () => {
    // Create various .env files
    await mkdir(path.join(gitRoot, "app", "config"), { recursive: true });
    await writeFile(path.join(gitRoot, ".env"), "");
    await writeFile(path.join(gitRoot, ".env.local"), "");
    await writeFile(path.join(gitRoot, "app", ".env.production"), "");
    await writeFile(path.join(gitRoot, "app", "config", ".env.test"), "");

    const result = await resolveGlobPatterns(gitRoot, ["**/.env*"]);

    assert.strictEqual(isOk(result), true);
    if (isOk(result)) {
      const { resolvedFiles } = result.value;
      assert.strictEqual(resolvedFiles.length, 4);
      assert.ok(resolvedFiles.includes(".env"));
      assert.ok(resolvedFiles.includes(".env.local"));
      assert.ok(resolvedFiles.includes(path.join("app", ".env.production")));
      assert.ok(
        resolvedFiles.includes(path.join("app", "config", ".env.test")),
      );
    }
  });

  test("should exclude .git directory from **/ pattern searches", async () => {
    // Create files in .git directory (simulating worktrees)
    await mkdir(path.join(gitRoot, ".git", "phantom", "worktrees", "other"), {
      recursive: true,
    });
    await writeFile(path.join(gitRoot, ".env"), "root");
    await writeFile(
      path.join(gitRoot, ".git", "phantom", "worktrees", "other", ".env"),
      "worktree",
    );
    await mkdir(path.join(gitRoot, "src"), { recursive: true });
    await writeFile(path.join(gitRoot, "src", ".env"), "src");

    const result = await resolveGlobPatterns(gitRoot, ["**/.env"]);

    assert.strictEqual(isOk(result), true);
    if (isOk(result)) {
      const { resolvedFiles } = result.value;
      // Should find .env files but NOT the one in .git directory
      assert.strictEqual(resolvedFiles.length, 2);
      assert.ok(resolvedFiles.includes(".env"));
      assert.ok(resolvedFiles.includes(path.join("src", ".env")));
      // Should NOT include files from .git directory
      assert.ok(
        !resolvedFiles.some((f) => f.includes(".git")),
        "Should not include files from .git directory",
      );
    }
  });

  test("should match dotfiles with prefix/**/ pattern", async () => {
    // Create .env files in oa-application subdirectory
    await mkdir(
      path.join(gitRoot, "oa-application", "src", "test", "resources"),
      { recursive: true },
    );
    await mkdir(path.join(gitRoot, "other-app"), { recursive: true });
    await writeFile(path.join(gitRoot, ".env"), "root");
    await writeFile(path.join(gitRoot, "oa-application", ".env"), "app");
    await writeFile(
      path.join(gitRoot, "oa-application", "src", "test", "resources", ".env"),
      "nested",
    );
    await writeFile(path.join(gitRoot, "other-app", ".env"), "other");

    const result = await resolveGlobPatterns(gitRoot, [
      "oa-application/**/.env",
    ]);

    assert.strictEqual(isOk(result), true);
    if (isOk(result)) {
      const { resolvedFiles } = result.value;
      // Should only find .env files under oa-application/
      assert.strictEqual(resolvedFiles.length, 2);
      assert.ok(resolvedFiles.includes(path.join("oa-application", ".env")));
      assert.ok(
        resolvedFiles.includes(
          path.join("oa-application", "src", "test", "resources", ".env"),
        ),
      );
      // Should NOT include root .env or other-app/.env
      assert.ok(!resolvedFiles.includes(".env"));
      assert.ok(!resolvedFiles.includes(path.join("other-app", ".env")));
    }
  });
});
