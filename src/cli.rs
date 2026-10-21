use std::path::Path;

use crate::args::{self, Opt, Parsed};
use crate::error::{Error, Result, GENERAL, NOT_FOUND, PARTIAL, SUCCESS, VALIDATION};
use crate::github;
use crate::help;
use crate::metadata::{self, MetadataInput};
use crate::preferences;
use crate::projects::{self, ProjectListEntry, ProjectRecord, ProjectRegistryStore};
use crate::repository;
use crate::trust::{self, HookControl};
use crate::worktree::{self, ActionRequest, Logger};

struct Command {
    name: &'static str,
    help_key: &'static str,
    run: fn(&[String]) -> Result<i32>,
    children: &'static [Command],
}

pub fn run(args: &[String]) -> Result<i32> {
    // Common options may precede the command as well as follow it. Keep the
    // command path in front so exec/remainder boundaries retain their meaning.
    let mut prefix = 0;
    while let Some(arg) = args.get(prefix) {
        let name = arg.split('=').next().unwrap_or(arg);
        if arg.starts_with("-R") && arg != "-R" {
            prefix += 1;
            continue;
        }
        if !matches!(
            name,
            "--json" | "--output" | "--no-input" | "--repo" | "-R" | "--project" | "-p"
        ) {
            break;
        }
        prefix += 1;
        if matches!(name, "--output" | "--repo" | "-R" | "--project" | "-p")
            && !arg.contains('=')
            && prefix < args.len()
        {
            prefix += 1;
        }
    }
    if prefix > 0 {
        if prefix == args.len() {
            return unresolved_usage(args, "", "A command is required after common options");
        }
        let rest = &args[prefix..];
        let consumed = find(rest, COMMANDS)
            .map(|(_, remaining)| rest.len() - remaining.len())
            .unwrap_or(1);
        let mut reordered = rest[..consumed].to_vec();
        reordered.extend_from_slice(&args[..prefix]);
        reordered.extend_from_slice(&rest[consumed..]);
        return run(&reordered);
    }
    if args.is_empty() || args[0] == "-h" || args[0] == "--help" {
        let prepared = crate::runtime::prepare(args, true, "", &command_options(""), true);
        if let Some(error) = prepared.error {
            return unresolved_usage(args, "", &error.to_string());
        }
        println!("{}", help::main_help()?);
        return Ok(SUCCESS);
    }
    match find(args, COMMANDS) {
        Some((command, remaining)) => {
            let key = command.help_key;
            let supports_json = key != "exec";
            let prepared = crate::runtime::prepare(
                remaining,
                supports_json || (!command.children.is_empty() && !remaining.is_empty()),
                key,
                &command_options(key),
                true,
            );
            let missing_subcommand = !command.children.is_empty() && prepared.args.is_empty();
            if prepared.error.is_none() && (prepared.help || (missing_subcommand && !prepared.json))
            {
                match help::command_help(key)? {
                    Some(text) => println!("{text}"),
                    None => println!("Help not available for command '{}'", command.name),
                }
                return Ok(SUCCESS);
            }
            crate::output::begin(key, prepared.json);
            let result = match prepared.error {
                Some(error) => Err(error),
                None if missing_subcommand => Err(Error::validation(format!(
                    "A subcommand is required for '{key}'"
                ))),
                None => (command.run)(&prepared.args),
            };
            let exit = match result {
                Ok(exit) => exit,
                Err(error) => fail_with(&error, error.exit_code())?,
            };
            crate::output::finish(exit)?;
            Ok(exit)
        }
        None => unresolved_usage(
            args,
            &args[0],
            &removed_command_hint(&args[0]).unwrap_or_else(|| {
                if crate::runtime::is_removed_repo_option(&args[0]) {
                    format!("Option '{}' was removed. Use -R/--repo REF.", args[0])
                } else {
                    format!("Unknown command '{}'", args.join(" "))
                }
            }),
        ),
    }
}

fn unresolved_usage(args: &[String], command: &str, message: &str) -> Result<i32> {
    let prepared = crate::runtime::prepare(args, true, command, &command_options(command), false);
    crate::output::begin(command, prepared.json);
    let error = prepared.error.unwrap_or_else(|| Error::validation(message));
    let exit = fail_with(&error, VALIDATION)?;
    let removed_interface = removed_command_hint(command).is_some()
        || args
            .iter()
            .any(|arg| crate::runtime::is_removed_repo_option(arg));
    if !crate::output::json() && !removed_interface {
        println!("{}", help::main_help()?);
    }
    crate::output::finish(exit)?;
    Ok(exit)
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

fn sync(args: &[String]) -> Result<i32> {
    let _hooks = crate::process::suppress_git_hooks();
    let json = crate::output::json();
    let parsed = match args::parse(args, &command_options("sync"), true) {
        Ok(parsed) => parsed,
        Err(error) => return fail_with(&error, 2),
    };
    let context = match command_context(&parsed) {
        Ok(context) => context,
        Err(error) => return fail_with(&error, error.exit_code()),
    };
    let request = crate::sync::Request {
        names: parsed.positionals.clone(),
        all: parsed.flag("all"),
        mine: parsed.flag("mine"),
        no_default: parsed.flag("no-default"),
        rebase: parsed.flag("rebase"),
        merge: parsed.flag("merge"),
        force: parsed.flag("force"),
        keep_conflicts: parsed.flag("keep-conflicts"),
        agent: std::env::var("MABO_AGENT_ID")
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty()),
    };
    let report = match crate::sync::run(&context, &request) {
        Ok(report) => report,
        Err(error) => return fail_with(&error, error.exit_code()),
    };
    if json {
        emit_json(&report)?;
        if report.exit != 0 {
            crate::output::failure(
                Error::Status {
                    code: if report.exit == crate::error::REFUSED {
                        "published"
                    } else {
                        crate::error::status_code(report.exit)
                    },
                    message: "Sync did not complete successfully".into(),
                }
                .to_json(report.exit)
                .error,
            );
        }
    } else {
        for item in report.default.iter().chain(&report.worktrees) {
            // Git diagnostics can contain newlines; human output stays one line per item.
            let mut detail = item
                .detail
                .as_deref()
                .unwrap_or("")
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ");
            if !item.conflicts.is_empty() {
                let files = item.conflicts.join(", ").replace(['\n', '\r'], " ");
                detail = format!("{files} ({detail})");
            }
            println!("{}  {}  {}", item.name, item.status, detail);
        }
        let mut counts = std::collections::BTreeMap::new();
        for item in report.default.iter().chain(&report.worktrees) {
            *counts.entry(item.status.as_str()).or_insert(0usize) += 1;
        }
        println!(
            "Sync complete: {}",
            counts
                .into_iter()
                .map(|(status, count)| format!("{count} {status}"))
                .collect::<Vec<_>>()
                .join(", ")
        );
    }
    Ok(report.exit)
}

