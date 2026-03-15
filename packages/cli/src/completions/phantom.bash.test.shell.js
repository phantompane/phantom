import { ok, strictEqual } from "node:assert";
import { dirname, join } from "node:path";
import { describe, it } from "vitest";
import { fileURLToPath } from "node:url";
import { runBashCompletion } from "../test-utils/run-bash-completion.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const completionScriptPath = join(__dirname, "phantom.bash");

describe("phantom.bash completion", () => {
  it("completes version when typing phantom v", () => {
    const { completions, result } = runBashCompletion(completionScriptPath, [
      "phantom",
      "v",
    ]);

    strictEqual(result.status, 0, result.stderr);

    ok(
      completions.includes("version"),
      `Expected version to be offered, got: ${completions.join(", ")}`,
    );
  });

  it("completes exec command arguments with the target command's completion", () => {
    const setupScript = `
_dummy_complete() {
  COMPREPLY=(--from-dummy)
}
complete -F _dummy_complete dummycmd
`;

    const { completions, result } = runBashCompletion(
      completionScriptPath,
      ["phantom", "exec", "demo-worktree", "dummycmd", "--from"],
      { setupScript },
    );

    strictEqual(result.status, 0, result.stderr);

    ok(
      completions.includes("--from-dummy"),
      `Expected exec to reuse dummycmd completion, got: ${completions.join(", ")}`,
    );
  });
});
