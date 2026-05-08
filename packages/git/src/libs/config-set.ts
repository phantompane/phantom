import { executeGitCommand } from "../executor.ts";

export interface ConfigSetOptions {
  key: string;
  value: string;
  global?: boolean;
  cwd?: string;
}

export async function configSet(options: ConfigSetOptions): Promise<void> {
  const { key, value, global = false, cwd } = options;

  const args = ["config"];
  if (global) {
    args.push("--global");
  }
  args.push(key, value);

  await executeGitCommand(args, { cwd });
}