fn create(args: &[String]) -> Result<i32> {
    let json = crate::output::json();
    let parsed = match args::parse(args, &command_options("create"), true) {
        Ok(parsed) => parsed,
        Err(error) => return fail_with(&error, error.exit_code()),
    };
    let action = match action_from(&parsed) {
        Ok(action) => action,
        Err(error) => return fail_with(&error, VALIDATION),
    };
    let metadata = match metadata_input(&parsed, true) {
        Ok(metadata) => metadata,
        Err(error) => return fail_with(&error, error.exit_code()),
    };
    let repository = match selected_repository(&parsed) {
        Ok(repository) => repository,
        Err(error) => return fail_with(&error, error.exit_code()),
    };
    match worktree::run_create(worktree::CreateRequest {
        name: parsed.positionals.first().map(String::as_str),
        base: parsed.value("base"),
        copy_files: &parsed.values("copy-file"),
        action,
        logger: logger_for(json),
        repository: repository.as_deref(),
        metadata,
        hooks: hook_control(&parsed, json, true),
    }) {
        Ok(outcome) => finish_change(json, &outcome),
        Err(error) => fail_with(&error, create_code(&error)),
    }
}

fn finish_change(json: bool, outcome: &worktree::CreateOutcome) -> Result<i32> {
    finish_mutation(
        json,
        &worktree::change_output(
            &outcome.worktree,
            Some(outcome.base.clone()),
            outcome.copy_error.as_deref(),
            outcome.hooks_ran,
            outcome.hook_failure.as_ref(),
            outcome.metadata_error.as_deref(),
            outcome.exec.clone(),
        ),
        outcome.exec.as_ref(),
        outcome.exit_code,
    )
}

fn attach(args: &[String]) -> Result<i32> {
    let json = crate::output::json();
    let parsed = match args::parse(args, &command_options("attach"), true) {
        Ok(parsed) => parsed,
        Err(error) => return fail_with(&error, error.exit_code()),
    };
    let Some(name) = parsed.positionals.first() else {
        return fail_with(
            &Error::msg("Missing required argument: branch name"),
            VALIDATION,
        );
    };
    let action = match action_from(&parsed) {
        Ok(action) => action,
        Err(error) => return fail_with(&error, VALIDATION),
    };
    let metadata = match metadata_input(&parsed, true) {
        Ok(metadata) => metadata,
        Err(error) => return fail_with(&error, error.exit_code()),
    };
    let repository = match selected_repository(&parsed) {
        Ok(repository) => repository,
        Err(error) => return fail_with(&error, error.exit_code()),
    };
    match worktree::run_attach(worktree::AttachRequest {
        name,
        copy_files: &parsed.values("copy-file"),
        action,
        logger: logger_for(json),
        repository: repository.as_deref(),
        metadata,
        hooks: hook_control(&parsed, json, true),
    }) {
        Ok(outcome) => finish_mutation(
            json,
            &worktree::change_output(
                &outcome.worktree,
                None,
                outcome.copy_error.as_deref(),
                outcome.hooks_ran,
                outcome.hook_failure.as_ref(),
                outcome.metadata_error.as_deref(),
                outcome.exec.clone(),
            ),
            outcome.exec.as_ref(),
            outcome.exit_code,
        ),
        Err(error) => fail_with(&error, attach_code(&error)),
    }
}

fn list(args: &[String]) -> Result<i32> {
    let json = crate::output::json();
    let parsed = match args::parse(args, &command_options("list"), false) {
        Ok(parsed) => parsed,
        Err(error) => return fail_with(&error, error.exit_code()),
    };
    let owner = match list_owner(&parsed) {
        Ok(owner) => owner,
        Err(error) => return fail_with(&error, error.exit_code()),
    };
    if json && parsed.flag("names") {
        return fail_with(
            &Error::msg("Only one of --json or --names can be specified"),
            VALIDATION,
        );
    }
    let context = match command_context(&parsed) {
        Ok(context) => context,
        Err(error) => return fail_with(&error, error.exit_code()),
    };
    let exclude_default = parsed.flag("no-default");
    if let Some(warning) = metadata::read_problem(&context.git_root) {
        crate::output::warning("metadata_read", format!("Warning: {warning}"));
    }
    let worktrees = match worktree::list_worktrees(&context, exclude_default, false) {
        Ok(worktrees) => worktrees,
        Err(error) => return fail_with(&error, GENERAL),
    };
    let worktrees = match owner.as_deref() {
        Some(owner) => worktrees
            .into_iter()
            .filter(|worktree| worktree.metadata.owner.as_deref() == Some(owner))
            .collect(),
        None => worktrees,
    };
    if json {
        return emit_json(&worktree::WorktreeListOutput {
            version: crate::error::JSON_VERSION,
            worktrees: worktrees
                .iter()
                .map(|worktree| worktree.to_json(None))
                .collect(),
        });
    }
    if worktrees.is_empty() {
        if !parsed.flag("names") {
            let available = worktree::list_worktrees(&context, false, false).unwrap_or_default();
            let message = if let Some(owner) = &owner {
                format!("No workspaces found for owner '{owner}'")
            } else if exclude_default && !available.is_empty() {
                "No linked workspaces found".to_string()
            } else {
                "No workspaces found".to_string()
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
            let suffix = metadata::list_suffix(&worktree.metadata);
            let orphaned = if worktree.orphaned { " [orphaned]" } else { "" };
            println!(
                "{} ({}){dirty}{suffix}{orphaned}",
                worktree.name, worktree.path_to_display
            );
        }
    }
    Ok(SUCCESS)
}

fn where_cmd(args: &[String]) -> Result<i32> {
    let json = crate::output::json();
    let parsed = match args::parse(args, &command_options("where"), true) {
        Ok(parsed) => parsed,
        Err(error) => return fail_with(&error, error.exit_code()),
    };
    if parsed.positionals.is_empty() {
        return fail_with(
            &Error::msg("Usage: mabo where <workspace-name>"),
            VALIDATION,
        );
    }
    let context = match command_context(&parsed) {
        Ok(context) => context,
        Err(error) => return fail_with(&error, error.exit_code()),
    };
    let name = &parsed.positionals[0];
    match worktree::find_worktree(&context, name, false, None) {
        Ok(mut worktree) => {
            match metadata::touch(&context.git_root, Path::new(&worktree.path)) {
                Ok(Some(updated)) => worktree.metadata = updated,
                Ok(None) => {}
                Err(error) => {
                    crate::output::warning("last_used_update", format!("Warning: {error}"))
                }
            }
            if json {
                emit_json(&worktree::WorktreeRefOutput {
                    version: crate::error::JSON_VERSION,
                    worktree: worktree.to_json(None),
                })
            } else {
                println!("{}", worktree.path);
                Ok(SUCCESS)
            }
        }
        Err(error @ Error::WorktreeNotFound(_)) => fail_with(&error, NOT_FOUND),
        Err(error) => fail_with(&error, GENERAL),
    }
}

fn delete(args: &[String]) -> Result<i32> {
    let json = crate::output::json();
    let parsed = match args::parse(args, &command_options("delete"), true) {
        Ok(parsed) => parsed,
        Err(error) => return fail_with(&error, error.exit_code()),
    };
    let delete_current = parsed.flag("current");
    if parsed.positionals.is_empty() && !delete_current {
        return fail_with(
            &Error::msg(
                "Please provide at least one workspace name to delete, or use --current to delete the current workspace",
            ),
            VALIDATION,
        );
    }
    if !parsed.positionals.is_empty() && delete_current {
        return fail_with(
            &Error::msg("Cannot specify --current with a workspace name"),
            VALIDATION,
        );
    }
    let context = match command_context(&parsed) {
        Ok(context) => context,
        Err(error) => return fail_with(&error, error.exit_code()),
    };
    let keep_branch =
        parsed.flag("keep-branch") || context.preferences.keep_branch.unwrap_or(false);
    let names = if delete_current {
        match worktree::current_worktree_name(&context) {
            Ok(Some(name)) => vec![name],
            Ok(None) => {
                return fail_with(
                    &Error::msg(
                        "Not in a workspace directory. The --current option can only be used from within a workspace.",
                    ),
                    VALIDATION,
                );
            }
            Err(error) => return fail_with(&error, GENERAL),
        }
    } else {
        parsed.positionals.clone()
    };
    let logger = logger_for(json);
    let options = worktree::DeleteOptions {
        force: parsed.flag("force"),
        keep_branch,
        allow_current: delete_current,
        published_tip: None,
    };
    let plans = match worktree::preflight_deletes(&context, &names, &options) {
        Ok(plans) => plans,
        Err(refusals) => return report_delete_refusals(refusals, json),
    };
    let mut deleted = Vec::new();
    for plan in plans {
        match worktree::commit_delete(
            &context,
            plan,
            &options,
            &logger,
            hook_control(&parsed, json, true),
        ) {
            Ok(outcome) => {
                if let Some(metadata_error) = outcome.metadata_error {
                    let error = Error::msg(metadata_error);
                    if !json {
                        println!("{}", outcome.message);
                    }
                    deleted.push(worktree::DeletedEntry {
                        worktree: Some(outcome.worktree.to_json(None)),
                        branch_deleted: outcome.branch_deleted,
                        branch_error: outcome.branch_error.clone(),
                        error: Some(error.to_string()),
                    });
                    if json {
                        emit_json(&worktree::DeleteOutput {
                            version: crate::error::JSON_VERSION,
                            deleted,
                            error: Some(error.to_json(crate::error::PARTIAL).error),
                        })?;
                        return Ok(crate::error::PARTIAL);
                    }
                    return fail(
                        &Error::status(crate::error::PARTIAL, error.to_string()),
                        crate::error::PARTIAL,
                    );
                }
                if !json {
                    println!("{}", outcome.message);
                }
                deleted.push(worktree::DeletedEntry {
                    worktree: Some(outcome.worktree.to_json(None)),
                    branch_deleted: outcome.branch_deleted,
                    branch_error: outcome.branch_error,
                    error: None,
                });
            }
            Err(failure) => {
                let error = &failure.error;
                let code = if deleted.is_empty() {
                    match error {
                        Error::Untrusted(_) => error.exit_code(),
                        _ => GENERAL,
                    }
                } else {
                    crate::error::PARTIAL
                };
                if json {
                    deleted.push(worktree::DeletedEntry {
                        worktree: failure
                            .worktree
                            .as_ref()
                            .map(|worktree| worktree.to_json(None)),
                        branch_deleted: false,
                        branch_error: None,
                        error: Some(error.to_string()),
                    });
                    emit_json(&worktree::DeleteOutput {
                        version: crate::error::JSON_VERSION,
                        deleted,
                        error: Some(error.aggregate_json(code)),
                    })?;
                    return Ok(code);
                }
                return fail(&Error::status(code, error.to_string()), code);
            }
        }
    }
    if json {
        return emit_json(&worktree::DeleteOutput {
            version: crate::error::JSON_VERSION,
            deleted,
            error: None,
        });
    }
    Ok(SUCCESS)
}

fn exec(args: &[String]) -> Result<i32> {
    let parsed = args::parse_with(args, &command_options("exec"), true, Some(1))?;
    if parsed.positionals.len() < 2 {
        return fail(
            &Error::msg("Usage: mabo exec <workspace-name> <command> [args...]"),
            VALIDATION,
        );
    }
    let command_args = parsed.positionals[1..].to_vec();
    let context = match command_context(&parsed) {
        Ok(context) => context,
        Err(error) => return fail_with(&error, error.exit_code()),
    };
    let name = parsed.positionals[0].clone();
    if let Err(error) = worktree::find_worktree(&context, &name, false, None) {
        let code = if matches!(error, Error::WorktreeNotFound(_)) {
            NOT_FOUND
        } else {
            error.child_exit_code()
        };
        return fail(&error, code);
    }
    let command = command_args[0].as_str();
    let rest = command_args[1..]
        .iter()
        .map(String::as_str)
        .collect::<Vec<_>>();
    match worktree::exec_in_worktree(&context, &name, command, &rest, &[], false) {
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
                error.child_exit_code()
            };
            fail(&error, code)
        }
    }
}

