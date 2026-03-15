import assert from "node:assert";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "vitest";
import { isOk } from "@phantompane/shared";
import { copyFiles } from "./file-copier.ts";

describe("copyFiles integration", () => {
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

  test("should copy files from source to target", async () => {
    await writeFile(path.join(sourceDir, ".env"), "SECRET=value");
    await writeFile(path.join(sourceDir, "config.json"), '{"key": "value"}');
    await writeFile(path.join(sourceDir, "test.txt"), "test content");

    const result = await copyFiles(sourceDir, targetDir, [
      ".env",
      "config.json",
      "missing.txt", // This should be skipped
    ]);

    assert.strictEqual(isOk(result), true);
    if (isOk(result)) {
      assert.deepStrictEqual(result.value.copiedFiles, [".env", "config.json"]);
      assert.deepStrictEqual(result.value.skippedFiles, ["missing.txt"]);
    }

    // Verify files were copied
    const envContent = await readFile(path.join(targetDir, ".env"), "utf-8");
    assert.strictEqual(envContent, "SECRET=value");

    const configContent = await readFile(
      path.join(targetDir, "config.json"),
      "utf-8",
    );
    assert.strictEqual(configContent, '{"key": "value"}');

    // Verify test.txt was not copied (not in the list)
    await assert.rejects(access(path.join(targetDir, "test.txt")), {
      code: "ENOENT",
    });
  });
});
