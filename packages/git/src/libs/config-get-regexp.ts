import { executeGitCommand } from "../executor.ts";

export interface ConfigGetRegexpOptions {
  pattern: string;
  global?: boolean;
  nullSeparated?: boolean;
  cwd?: string;
}

export async function configGetRegexp(
  options: ConfigGetRegexpOptions,
): Promise<string> {
  const { pattern, global = false, nullSeparated = false, cwd } = options;

  const args = ["config"];
  if (global) {
    args.push("--global");
  }
  if (nullSeparated) {
    args.push("--null");
  }
  args.push("--get-regexp", pattern);

  const { stdout } =
    cwd !== undefined
      ? await executeGitCommand(args, { cwd })
      : await executeGitCommand(args);
  return stdout;
}