fn config_root(args: &[String]) -> Result<i32> {
    Err(Error::validation(format!(
        "Unknown config subcommand: {}",
        args.join(" ")
    )))
}

fn config_get(args: &[String]) -> Result<i32> {
    config_read(args, false)
}

fn config_list(args: &[String]) -> Result<i32> {
    config_read(args, true)
}

fn config_read(args: &[String], list: bool) -> Result<i32> {
    let key = if list { "config list" } else { "config get" };
    let parsed = args::parse(args, &command_options(key), true)?;
    selected_repository(&parsed)?;
    if parsed.positionals.len() != usize::from(!list) {
        return Err(Error::validation(if list {
            "Usage: mabo config list [--sources]"
        } else {
            "Usage: mabo config get KEY [--sources]"
        }));
    }
    let keys = if list {
        preferences::SUPPORTED_KEYS.to_vec()
    } else {
        preferences::require_key(&parsed.positionals[0])?;
        vec![parsed.positionals[0].as_str()]
    };
    let loaded = preferences::load_preferences()?;
    let mut values = serde_json::Map::new();
    for key in keys {
        let effective = preferences::effective_value(&loaded, key)?;
        if crate::output::json() {
            values.insert(
                key.into(),
                if parsed.flag("sources") {
                    serde_json::to_value(effective)
                        .map_err(|error| Error::msg(error.to_string()))?
                } else {
                    effective.value
                },
            );
        } else {
            let value = match &effective.value {
                serde_json::Value::String(value) => value.clone(),
                value => value.to_string(),
            };
            let label = if list {
                format!("{key} = ")
            } else {
                String::new()
            };
            if parsed.flag("sources") {
                println!(
                    "{label}{value}\t{} ({})",
                    effective.source, effective.detail
                );
            } else {
                println!("{label}{value}");
            }
        }
    }
    if crate::output::json() {
        emit_json(&serde_json::json!({"config": values}))
    } else {
        Ok(SUCCESS)
    }
}

fn config_set(args: &[String]) -> Result<i32> {
    let parsed = args::parse(args, &command_options("config set"), true)?;
    selected_repository(&parsed)?;
    if parsed.positionals.len() != 2 {
        return Err(Error::validation("Usage: mabo config set KEY VALUE"));
    }
    let key = &parsed.positionals[0];
    let value = &parsed.positionals[1];
    preferences::require_key(key)?;
    if value.is_empty() {
        return Err(Error::validation(format!(
            "Config key '{key}' requires a value"
        )));
    }
    if let Some(message) = preferences::validate_preference_value(key, value) {
        return Err(Error::validation(message));
    }
    let path = preferences::set_preference(key, value)?;
    if crate::output::json() {
        let value = if matches!(key.as_str(), "keep-branch" | "discover-ghq") {
            serde_json::json!(value == "true")
        } else {
            serde_json::json!(value)
        };
        emit_json(&serde_json::json!({"key": key, "value": value}))
    } else {
        println!("Set {key} to '{value}' in {}", path.display());
        Ok(SUCCESS)
    }
}

