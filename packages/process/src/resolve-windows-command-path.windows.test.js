import { strictEqual } from "node:assert";
import { execFile } from "node:child_process";
import path from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";
import { resolveWindowsCommandPath } from "./resolve-windows-command-path.ts";

const execFileAsync = promisify(execFile);

describe(
  "resolveWindowsCommandPath (Windows)",
  { skip: process.platform !== "win32" },
  () => {
    it(
      "resolves an extensionless command to a runnable executable path",
      { timeout: 10_000 },
      async () => {
        const commandPath = resolveWindowsCommandPath("cmd");

        strictEqual(path.isAbsolute(commandPath), true);
        strictEqual(path.basename(commandPath).toLowerCase(), "cmd.exe");

        const { stdout } = await execFileAsync(
          commandPath,
          ["/c", "echo", "phantom-process-test"],
          { windowsHide: true },
        );

        strictEqual(stdout.toString().trim(), "phantom-process-test");
      },
    );
  },
);
