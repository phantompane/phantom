import { strictEqual } from "node:assert";
import { normalize } from "node:path";
import { describe, it } from "vitest";
import {
  getWorktreePathFromDirectory,
  getWorktreesDirectory,
} from "./paths.ts";

describe("paths", () => {
  describe("getWorktreesDirectory", () => {
    it("should return correct phantom directory path", () => {
      const gitRoot = "/test/repo";
      const result = getWorktreesDirectory(gitRoot, undefined);
      strictEqual(
        normalize(result),
        normalize("/test/repo/.git/phantom/worktrees"),
      );
    });

    it("should handle git root with trailing slash", () => {
      const gitRoot = "/test/repo/";
      const result = getWorktreesDirectory(gitRoot, undefined);
      strictEqual(
        normalize(result),
        normalize("/test/repo/.git/phantom/worktrees"),
      );
    });

    describe("with worktreesDirectory", () => {
      it("should return default path when worktreesDirectory is undefined", () => {
        const gitRoot = "/test/repo";
        const result = getWorktreesDirectory(gitRoot, undefined);
        strictEqual(
          normalize(result),
          normalize("/test/repo/.git/phantom/worktrees"),
        );
      });

      it("should handle relative worktreesDirectory", () => {
        const gitRoot = "/test/repo";
        const result = getWorktreesDirectory(gitRoot, "../phantom-external");
        strictEqual(normalize(result), normalize("/test/phantom-external"));
      });

      it("should handle absolute worktreesDirectory", () => {
        const gitRoot = "/test/repo";
        const result = getWorktreesDirectory(gitRoot, "/tmp/phantom-worktrees");
        strictEqual(normalize(result), normalize("/tmp/phantom-worktrees"));
      });

      it("should handle nested relative worktreesDirectory", () => {
        const gitRoot = "/test/repo";
        const result = getWorktreesDirectory(gitRoot, "custom/phantom");
        strictEqual(normalize(result), normalize("/test/repo/custom/phantom"));
      });

      it("should handle complex relative worktreesDirectory", () => {
        const gitRoot = "/test/repo";
        const result = getWorktreesDirectory(gitRoot, "../../shared/worktrees");
        strictEqual(normalize(result), normalize("/shared/worktrees"));
      });

      it("should handle worktreesDirectory with trailing slash", () => {
        const gitRoot = "/test/repo";
        const result = getWorktreesDirectory(gitRoot, "../phantom-external/");
        // path.join normalizes paths and may add trailing slash
        strictEqual(normalize(result), normalize("/test/phantom-external/"));
      });
    });
  });

  describe("getWorktreePathFromDirectory", () => {
    it("keeps nested directories by default", () => {
      const result = getWorktreePathFromDirectory(
        "/test/repo/.git/phantom/worktrees",
        "feature/test",
        "/",
      );

      strictEqual(
        normalize(result),
        normalize("/test/repo/.git/phantom/worktrees/feature/test"),
      );
    });

    it("replaces slashes when directoryNameSeparator is provided", () => {
      const result = getWorktreePathFromDirectory(
        "/test/repo/.git/phantom/worktrees",
        "feature/test",
        "-",
      );

      strictEqual(
        normalize(result),
        normalize("/test/repo/.git/phantom/worktrees/feature-test"),
      );
    });
  });
});
