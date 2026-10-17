use std::path::Path;

use crate::args::{self, Opt, Parsed};
use crate::error::{Error, Result, GENERAL, NOT_FOUND, SUCCESS, VALIDATION};
use crate::git;
use crate::github;
use crate::help;
use crate::preferences::{self, Preferences};
use crate::process;
use crate::projects::{self, ProjectListEntry, ProjectRecord, ProjectRegistryStore};
use crate::tmux::{self, TmuxDirection};
use crate::worktree::{self, ActionRequest, Logger};

struct Command {
    name: &'static str,
    help_key: &'static str,
    run: fn(&[String]) -> Result<i32>,
    children: &'static [Command],
}

pub fn run(args: &[String]) -> Result<i32> {
    if args.is_empty() || args[0] == "-h" || args[0] == "--help" {
        println!("{}", help::main_help()?);
        return Ok(SUCCESS);
    }
    if args[0] == "-v" || args[0] == "--version" {
        println!("{}", crate::version_line());
        return Ok(SUCCESS);
    }
    match find(args, COMMANDS) {
        Some((command, remaining))
            if remaining.iter().any(|arg| arg == "-h" || arg == "--help") =>
        {
            match help::command_help(command.help_key)? {
                Some(text) => println!("{text}"),
                None => println!("Help not available for command '{}'", command.name),
            }
            Ok(SUCCESS)
        }
        Some((command, remaining)) => (command.run)(remaining),
        None => {
            eprintln!("Error: Unknown command '{}'\n", args.join(" "));
            println!("{}", help::main_help()?);
            Ok(GENERAL)
        }
    }
}

fn find<'a>(args: &'a [String], commands: &'a [Command]) -> Option<(&'a Command, &'a [String])> {
    let (name, rest) = args.split_first()?;
    let command = commands.iter().find(|command| command.name == name)?;
    if !command.children.is_empty() && !rest.is_empty() {
        if let Some(found) = find(rest, command.children) {
            return Some(found);
        }
    }
    Some((command, rest))
}

fn create(args: &[String]) -> Result<i32> {
    let parsed = args::parse(
        args,
        &[
            flag("shell", Some('s')),
            value_flag("exec", Some('x')),
            flag("tmux", Some('t')),
            flag("tmux-vertical", None),
            flag("tmux-v", None),
            flag("tmux-horizontal", None),
            flag("tmux-h", None),
            Opt {
                name: "copy-file",
                short: None,
                value: true,
                multiple: true,
            },
            value_flag("base", None),
        ],
        true,
    )?;
    match worktree::run_create(worktree::CreateRequest {
        name: parsed.positionals.first().map(String::as_str),
        base: parsed.value("base"),
        copy_files: &parsed.values("copy-file"),
        action: action_from(&parsed),
        logger: Logger::on(),
    }) {
        Ok(outcome) => Ok(outcome.exit_code.unwrap_or(SUCCESS)),
        Err(error) => fail(&error, create_code(&error)),
    }
}

fn attach(args: &[String]) -> Result<i32> {
    let parsed = args::parse(
        args,
        &[
            flag("shell", Some('s')),
            value_flag("exec", Some('x')),
            flag("tmux", Some('t')),
            flag("tmux-vertical", None),
            flag("tmux-v", None),
            flag("tmux-horizontal", None),
            flag("tmux-h", None),
            Opt {
                name: "copy-file",
                short: None,
                value: true,
                multiple: true,
            },
        ],
        true,
    )?;
    let Some(name) = parsed.positionals.first() else {
        return fail(
            &Error::msg("Missing required argument: branch name"),
            VALIDATION,
        );
    };
    match worktree::run_attach(worktree::AttachRequest {
        name,
        copy_files: &parsed.values("copy-file"),
        action: action_from(&parsed),
        logger: Logger::on(),
    }) {
        Ok(outcome) => Ok(outcome.exit_code.unwrap_or(SUCCESS)),
        Err(error) => fail(&error, attach_code(&error)),
    }
}

