import { githubCheckout } from "@phantompane/core";
import { isOk } from "@phantompane/utils";
import { z } from "zod";
import type { Tool } from "./types.ts";

const schema = z.object({
  number: z.string().describe("Issue or pull request number to checkout"),
  base: z
    .string()
    .optional()
    .describe("Base branch for issues (not applicable for pull requests)"),
});

export const githubCheckoutTool: Tool<typeof schema> = {
  name: "phantom_github_checkout",
  description:
    "Checkout a GitHub issue or pull request by number into a new worktree",
  inputSchema: schema,
  handler: async ({ number, base }) => {
    const result = await githubCheckout({ number, base });

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
              message: result.value.alreadyExists
                ? `Worktree '${result.value.worktree}' already exists.`
                : `Successfully checked out #${number} to worktree '${result.value.worktree}'.`,
              worktree: result.value.worktree,
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
