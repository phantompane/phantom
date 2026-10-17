export interface CommandOption {
  name: string;
  short?: string;
  type: "boolean" | "string";
  description: string;
  multiple?: boolean;
  example?: string;
}

export interface CommandHelp {
  name: string;
  description: string;
  usage: string;
  options?: CommandOption[];
  examples?: Array<{
    description: string;
    command: string;
  }>;
  notes?: string[];
}

export class HelpFormatter {
  private readonly width: number;
  private readonly indent = "  ";

  constructor() {
    this.width = process.stdout.columns || 80;
  }

  formatMainHelp(
    commands: Array<{ name: string; description: string }>,
  ): string {
    const lines: string[] = [];

    lines.push(this.bold("Phantom - Git Worktree Manager"));
    lines.push("");
    lines.push(
      this.dim(
        "A CLI tool for managing Git worktrees with enhanced functionality",
      ),
    );
    lines.push("");
    lines.push(this.section("USAGE"));
    lines.push(`${this.indent}phantom <command> [options]`);
    lines.push("");
    lines.push(this.section("COMMANDS"));

    const maxNameLength = Math.max(...commands.map((cmd) => cmd.name.length));

    for (const cmd of commands) {
      const paddedName = cmd.name.padEnd(maxNameLength + 2);
      lines.push(`${this.indent}${this.cyan(paddedName)}${cmd.description}`);
    }

    lines.push("");
    lines.push(this.section("GLOBAL OPTIONS"));
    const helpOption = "-h, --help";
    const versionOption = "-v, --version";
    const globalOptionWidth =
      Math.max(helpOption.length, versionOption.length) + 2;
    lines.push(
      `${this.indent}${this.cyan(helpOption.padEnd(globalOptionWidth))}Show help`,
    );
    lines.push(
      `${this.indent}${this.cyan(versionOption.padEnd(globalOptionWidth))}Show version`,
    );
    lines.push("");
    lines.push(
      this.dim(
        "Run 'phantom <command> --help' for more information on a command.",
      ),
    );

    return lines.join("\n");
  }

  formatCommandHelp(help: CommandHelp): string {
    const lines: string[] = [];

    lines.push(this.bold(`phantom ${help.name}`));
    lines.push(this.dim(help.description));
    lines.push("");

    lines.push(this.section("USAGE"));
    lines.push(`${this.indent}${help.usage}`);
    lines.push("");

    if (help.options && help.options.length > 0) {
      lines.push(this.section("OPTIONS"));
      const maxOptionLength = Math.max(
        ...help.options.map((opt) => this.formatOptionName(opt).length),
      );

      for (const option of help.options) {
        const optionName = this.formatOptionName(option);
        const paddedName = optionName.padEnd(maxOptionLength + 2);
        const description = this.wrapText(
          option.description,
          maxOptionLength + 4,
        );

        lines.push(`${this.indent}${this.cyan(paddedName)}${description[0]}`);
        for (let i = 1; i < description.length; i++) {
          lines.push(
            `${this.indent}${" ".repeat(maxOptionLength + 2)}${description[i]}`,
          );
        }

        if (option.example) {
          const exampleIndent = " ".repeat(maxOptionLength + 4);
          lines.push(
            `${this.indent}${exampleIndent}${this.dim(`Example: ${option.example}`)}`,
          );
        }
      }
      lines.push("");
    }

    if (help.examples && help.examples.length > 0) {
      lines.push(this.section("EXAMPLES"));
      for (const example of help.examples) {
        lines.push(`${this.indent}${this.dim(example.description)}`);
        lines.push(`${this.indent}${this.indent}$ ${example.command}`);
        lines.push("");
      }
    }

    if (help.notes && help.notes.length > 0) {
      lines.push(this.section("NOTES"));
      for (const note of help.notes) {
        const wrappedNote = this.wrapText(note, 2);
        for (const line of wrappedNote) {
          lines.push(`${this.indent}${line}`);
        }
      }
      lines.push("");
    }

    return lines.join("\n");
  }

  private formatOptionName(option: CommandOption): string {
    const parts: string[] = [];

    if (option.short) {
      parts.push(`-${option.short},`);
    }

    parts.push(`--${option.name}`);

    if (option.type === "string") {
      parts.push(option.multiple ? "<value>..." : "<value>");
    }

    return parts.join(" ");
  }

  private wrapText(text: string, indent: number): string[] {
    const maxWidth = this.width - indent - 2;
    const words = text.split(" ");
    const lines: string[] = [];
    let currentLine = "";

    for (const word of words) {
      if (currentLine.length + word.length + 1 > maxWidth) {
        lines.push(currentLine);
        currentLine = word;
      } else {
        currentLine = currentLine ? `${currentLine} ${word}` : word;
      }
    }

    if (currentLine) {
      lines.push(currentLine);
    }

    return lines;
  }

  private section(text: string): string {
    return this.bold(text);
  }

  private bold(text: string): string {
    return `\x1b[1m${text}\x1b[0m`;
  }

  private dim(text: string): string {
    return `\x1b[2m${text}\x1b[0m`;
  }

  private cyan(text: string): string {
    return `\x1b[36m${text}\x1b[0m`;
  }
}

export const helpFormatter = new HelpFormatter();
