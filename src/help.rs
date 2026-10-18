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
    #[serde(default)]
    aliases: Vec<String>,
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
    lines.push("  ptm <command> [options]".to_string());
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
        "Run 'ptm <command> --help' for more information on a command.",
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
    lines.push(bold(&format!("ptm {}", help.name)));
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
    let mut flags = Vec::new();
    if let Some(short) = &option.short {
        flags.push(format!("-{short}"));
    }
    flags.push(format!("--{}", option.name));
    for alias in &option.aliases {
        flags.push(format!("--{alias}"));
    }
    let mut rendered = flags.join(", ");
    if option.kind == "string" {
        rendered.push(' ');
        rendered.push_str(if option.multiple {
            "<value>..."
        } else {
            "<value>"
        });
    }
    rendered
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
    styled("1", text)
}

fn dim(text: &str) -> String {
    styled("2", text)
}

fn cyan(text: &str) -> String {
    styled("36", text)
}

fn styled(code: &str, text: &str) -> String {
    if colors_enabled() {
        format!("\u{1b}[{code}m{text}\u{1b}[0m")
    } else {
        text.to_string()
    }
}

fn colors_enabled() -> bool {
    color_enabled(
        std::env::var("NO_COLOR").ok().as_deref(),
        std::env::var("FORCE_COLOR").ok().as_deref(),
        std::io::stdout().is_terminal(),
    )
}

fn color_enabled(no_color: Option<&str>, force_color: Option<&str>, stdout_is_tty: bool) -> bool {
    if no_color.is_some_and(|value| !value.is_empty()) {
        return false;
    }
    if let Some(value) = force_color {
        return value != "0" && !value.eq_ignore_ascii_case("false");
    }
    stdout_is_tty
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn long_options_use_two_dashes() {
        for key in [
            "list",
            "github checkout",
            "gh checkout",
            "exec",
            "delete",
            "where",
        ] {
            let help = command_help(key).expect("help data").expect(key);
            assert!(
                !help.contains("----"),
                "{key} rendered a four-dash option:\n{help}"
            );
        }
        let list = command_help("list").expect("help").expect("list");
        assert!(list.contains("--names"));
        assert!(list.contains("--no-default"));
        assert!(list.contains("--json"));
        let checkout = command_help("github checkout")
            .expect("help")
            .expect("checkout");
        assert!(checkout.contains("--base <value>"));
    }

    #[test]
    fn rendered_help_names_the_ptm_command() {
        let main = main_help().expect("main help");
        assert!(main.contains("ptm <command> [options]"));
        assert!(main.contains("Run 'ptm <command> --help'"));
        assert!(!mentions_phantom_command(&main), "{main}");
        let file = data().expect("help data");
        assert!(!file.helps.is_empty());
        for key in file.helps.keys() {
            let help = command_help(key).expect("render").expect(key);
            assert!(
                help.contains("ptm "),
                "{key} help does not name ptm:\n{help}"
            );
            assert!(
                !mentions_phantom_command(&help),
                "{key} still tells the user to run phantom:\n{help}"
            );
        }
    }

    #[test]
    fn help_names_worktrees_and_ptm_env() {
        let main = main_help().expect("main help");
        assert!(main.contains("Create a new Git worktree"));
        assert!(main.contains("List all Git worktrees"));
        assert!(main.contains("Delete a Git worktree"));
        assert!(main.contains("GitHub-specific commands for worktrees"));
        assert!(!main.contains("(phantom)"));
        assert!(!main.contains("(phantoms)"));
        for key in ["create", "attach", "delete", "exec"] {
            let help = command_help(key).expect("render").expect(key);
            assert!(help.contains("PTM_NAME"), "{key}:\n{help}");
            assert!(help.contains("PTM_PATH"), "{key}:\n{help}");
            assert!(!help.contains("PHANTOM"), "{key}:\n{help}");
        }
        for key in ["create", "attach", "delete"] {
            let help = command_help(key).expect("render").expect(key);
            assert!(help.contains("PTM_ROOT_PATH"), "{key}:\n{help}");
        }
        let exec = command_help("exec").expect("render").expect("exec");
        assert!(!exec.contains("PTM_ROOT_PATH"), "{exec}");
    }

    fn mentions_phantom_command(help: &str) -> bool {
        const COMMANDS: &[&str] = &[
            "<command>",
            "--version",
            "-v",
            "create",
            "attach",
            "list",
            "where",
            "delete",
            "exec",
            "preferences",
            "version",
            "project",
            "clone",
            "github",
            "gh",
        ];
        help.split("phantom ")
            .skip(1)
            .any(|rest| COMMANDS.iter().any(|command| rest.starts_with(command)))
    }

    #[test]
    fn color_follows_tty_no_color_and_force_color() {
        assert!(!color_enabled(None, None, false));
        assert!(color_enabled(None, None, true));
        assert!(!color_enabled(Some("1"), None, true));
        assert!(color_enabled(Some(""), None, true));
        assert!(color_enabled(None, Some("1"), false));
        assert!(color_enabled(None, Some(""), false));
        assert!(!color_enabled(None, Some("0"), true));
        assert!(!color_enabled(None, Some("false"), true));
        assert!(!color_enabled(Some("1"), Some("1"), true));
    }
}