fn list(args: &[String]) -> Result<i32> {
    let parsed = args::parse(
        args,
        &[
            flag("fzf", None),
            flag("no-default", None),
            flag("names", None),
        ],
        false,
    )?;
    let cwd = std::env::current_dir().map_err(|error| Error::msg(error.to_string()))?;
    let git_root = match git::git_root(&cwd) {
        Ok(root) => root,
        Err(error) => return fail(&error, error.exit_code()),
    };
    let exclude_default = parsed.flag("no-default");
    if parsed.flag("fzf") {
        return match worktree::select_with_fzf(&git_root, exclude_default) {
            Ok(Some(worktree)) => {
                println!("{}", worktree.name);
                Ok(SUCCESS)
            }
            Ok(None) => Ok(SUCCESS),
            Err(error) => fail(&error, GENERAL),
        };
    }
    let worktrees = match worktree::list_worktrees(&git_root, exclude_default, false) {
        Ok(worktrees) => worktrees,
        Err(error) => return fail(&error, GENERAL),
    };
    if worktrees.is_empty() {
        if !parsed.flag("names") {
            let available = worktree::list_worktrees(&git_root, false, false).unwrap_or_default();
            let message = if exclude_default && !available.is_empty() {
                "No sub worktrees found"
            } else {
                "No worktrees found"
            };
            println!("{message}");
        }
        return Ok(SUCCESS);
    }
    for worktree in worktrees {
        if parsed.flag("names") {
            println!("{}", worktree.name);
        } else {
            let dirty = if worktree.is_clean { "" } else { " [dirty]" };
            println!("{} ({}){dirty}", worktree.name, worktree.path_to_display);
        }
    }
    Ok(SUCCESS)
}

fn where_cmd(args: &[String]) -> Result<i32> {
    let parsed = args::parse(args, &[flag("fzf", None)], true)?;
    let use_fzf = parsed.flag("fzf");
    if parsed.positionals.is_empty() && !use_fzf {
        return fail(
            &Error::msg("Usage: phantom where <worktree-name> or phantom where --fzf"),
            VALIDATION,
        );
    }
    if !parsed.positionals.is_empty() && use_fzf {
        return fail(
            &Error::msg("Cannot specify both a worktree name and --fzf option"),
            VALIDATION,
        );
    }
    let cwd = std::env::current_dir().map_err(|error| Error::msg(error.to_string()))?;
    let git_root = match git::git_root(&cwd) {
        Ok(root) => root,
        Err(error) => return fail(&error, error.exit_code()),
    };
    let context = crate::context::create(&git_root)?;
    let name = if use_fzf {
        match worktree::select_with_fzf(&context.git_root, false) {
            Ok(Some(worktree)) => worktree.name,
            Ok(None) => return Ok(SUCCESS),
            Err(error) => return fail(&error, GENERAL),
        }
    } else {
        parsed.positionals[0].clone()
    };
    match worktree::find_worktree(&context.git_root, &name, false, None) {
        Ok(worktree) => {
            println!("{}", worktree.path);
            Ok(SUCCESS)
        }
        Err(error @ Error::WorktreeNotFound(_)) => fail(&error, NOT_FOUND),
        Err(error) => fail(&error, GENERAL),
    }
}

fn delete(args: &[String]) -> Result<i32> {
    let parsed = args::parse(
        args,
        &[
            flag("force", Some('f')),
            flag("keep-branch", None),
            flag("current", None),
            flag("fzf", None),
        ],
        true,
    )?;
    let delete_current = parsed.flag("current");
    let use_fzf = parsed.flag("fzf");
    if parsed.positionals.is_empty() && !delete_current && !use_fzf {
        return fail(
            &Error::msg(
                "Please provide at least one worktree name to delete, use --current to delete the current worktree, or use --fzf for interactive selection",
            ),
            VALIDATION,
        );
    }
    if (!parsed.positionals.is_empty() || use_fzf) && delete_current {
        return fail(
            &Error::msg("Cannot specify --current with a worktree name or --fzf option"),
            VALIDATION,
        );
    }
    if !parsed.positionals.is_empty() && use_fzf {
        return fail(
            &Error::msg("Cannot specify both a worktree name and --fzf option"),
            VALIDATION,
        );
    }
    let cwd = std::env::current_dir().map_err(|error| Error::msg(error.to_string()))?;
    let git_root = match git::git_root(&cwd) {
        Ok(root) => root,
        Err(error) => return fail(&error, error.exit_code()),
    };
    let context = match crate::context::create(&git_root) {
        Ok(context) => context,
        Err(error) => return fail(&error, GENERAL),
    };
    let keep_branch =
        parsed.flag("keep-branch") || context.preferences.keep_branch.unwrap_or(false);
    let names = if delete_current {
        match worktree::current_worktree_name(&git_root)? {
            Some(name) => vec![name],
            None => {
                return fail(
                    &Error::msg(
                        "Not in a worktree directory. The --current option can only be used from within a worktree.",
                    ),
                    VALIDATION,
                );
            }
        }
    } else if use_fzf {
        match worktree::select_with_fzf(&context.git_root, false) {
            Ok(Some(worktree)) => vec![worktree.name],
            Ok(None) => return Ok(SUCCESS),
            Err(error) => return fail(&error, GENERAL),
        }
    } else {
        parsed.positionals.clone()
    };
    for name in names {
        match worktree::delete_worktree(&context, &name, parsed.flag("force"), keep_branch, None) {
            Ok(outcome) => println!("{}", outcome.message),
            Err(error) => {
                let code = match &error {
                    Error::WorktreeNotFound(_) | Error::Uncommitted { .. } => VALIDATION,
                    _ => GENERAL,
                };
                return fail(&error, code);
            }
        }
    }
    Ok(SUCCESS)
}

