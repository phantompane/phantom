//! Small shell adapters; command names, flags and selector arity come from help.
use crate::error::{Error, Result};
use crate::help::{self, CommandOption};

#[derive(Clone, Copy)]
pub(crate) enum Shell {
    Bash,
    Zsh,
    Fish,
}

impl Shell {
    pub(crate) fn parse(name: &str) -> Result<Self> {
        match name {
            "bash" => Ok(Self::Bash),
            "zsh" => Ok(Self::Zsh),
            "fish" => Ok(Self::Fish),
            _ => Err(Error::validation(format!(
                "Unknown shell '{name}'; use bash, zsh or fish"
            ))),
        }
    }

    fn quote(self, value: &str) -> String {
        match self {
            Self::Fish => format!("'{}'", value.replace('\\', "\\\\").replace('\'', "\\'")),
            _ => format!("'{}'", value.replace('\'', "'\\''")),
        }
    }
}

pub(crate) fn init(shell: Shell) -> &'static str {
    match shell {
        Shell::Bash | Shell::Zsh => include_str!("shell/init.sh"),
        Shell::Fish => include_str!("shell/init.fish"),
    }
}

fn spellings(option: &CommandOption) -> Vec<String> {
    let mut names = vec![format!("--{}", option.name)];
    names.extend(option.short.iter().map(|short| format!("-{short}")));
    names.extend(option.aliases.iter().map(|alias| format!("--{alias}")));
    names
}

pub(crate) fn completions(shell: Shell) -> Result<String> {
    let file = help::data()?;
    let fish = matches!(shell, Shell::Fish);
    let mut values = String::new();
    let mut commands = String::new();
    let mut candidates = String::new();
    // The empty context describes global options and top-level commands.
    for key in std::iter::once("").chain(file.helps.keys().map(String::as_str)) {
        let entry = file.helps.get(key);
        let options = entry.map_or(file.global_options.as_slice(), |help| &help.options);
        for option in options.iter().filter(|option| option.kind == "string") {
            for spelling in spellings(option) {
                let pattern = shell.quote(&format!("{key}:{spelling}"));
                let pending = if option.name == "repo" {
                    "repo"
                } else {
                    "value"
                };
                if fish {
                    values.push_str(&format!("                case {pattern}\n                    set mabo_pending {pending}\n                    continue\n"));
                } else {
                    values.push_str(&format!(
                        "                {pattern}) mabo_pending={pending}; continue ;;\n"
                    ));
                }
            }
        }
        let children = if key.is_empty() || key == "help" {
            file.commands
                .iter()
                .map(|command| (command.name.as_str(), command.description.as_str()))
                .collect::<Vec<_>>()
        } else {
            let prefix = format!("{key} ");
            file.helps
                .iter()
                .filter_map(|(child, help)| {
                    let name = child.strip_prefix(&prefix)?;
                    (!name.contains(' ')).then_some((name, help.description.as_str()))
                })
                .collect()
        };
        for (child, _) in &children {
            let pattern = shell.quote(&format!("{key}:{child}"));
            let next = if key.is_empty() || key == "help" {
                child.to_string()
            } else {
                format!("{key} {child}")
            };
            let next = shell.quote(&next);
            let help_mode = if *child == "help" {
                if fish {
                    "set mabo_help 1\n                    "
                } else {
                    "mabo_help=1; "
                }
            } else {
                ""
            };
            if fish {
                commands.push_str(&format!("                case {pattern}\n                    {help_mode}set mabo_context {next}\n                    continue\n"));
            } else {
                commands.push_str(&format!(
                    "                {pattern}) {help_mode}mabo_context={next}; continue ;;\n"
                ));
            }
        }
        let flags = options
            .iter()
            .flat_map(|option| {
                spellings(option)
                    .into_iter()
                    .map(|name| (name, option.description.as_str()))
            })
            .map(|(name, description)| row(shell, &name, description))
            .collect::<Vec<_>>();
        let children = children
            .iter()
            .map(|(name, description)| row(shell, name, description))
            .collect::<Vec<_>>();
        if fish {
            candidates.push_str(&format!("        case {}\n", shell.quote(key)));
        } else {
            candidates.push_str(&format!("        {})\n", shell.quote(key)));
        }
        conditional(shell, &mut candidates, "flags", &flags);
        conditional(shell, &mut candidates, "children", &children);
        if let Some(help) = entry {
            if help.usage.contains("SEL") {
                let condition = if help.usage.contains("SEL...") {
                    "many"
                } else {
                    "one"
                };
                let query = if fish {
                    "set -l mabo_names (command mabo $mabo_repo list --names 2>/dev/null | string collect)\n            test $pipestatus[1] -eq 0; or return 0\n            test -z \"$mabo_names\"; or printf '%s\\n' \"$mabo_names\""
                } else {
                    "mabo_names=$(command mabo \"${mabo_repo[@]}\" list --names 2>/dev/null) || return 0\n            [ -z \"$mabo_names\" ] || printf '%s\\n' \"$mabo_names\""
                };
                block(shell, &mut candidates, condition, query);
            }
            if matches!(key, "completions" | "shell-init") {
                let rows = ["bash", "zsh", "fish"].map(|name| row(shell, name, "Shell"));
                conditional(shell, &mut candidates, "one", &rows);
            }
        }
        if !fish {
            candidates.push_str("            ;;\n");
        }
    }
    let template = if fish {
        include_str!("shell/candidates.fish")
    } else {
        include_str!("shell/candidates.sh")
    };
    let mut script = template
        .replace("@VALUE_OPTIONS@", &values)
        .replace("@COMMANDS@", &commands)
        .replace("@CANDIDATES@", &candidates);
    script.push_str(match shell {
        Shell::Bash => include_str!("shell/complete.bash"),
        Shell::Zsh => include_str!("shell/complete.zsh"),
        Shell::Fish => "",
    });
    Ok(script)
}

fn row(shell: Shell, name: &str, description: &str) -> String {
    // Descriptions must stay on one line for fish and the zsh adapter.
    let description = description.split_whitespace().collect::<Vec<_>>().join(" ");
    shell.quote(&format!("{name}\t{description}"))
}

fn conditional(shell: Shell, output: &mut String, condition: &str, rows: &[String]) {
    if !rows.is_empty() {
        block(
            shell,
            output,
            condition,
            &format!("printf '%s\\n' {}", rows.join(" ")),
        );
    }
}

fn block(shell: Shell, output: &mut String, condition: &str, body: &str) {
    let fish = matches!(shell, Shell::Fish);
    let condition = match (fish, condition) {
        (true, "flags") => "test $mabo_stop -eq 0",
        (true, "children") => "test $mabo_stop -eq 0; and test $mabo_count -eq 0",
        (true, "one") => "test $mabo_help -eq 0; and test $mabo_count -eq 0",
        (true, _) => "test $mabo_help -eq 0",
        (false, "flags") => "[ \"$mabo_stop\" -eq 0 ]",
        (false, "children") => "[ \"$mabo_stop\" -eq 0 ] && [ \"$mabo_count\" -eq 0 ]",
        (false, "one") => "[ \"$mabo_help\" -eq 0 ] && [ \"$mabo_count\" -eq 0 ]",
        (false, _) => "[ \"$mabo_help\" -eq 0 ]",
    };
    if fish {
        output.push_str(&format!(
            "            if {condition}\n                {body}\n            end\n"
        ));
    } else {
        output.push_str(&format!(
            "            if {condition}; then\n                {body}\n            fi\n"
        ));
    }
}
