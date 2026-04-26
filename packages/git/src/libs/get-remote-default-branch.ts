import { executeGitCommand } from "../executor.ts";

export interface GetRemoteDefaultBranchOptions {
  cwd?: string;
  remote: string;
}

export async function getRemoteDefaultBranch(
  options: GetRemoteDefaultBranchOptions,
): Promise<string | null> {
  try {
    const { stdout } = await executeGitCommand(
      ["ls-remote", "--symref", options.remote, "HEAD"],
      { cwd: options.cwd },
    );
    return parseRemoteDefaultBranch(stdout);
  } catch {
    return null;
  }
}

function parseRemoteDefaultBranch(stdout: string): string | null {
  const line = stdout
    .split("\n")
    .find((candidate) => candidate.startsWith("ref: refs/heads/"));
  if (!line) {
    return null;
  }

  const [ref] = line.slice("ref: refs/heads/".length).split(/\s+/, 1);
  return ref || null;
}