fn config_unset(args: &[String]) -> Result<i32> {
    let parsed = args::parse(args, &command_options("config unset"), true)?;
    selected_repository(&parsed)?;
    if parsed.positionals.len() != 1 {
        return Err(Error::validation("Usage: mabo config unset KEY"));
    }
    let key = &parsed.positionals[0];
    preferences::require_key(key)?;
    let path = preferences::remove_preference(key)?;
    if crate::output::json() {
        emit_json(&serde_json::json!({"key": key, "unset": true}))
    } else {
        println!("Unset {key} in {}", path.display());
        Ok(SUCCESS)
    }
}

fn version(args: &[String]) -> Result<i32> {
    let parsed = args::parse(args, &command_options("--version"), false)?;
    selected_repository(&parsed)?;
    if crate::output::json() {
        // `version` is application data here, distinct from the envelope schema.
        crate::output::app_version(crate::version_line())
    } else {
        println!("{}", crate::version_line());
        Ok(SUCCESS)
    }
}

fn help_cmd(args: &[String]) -> Result<i32> {
    let parsed = args::parse(args, &command_options("help"), true)?;
    selected_repository(&parsed)?;
    let key = parsed.positionals.join(" ");
    if !key.is_empty() && help::command_help(&key)?.is_none() {
        return Err(Error::validation(
            removed_command_hint(&key).unwrap_or_else(|| format!("Unknown command '{key}'")),
        ));
    }
    if crate::output::json() {
        emit_json(&help::json_help(&key)?)
    } else {
        println!(
            "{}",
            if key.is_empty() {
                help::main_help()?
            } else {
                help::command_help(&key)?.unwrap_or_default()
            }
        );
        Ok(SUCCESS)
    }
}

fn removed_command_hint(command: &str) -> Option<String> {
    let replacement = match command.split_whitespace().next()? {
        "project" => "mabo repo add/list/show/forget",
        "preferences" => "mabo config get/set/unset/list",
        "untrust" => "mabo trust remove",
        "version" => "mabo --version",
        _ => return None,
    };
    Some(format!(
        "Command '{command}' was removed. Use `{replacement}`."
    ))
}

fn clone_cmd(args: &[String]) -> Result<i32> {
    let json = crate::output::json();
    let parsed = match args::parse(args, &command_options("clone"), true) {
        Ok(parsed) => parsed,
        Err(error) => return fail_with(&error, error.exit_code()),
    };
    if parsed.positionals.len() != 1 {
        return fail_with(&Error::validation(
                "Usage: mabo clone <url|host/owner/repo|owner/repo> [--branch <branch>] [--depth <n>] [--update] [--json]",
            ), VALIDATION);
    }
    selected_repository(&parsed)?;
    match repository::clone_repository(&repository::CloneRequest {
        source: &parsed.positionals[0],
        branch: parsed.value("branch"),
        depth: parsed.value("depth"),
        update: parsed.flag("update"),
    }) {
        Ok(outcome) => {
            let result = outcome.result;
            if json {
                emit_json(&serde_json::json!({
                    "repo": {"root": result.path, "name": format!("{}/{}/{}", result.host, result.owner, result.repo), "remoteUrl": result.remote_url},
                    "cloned": result.cloned, "updated": result.updated,
                }))?;
            } else {
                println!("{}", repository::human_clone_message(&result));
            }
            if let Some(error) = outcome.registration_error {
                let status = if result.cloned || result.updated {
                    PARTIAL
                } else {
                    GENERAL
                };
                return fail_with(&Error::status(status, error.to_string()), status);
            }
            Ok(SUCCESS)
        }
        Err(error) => fail_with(&error, error.exit_code()),
    }
}

fn project_root(args: &[String]) -> Result<i32> {
    if args.is_empty() {
        if let Some(text) = help::command_help("repo")? {
            println!("{text}");
        }
        return Ok(SUCCESS);
    }
    Err(Error::validation(format!(
        "Unknown repo subcommand: {}",
        args[0]
    )))
}

fn project_add(args: &[String]) -> Result<i32> {
    let json = crate::output::json();
    let parsed = match args::parse(args, &command_options("repo add"), true) {
        Ok(parsed) => parsed,
        Err(error) => return fail_with(&error, VALIDATION),
    };
    if parsed.positionals.len() > 1 {
        return fail_with(
            &Error::msg("Usage: mabo repo add [path] [--json]"),
            VALIDATION,
        );
    }
    let cwd = match std::env::current_dir() {
        Ok(cwd) => cwd,
        Err(error) => return bubble(Error::msg(error.to_string()), json),
    };
    let selected = selected_repository(&parsed)?;
    let input = parsed
        .positionals
        .first()
        .map(Path::new)
        .unwrap_or(selected.as_deref().unwrap_or(cwd.as_path()));
    let root = match projects::resolve_project_root(input) {
        Ok(root) => root,
        Err(error) => return bubble(error, json),
    };
    let store = match ProjectRegistryStore::default_store() {
        Ok(store) => store,
        Err(error) => return bubble(error, json),
    };
    let (project, added) = match store.add(&root) {
        Ok(added) => added,
        Err(error) => return bubble(error, json),
    };
    if json {
        return emit_json(&project_add_json(added, &project));
    } else if added {
        println!("Added repo '{}' ({})", project.name, project.root_path);
    } else {
        println!(
            "Repository '{}' is already registered ({})",
            project.name, project.root_path
        );
    }
    Ok(SUCCESS)
}