fn exec(args: &[String]) -> Result<i32> {
    let parsed = args::parse(args, &tmux_options_with(&[flag("fzf", None)]), true)?;
    let use_fzf = parsed.flag("fzf");
    let direction = tmux_direction(&parsed);
    if direction.is_some() && !tmux::inside_tmux() {
        return fail(&Error::TmuxRequired, VALIDATION);
    }
    let command_args: Vec<String> = if use_fzf {
        if parsed.positionals.is_empty() {
            return fail(
                &Error::msg("Usage: phantom exec --fzf <command> [args...]"),
                VALIDATION,
            );
        }
        parsed.positionals.clone()
    } else {
        if parsed.positionals.len() < 2 {
            return fail(
                &Error::msg("Usage: phantom exec <worktree-name> <command> [args...]"),
                VALIDATION,
            );
        }
        parsed.positionals[1..].to_vec()
    };
    let cwd = std::env::current_dir().map_err(|error| Error::msg(error.to_string()))?;
    let git_root = match git::git_root(&cwd) {
        Ok(root) => root,
        Err(error) => return fail(&error, error.exit_code()),
    };
    let context = match crate::context::create(&git_root) {
        Ok(context) => context,
        Err(error) => return fail(&error, GENERAL),
    };
    let name = if use_fzf {
        match worktree::select_with_fzf(&context.git_root, false) {
            Ok(Some(worktree)) => worktree.name,
            Ok(None) => return Ok(SUCCESS),
            Err(error) => return fail(&error, GENERAL),
        }
    } else {
        parsed.positionals[0].clone()
    };
    let worktree = match worktree::find_worktree(&context.git_root, &name, false, None) {
        Ok(worktree) => worktree,
        Err(error) => return fail(&error, GENERAL),
    };
    let path = Path::new(&worktree.path).to_path_buf();
    if let Some(direction) = direction {
        println!(
            "Executing command in worktree '{name}' in tmux {}...",
            if direction == TmuxDirection::New {
                "window"
            } else {
                "pane"
            }
        );
        let env = worktree::phantom_env(&name, &path);
        let command = command_args[0].as_str();
        let rest = command_args[1..]
            .iter()
            .map(String::as_str)
            .collect::<Vec<_>>();
        let window = (direction == TmuxDirection::New).then_some(name.as_str());
        if let Err(error) = tmux::run_command(direction, command, &rest, &path, &env, window) {
            eprintln!("{error}");
            eprintln!();
            return Ok(error.exit_code());
        }
        return Ok(SUCCESS);
    }
    let command = command_args[0].as_str();
    let rest = command_args[1..]
        .iter()
        .map(String::as_str)
        .collect::<Vec<_>>();
    match worktree::exec_in_worktree(
        &context.git_root,
        &context.worktrees_directory,
        &name,
        command,
        &rest,
        &[],
    ) {
        Ok(0) => Ok(SUCCESS),
        Ok(code) => fail(
            &Error::CommandFailed {
                command: command.to_string(),
                code,
            },
            code,
        ),
        Err(error) => {
            let code = if matches!(error, Error::WorktreeNotFound(_)) {
                NOT_FOUND
            } else {
                error.exit_code()
            };
            fail(&error, code)
        }
    }
}

