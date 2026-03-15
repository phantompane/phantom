import assert from "node:assert";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { isOk } from "@phantompane/shared";
import { copyFiles } from "./file-copier.ts";

describe("copyFiles", () => {
  let tempDir;
  let sourceDir;
  let targetDir;

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
});
