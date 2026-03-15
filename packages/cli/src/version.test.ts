import { strictEqual } from "node:assert";
import { describe, it } from "vitest";
import { getVersion } from "./version.ts";

describe("getVersion", () => {
  it("should return version successfully", () => {
    const version = getVersion();
    strictEqual(typeof version, "string");
    strictEqual(version.length > 0, true);
  });

  it("should validate version format", () => {
    const version = getVersion();
    // Check that version follows semantic versioning pattern
    const versionPattern = /^\d+\.\d+\.\d+/;
    strictEqual(versionPattern.test(version), true);
  });
});
