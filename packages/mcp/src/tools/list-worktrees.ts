import { listWorktrees } from "@phantompane/core";
import { getGitRoot } from "@phantompane/git";
import { isOk } from "@phantompane/utils";
import { z } from "zod";
import type { Tool } from "./types.ts";

const schema = z.object({});

export const listWorktreesTool: Tool<typeof schema> = {
  name: "phantom_list_worktrees",
  description: "List all Git worktrees (phantoms)",
  inputSchema: schema,
  handler: async () => {
    const gitRoot = await getGitRoot();
    const result = await listWorktrees(gitRoot, { includePrunable: false });

    if (!isOk(result)) {
      throw new Error("Failed to list worktrees");
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              worktrees: result.value.worktrees.map((wt) => ({
                name: wt.name,
                path: wt.path,
                branch: wt.branch,
                isClean: wt.isClean,
              })),
              note: `You can switch to a worktree using 'cd <path>'`,
            },
            null,
            2,
          ),
        },
      ],
    };
  },
};
