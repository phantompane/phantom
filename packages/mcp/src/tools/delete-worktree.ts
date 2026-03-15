import { createContext, deleteWorktree } from "@phantompane/core";
import { getGitRoot } from "@phantompane/git";
import { isOk } from "@phantompane/shared";
import { z } from "zod";
import type { Tool } from "./types.ts";

const schema = z.object({
  name: z.string().describe("Name of the worktree to delete"),
  force: z
    .boolean()
    .optional()
    .describe("Force deletion even if there are uncommitted changes"),
});

export const deleteWorktreeTool: Tool<typeof schema> = {
  name: "phantom_delete_worktree",
  description: "Delete a Git worktree (phantom)",
  inputSchema: schema,
  handler: async ({ name, force }) => {
    const gitRoot = await getGitRoot();
    const context = await createContext(gitRoot);
    const result = await deleteWorktree(
      context.gitRoot,
      context.worktreesDirectory,
      name,
      {
        force,
      },
      context.config?.preDelete?.commands,
    );

    if (!isOk(result)) {
      throw new Error(result.error.message);
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              success: true,
              message: `Worktree '${name}' deleted successfully`,
            },
            null,
            2,
          ),
        },
      ],
    };
  },
};