fn project_list(args: &[String]) -> Result<i32> {
    let json = crate::output::json();
    let parsed = match args::parse(args, &command_options("repo list"), false) {
        Ok(parsed) => parsed,
        Err(error) => return fail_with(&error, VALIDATION),
    };
    let modes = [json, parsed.flag("names"), parsed.flag("paths")]
        .iter()
        .filter(|enabled| **enabled)
        .count();
    if modes > 1 {
        return fail_with(
            &Error::msg("Only one of --json, --names, or --paths can be specified"),
            VALIDATION,
        );
    }
    let loaded = match preferences::load_preferences() {
        Ok(preferences) => preferences,
        Err(error) => return fail_with(&error, GENERAL),
    };
    if parsed.flag("registered") && parsed.flag("discovered") {
        return Err(Error::validation(
            "Use only one of --registered or --discovered",
        ));
    }
    selected_repository(&parsed)?;
    let mut catalog = match projects::list_catalog(
        !parsed.flag("registered") && loaded.ghq_discovery != Some(false),
    ) {
        Ok(catalog) => catalog,
        Err(error) => return bubble(error, json),
    };
    if parsed.flag("discovered") {
        catalog
            .projects
            .retain(|entry| matches!(entry, ProjectListEntry::Ghq { .. }));
    }
    for warning in &catalog.warnings {
        crate::output::warning("repo_discovery", format!("Warning: {warning}"));
    }
    if json {
        return emit_json(&catalog_json(&catalog.projects, catalog.version));
    }
    if catalog.projects.is_empty() {
        if !parsed.flag("names") && !parsed.flag("paths") {
            println!("No repos found.");
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
            ProjectListEntry::Ghq {
                name, root_path, ..
            } => {
                println!("{name} ({root_path}) [ghq]")
            }
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
    let json = crate::output::json();
    let parsed = match args::parse(args, &command_options("repo forget"), true) {
        Ok(parsed) => parsed,
        Err(error) => return fail_with(&error, error.exit_code()),
    };
    if parsed.positionals.len() != 1 {
        return fail_with(
            &Error::msg("Usage: mabo repo remove <id|name|path> [--json]"),
            VALIDATION,
        );
    }
    selected_repository(&parsed)?;
    let identifier = &parsed.positionals[0];
    let store = match ProjectRegistryStore::default_store() {
        Ok(store) => store,
        Err(error) => return bubble(error, json),
    };
    let projects = match store.list() {
        Ok(projects) => projects,
        Err(error) => return bubble(error, json),
    };
    let project = match find_project(&projects, identifier) {
        Ok(Some(project)) => project,
        Ok(None) => {
            return fail_with(
                &Error::msg(format!("Repository '{identifier}' not found")),
                NOT_FOUND,
            )
        }
        Err(error) => return fail_with(&error, error.exit_code()),
    };
    let removed = match store.remove(&project.id) {
        Ok(Some(removed)) => removed,
        Ok(None) => {
            return fail_with(
                &Error::msg(format!("Repository '{identifier}' not found")),
                NOT_FOUND,
            )
        }
        Err(error) => return bubble(error, json),
    };
    if json {
        return emit_json(&serde_json::json!({
            "status": "removed",
            "repo": removed,
        }));
    } else {
        println!("Removed repo '{}' ({})", removed.name, removed.root_path);
    }
    Ok(SUCCESS)
}

fn repo_show(args: &[String]) -> Result<i32> {
    let parsed = args::parse(args, &command_options("repo show"), true)?;
    if parsed.positionals.len() > 1 {
        return Err(Error::validation("Usage: mabo repo show [REF]"));
    }
    let selected = selected_repository(&parsed)?;
    let root = match parsed.positionals.first() {
        Some(reference) => projects::resolve_project_ref(reference)?,
        None => crate::context::open(selected.as_deref())?.git_root,
    };
    let context = crate::context::create_at(&root)?;
    let name = repository::canonical_name_from_origin(&root).unwrap_or_else(|| {
        root.file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned()
    });
    let default_branch = crate::git::default_branch(&root)?;
    let trusted = trust::trust_all() || trust::is_trusted_root(&root)?;
    let value = serde_json::json!({"repo": {
        "root": root, "name": name, "defaultBranch": default_branch,
        "configPresent": root.join(".mabo.toml").is_file(), "trusted": trusted,
        "workspaceRoot": context.worktrees_directory,
    }});
    if crate::output::json() {
        emit_json(&value)
    } else {
        println!("{name}\nPrimary checkout: {}\nDefault branch: {}\n.mabo.toml: {}\nTrusted: {trusted}\nWorkspace root: {}", root.display(), default_branch.as_deref().unwrap_or("unknown"), root.join(".mabo.toml").is_file(), context.worktrees_directory.display());
        Ok(SUCCESS)
    }
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
        return Err(Error::Status {
            code: "ambiguous",
            message: format!("Repository '{identifier}' is ambiguous; use its id or path"),
        });
    }
    match projects::resolve_project_ref(identifier) {
        Ok(root) => {
            let root = root.to_string_lossy().to_string();
            Ok(projects
                .iter()
                .find(|project| project.root_path == root)
                .cloned())
        }
        Err(Error::ProjectNotFound(_) | Error::PathNotFound(_) | Error::NotARepository) => Ok(None),
        Err(error) => Err(error),
    }
}

fn github_root(args: &[String]) -> Result<i32> {
    if args.is_empty() {
        if let Some(text) = help::command_help("github")? {
            println!("{text}");
        }
        return Ok(SUCCESS);
    }
    Err(Error::validation(format!(
        "Unknown github subcommand: {}",
        args[0]
    )))
}

fn github_checkout(args: &[String]) -> Result<i32> {
    let json = crate::output::json();
    let parsed = match args::parse(args, &command_options("github checkout"), true) {
        Ok(parsed) => parsed,
        Err(error) => return fail_with(&error, error.exit_code()),
    };
    let Some(number) = parsed.positionals.first() else {
        return fail_with(
            &Error::msg("Please specify a PR or issue number"),
            VALIDATION,
        );
    };
    let repository = match selected_repository(&parsed) {
        Ok(repository) => repository,
        Err(error) => return fail_with(&error, error.exit_code()),
    };
    let metadata = match metadata_input(&parsed, true) {
        Ok(metadata) => metadata,
        Err(error) => return fail_with(&error, error.exit_code()),
    };
    let checkout = match github::checkout(
        number,
        parsed.value("base"),
        &logger_for(json),
        repository.as_deref(),
        metadata,
        hook_control(&parsed, json, true),
    ) {
        Ok(checkout) => checkout,
        Err(error) => return fail_with(&error, error.exit_code()),
    };
    let partial = checkout.hook_failure.is_some()
        || checkout.metadata_error.is_some()
        || checkout.copy_error.is_some();
    if json {
        let document = match checkout.to_json() {
            Ok(document) => document,
            Err(error) => return fail_with(&error, GENERAL),
        };
        emit_json(&document)?;
    } else {
        println!("{}", checkout.message);
    }
    if let Some(error) = &checkout.metadata_error {
        crate::output::warning("metadata_save", format!("Warning: {error}"));
    }
    if let Some(failure) = &checkout.hook_failure {
        let _ = std::io::Write::flush(&mut std::io::stdout());
        crate::output::warning("post_create", failure.warning(&checkout.path));
    }
    let status = if partial {
        crate::error::PARTIAL
    } else {
        SUCCESS
    };
    Ok(status)
}

fn project_add_json(added: bool, project: &ProjectRecord) -> serde_json::Value {
    serde_json::json!({
        "status": if added { "added" } else { "existing" },
        "repo": project,
    })
}

fn catalog_json(projects: &[ProjectListEntry], version: u32) -> serde_json::Value {
    serde_json::json!({
        "version": version,
        "repos": projects,
    })
}

fn meta_root(args: &[String]) -> Result<i32> {
    if args.is_empty() {
        if let Some(text) = help::command_help("meta")? {
            println!("{text}");
        }
        return Ok(SUCCESS);
    }
    Err(Error::validation(format!(
        "Unknown meta subcommand: {}",
        args[0]
    )))
}

fn meta_set(args: &[String]) -> Result<i32> {
    let json = crate::output::json();
    let parsed = match args::parse(args, &command_options("meta set"), true) {
        Ok(parsed) => parsed,
        Err(error) => return fail_with(&error, error.exit_code()),
    };
    if parsed.positionals.len() != 1 {
        return fail_with(
            &Error::msg("Usage: mabo meta set <workspace-name> [options]"),
            VALIDATION,
        );
    }
    let mut input = match metadata_input(&parsed, false) {
        Ok(input) => input,
        Err(error) => return fail_with(&error, error.exit_code()),
    };
    if parsed.value("base").is_none()
        && input.owner.is_none()
        && input.purpose.is_none()
        && input.pr.is_none()
        && input.issue.is_none()
    {
        return fail_with(
            &Error::msg("Specify at least one of --owner, --purpose, --pr, --issue, or --base"),
            VALIDATION,
        );
    }
    let context = match command_context(&parsed) {
        Ok(context) => context,
        Err(error) => return fail_with(&error, error.exit_code()),
    };
    let base = match single_value(&parsed, "base") {
        Ok(base) => base,
        Err(error) => return fail_with(&error, VALIDATION),
    };
    if let Some(base) = base {
        input.base = match crate::sync::normalize_base(&context.git_root, base) {
            Ok(base) => Some(base),
            Err(error) => return fail_with(&error, VALIDATION),
        };
    }
    let name = &parsed.positionals[0];
    let worktree = match worktree::find_worktree(&context, name, false, None) {
        Ok(worktree) => worktree,
        Err(error @ Error::WorktreeNotFound(_)) => return fail_with(&error, NOT_FOUND),
        Err(error) => return fail_with(&error, error.exit_code()),
    };
    let input = match worktree::outside_name_to_store(&context, Path::new(&worktree.path)) {
        Ok(name) => metadata::MetadataInput { name, ..input },
        Err(error) => return fail_with(&error, error.exit_code()),
    };
    if let Err(error) = metadata::write(&context.git_root, Path::new(&worktree.path), &input) {
        return fail_with(&error, GENERAL);
    }
    let worktree = match worktree::worktree_at_path(&context, Path::new(&worktree.path)) {
        Ok(worktree) => worktree,
        Err(error) => return fail_with(&error, GENERAL),
    };
    if json {
        return emit_json(&worktree::WorktreeRefOutput {
            version: crate::error::JSON_VERSION,
            worktree: worktree.to_json(None),
        });
    }
    println!("Updated metadata for '{}'", worktree.name);
    Ok(SUCCESS)
}

fn action_from(parsed: &Parsed) -> Result<ActionRequest> {
    if parsed.occurrences("exec") > 1 {
        return Err(Error::msg("The --exec option can only be specified once"));
    }
    let exec = parsed.values("exec");
    Ok(ActionRequest {
        exec: (!exec.is_empty()).then_some(exec),
    })
}

/// Shared by common-option extraction and command validation.
fn command_options(key: &str) -> Vec<Opt> {
    let mut options = match key {
        "sync" => vec![
            repo_flag(),
            flag("all", None),
            flag("mine", None),
            flag("no-default", None),
            flag("rebase", None),
            flag("merge", None),
            flag("force", Some('f')),
            flag("keep-conflicts", None),
        ],
        "create" => {
            let mut options = vec![
                repo_flag(),
                remainder_flag("exec", Some('x')),
                Opt {
                    name: "copy-file",
                    short: None,
                    value: true,
                    multiple: true,
                    remainder: false,
                },
                value_flag("base", None),
                flag("no-hooks", None),
            ];
            options.extend(metadata_options());
            options
        }
        "attach" => {
            let mut options = vec![
                repo_flag(),
                remainder_flag("exec", Some('x')),
                Opt {
                    name: "copy-file",
                    short: None,
                    value: true,
                    multiple: true,
                    remainder: false,
                },
                flag("no-hooks", None),
            ];
            options.extend(metadata_options());
            options
        }
        "list" => vec![
            repo_flag(),
            flag("no-default", None),
            flag("names", None),
            value_flag("owner", None),
        ],
        "where" => vec![repo_flag()],
        "delete" => vec![
            repo_flag(),
            flag("force", Some('f')),
            flag("keep-branch", None),
            flag("current", None),
            flag("no-hooks", None),
        ],
        "exec" => vec![repo_flag()],
        "clone" => vec![
            value_flag("branch", None),
            value_flag("depth", None),
            flag("update", None),
        ],
        "repo add" => vec![],
        "repo list" => vec![
            flag("names", None),
            flag("paths", None),
            flag("registered", None),
            flag("discovered", None),
        ],
        "config get" | "config list" => vec![flag("sources", None)],
        "help" => vec![flag("help", Some('h'))],
        "repo forget" => vec![],
        "github checkout" => vec![
            repo_flag(),
            value_flag("base", None),
            flag("no-hooks", None),
            value_flag("owner", None),
            value_flag("purpose", None),
        ],
        "meta set" => {
            let mut options = vec![repo_flag(), value_flag("base", None)];
            options.extend(metadata_options());
            options
        }
        "gc" => vec![
            repo_flag(),
            flag("apply", None),
            flag("force", Some('f')),
            flag("merged", None),
            flag("pr", None),
            flag("orphaned", None),
            value_flag("older-than", None),
            value_flag("owner", None),
            flag("keep-branch", None),
            flag("no-hooks", None),
        ],

        _ => vec![],
    };
    if !options.iter().any(|option| option.name == "repo") {
        options.push(repo_flag());
    }
    options
}

fn repo_flag() -> Opt {
    value_flag("repo", Some('R'))
}

fn metadata_options() -> [Opt; 4] {
    [
        value_flag("owner", None),
        value_flag("purpose", None),
        value_flag("pr", None),
        value_flag("issue", None),
    ]
}

fn metadata_input(parsed: &Parsed, use_env: bool) -> Result<MetadataInput> {
    let env = use_env
        .then(|| std::env::var("MABO_AGENT_ID").ok())
        .flatten();
    Ok(MetadataInput {
        owner: metadata::resolve_owner(single_value(parsed, "owner")?, env.as_deref())?,
        purpose: single_value(parsed, "purpose")?
            .map(metadata::parse_purpose)
            .transpose()?,
        pr: single_value(parsed, "pr")?
            .map(metadata::parse_link)
            .transpose()?,
        issue: single_value(parsed, "issue")?
            .map(metadata::parse_link)
            .transpose()?,
        name: None,
        base: None,
    })
}

fn list_owner(parsed: &Parsed) -> Result<Option<String>> {
    single_value(parsed, "owner")?
        .map(metadata::parse_owner)
        .transpose()
}

fn single_value<'a>(parsed: &'a Parsed, name: &str) -> Result<Option<&'a str>> {
    if parsed.occurrences(name) > 1 {
        return Err(Error::validation(format!(
            "The --{name} option can only be specified once"
        )));
    }
    match parsed.value(name) {
        Some(value) if value.starts_with('-') => Err(Error::validation(format!(
            "Option '--{name} <value>' received '{value}', which looks like an option"
        ))),
        value => Ok(value),
    }
}

