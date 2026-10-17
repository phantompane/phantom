use std::io::IsTerminal;
use std::sync::OnceLock;

use serde::Deserialize;

use crate::error::{Error, Result};

#[derive(Debug, Deserialize)]
struct HelpFile {
    commands: Vec<CommandSummary>,
    helps: std::collections::BTreeMap<String, CommandHelp>,
}

#[derive(Debug, Deserialize)]
struct CommandSummary {
    name: String,
    description: String,
}

#[derive(Debug, Deserialize)]
struct CommandHelp {
    name: String,
    description: String,
    usage: String,
    #[serde(default)]
    options: Vec<CommandOption>,
    #[serde(default)]
    examples: Vec<CommandExample>,
    #[serde(default)]
    notes: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct CommandOption {
    name: String,
    short: Option<String>,
    #[serde(rename = "type")]
    kind: String,
    description: String,
    #[serde(default)]
    multiple: bool,
    example: Option<String>,
}

#[derive(Debug, Deserialize)]
struct CommandExample {
    description: String,
    command: String,
}

fn data() -> Result<&'static HelpFile> {
    static DATA: OnceLock<std::result::Result<HelpFile, String>> = OnceLock::new();
    match DATA.get_or_init(|| {
        serde_json::from_str(include_str!("../help-data.json")).map_err(|error| error.to_string())
    }) {
        Ok(file) => Ok(file),
        Err(error) => Err(Error::msg(error.clone())),
    }
}

#[allow(clippy::vec_init_then_push)]
pub fn main_help() -> Result<String> {
    let file = data()?;
    let mut lines = Vec::new();
    lines.push(bold("Phantom - Git Worktree Manager"));
    lines.push(String::new());
    lines.push(dim(
        "A CLI tool for managing Git worktrees with enhanced functionality",
    ));
    lines.push(String::new());
    lines.push(bold("USAGE"));
    lines.push("  phantom <command> [options]".to_string());
    lines.push(String::new());
    lines.push(bold("COMMANDS"));
    let max_name = file
        .commands
        .iter()
        .map(|command| command.name.len())
        .max()
        .unwrap_or(0);
    for command in &file.commands {
        lines.push(format!(
            "  {}{}",
            cyan(&format!("{:width$}", command.name, width = max_name + 2)),
            command.description
        ));
    }
    lines.push(String::new());
    lines.push(bold("GLOBAL OPTIONS"));
    let help_option = "-h, --help";
    let version_option = "-v, --version";
    let width = help_option.len().max(version_option.len()) + 2;
    lines.push(format!(
        "  {}Show help",
        cyan(&format!("{help_option:width$}"))
    ));
    lines.push(format!(
        "  {}Show version",
        cyan(&format!("{version_option:width$}"))
    ));
    lines.push(String::new());
    lines.push(dim(
        "Run 'phantom <command> --help' for more information on a command.",
    ));
    Ok(lines.join("\n"))
}

#[allow(clippy::vec_init_then_push)]
pub fn command_help(key: &str) -> Result<Option<String>> {
    let file = data()?;
    let Some(help) = file.helps.get(key) else {
        return Ok(None);
    };
    let mut lines = Vec::new();
    lines.push(bold(&format!("phantom {}", help.name)));
    lines.push(dim(&help.description));
    lines.push(String::new());
    lines.push(bold("USAGE"));
    lines.push(format!("  {}", help.usage));
    lines.push(String::new());
    if !help.options.is_empty() {
        lines.push(bold("OPTIONS"));
        let max_option = help
            .options
            .iter()
            .map(|option| option_name(option).len())
            .max()
            .unwrap_or(0);
        for option in &help.options {
            let name = option_name(option);
            let description = wrap_text(&option.description, max_option + 4);
            let padded = format!("{name:width$}", width = max_option + 2);
            let first = description.first().map(String::as_str).unwrap_or("");
            lines.push(format!("  {}{first}", cyan(&padded)));
            for extra in description.iter().skip(1) {
                lines.push(format!("  {:width$}{extra}", "", width = max_option + 2));
            }
            if let Some(example) = &option.example {
                let indent = " ".repeat(max_option + 4);
                lines.push(format!("  {indent}{}", dim(&format!("Example: {example}"))));
            }
        }
        lines.push(String::new());
    }
    if !help.examples.is_empty() {
        lines.push(bold("EXAMPLES"));
        for example in &help.examples {
            lines.push(format!("  {}", dim(&example.description)));
            lines.push(format!("    $ {}", example.command));
            lines.push(String::new());
        }
    }
    if !help.notes.is_empty() {
        lines.push(bold("NOTES"));
        for note in &help.notes {
            for line in wrap_text(note, 2) {
                lines.push(format!("  {line}"));
            }
        }
        lines.push(String::new());
    }
    Ok(Some(lines.join("\n")))
}

fn option_name(option: &CommandOption) -> String {
    let mut parts = Vec::new();
    if let Some(short) = &option.short {
        parts.push(format!("-{short},"));
    }
    parts.push(format!("--{}", option.name));
    if option.kind == "string" {
        parts.push(
            if option.multiple {
                "<value>..."
            } else {
                "<value>"
            }
            .to_string(),
        );
    }
    parts.join(" ")
}

fn wrap_text(text: &str, indent: usize) -> Vec<String> {
    let max_width = width().saturating_sub(indent).saturating_sub(2);
    let mut lines = Vec::new();
    let mut current = String::new();
    for word in text.split(' ') {
        if !current.is_empty() && current.len() + word.len() + 1 > max_width {
            lines.push(std::mem::take(&mut current));
            current = word.to_string();
        } else if current.is_empty() {
            current = word.to_string();
        } else {
            current.push(' ');
            current.push_str(word);
        }
    }
    if !current.is_empty() {
        lines.push(current);
    }
    lines
}

fn width() -> usize {
    if !std::io::stdout().is_terminal() {
        return 80;
    }
    terminal_size::terminal_size()
        .map(|(width, _)| width.0 as usize)
        .unwrap_or(80)
}

fn bold(text: &str) -> String {
    format!("\u{1b}[1m{text}\u{1b}[0m")
}

fn dim(text: &str) -> String {
    format!("\u{1b}[2m{text}\u{1b}[0m")
}

fn cyan(text: &str) -> String {
    format!("\u{1b}[36m{text}\u{1b}[0m")
}
