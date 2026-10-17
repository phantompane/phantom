import { executeGitCommand } from "../executor.ts";

export interface ConfigUnsetOptions {
  key: string;
  global?: boolean;
  cwd?: string;
}

export async function configUnset(options: ConfigUnsetOptions): Promise<void> {
  const { key, global = false, cwd } = options;

  const args = ["config"];
  if (global) {
    args.push("--global");
  }
  args.push("--unset", key);

  if (cwd !== undefined) {
    await executeGitCommand(args, { cwd });
    return;
  }
  await executeGitCommand(args);
}