fn selected_repository(parsed: &Parsed) -> Result<Option<std::path::PathBuf>> {
    if parsed.occurrences("repo") > 1 {
        return Err(Error::validation(
            "The --repo option can only be specified once".to_string(),
        ));
    }
    match parsed.value("repo") {
        Some(reference) => projects::resolve_project_ref(reference).map(Some),
        None => Ok(None),
    }
}

fn gc(args: &[String]) -> Result<i32> {
    let json = crate::output::json();
    let parsed = match args::parse(args, &command_options("gc"), false) {
        Ok(parsed) => parsed,
        Err(error) => return fail_with(&error, error.exit_code()),
    };
    let older_than = match parsed.value("older-than") {
        Some(value) => match crate::gc::parse_duration(value) {
            Ok(duration) => Some(duration),
            Err(error) => return fail_with(&error, error.exit_code()),
        },
        None => None,
    };
    let owner_filter = match parsed.value("owner") {
        Some(value) => match metadata::parse_owner(value) {
            Ok(owner) => Some(owner),
            Err(error) => return fail_with(&error, error.exit_code()),
        },
        None => None,
    };
    let context = match command_context(&parsed) {
        Ok(context) => context,
        Err(error) => return fail_with(&error, error.exit_code()),
    };
    let agent_id = std::env::var("MABO_AGENT_ID")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let force = parsed.flag("force");
    let request = crate::gc::Request {
        policy: crate::gc::Policy {
            selection: crate::gc::selection_from_flags(
                parsed.flag("merged"),
                parsed.flag("pr"),
                parsed.flag("orphaned"),
                older_than,
            ),
            now: std::time::SystemTime::now(),
            force,
            agent_id,
            owner_filter,
        },
        apply: parsed.flag("apply") || force,
        keep_branch: parsed.flag("keep-branch") || context.preferences.keep_branch.unwrap_or(false),
        no_hooks: parsed.flag("no-hooks"),
    };
    let report = match crate::gc::run(&context, &request, &logger_for(json)) {
        Ok(report) => report,
        Err(error) => return fail_with(&error, error.exit_code()),
    };
    if json {
        emit_json(&report)?;
        return Ok(report.exit_code());
    }
    for line in &report.lines {
        println!("{line}");
    }
    Ok(report.exit_code())
}

