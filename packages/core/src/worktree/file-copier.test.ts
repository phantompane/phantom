import assert from "node:assert";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "vitest";
import { isOk } from "@phantompane/shared";
import { copyFiles } from "./file-copier.ts";

describe("copyFiles", () => {
  let tempDir: string;
  let sourceDir: string;
  let targetDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "phantom-test-"));
    sourceDir = path.join(tempDir, "source");
    targetDir = path.join(tempDir, "target");
    await mkdir(sourceDir, { recursive: true });
    await mkdir(targetDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("should copy existing files", async () => {
    await writeFile(path.join(sourceDir, ".env"), "TEST=value");
    await writeFile(path.join(sourceDir, "config.json"), '{"key": "value"}');

    const result = await copyFiles(sourceDir, targetDir, [
      ".env",
      "config.json",
    ]);

    assert.strictEqual(isOk(result), true);
    if (isOk(result)) {
      assert.deepStrictEqual(result.value.copiedFiles, [".env", "config.json"]);
      assert.deepStrictEqual(result.value.skippedFiles, []);
    }

    const copiedEnv = await readFile(path.join(targetDir, ".env"), "utf-8");
    assert.strictEqual(copiedEnv, "TEST=value");

    const copiedConfig = await readFile(
      path.join(targetDir, "config.json"),
      "utf-8",
    );
    assert.strictEqual(copiedConfig, '{"key": "value"}');
  });

  test("should skip non-existent files", async () => {
    await writeFile(path.join(sourceDir, ".env"), "TEST=value");

    const result = await copyFiles(sourceDir, targetDir, [
      ".env",
      "missing.txt",
    ]);

    assert.strictEqual(isOk(result), true);
    if (isOk(result)) {
      assert.deepStrictEqual(result.value.copiedFiles, [".env"]);
      assert.deepStrictEqual(result.value.skippedFiles, ["missing.txt"]);
    }
  });

  test("should skip directories", async () => {
    await writeFile(path.join(sourceDir, "file.txt"), "content");
    await mkdir(path.join(sourceDir, "subdir"));

    const result = await copyFiles(sourceDir, targetDir, [
      "file.txt",
      "subdir",
    ]);

    assert.strictEqual(isOk(result), true);
    if (isOk(result)) {
      assert.deepStrictEqual(result.value.copiedFiles, ["file.txt"]);
      assert.deepStrictEqual(result.value.skippedFiles, ["subdir"]);
    }
  });

  test("should handle empty file list", async () => {
    const result = await copyFiles(sourceDir, targetDir, []);

    assert.strictEqual(isOk(result), true);
    if (isOk(result)) {
      assert.deepStrictEqual(result.value.copiedFiles, []);
      assert.deepStrictEqual(result.value.skippedFiles, []);
    }
  });

  test("should create target directory if it doesn't exist for nested file", async () => {
    const sourceSubdir = path.join(sourceDir, "nested");
    await mkdir(sourceSubdir);
    await writeFile(path.join(sourceSubdir, "file.txt"), "content");

    const result = await copyFiles(sourceDir, targetDir, ["nested/file.txt"]);

    assert.strictEqual(isOk(result), true);
    if (isOk(result)) {
      assert.deepStrictEqual(result.value.copiedFiles, ["nested/file.txt"]);
      assert.deepStrictEqual(result.value.skippedFiles, []);
    }

    const copiedFile = await readFile(
      path.join(targetDir, "nested", "file.txt"),
      "utf-8",
    );
    assert.strictEqual(copiedFile, "content");
  });

  test("should copy files in subdirectories if target directory exists", async () => {
    const sourceSubdir = path.join(sourceDir, "config");
    const targetSubdir = path.join(targetDir, "config");
    await mkdir(sourceSubdir);
    await mkdir(targetSubdir);
    await writeFile(path.join(sourceSubdir, "local.json"), '{"env": "local"}');

    const result = await copyFiles(sourceDir, targetDir, ["config/local.json"]);

    assert.strictEqual(isOk(result), true);
    if (isOk(result)) {
      assert.deepStrictEqual(result.value.copiedFiles, ["config/local.json"]);
      assert.deepStrictEqual(result.value.skippedFiles, []);
    }

    const copiedFile = await readFile(
      path.join(targetSubdir, "local.json"),
      "utf-8",
    );
    assert.strictEqual(copiedFile, '{"env": "local"}');
  });

  test("should copy files matching wildcard pattern", async () => {
    await writeFile(path.join(sourceDir, ".env"), "TEST=value");
    await writeFile(path.join(sourceDir, ".env.local"), "LOCAL=value");
    await writeFile(path.join(sourceDir, ".env.production"), "PROD=value");
    await writeFile(path.join(sourceDir, "config.json"), '{"key": "value"}');

    const result = await copyFiles(sourceDir, targetDir, [".env*"]);

    assert.strictEqual(isOk(result), true);
    if (isOk(result)) {
      assert.strictEqual(result.value.copiedFiles.length, 3);
      assert.ok(result.value.copiedFiles.includes(".env"));
      assert.ok(result.value.copiedFiles.includes(".env.local"));
      assert.ok(result.value.copiedFiles.includes(".env.production"));
    }

    const copiedEnv = await readFile(path.join(targetDir, ".env"), "utf-8");
    assert.strictEqual(copiedEnv, "TEST=value");
  });

  test("should copy files matching recursive pattern", async () => {
    await mkdir(path.join(sourceDir, "config", "db"), { recursive: true });
    await mkdir(path.join(sourceDir, "config", "api"), { recursive: true });

    await writeFile(
      path.join(sourceDir, "config", "db", "database.local.yml"),
      "db: local",
    );
    await writeFile(
      path.join(sourceDir, "config", "api", "api.local.yml"),
      "api: local",
    );
    await writeFile(
      path.join(sourceDir, "config", "settings.yml"),
      "settings: default",
    );

    const result = await copyFiles(sourceDir, targetDir, [
      "config/**/*.local.yml",
    ]);

    assert.strictEqual(isOk(result), true);
    if (isOk(result)) {
      assert.strictEqual(result.value.copiedFiles.length, 2);
      assert.ok(
        result.value.copiedFiles.includes(
          path.join("config", "db", "database.local.yml"),
        ),
      );
      assert.ok(
        result.value.copiedFiles.includes(
          path.join("config", "api", "api.local.yml"),
        ),
      );
    }

    const copiedDb = await readFile(
      path.join(targetDir, "config", "db", "database.local.yml"),
      "utf-8",
    );
    assert.strictEqual(copiedDb, "db: local");
  });

  test("should skip patterns with no matches", async () => {
    await writeFile(path.join(sourceDir, "file.txt"), "content");

    const result = await copyFiles(sourceDir, targetDir, ["*.nonexistent"]);

    assert.strictEqual(isOk(result), true);
    if (isOk(result)) {
      assert.deepStrictEqual(result.value.copiedFiles, []);
      assert.deepStrictEqual(result.value.skippedFiles, []);
    }
  });

  test("should combine glob patterns and exact paths", async () => {
    await writeFile(path.join(sourceDir, ".env"), "TEST=value");
    await writeFile(path.join(sourceDir, ".env.local"), "LOCAL=value");
    await writeFile(path.join(sourceDir, "config.json"), '{"key": "value"}');

    const result = await copyFiles(sourceDir, targetDir, [
      ".env*",
      "config.json",
    ]);

    assert.strictEqual(isOk(result), true);
    if (isOk(result)) {
      assert.strictEqual(result.value.copiedFiles.length, 3);
      assert.ok(result.value.copiedFiles.includes(".env"));
      assert.ok(result.value.copiedFiles.includes(".env.local"));
      assert.ok(result.value.copiedFiles.includes("config.json"));
    }
  });

  test("should deduplicate files from overlapping patterns", async () => {
    await writeFile(path.join(sourceDir, ".env"), "TEST=value");
    await writeFile(path.join(sourceDir, ".env.local"), "LOCAL=value");

    const result = await copyFiles(sourceDir, targetDir, [".env*", ".env"]);

    assert.strictEqual(isOk(result), true);
    if (isOk(result)) {
      // Should only copy each file once
      assert.strictEqual(result.value.copiedFiles.length, 2);
      assert.strictEqual(
        result.value.copiedFiles.filter((f) => f === ".env").length,
        1,
      );
    }
  });

  test("should preserve subdirectory structure for matched files", async () => {
    await mkdir(path.join(sourceDir, "nested"), { recursive: true });
    await writeFile(path.join(sourceDir, "nested", "file1.txt"), "content1");
    await writeFile(path.join(sourceDir, "nested", "file2.txt"), "content2");

    const result = await copyFiles(sourceDir, targetDir, ["nested/*.txt"]);

    assert.strictEqual(isOk(result), true);
    if (isOk(result)) {
      assert.strictEqual(result.value.copiedFiles.length, 2);
      assert.ok(
        result.value.copiedFiles.includes(path.join("nested", "file1.txt")),
      );
      assert.ok(
        result.value.copiedFiles.includes(path.join("nested", "file2.txt")),
      );
    }

    const copiedFile1 = await readFile(
      path.join(targetDir, "nested", "file1.txt"),
      "utf-8",
    );
    assert.strictEqual(copiedFile1, "content1");
  });
});
