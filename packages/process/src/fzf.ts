import { spawn } from "node:child_process";
import { err, ok, type Result } from "@phantompane/shared";

export interface FzfOptions {
  prompt?: string;
  header?: string;
  previewCommand?: string;
}

export async function selectWithFzf(
  items: string[],
  options: FzfOptions = {},
): Promise<Result<string | null, Error>> {
  return new Promise((resolve) => {
    const args: string[] = [];

    if (options.prompt) {
      args.push("--prompt", options.prompt);
    }

    if (options.header) {
      args.push("--header", options.header);
    }

    if (options.previewCommand) {
      args.push("--preview", options.previewCommand);
    }

    const fzf = spawn("fzf", args, {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let result = "";
    let errorOutput = "";

    fzf.stdout.on("data", (data) => {
      result += data.toString();
    });

    if (fzf.stderr) {
      fzf.stderr.on("data", (data) => {
        errorOutput += data.toString();
      });
    }

    fzf.on("error", (error) => {
      if (error.message.includes("ENOENT")) {
        resolve(
          err(new Error("fzf command not found. Please install fzf first.")),
        );
      } else {
        resolve(err(error));
      }
    });

    fzf.on("close", (code) => {
      if (code === 0) {
        const selected = result.trim();
        resolve(ok(selected || null));
      } else if (code === 1) {
        resolve(ok(null));
      } else if (code === 130) {
        resolve(ok(null));
      } else {
        resolve(err(new Error(`fzf exited with code ${code}: ${errorOutput}`)));
      }
    });

    fzf.stdin.write(items.join("\n"));
    fzf.stdin.end();
  });
}
