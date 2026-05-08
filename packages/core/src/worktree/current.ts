import { getCurrentBranch, getTopLevel } from "@phantompane/git";

export async function getCurrentWorktreeName(
  gitRoot: string,
): Promise<string | null> {
  try {
    const currentTopLevel = await getTopLevel();
    if (currentTopLevel === gitRoot) {
      return null;
    }

    const branch = await getCurrentBranch({ cwd: currentTopLevel });
    return branch || null;
  } catch {
    return null;
  }
}
