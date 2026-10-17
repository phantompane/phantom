import { executeGitCommand } from "../executor.ts";

export interface GetStatusOptions {
  cwd: string;
}

export interface GitStatusEntry {
  indexStatus: string;
  workingTreeStatus: string;
  path: string;
  originalPath?: string;
}

export interface GitStatusResult {
  entries: GitStatusEntry[];
  isClean: boolean;
}

const renamePattern = /^(.+) -> (.+)$/;

function parseStatusLine(line: string): GitStatusEntry {
  const indexStatus = line[0] ?? " ";
  const workingTreeStatus = line[1] ?? " ";
  const pathPart = line.slice(3);
  const isRenameOrCopy =
    indexStatus === "R" ||
    indexStatus === "C" ||
    workingTreeStatus === "R" ||
    workingTreeStatus === "C";
  const renamedPaths = isRenameOrCopy ? pathPart.match(renamePattern) : null;

  let path = pathPart;
  let originalPath: string | undefined;
  if (renamedPaths) {
    const original = renamedPaths[1];
    const renamed = renamedPaths[2];
    if (renamed !== undefined) {
      path = renamed;
    }
    if (original !== undefined) {
      originalPath = original;
    }
  }

  return {
    indexStatus,
    workingTreeStatus,
    path,
    originalPath,
  };
}

export async function getStatus(
  options: GetStatusOptions,
): Promise<GitStatusResult> {
  const { stdout } = await executeGitCommand(["status", "--porcelain"], {
    cwd: options.cwd,
    trimStdout: false,
  });

  const entries = stdout
    .split("\n")
    .filter((line) => line.length > 0)
    .map(parseStatusLine);

  return {
    entries,
    isClean: entries.length === 0,
  };
}
