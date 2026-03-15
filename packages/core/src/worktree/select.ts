import { selectWithFzf } from "@phantompane/process";
import { isErr, type Result } from "@phantompane/shared";
import { listWorktrees } from "./list.ts";

export interface SelectWorktreeResult {
  name: string;
  branch: string | null;
  isClean: boolean;
}

export interface SelectWorktreeOptions {
  excludeDefault?: boolean;
}

export async function selectWorktreeWithFzf(
  gitRoot: string,
  options: SelectWorktreeOptions = {},
): Promise<Result<SelectWorktreeResult | null, Error>> {
  const listResult = await listWorktrees(gitRoot, {
    excludeDefault: options.excludeDefault,
  });

  if (isErr(listResult)) {
    return listResult;
  }

  const { worktrees } = listResult.value;

  if (worktrees.length === 0) {
    return {
      ok: true,
      value: null,
    };
  }

  const list = worktrees.map((wt) => {
    const status = !wt.isClean ? " [dirty]" : "";
    return `${wt.name} (${wt.pathToDisplay})${status}`;
  });

  const fzfResult = await selectWithFzf(list, {
    prompt: "Select worktree> ",
    header: "Git Worktrees",
  });

  if (isErr(fzfResult)) {
    return fzfResult;
  }

  if (!fzfResult.value) {
    return {
      ok: true,
      value: null,
    };
  }

  const selectedName = fzfResult.value.split(" ")[0];
  const selectedWorktree = worktrees.find((wt) => wt.name === selectedName);

  if (!selectedWorktree) {
    return {
      ok: false,
      error: new Error("Selected worktree not found"),
    };
  }

  return {
    ok: true,
    value: {
      name: selectedWorktree.name,
      branch: selectedWorktree.branch,
      isClean: selectedWorktree.isClean,
    },
  };
}