fn shell(args: &[String]) -> Result<i32> {
    let parsed = args::parse(args, &tmux_options_with(&[flag("fzf", None)]), true)?;
    let use_fzf = parsed.flag("fzf");
    let direction = tmux_direction(&parsed);
    if parsed.positionals.is_empty() && !use_fzf {
        return fail(
            &Error::msg("Usage: phantom shell <worktree-name> or phantom shell --fzf"),
            VALIDATION,
        );
    }
    if !parsed.positionals.is_empty() && use_fzf {
        return fail(
            &Error::msg("Cannot specify both a worktree name and --fzf option"),
            VALIDATION,
        );
    }
    let cwd = std::env::current_dir().map_err(|error| Error::msg(error.to_string()))?;
    let git_root = match git::git_root(&cwd) {
        Ok(root) => root,
        Err(error) => return fail(&error, error.exit_code()),
    };
    let context = match crate::context::create(&git_root) {
        Ok(context) => context,
        Err(error) => return fail(&error, GENERAL),
    };
    if direction.is_some() && !tmux::inside_tmux() {
        return fail(&Error::TmuxRequired, VALIDATION);
    }
    let name = if use_fzf {
        match worktree::select_with_fzf(&context.git_root, false) {
            Ok(Some(worktree)) => worktree.name,
            Ok(None) => return Ok(SUCCESS),
            Err(error) => return fail(&error, GENERAL),
        }
    } else {
        parsed.positionals[0].clone()
    };
    let worktree = match worktree::find_worktree(&context.git_root, &name, false, None) {
        Ok(worktree) => worktree,
        Err(error) => return fail(&error, GENERAL),
    };
    let path = Path::new(&worktree.path).to_path_buf();
    if let Some(direction) = direction {
        println!(
            "Opening worktree '{name}' in tmux {}...",
            if direction == TmuxDirection::New {
                "window"
            } else {
                "pane"
            }
        );
        let env = worktree::phantom_env(&name, &path);
        let window = (direction == TmuxDirection::New).then_some(name.as_str());
        if let Err(error) = tmux::open_shell(direction, &path, &env, window) {
            eprintln!("{error}");
            eprintln!();
            return Ok(error.exit_code());
        }
        return Ok(SUCCESS);
    }
    println!("Entering worktree '{name}' at {}", path.display());
    println!("Type 'exit' to return to your original directory\n");
    match worktree::open_shell(&context.git_root, &name) {
        Ok(0) => Ok(SUCCESS),
        Ok(code) => {
            let shell_name = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
            fail(
                &Error::CommandFailed {
                    command: shell_name,
                    code,
                },
                code,
            )
        }
        Err(error) => {
            let code = if matches!(error, Error::WorktreeNotFound(_)) {
                NOT_FOUND
            } else {
                error.exit_code()
            };
            fail(&error, code)
        }
    }
}

fn edit(args: &[String]) -> Result<i32> {
    let parsed = args::parse(args, &[], true)?;
    if parsed.positionals.is_empty() || parsed.positionals.len() > 2 {
        return fail(
            &Error::msg("Usage: phantom edit <worktree-name> [path]"),
            VALIDATION,
        );
    }
    launch_configured(args, true)
}

fn ai(args: &[String]) -> Result<i32> {
    let parsed = args::parse(args, &[], true)?;
    if parsed.positionals.len() != 1 {
        return fail(&Error::msg("Usage: phantom ai <worktree-name>"), VALIDATION);
    }
    launch_configured(args, false)
}

fn launch_configured(args: &[String], editor: bool) -> Result<i32> {
    let parsed = args::parse(args, &[], true)?;
    let name = &parsed.positionals[0];
    let target = parsed.positionals.get(1).map(String::as_str).unwrap_or(".");
    let cwd = std::env::current_dir().map_err(|error| Error::msg(error.to_string()))?;
    let git_root = match git::git_root(&cwd) {
        Ok(root) => root,
        Err(error) => return fail(&error, error.exit_code()),
    };
    let context = match crate::context::create(&git_root) {
        Ok(context) => context,
        Err(error) => return fail(&error, GENERAL),
    };
    let command = if editor {
        match context
            .preferences
            .editor
            .clone()
            .or_else(|| std::env::var("EDITOR").ok())
        {
            Some(command) => command,
            None => {
                return fail(
                    &Error::msg(
                        "Editor is not configured. Run 'phantom preferences set editor <command>' or set the EDITOR env var.",
                    ),
                    VALIDATION,
                );
            }
        }
    } else {
        match context.preferences.ai.clone() {
            Some(command) => command,
            None => {
                return fail(
                    &Error::msg(
                        "AI assistant is not configured. Run 'phantom preferences set ai <command>' first.",
                    ),
                    VALIDATION,
                );
            }
        }
    };
    let worktree = match worktree::find_worktree(&context.git_root, name, false, None) {
        Ok(worktree) => worktree,
        Err(Error::WorktreeNotFound(missing)) => {
            return fail(&Error::WorktreeNotFound(missing), NOT_FOUND);
        }
        Err(error) => return fail(&error, GENERAL),
    };
    let path = Path::new(&worktree.path).to_path_buf();
    if editor {
        println!("Opening editor in worktree '{name}'...");
    } else {
        println!("Launching AI assistant in worktree '{name}'...");
    }
    let env = worktree::phantom_env(name, &path);
    let pairs = env
        .iter()
        .map(|(key, value)| (key.as_str(), value.as_str()))
        .collect::<Vec<_>>();
    let script = if editor {
        format!("{command} {target}")
    } else {
        command
    };
    match process::shell(&script, &path, &pairs) {
        Ok(code) => Ok(code),
        Err(error) => fail(&error, GENERAL),
    }
}

