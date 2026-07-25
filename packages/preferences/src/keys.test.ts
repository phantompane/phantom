import { deepStrictEqual, strictEqual } from "node:assert";
import { describe, it } from "vitest";
import {
  getPreferenceConfigKey,
  getPreferenceValue,
  isPreferenceKey,
  supportedPreferenceKeys,
  validatePreferenceValue,
} from "./keys.ts";

describe("preference keys", () => {
  it("exposes supported keys", () => {
    deepStrictEqual(supportedPreferenceKeys, [
      "editor",
      "ai",
      "worktreesDirectory",
      "directoryNameSeparator",
      "keepBranch",
      "ghqDiscovery",
    ]);
  });

  it("recognizes valid keys", () => {
    strictEqual(isPreferenceKey("editor"), true);
    strictEqual(isPreferenceKey("ghqDiscovery"), true);
    strictEqual(isPreferenceKey("unknown"), false);
  });

  it("returns git config keys", () => {
    strictEqual(getPreferenceConfigKey("keepBranch"), "phantom.keepBranch");
    strictEqual(getPreferenceConfigKey("ghqDiscovery"), "phantom.ghqDiscovery");
  });

  it("reads string and boolean values", () => {
    strictEqual(getPreferenceValue({ editor: "code" }, "editor"), "code");
    strictEqual(getPreferenceValue({ keepBranch: true }, "keepBranch"), "true");
    strictEqual(
      getPreferenceValue({ ghqDiscovery: false }, "ghqDiscovery"),
      "false",
    );
  });

  it("validates keepBranch values", () => {
    strictEqual(validatePreferenceValue("keepBranch", "true"), null);
    strictEqual(
      validatePreferenceValue("keepBranch", "yes"),
      "Preference 'keepBranch' must be 'true' or 'false'",
    );
  });

  it("validates ghqDiscovery values", () => {
    strictEqual(validatePreferenceValue("ghqDiscovery", "false"), null);
    strictEqual(
      validatePreferenceValue("ghqDiscovery", "yes"),
      "Preference 'ghqDiscovery' must be 'true' or 'false'",
    );
  });
});
