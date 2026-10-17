import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function resolveCompletionScript(
  shell: "bash" | "fish" | "zsh",
  fallbackPath: string,
): string {
  const bin = process.env.PHANTOM_BIN;
  if (!bin) {
    return fallbackPath;
  }

  const script = execFileSync(bin, ["completion", shell], { encoding: "utf8" });
  const directory = mkdtempSync(join(tmpdir(), "phantom-completion-"));
  const scriptPath = join(directory, `phantom.${shell}`);
  writeFileSync(scriptPath, script);
  return scriptPath;
}
