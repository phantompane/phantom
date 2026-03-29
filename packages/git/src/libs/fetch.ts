import { err, ok, type Result } from "@phantompane/utils";
import { executeGitCommand } from "../executor.ts";

export interface FetchOptions {
  remote?: string;
  refspec?: string;
  cwd?: string;
}

export async function fetch(options: FetchOptions = {}): Promise<Result<void>> {
  const { remote = "origin", refspec, cwd } = options;

  const args = ["fetch", remote];
  if (refspec) {
    args.push(refspec);
  }

  try {
    await executeGitCommand(args, { cwd });
    return ok(undefined);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return err(new Error(`git fetch failed: ${errorMessage}`));
  }
}