fn preferences_root(args: &[String]) -> Result<i32> {
    if args.is_empty() {
        if let Some(text) = help::command_help("preferences")? {
            println!("{text}");
        }
        return Ok(SUCCESS);
    }
    Err(Error::msg(format!(
        "Unknown preferences subcommand: {}",
        args[0]
    )))
}

fn preferences_get(args: &[String]) -> Result<i32> {
    let parsed = args::parse(args, &[], true)?;
    if parsed.positionals.len() != 1 {
        return fail(
            &Error::msg("Usage: phantom preferences get <key>"),
            VALIDATION,
        );
    }
    let key = &parsed.positionals[0];
    if let Err(error) = preferences::require_key(key) {
        return fail(&error, VALIDATION);
    }
    let loaded = match preferences::load_preferences() {
        Ok(preferences) => preferences,
        Err(error) => return fail(&error, GENERAL),
    };
    match preferences::preference_value(&loaded, key) {
        Some(value) => println!("{value}"),
        None => println!(
            "Preference '{key}' is not set (git config --global {})",
            preferences::config_key(key)
        ),
    }
    Ok(SUCCESS)
}

fn preferences_set(args: &[String]) -> Result<i32> {
    if args.len() < 2 {
        return fail(
            &Error::msg("Usage: phantom preferences set <key> <value>"),
            VALIDATION,
        );
    }
    let key = &args[0];
    if let Err(error) = preferences::require_key(key) {
        return fail(&error, VALIDATION);
    }
    let value = args[1..].join(" ");
    if value.is_empty() {
        return fail(
            &Error::msg(format!("Preference '{key}' requires a value")),
            VALIDATION,
        );
    }
    if let Some(message) = preferences::validate_preference_value(key, &value) {
        return fail(&Error::msg(message), VALIDATION);
    }
    let config_key = preferences::config_key(key);
    if let Err(error) = git::config_set_global(&config_key, &value) {
        return fail(&error, GENERAL);
    }
    println!("Set {config_key} (global) to '{value}'");
    Ok(SUCCESS)
}

fn preferences_remove(args: &[String]) -> Result<i32> {
    let parsed = args::parse(args, &[], true)?;
    if parsed.positionals.len() != 1 {
        return fail(
            &Error::msg("Usage: phantom preferences remove <key>"),
            VALIDATION,
        );
    }
    let key = &parsed.positionals[0];
    if let Err(error) = preferences::require_key(key) {
        return fail(&error, VALIDATION);
    }
    let config_key = preferences::config_key(key);
    if let Err(error) = git::config_unset_global(&config_key) {
        return fail(&error, GENERAL);
    }
    println!("Removed {config_key} from global git config");
    Ok(SUCCESS)
}

fn version(args: &[String]) -> Result<i32> {
    args::parse(args, &[], false)?;
    println!("{}", crate::version_line());
    Ok(SUCCESS)
}

fn completion(args: &[String]) -> Result<i32> {
    let Some(shell) = args.first() else {
        eprintln!("Usage: phantom completion <shell>");
        eprintln!("Supported shells: fish, zsh, bash");
        return Ok(GENERAL);
    };
    let script = match shell.to_ascii_lowercase().as_str() {
        "bash" => include_str!("../completions/phantom.bash"),
        "zsh" => include_str!("../completions/phantom.zsh"),
        "fish" => include_str!("../completions/phantom.fish"),
        _ => {
            eprintln!("Unsupported shell: {shell}");
            eprintln!("Supported shells: fish, zsh, bash");
            return Ok(GENERAL);
        }
    };
    println!("{script}");
    Ok(SUCCESS)
}

