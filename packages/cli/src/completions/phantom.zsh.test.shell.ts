import { ok, strictEqual } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "vitest";
import { fileURLToPath } from "node:url";
import { ZSH_COMPLETION_SCRIPT } from "./phantom-zsh.ts";
import { runZshCompletion } from "../test-utils/run-zsh-completion.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const completionScriptPath = join(__dirname, "phantom.zsh");

describe("phantom.zsh completion", () => {
  it("tests the completion script emitted by the CLI", () => {
    strictEqual(
      readFileSync(completionScriptPath, "utf8"),
      `${ZSH_COMPLETION_SCRIPT}\n`,
    );
  });

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

  it("does not complete the removed serve command", () => {
    const { completions, result } = runZshCompletion(completionScriptPath, [
      "phantom",
      "s",
    ]);

    strictEqual(result.status, 0, result.stderr);

    ok(completions.includes("shell"));
    ok(!completions.includes("serve"));
  });

  it("completes the project command", () => {
    const { completions, result } = runZshCompletion(completionScriptPath, [
      "phantom",
      "p",
    ]);

    strictEqual(result.status, 0, result.stderr);
    ok(completions.includes("project"));
  });

  it("completes project subcommands", () => {
    const { completions, result } = runZshCompletion(completionScriptPath, [
      "phantom",
      "project",
      "",
    ]);

    strictEqual(result.status, 0, result.stderr);
    ok(completions.includes("add"));
    ok(completions.includes("list"));
    ok(completions.includes("remove"));
  });

  it("completes project options", () => {
    const listCompletion = runZshCompletion(completionScriptPath, [
      "phantom",
      "project",
      "list",
      "--",
    ]);
    strictEqual(listCompletion.result.status, 0, listCompletion.result.stderr);
    ok(listCompletion.completions.includes("--json"));
    ok(listCompletion.completions.includes("--names"));
    ok(listCompletion.completions.includes("--paths"));

    for (const subcommand of ["add", "remove"]) {
      const { completions, result } = runZshCompletion(completionScriptPath, [
        "phantom",
        "project",
        subcommand,
        "--j",
      ]);
      strictEqual(result.status, 0, result.stderr);
      ok(completions.includes("--json"));
    }
  });

  it("completes the ghqDiscovery preference", () => {
    const { completions, result } = runZshCompletion(completionScriptPath, [
      "phantom",
      "preferences",
      "set",
      "ghqD",
    ]);

    strictEqual(result.status, 0, result.stderr);
    ok(completions.includes("ghqDiscovery"));
  });
});
