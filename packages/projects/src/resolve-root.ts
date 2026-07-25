import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { getGitRoot } from "@phantompane/git";

export async function resolveProjectRootPath(
  inputPath: string,
): Promise<string> {
  const resolvedPath = await realpath(resolve(inputPath));
  const gitRoot = await getGitRoot({ cwd: resolvedPath });
  return await realpath(gitRoot);
}