fn mcp(args: &[String]) -> Result<i32> {
    let parsed = args::parse(args, &[flag("help", Some('h'))], true)?;
    if parsed.flag("help") || parsed.positionals.is_empty() {
        if let Some(text) = help::command_help("mcp")? {
            println!("{text}");
        }
        return Ok(SUCCESS);
    }
    if parsed.positionals[0] != "serve" {
        eprintln!("Unknown subcommand: {}", parsed.positionals[0]);
        return Ok(GENERAL);
    }
    if let Err(error) = crate::mcp::serve() {
        eprintln!("Failed to start MCP server: {error}");
        return Ok(GENERAL);
    }
    Ok(SUCCESS)
}

fn project_root(args: &[String]) -> Result<i32> {
    if args.is_empty() {
        if let Some(text) = help::command_help("project")? {
            println!("{text}");
        }
        return Ok(SUCCESS);
    }
    Err(Error::msg(format!(
        "Unknown project subcommand: {}",
        args[0]
    )))
}

fn project_add(args: &[String]) -> Result<i32> {
    let parsed = match args::parse(args, &[flag("json", None)], true) {
        Ok(parsed) => parsed,
        Err(error) => return fail(&error, VALIDATION),
    };
    if parsed.positionals.len() > 1 {
        return fail(
            &Error::msg("Usage: phantom project add [path] [--json]"),
            VALIDATION,
        );
    }
    let cwd = std::env::current_dir().map_err(|error| Error::msg(error.to_string()))?;
    let input = parsed
        .positionals
        .first()
        .map(Path::new)
        .unwrap_or(cwd.as_path());
    let root = projects::resolve_project_root(input)?;
    let store = ProjectRegistryStore::default_store()?;
    let (project, added) = store.add(&root)?;
    if parsed.flag("json") {
        println!(
            "{}",
            serde_json::to_string_pretty(&project_add_json(added, &project))
                .map_err(|error| Error::msg(error.to_string()))?
        );
    } else if added {
        println!("Added project '{}' ({})", project.name, project.root_path);
    } else {
        println!(
            "Project '{}' is already registered ({})",
            project.name, project.root_path
        );
    }
    Ok(SUCCESS)
}

fn project_list(args: &[String]) -> Result<i32> {
    let parsed = match args::parse(
        args,
        &[flag("json", None), flag("names", None), flag("paths", None)],
        false,
    ) {
        Ok(parsed) => parsed,
        Err(error) => return fail(&error, VALIDATION),
    };
    let modes = [
        parsed.flag("json"),
        parsed.flag("names"),
        parsed.flag("paths"),
    ]
    .iter()
    .filter(|enabled| **enabled)
    .count();
    if modes > 1 {
        return fail(
            &Error::msg("Only one of --json, --names, or --paths can be specified"),
            VALIDATION,
        );
    }
    let loaded = preferences::load_preferences().unwrap_or_else(|_| Preferences::default());
    let catalog = projects::list_catalog(loaded.ghq_discovery != Some(false))?;
    for warning in &catalog.warnings {
        eprintln!("Warning: {warning}");
    }
    if parsed.flag("json") {
        println!(
            "{}",
            serde_json::to_string_pretty(&catalog_json(&catalog.projects, catalog.version))
                .map_err(|error| Error::msg(error.to_string()))?
        );
        return Ok(SUCCESS);
    }
    if catalog.projects.is_empty() {
        if !parsed.flag("names") && !parsed.flag("paths") {
            println!("No projects found.");
        }
        return Ok(SUCCESS);
    }
    for project in &catalog.projects {
        match project {
            ProjectListEntry::Registry {
                id,
                name,
                root_path,
                ..
            } if parsed.flag("names") => println!("{name}"),
            ProjectListEntry::Ghq { name, .. } if parsed.flag("names") => println!("{name}"),
            ProjectListEntry::Registry { root_path, .. }
            | ProjectListEntry::Ghq { root_path, .. }
                if parsed.flag("paths") =>
            {
                println!("{root_path}");
            }
            ProjectListEntry::Ghq { name, root_path } => println!("{name} ({root_path}) [ghq]"),
            ProjectListEntry::Registry {
                id,
                name,
                root_path,
                ..
            } => println!("{name} ({root_path}) [{id}]"),
        }
    }
    Ok(SUCCESS)
}

