import { ok, strictEqual } from "node:assert";
import { dirname, join } from "node:path";
import { describe, it } from "vitest";
import { fileURLToPath } from "node:url";
import { runZshCompletion } from "../test-utils/run-zsh-completion.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const completionScriptPath = join(__dirname, "phantom.zsh");

describe("phantom.zsh completion", () => {
  it("completes version when typing phantom v", () => {
    const { completions, result } = runZshCompletion(completionScriptPath, [
      "phantom",
      "v",
    ]);

    strictEqual(result.status, 0, result.stderr);

    ok(
      completions.includes("version"),
      `Expected version to be offered, got: ${completions.join(", ")}`,
    );
  });
});
