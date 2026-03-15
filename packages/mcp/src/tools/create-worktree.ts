import { createContext, createWorktree } from "@phantompane/core";
import { getGitRoot } from "@phantompane/git";
import { isOk } from "@phantompane/shared";
import { z } from "zod";
import type { Tool } from "./types.ts";

const schema = z.object({
  name: z
    .string()
    .describe("Name for the worktree (also used as the branch name)"),
  baseBranch: z
    .string()
    .optional()
    .describe("Base branch to create from (optional)"),
});

export const createWorktreeTool: Tool<typeof schema> = {
  name: "phantom_create_worktree",
  description: "Create a new Git worktree (phantom)",
  inputSchema: schema,
  handler: async ({ name, baseBranch }) => {
    const gitRoot = await getGitRoot();
    const context = await createContext(gitRoot);
    const result = await createWorktree(
      context.gitRoot,
      context.worktreesDirectory,
      name,
      {
        branch: name,
        base: baseBranch,
      },
      context.config?.postCreate?.copyFiles,
      context.config?.postCreate?.commands,
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
              message: `Worktree '${name}' created successfully.`,
              path: result.value.path,
              note: `You can now switch to the worktree using 'cd ${result.value.path}'`,
            },
            null,
            2,
          ),
        },
      ],
    };
  },
};