fn project_remove(args: &[String]) -> Result<i32> {
    let parsed = match args::parse(args, &[flag("json", None)], true) {
        Ok(parsed) => parsed,
        Err(error) => return fail(&error, VALIDATION),
    };
    if parsed.positionals.len() != 1 {
        return fail(
            &Error::msg("Usage: phantom project remove <id|name|path> [--json]"),
            VALIDATION,
        );
    }
    let identifier = &parsed.positionals[0];
    let store = ProjectRegistryStore::default_store()?;
    let projects = store.list()?;
    let project = match find_project(&projects, identifier) {
        Ok(Some(project)) => project,
        Ok(None) => {
            return fail(
                &Error::msg(format!("Project '{identifier}' not found")),
                NOT_FOUND,
            )
        }
        Err(error) => return fail(&error, VALIDATION),
    };
    let Some(removed) = store.remove(&project.id)? else {
        return fail(
            &Error::msg(format!("Project '{identifier}' not found")),
            NOT_FOUND,
        );
    };
    if parsed.flag("json") {
        println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({
                "status": "removed",
                "project": removed,
            }))
            .map_err(|error| Error::msg(error.to_string()))?
        );
    } else {
        println!("Removed project '{}' ({})", removed.name, removed.root_path);
    }
    Ok(SUCCESS)
}

fn find_project(projects: &[ProjectRecord], identifier: &str) -> Result<Option<ProjectRecord>> {
    if let Some(project) = projects.iter().find(|project| project.id == identifier) {
        return Ok(Some(project.clone()));
    }
    if let Some(project) = projects
        .iter()
        .find(|project| project.root_path == identifier)
    {
        return Ok(Some(project.clone()));
    }
    let name_matches = projects
        .iter()
        .filter(|project| project.name == identifier)
        .collect::<Vec<_>>();
    if name_matches.len() == 1 {
        return Ok(Some(name_matches[0].clone()));
    }
    if name_matches.len() > 1 {
        return Err(Error::msg(format!(
            "Project '{identifier}' is ambiguous; use its id or path"
        )));
    }
    if let Ok(root) = projects::resolve_project_root(Path::new(identifier)) {
        let root = root.to_string_lossy().to_string();
        return Ok(projects
            .iter()
            .find(|project| project.root_path == root)
            .cloned());
    }
    Ok(None)
}

fn github_root(args: &[String]) -> Result<i32> {
    if args.is_empty() {
        if let Some(text) = help::command_help("github")? {
            println!("{text}");
        }
        return Ok(SUCCESS);
    }
    Err(Error::msg(format!(
        "Unknown github subcommand: {}",
        args[0]
    )))
}

fn github_checkout(args: &[String]) -> Result<i32> {
    let parsed = args::parse(args, &tmux_options_with(&[value_flag("base", None)]), true)?;
    let Some(number) = parsed.positionals.first() else {
        return fail(
            &Error::msg("Please specify a PR or issue number"),
            VALIDATION,
        );
    };
    let direction = tmux_direction(&parsed);
    if direction.is_some() && !tmux::inside_tmux() {
        return fail(&Error::TmuxRequired, VALIDATION);
    }
    let checkout = match github::checkout(number, parsed.value("base"), &Logger::on()) {
        Ok(checkout) => checkout,
        Err(error) => return fail(&error, error.exit_code()),
    };
    println!("{}", checkout.message);
    if let Some(failure) = &checkout.hook_failure {
        let _ = std::io::Write::flush(&mut std::io::stdout());
        eprintln!("{}", failure.warning(&checkout.path));
    }
    if let Some(direction) = direction {
        println!(
            "\nOpening worktree '{}' in tmux {}...",
            checkout.worktree,
            if direction == TmuxDirection::New {
                "window"
            } else {
                "pane"
            }
        );
        let env = worktree::phantom_env(&checkout.worktree, &checkout.path);
        let window = (direction == TmuxDirection::New).then_some(checkout.worktree.as_str());
        if let Err(error) = tmux::open_shell(direction, &checkout.path, &env, window) {
            eprintln!("{error}");
            eprintln!();
            return Ok(error.exit_code());
        }
    }
    Ok(checkout
        .hook_failure
        .as_ref()
        .map(|failure| failure.code)
        .unwrap_or(SUCCESS))
}

fn project_add_json(added: bool, project: &ProjectRecord) -> serde_json::Value {
    serde_json::json!({
        "status": if added { "added" } else { "existing" },
        "project": project,
    })
}

fn catalog_json(projects: &[ProjectListEntry], version: u32) -> serde_json::Value {
    serde_json::json!({
        "version": version,
        "projects": projects,
    })
}

fn action_from(parsed: &Parsed) -> ActionRequest {
    ActionRequest {
        shell: parsed.flag("shell"),
        exec: parsed.value("exec").map(str::to_string),
        tmux: tmux_direction(parsed),
    }
}

