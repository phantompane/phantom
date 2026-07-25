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

  it("does not complete the removed serve command", () => {
    const { completions, result } = runBashCompletion(completionScriptPath, [
      "phantom",
      "s",
    ]);

    strictEqual(result.status, 0, result.stderr);

    ok(completions.includes("shell"));
    ok(!completions.includes("serve"));
  });

  it("completes the project command", () => {
    const { completions, result } = runBashCompletion(completionScriptPath, [
      "phantom",
      "p",
    ]);

    strictEqual(result.status, 0, result.stderr);
    ok(completions.includes("project"));
  });

  it("completes project subcommands", () => {
    const { completions, result } = runBashCompletion(completionScriptPath, [
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
    const { completions, result } = runBashCompletion(completionScriptPath, [
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
      const { completions, result } = runBashCompletion(completionScriptPath, [
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
      const { completions, result } = runBashCompletion(completionScriptPath, [
        "phantom",
        "project",
        subcommand,
        "--j",
      ]);

      strictEqual(result.status, 0, result.stderr);
      ok(completions.includes("--json"));
    }
  });

  it("completes directories for project add", () => {
    const setupScript = `
_filedir() {
  COMPREPLY=(demo-repository/)
}
`;
    const { completions, result } = runBashCompletion(
      completionScriptPath,
      ["phantom", "project", "add", ""],
      { setupScript },
    );

    strictEqual(result.status, 0, result.stderr);
    ok(completions.includes("demo-repository/"));
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