fn command_context(parsed: &Parsed) -> Result<crate::context::Context> {
    let repository = selected_repository(parsed)?;
    crate::context::open(repository.as_deref())
}

fn hook_control(parsed: &Parsed, json: bool, prompt: bool) -> HookControl {
    HookControl {
        no_hooks: parsed.flag("no-hooks"),
        json,
        prompt,
    }
}

fn trust_cmd(args: &[String]) -> Result<i32> {
    let json = crate::output::json();
    let parsed = match args::parse(args, &command_options("trust add"), true) {
        Ok(parsed) => parsed,
        Err(error) => return fail_with(&error, error.exit_code()),
    };
    if parsed.positionals.len() > 1 {
        return fail_with(
            &Error::validation("Usage: mabo trust add [REPO]"),
            VALIDATION,
        );
    }
    let start = match trust_start(&parsed) {
        Ok(start) => start,
        Err(error) => return fail_with(&error, error.exit_code()),
    };
    let project = match trust::load_hooks(&start) {
        Ok(project) => project,
        Err(error) => return fail_with(&error, error.exit_code()),
    };
    eprintln!(
        "{}\n{}",
        project.project,
        trust::format_hooks(&project.post_create, &project.pre_delete)
    );
    match trust::trust_root(Path::new(&project.git_root)) {
        Ok(record) => {
            if json {
                emit_json(&serde_json::json!({
                    "version": crate::error::JSON_VERSION,
                    "path": record.path,
                    "trustedAt": record.trusted_at,
                }))
            } else {
                println!("Trusted {}", record.path);
                Ok(SUCCESS)
            }
        }
        Err(error) => fail_with(&error, error.exit_code()),
    }
}

fn untrust_cmd(args: &[String]) -> Result<i32> {
    let json = crate::output::json();
    let parsed = match args::parse(args, &command_options("trust remove"), true) {
        Ok(parsed) => parsed,
        Err(error) => return fail_with(&error, error.exit_code()),
    };
    if parsed.positionals.len() > 1 {
        return fail_with(
            &Error::validation("Usage: mabo trust remove [REPO]"),
            VALIDATION,
        );
    }
    let start = match trust_start(&parsed) {
        Ok(start) => start,
        Err(error) => return fail_with(&error, error.exit_code()),
    };
    let git_root = match crate::git::git_root(&start) {
        Ok(git_root) => git_root,
        Err(error) => return fail_with(&error, error.exit_code()),
    };
    let key = match trust::common_dir_key(&git_root) {
        Ok(key) => key.to_string_lossy().to_string(),
        Err(error) => return fail_with(&error, error.exit_code()),
    };
    match trust::untrust_root(&git_root) {
        Ok(removed) => {
            if json {
                emit_json(&serde_json::json!({
                    "version": crate::error::JSON_VERSION,
                    "path": key,
                    "removed": removed,
                }))
            } else if removed {
                println!("Removed trust for {key}");
                Ok(SUCCESS)
            } else {
                println!("Not trusted: {key}");
                Ok(SUCCESS)
            }
        }
        Err(error) => fail_with(&error, error.exit_code()),
    }
}

fn print_trust_list(json: bool) -> Result<i32> {
    let projects = match trust::list_trusted() {
        Ok(projects) => projects,
        Err(error) => return fail_with(&error, error.exit_code()),
    };
    if json {
        let projects = projects
            .iter()
            .map(|project| {
                serde_json::json!({
                    "path": project.path,
                    "trustedAt": project.trusted_at,
                })
            })
            .collect::<Vec<_>>();
        return emit_json(&serde_json::json!({
            "version": crate::error::JSON_VERSION,
            "repos": projects,
        }));
    }
    if projects.is_empty() {
        println!("No trusted repos");
        return Ok(SUCCESS);
    }
    for project in projects {
        println!("{}\t{}", project.path, project.trusted_at);
    }
    Ok(SUCCESS)
}

fn trust_root_cmd(args: &[String]) -> Result<i32> {
    let hint = if args.iter().any(|arg| arg == "--list") {
        "mabo trust list"
    } else {
        "mabo trust add [REPO] or mabo trust remove [REPO]"
    };
    Err(Error::validation(format!(
        "Use `{hint}`. The old trust syntax (--yes/--list) was removed."
    )))
}

fn trust_list_cmd(args: &[String]) -> Result<i32> {
    let parsed = args::parse(args, &command_options("trust list"), false)?;
    selected_repository(&parsed)?;
    print_trust_list(crate::output::json())
}

fn trust_start(parsed: &Parsed) -> Result<std::path::PathBuf> {
    let selected = selected_repository(parsed)?;
    match parsed.positionals.first() {
        Some(reference) => projects::resolve_project_ref(reference),
        None => match selected {
            Some(root) => Ok(root),
            None => std::env::current_dir().map_err(|error| Error::msg(error.to_string())),
        },
    }
}

fn flag(name: &'static str, short: Option<char>) -> Opt {
    Opt {
        name,
        short,
        value: false,
        multiple: false,
        remainder: false,
    }
}

fn value_flag(name: &'static str, short: Option<char>) -> Opt {
    Opt {
        name,
        short,
        value: true,
        multiple: false,
        remainder: false,
    }
}

fn remainder_flag(name: &'static str, short: Option<char>) -> Opt {
    Opt {
        name,
        short,
        value: true,
        multiple: false,
        remainder: true,
    }
}

fn report_delete_refusals(failures: Vec<worktree::DeleteError>, json: bool) -> Result<i32> {
    let first = failures
        .first()
        .map(|failure| delete_status(&failure.error))
        .unwrap_or(GENERAL);
    if json {
        let deleted = failures
            .iter()
            .map(|failure| worktree::DeletedEntry {
                worktree: failure
                    .worktree
                    .as_ref()
                    .map(|worktree| worktree.to_json(None)),
                branch_deleted: false,
                branch_error: None,
                error: Some(failure.error.to_string()),
            })
            .collect();
        let error = failures
            .first()
            .map(|failure| failure.error.to_json(first).error);
        emit_json(&worktree::DeleteOutput {
            version: crate::error::JSON_VERSION,
            deleted,
            error,
        })?;
        return Ok(first);
    }
    for failure in &failures {
        eprintln!("{}", failure.error);
    }
    Ok(first)
}