fn tmux_direction(parsed: &Parsed) -> Option<TmuxDirection> {
    if parsed.flag("tmux") {
        Some(TmuxDirection::New)
    } else if parsed.flag("tmux-vertical") || parsed.flag("tmux-v") {
        Some(TmuxDirection::Vertical)
    } else if parsed.flag("tmux-horizontal") || parsed.flag("tmux-h") {
        Some(TmuxDirection::Horizontal)
    } else {
        None
    }
}

fn tmux_options_with(extra: &[Opt]) -> Vec<Opt> {
    let mut options = extra.to_vec();
    options.extend([
        flag("tmux", Some('t')),
        flag("tmux-vertical", None),
        flag("tmux-v", None),
        flag("tmux-horizontal", None),
        flag("tmux-h", None),
    ]);
    options
}

fn flag(name: &'static str, short: Option<char>) -> Opt {
    Opt {
        name,
        short,
        value: false,
        multiple: false,
    }
}

fn value_flag(name: &'static str, short: Option<char>) -> Opt {
    Opt {
        name,
        short,
        value: true,
        multiple: false,
    }
}

fn fail(error: &Error, code: i32) -> Result<i32> {
    let message = error.to_string();
    if message.is_empty() {
        eprintln!();
    } else {
        eprintln!("{message}");
    }
    Ok(code)
}

fn create_code(error: &Error) -> i32 {
    match error {
        Error::WorktreeAlreadyExists(_) | Error::ActionConflict | Error::TmuxRequired => VALIDATION,
        Error::CommandFailed { code, .. } => *code,
        other => other.exit_code(),
    }
}

fn attach_code(error: &Error) -> i32 {
    match error {
        Error::WorktreeAlreadyExists(_) | Error::ActionConflict | Error::TmuxRequired => VALIDATION,
        Error::BranchNotFound(_) => NOT_FOUND,
        Error::CommandFailed { code, .. } => *code,
        other => other.exit_code(),
    }
}

static PREFERENCE_COMMANDS: &[Command] = &[
    Command {
        name: "get",
        help_key: "preferences get",
        run: preferences_get,
        children: &[],
    },
    Command {
        name: "set",
        help_key: "preferences set",
        run: preferences_set,
        children: &[],
    },
    Command {
        name: "remove",
        help_key: "preferences remove",
        run: preferences_remove,
        children: &[],
    },
];

static PROJECT_COMMANDS: &[Command] = &[
    Command {
        name: "add",
        help_key: "project add",
        run: project_add,
        children: &[],
    },
    Command {
        name: "list",
        help_key: "project list",
        run: project_list,
        children: &[],
    },
    Command {
        name: "remove",
        help_key: "project remove",
        run: project_remove,
        children: &[],
    },
];

static GITHUB_COMMANDS: &[Command] = &[Command {
    name: "checkout",
    help_key: "github checkout",
    run: github_checkout,
    children: &[],
}];

static COMMANDS: &[Command] = &[
    Command {
        name: "create",
        help_key: "create",
        run: create,
        children: &[],
    },
    Command {
        name: "attach",
        help_key: "attach",
        run: attach,
        children: &[],
    },
    Command {
        name: "list",
        help_key: "list",
        run: list,
        children: &[],
    },
    Command {
        name: "where",
        help_key: "where",
        run: where_cmd,
        children: &[],
    },
    Command {
        name: "delete",
        help_key: "delete",
        run: delete,
        children: &[],
    },
    Command {
        name: "exec",
        help_key: "exec",
        run: exec,
        children: &[],
    },
    Command {
        name: "edit",
        help_key: "edit",
        run: edit,
        children: &[],
    },
    Command {
        name: "ai",
        help_key: "ai",
        run: ai,
        children: &[],
    },
    Command {
        name: "shell",
        help_key: "shell",
        run: shell,
        children: &[],
    },
    Command {
        name: "preferences",
        help_key: "preferences",
        run: preferences_root,
        children: PREFERENCE_COMMANDS,
    },
    Command {
        name: "version",
        help_key: "version",
        run: version,
        children: &[],
    },
    Command {
        name: "completion",
        help_key: "completion",
        run: completion,
        children: &[],
    },
    Command {
        name: "mcp",
        help_key: "mcp",
        run: mcp,
        children: &[],
    },
    Command {
        name: "project",
        help_key: "project",
        run: project_root,
        children: PROJECT_COMMANDS,
    },
    Command {
        name: "github",
        help_key: "github",
        run: github_root,
        children: GITHUB_COMMANDS,
    },
    Command {
        name: "gh",
        help_key: "github",
        run: github_root,
        children: GITHUB_COMMANDS,
    },
];
