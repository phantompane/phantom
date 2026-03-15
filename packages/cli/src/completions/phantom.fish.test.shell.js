import { ok, strictEqual } from "node:assert";
import { dirname, join } from "node:path";
import { describe, it } from "vitest";
import { fileURLToPath } from "node:url";
import { runFishCompletion } from "../test-utils/run-fish-completion.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const completionScriptPath = join(__dirname, "phantom.fish");

describe("phantom.fish completion", () => {
  it("completes version when typing phantom v", () => {
    const { completions, result } = runFishCompletion(completionScriptPath, [
      "phantom",
      "v",
    ]);

    strictEqual(result.status, 0, result.stderr);

    ok(
      completions.includes("version"),
      `Expected version to be offered, got: ${completions.join(", ")}`,
    );
  });

  it("passes exec completions through to the invoked command", () => {
    const setupScript = `
complete -c dummycmd -l from-dummy -d "Dummy option"
`;

    const { completions, result } = runFishCompletion(
      completionScriptPath,
      ["phantom", "exec", "demo-worktree", "dummycmd", "--from"],
      { setupScript },
    );

    strictEqual(result.status, 0, result.stderr);

    ok(
      completions.includes("--from-dummy"),
      `Expected dummycmd completion to be forwarded, got: ${completions.join(", ")}`,
    );
  });
});
