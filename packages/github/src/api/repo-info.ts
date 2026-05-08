import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";

const execFileAsync = promisify(execFile);

const repoInfoSchema = z.object({
  owner: z.string(),
  repo: z.string(),
});

export interface GetGitHubRepoInfoOptions {
  cwd?: string;
}

export async function getGitHubRepoInfo(): Promise<{
  owner: string;
  repo: string;
}>;
export async function getGitHubRepoInfo(
  options: GetGitHubRepoInfoOptions,
): Promise<{
  owner: string;
  repo: string;
}>;
export async function getGitHubRepoInfo(
  options: GetGitHubRepoInfoOptions = {},
): Promise<{
  owner: string;
  repo: string;
}> {
  try {
    const { stdout } = await execFileAsync(
      "gh",
      ["repo", "view", "--json", "owner,name"],
      options.cwd ? { cwd: options.cwd } : undefined,
    );
    const data = JSON.parse(stdout.toString());
    return repoInfoSchema.parse({
      owner: data.owner.login,
      repo: data.name,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to get repository info: ${errorMessage}`);
  }
}
