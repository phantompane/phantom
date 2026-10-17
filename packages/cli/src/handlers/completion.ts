import { BASH_COMPLETION_SCRIPT } from "../completions/phantom-bash.ts";
import { FISH_COMPLETION_SCRIPT } from "../completions/phantom-fish.ts";
import { ZSH_COMPLETION_SCRIPT } from "../completions/phantom-zsh.ts";
import { output } from "../output.ts";

export async function completionHandler(args: string[]): Promise<void> {
  const shell = args[0];

  if (!shell) {
    output.error("Usage: phantom completion <shell>");
    output.error("Supported shells: fish, zsh, bash");
    process.exit(1);
  }

  switch (shell.toLowerCase()) {
    case "fish":
      console.log(FISH_COMPLETION_SCRIPT);
      break;
    case "zsh":
      console.log(ZSH_COMPLETION_SCRIPT);
      break;
    case "bash":
      console.log(BASH_COMPLETION_SCRIPT);
      break;
    default:
      output.error(`Unsupported shell: ${shell}`);
      output.error("Supported shells: fish, zsh, bash");
      process.exit(1);
  }
}
