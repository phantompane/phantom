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

  it("does not complete the removed serve command", () => {
    const { completions, result } = runFishCompletion(completionScriptPath, [
      "phantom",
      "s",
    ]);

    strictEqual(result.status, 0, result.stderr);

    ok(completions.includes("shell"));
    ok(!completions.includes("serve"));
  });

  it("completes the project command", () => {
    const { completions, result } = runFishCompletion(completionScriptPath, [
      "phantom",
      "p",
    ]);

    strictEqual(result.status, 0, result.stderr);
    ok(completions.includes("project"));
  });

  it("completes project subcommands", () => {
    const { completions, result } = runFishCompletion(completionScriptPath, [
      "phantom",
      "project",
      "",
    ]);

    strictEqual(result.status, 0, result.stderr);
    ok(completions.includes("add"));
    ok(completions.includes("list"));
    ok(completions.includes("remove"));
  });

  it("completes project list output flags", () => {
    const { completions, result } = runFishCompletion(completionScriptPath, [
      "phantom",
      "project",
      "list",
      "--",
    ]);

    strictEqual(result.status, 0, result.stderr);
    ok(completions.includes("--json"));
    ok(completions.includes("--names"));
    ok(completions.includes("--paths"));
  });

  it("does not offer another project list output mode", () => {
    for (const selectedMode of ["--json", "--names", "--paths"]) {
      const { completions, result } = runFishCompletion(completionScriptPath, [
        "phantom",
        "project",
        "list",
        selectedMode,
        "--",
      ]);

      strictEqual(result.status, 0, result.stderr);
      ok(!completions.includes("--json"));
      ok(!completions.includes("--names"));
      ok(!completions.includes("--paths"));
    }
  });

  it("completes the JSON flag for project mutations", () => {
    for (const subcommand of ["add", "remove"]) {
      const { completions, result } = runFishCompletion(completionScriptPath, [
        "phantom",
        "project",
        subcommand,
        "--j",
      ]);

      strictEqual(result.status, 0, result.stderr);
      ok(completions.includes("--json"));
    }
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