fn delete_status(error: &Error) -> i32 {
    error.exit_code()
}

fn fail(error: &Error, code: i32) -> Result<i32> {
    fail_with(error, code)
}

fn fail_with(error: &Error, requested: i32) -> Result<i32> {
    let json = crate::output::json();
    let code = if matches!(error, Error::CommandFailed { .. } | Error::Signaled(_)) && !json {
        // Child status transparency belongs only to standalone exec.
        if crate::output::command_is_exec() {
            error.child_exit_code()
        } else {
            error.exit_code()
        }
    } else {
        crate::error::exit_for_code(error.json_code(requested))
    };
    crate::output::failure(error.to_json(requested).error);
    Ok(code)
}

fn emit_json(value: &impl serde::Serialize) -> Result<i32> {
    crate::output::data(value)
}

fn finish_mutation(
    json: bool,
    document: &worktree::WorktreeChangeOutput,
    exec: Option<&worktree::ExecOutcome>,
    exit_code: Option<i32>,
) -> Result<i32> {
    let partial = exit_code.is_some_and(|code| code != 0) || !document.copy_files.ok;
    let status = if partial {
        crate::error::PARTIAL
    } else {
        SUCCESS
    };
    if json {
        emit_json(document)?;
    }
    if partial {
        let mut error = Error::status(status, "Workspace created but setup did not complete")
            .to_json(status)
            .error;
        if let Some(exec) = exec.filter(|exec| !exec.ok) {
            error.details =
                Some(serde_json::json!({"exitCode": exec.exit_code, "signal": exec.signal}));
            error.message = if let Some(signal) = &exec.signal {
                Error::Signaled(signal.clone()).to_string()
            } else if let Some(error) = &exec.error {
                error.clone()
            } else {
                Error::CommandFailed {
                    command: exec.shell.clone(),
                    code: exec.exit_code,
                }
                .to_string()
            };
        }
        crate::output::failure(error);
    }
    Ok(status)
}

fn bubble(error: Error, json: bool) -> Result<i32> {
    if json {
        let code = error.exit_code();
        fail_with(&error, code)
    } else {
        Err(error)
    }
}

fn logger_for(json: bool) -> Logger {
    if json {
        Logger::json()
    } else {
        Logger::on()
    }
}

fn create_code(error: &Error) -> i32 {
    error.exit_code()
}
fn attach_code(error: &Error) -> i32 {
    error.exit_code()
}

static META_COMMANDS: &[Command] = &[Command {
    name: "set",
    help_key: "meta set",
    run: meta_set,
    children: &[],
}];

static PREFERENCE_COMMANDS: &[Command] = &[
    Command {
        name: "list",
        help_key: "config list",
        run: config_list,
        children: &[],
    },
    Command {
        name: "get",
        help_key: "config get",
        run: config_get,
        children: &[],
    },
    Command {
        name: "set",
        help_key: "config set",
        run: config_set,
        children: &[],
    },
    Command {
        name: "unset",
        help_key: "config unset",
        run: config_unset,
        children: &[],
    },
];

static PROJECT_COMMANDS: &[Command] = &[
    Command {
        name: "show",
        help_key: "repo show",
        run: repo_show,
        children: &[],
    },
    Command {
        name: "add",
        help_key: "repo add",
        run: project_add,
        children: &[],
    },
    Command {
        name: "list",
        help_key: "repo list",
        run: project_list,
        children: &[],
    },
    Command {
        name: "forget",
        help_key: "repo forget",
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

static TRUST_COMMANDS: &[Command] = &[
    Command {
        name: "add",
        help_key: "trust add",
        run: trust_cmd,
        children: &[],
    },
    Command {
        name: "remove",
        help_key: "trust remove",
        run: untrust_cmd,
        children: &[],
    },
    Command {
        name: "list",
        help_key: "trust list",
        run: trust_list_cmd,
        children: &[],
    },
];

static COMMANDS: &[Command] = &[
    Command {
        name: "-v",
        help_key: "--version",
        run: version,
        children: &[],
    },
    Command {
        name: "help",
        help_key: "help",
        run: help_cmd,
        children: &[],
    },
    Command {
        name: "sync",
        help_key: "sync",
        run: sync,
        children: &[],
    },
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
        name: "gc",
        help_key: "gc",
        run: gc,
        children: &[],
    },
    Command {
        name: "trust",
        help_key: "trust",
        run: trust_root_cmd,
        children: TRUST_COMMANDS,
    },
    Command {
        name: "exec",
        help_key: "exec",
        run: exec,
        children: &[],
    },
    Command {
        name: "meta",
        help_key: "meta",
        run: meta_root,
        children: META_COMMANDS,
    },
    Command {
        name: "config",
        help_key: "config",
        run: config_root,
        children: PREFERENCE_COMMANDS,
    },
    Command {
        name: "--version",
        help_key: "--version",
        run: version,
        children: &[],
    },
    Command {
        name: "clone",
        help_key: "clone",
        run: clone_cmd,
        children: &[],
    },
    Command {
        name: "repo",
        help_key: "repo",
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

#[cfg(test)]
mod contract_tests {
    use super::*;
    use std::collections::BTreeSet;

    fn collect_commands(commands: &[Command], keys: &mut BTreeSet<String>) {
        for command in commands {
            keys.insert(command.help_key.into());
            collect_commands(command.children, keys);
        }
    }

    #[test]
    fn help_contract_covers_every_command_and_exact_parser_flags() {
        let contract: serde_json::Value =
            serde_json::from_str(include_str!("../help-data.json")).unwrap();
        let mut commands = BTreeSet::new();
        collect_commands(COMMANDS, &mut commands);
        for key in commands {
            let entry = &contract["helps"][&key];
            assert!(entry.is_object(), "missing command {key}");
            let actual = command_options(&key)
                .iter()
                .map(|opt| (opt.name.to_string(), opt.short))
                .collect::<BTreeSet<_>>();
            let documented = entry["options"]
                .as_array()
                .unwrap()
                .iter()
                .filter_map(|opt| {
                    let name = opt["name"].as_str().unwrap();
                    (!matches!(name, "json" | "output" | "no-input" | "help")).then(|| {
                        (
                            name.to_string(),
                            opt["short"].as_str().and_then(|short| short.chars().next()),
                        )
                    })
                })
                .collect::<BTreeSet<_>>();
            let actual = actual
                .into_iter()
                .filter(|(name, _)| name != "help")
                .collect::<BTreeSet<_>>();
            assert_eq!(documented, actual, "flags for {key}");
        }
        for (key, entry) in contract["helps"].as_object().unwrap() {
            assert!(
                matches!(key.as_str(), "gh" | "gh checkout")
                    || find(
                        &key.split_whitespace()
                            .map(str::to_string)
                            .collect::<Vec<_>>(),
                        COMMANDS
                    )
                    .is_some(),
                "unknown documented command {key}"
            );
            for option in entry["options"].as_array().unwrap() {
                assert!(
                    !matches!(option["name"].as_str(), Some("project")),
                    "removed flag in {key}"
                );
                if key.starts_with("trust") {
                    assert!(
                        !matches!(option["name"].as_str(), Some("yes" | "list")),
                        "removed trust flag in {key}"
                    );
                }
            }
        }
        for removed in ["project", "preferences", "untrust", "version"] {
            assert!(contract["helps"].get(removed).is_none(), "{removed}");
        }
    }
}
