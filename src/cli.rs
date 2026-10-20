use std::path::Path;

use crate::args::{self, Opt, Parsed};
use crate::error::{Error, Result, GENERAL, NOT_FOUND, SUCCESS, VALIDATION};
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
    if args.is_empty() || args[0] == "-h" || args[0] == "--help" {
        println!("{}", help::main_help()?);
        return Ok(SUCCESS);
    }
    if args[0] == "-v" || args[0] == "--version" {
        println!("{}", crate::version_line());
        return Ok(SUCCESS);
    }
    match find(args, COMMANDS) {
        Some((command, remaining)) if requests_help(command, remaining) => {
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
    let json = wants_json(args);
    let mut options = vec![
        project_flag(),
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
        flag("json", None),
    ];
    options.extend(metadata_options());
    let parsed = match args::parse(args, &options, true) {
        Ok(parsed) => parsed,
        Err(error) => return fail_with(&error, error.exit_code(), json),
    };
    let json = parsed.flag("json") || wants_json(args);
    let action = match action_from(&parsed) {
        Ok(action) => action,
        Err(error) => return fail_with(&error, VALIDATION, json),
    };
    let metadata = match metadata_input(&parsed, true) {
        Ok(metadata) => metadata,
        Err(error) => return fail_with(&error, error.exit_code(), json),
    };
    let repository = match selected_repository(&parsed) {
        Ok(repository) => repository,
        Err(error) => return fail_project(&error, args, &parsed, json),
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
        Err(error) => fail_with(&error, create_code(&error), json),
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
    let json = wants_json(args);
    let mut options = vec![
        project_flag(),
        remainder_flag("exec", Some('x')),
        Opt {
            name: "copy-file",
            short: None,
            value: true,
            multiple: true,
            remainder: false,
        },
        flag("no-hooks", None),
        flag("json", None),
    ];
    options.extend(metadata_options());
    let parsed = match args::parse(args, &options, true) {
        Ok(parsed) => parsed,
        Err(error) => return fail_with(&error, error.exit_code(), json),
    };
    let json = parsed.flag("json") || wants_json(args);
    let Some(name) = parsed.positionals.first() else {
        return fail_with(
            &Error::msg("Missing required argument: branch name"),
            VALIDATION,
            json,
        );
    };
    let action = match action_from(&parsed) {
        Ok(action) => action,
        Err(error) => return fail_with(&error, VALIDATION, json),
    };
    let metadata = match metadata_input(&parsed, true) {
        Ok(metadata) => metadata,
        Err(error) => return fail_with(&error, error.exit_code(), json),
    };
    let repository = match selected_repository(&parsed) {
        Ok(repository) => repository,
        Err(error) => return fail_project(&error, args, &parsed, json),
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
        Err(error) => fail_with(&error, attach_code(&error), json),
    }
}

fn list(args: &[String]) -> Result<i32> {
    let json = wants_json(args);
    let parsed = match args::parse(
        args,
        &[
            project_flag(),
            flag("no-default", None),
            flag("names", None),
            flag("json", None),
            value_flag("owner", None),
        ],
        false,
    ) {
        Ok(parsed) => parsed,
        Err(error) => return fail_with(&error, error.exit_code(), json),
    };
    let json = parsed.flag("json") || wants_json(args);
    let owner = match list_owner(&parsed) {
        Ok(owner) => owner,
        Err(error) => return fail_with(&error, error.exit_code(), json),
    };
    if json && parsed.flag("names") {
        return fail_with(
            &Error::msg("Only one of --json or --names can be specified"),
            VALIDATION,
            true,
        );
    }
    let context = match command_context(&parsed) {
        Ok(context) => context,
        Err(error) => return fail_project(&error, args, &parsed, json),
    };
    let exclude_default = parsed.flag("no-default");
    if let Some(warning) = metadata::read_problem(&context.git_root) {
        eprintln!("Warning: {warning}");
    }
    let worktrees = match worktree::list_worktrees(&context, exclude_default, false) {
        Ok(worktrees) => worktrees,
        Err(error) => return fail_with(&error, GENERAL, json),
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
                format!("No worktrees found for owner '{owner}'")
            } else if exclude_default && !available.is_empty() {
                "No sub worktrees found".to_string()
            } else {
                "No worktrees found".to_string()
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
            println!(
                "{} ({}){dirty}{suffix}",
                worktree.name, worktree.path_to_display
            );
        }
    }
    Ok(SUCCESS)
}

fn where_cmd(args: &[String]) -> Result<i32> {
    let json = wants_json(args);
    let parsed = match args::parse(args, &[project_flag(), flag("json", None)], true) {
        Ok(parsed) => parsed,
        Err(error) => return fail_with(&error, error.exit_code(), json),
    };
    let json = parsed.flag("json") || wants_json(args);
    if parsed.positionals.is_empty() {
        return fail_with(
            &Error::msg("Usage: mabo where <worktree-name>"),
            VALIDATION,
            json,
        );
    }
    let context = match command_context(&parsed) {
        Ok(context) => context,
        Err(error) => return fail_project(&error, args, &parsed, json),
    };
    let name = &parsed.positionals[0];
    match worktree::find_worktree(&context, name, false, None) {
        Ok(mut worktree) => {
            match metadata::touch(&context.git_root, Path::new(&worktree.path)) {
                Ok(Some(updated)) => worktree.metadata = updated,
                Ok(None) => {}
                Err(error) => eprintln!("Warning: {error}"),
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
        Err(error @ Error::WorktreeNotFound(_)) => fail_with(&error, NOT_FOUND, json),
        Err(error) => fail_with(&error, GENERAL, json),
    }
}

fn delete(args: &[String]) -> Result<i32> {
    let json = wants_json(args);
    let parsed = match args::parse(
        args,
        &[
            project_flag(),
            flag("force", Some('f')),
            flag("keep-branch", None),
            flag("current", None),
            flag("no-hooks", None),
            flag("json", None),
        ],
        true,
    ) {
        Ok(parsed) => parsed,
        Err(error) => return fail_with(&error, error.exit_code(), json),
    };
    let json = parsed.flag("json") || wants_json(args);
    let delete_current = parsed.flag("current");
    if parsed.positionals.is_empty() && !delete_current {
        return fail_with(
            &Error::msg(
                "Please provide at least one worktree name to delete, or use --current to delete the current worktree",
            ),
            VALIDATION,
            json,
        );
    }
    if !parsed.positionals.is_empty() && delete_current {
        return fail_with(
            &Error::msg("Cannot specify --current with a worktree name"),
            VALIDATION,
            json,
        );
    }
    let context = match command_context(&parsed) {
        Ok(context) => context,
        Err(error) => return fail_project(&error, args, &parsed, json),
    };
    let keep_branch =
        parsed.flag("keep-branch") || context.preferences.keep_branch.unwrap_or(false);
    let names = if delete_current {
        match worktree::current_worktree_name(&context) {
            Ok(Some(name)) => vec![name],
            Ok(None) => {
                return fail_with(
                    &Error::msg(
                        "Not in a worktree directory. The --current option can only be used from within a worktree.",
                    ),
                    VALIDATION,
                    json,
                );
            }
            Err(error) => return fail_with(&error, GENERAL, json),
        }
    } else {
        parsed.positionals.clone()
    };
    let logger = logger_for(json);
    let options = worktree::DeleteOptions {
        force: parsed.flag("force"),
        keep_branch,
        allow_current: delete_current,
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
                            error: Some(error.to_json(GENERAL).error),
                        })?;
                        return Ok(GENERAL);
                    }
                    return fail(&error, GENERAL);
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
                let code = match error {
                    Error::WorktreeNotFound(_) => NOT_FOUND,
                    Error::Uncommitted { .. } => VALIDATION,
                    other => other.exit_code(),
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
                        error: Some(error.to_json(code).error),
                    })?;
                    return Ok(code);
                }
                return fail(error, code);
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
    let parsed = args::parse_with(args, &[project_flag()], true, Some(1))?;
    if parsed.positionals.len() < 2 {
        return fail(
            &Error::msg("Usage: mabo exec <worktree-name> <command> [args...]"),
            VALIDATION,
        );
    }
    let command_args = parsed.positionals[1..].to_vec();
    let context = match command_context(&parsed) {
        Ok(context) => context,
        Err(error) => return fail_project(&error, args, &parsed, false),
    };
    let name = parsed.positionals[0].clone();
    if let Err(error) = worktree::find_worktree(&context, &name, false, None) {
        let code = if matches!(error, Error::WorktreeNotFound(_)) {
            NOT_FOUND
        } else {
            error.exit_code()
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
                error.exit_code()
            };
            fail(&error, code)
        }
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
        return fail(&Error::msg("Usage: mabo preferences get <key>"), VALIDATION);
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
        None => {
            let path = match preferences::config_path() {
                Ok(path) => path,
                Err(error) => return fail(&error, GENERAL),
            };
            println!("Preference '{key}' is not set ({})", path.display());
        }
    }
    Ok(SUCCESS)
}

fn preferences_set(args: &[String]) -> Result<i32> {
    if args.len() < 2 {
        return fail(
            &Error::msg("Usage: mabo preferences set <key> <value>"),
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
    let path = match preferences::set_preference(key, &value) {
        Ok(path) => path,
        Err(error) => return fail(&error, GENERAL),
    };
    println!("Set {key} to '{value}' in {}", path.display());
    Ok(SUCCESS)
}

fn preferences_remove(args: &[String]) -> Result<i32> {
    let parsed = args::parse(args, &[], true)?;
    if parsed.positionals.len() != 1 {
        return fail(
            &Error::msg("Usage: mabo preferences remove <key>"),
            VALIDATION,
        );
    }
    let key = &parsed.positionals[0];
    if let Err(error) = preferences::require_key(key) {
        return fail(&error, VALIDATION);
    }
    let path = match preferences::remove_preference(key) {
        Ok(path) => path,
        Err(error) => return fail(&error, GENERAL),
    };
    println!("Removed {key} from {}", path.display());
    Ok(SUCCESS)
}

fn version(args: &[String]) -> Result<i32> {
    args::parse(args, &[], false)?;
    println!("{}", crate::version_line());
    Ok(SUCCESS)
}

fn clone_cmd(args: &[String]) -> Result<i32> {
    let json = wants_json(args);
    let parsed = match args::parse(
        args,
        &[
            value_flag("branch", None),
            value_flag("depth", None),
            flag("update", None),
            flag("json", None),
        ],
        true,
    ) {
        Ok(parsed) => parsed,
        Err(error) => return fail_with(&error, error.exit_code(), json),
    };
    let json = parsed.flag("json") || wants_json(args);
    if parsed.positionals.len() != 1 {
        return fail_with(
            &Error::validation(
                "Usage: mabo clone <url|host/owner/repo|owner/repo> [--branch <branch>] [--depth <n>] [--update] [--json]",
            ),
            VALIDATION,
            json,
        );
    }
    match repository::clone_repository(&repository::CloneRequest {
        source: &parsed.positionals[0],
        branch: parsed.value("branch"),
        depth: parsed.value("depth"),
        update: parsed.flag("update"),
    }) {
        Ok(result) => {
            if json {
                emit_json(&result)
            } else {
                println!("{}", repository::human_clone_message(&result));
                Ok(SUCCESS)
            }
        }
        Err(error) => fail_with(&error, error.exit_code(), json),
    }
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
    let json = wants_json(args);
    let parsed = match args::parse(args, &[flag("json", None)], true) {
        Ok(parsed) => parsed,
        Err(error) => return fail_with(&error, VALIDATION, json),
    };
    let json = parsed.flag("json") || wants_json(args);
    if parsed.positionals.len() > 1 {
        return fail_with(
            &Error::msg("Usage: mabo project add [path] [--json]"),
            VALIDATION,
            json,
        );
    }
    let cwd = match std::env::current_dir() {
        Ok(cwd) => cwd,
        Err(error) => return bubble(Error::msg(error.to_string()), json),
    };
    let input = parsed
        .positionals
        .first()
        .map(Path::new)
        .unwrap_or(cwd.as_path());
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
    let json = wants_json(args);
    let parsed = match args::parse(
        args,
        &[flag("json", None), flag("names", None), flag("paths", None)],
        false,
    ) {
        Ok(parsed) => parsed,
        Err(error) => return fail_with(&error, VALIDATION, json),
    };
    let json = parsed.flag("json") || wants_json(args);
    let modes = [
        parsed.flag("json"),
        parsed.flag("names"),
        parsed.flag("paths"),
    ]
    .iter()
    .filter(|enabled| **enabled)
    .count();
    if modes > 1 {
        return fail_with(
            &Error::msg("Only one of --json, --names, or --paths can be specified"),
            VALIDATION,
            json,
        );
    }
    let loaded = match preferences::load_preferences() {
        Ok(preferences) => preferences,
        Err(error) => return fail_with(&error, GENERAL, json),
    };
    let catalog = match projects::list_catalog(loaded.ghq_discovery != Some(false)) {
        Ok(catalog) => catalog,
        Err(error) => return bubble(error, json),
    };
    for warning in &catalog.warnings {
        eprintln!("Warning: {warning}");
    }
    if json {
        return emit_json(&catalog_json(&catalog.projects, catalog.version));
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
    let json = wants_json(args);
    let parsed = match args::parse(args, &[flag("json", None)], true) {
        Ok(parsed) => parsed,
        Err(error) => return fail_with(&error, VALIDATION, json),
    };
    let json = parsed.flag("json") || wants_json(args);
    if parsed.positionals.len() != 1 {
        return fail_with(
            &Error::msg("Usage: mabo project remove <id|name|path> [--json]"),
            VALIDATION,
            json,
        );
    }
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
                &Error::msg(format!("Project '{identifier}' not found")),
                NOT_FOUND,
                json,
            )
        }
        Err(error) => return fail_with(&error, VALIDATION, json),
    };
    let removed = match store.remove(&project.id) {
        Ok(Some(removed)) => removed,
        Ok(None) => {
            return fail_with(
                &Error::msg(format!("Project '{identifier}' not found")),
                NOT_FOUND,
                json,
            )
        }
        Err(error) => return bubble(error, json),
    };
    if json {
        return emit_json(&serde_json::json!({
            "status": "removed",
            "project": removed,
        }));
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
    let json = wants_json(args);
    let options = vec![
        project_flag(),
        value_flag("base", None),
        flag("no-hooks", None),
        flag("json", None),
        value_flag("owner", None),
        value_flag("purpose", None),
    ];
    let parsed = match args::parse(args, &options, true) {
        Ok(parsed) => parsed,
        Err(error) => return fail_with(&error, error.exit_code(), json),
    };
    let json = parsed.flag("json") || wants_json(args);
    let Some(number) = parsed.positionals.first() else {
        return fail_with(
            &Error::msg("Please specify a PR or issue number"),
            VALIDATION,
            json,
        );
    };
    let repository = match selected_repository(&parsed) {
        Ok(repository) => repository,
        Err(error) => return fail_project(&error, args, &parsed, json),
    };
    let metadata = match metadata_input(&parsed, true) {
        Ok(metadata) => metadata,
        Err(error) => return fail_with(&error, error.exit_code(), json),
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
        Err(error) => return fail_with(&error, error.exit_code(), json),
    };
    if json {
        let document = match checkout.to_json() {
            Ok(document) => document,
            Err(error) => return fail_with(&error, GENERAL, true),
        };
        emit_json(&document)?;
    } else {
        println!("{}", checkout.message);
    }
    if let Some(error) = &checkout.metadata_error {
        eprintln!("Warning: {error}");
    }
    if let Some(failure) = &checkout.hook_failure {
        let _ = std::io::Write::flush(&mut std::io::stdout());
        eprintln!("{}", failure.warning(&checkout.path));
    }
    let status = checkout
        .hook_failure
        .as_ref()
        .map(|failure| failure.code)
        .or(checkout.metadata_error.as_ref().map(|_| GENERAL))
        .unwrap_or(SUCCESS);
    Ok(status)
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

fn meta_root(args: &[String]) -> Result<i32> {
    if args.is_empty() {
        if let Some(text) = help::command_help("meta")? {
            println!("{text}");
        }
        return Ok(SUCCESS);
    }
    Err(Error::msg(format!("Unknown meta subcommand: {}", args[0])))
}

fn meta_set(args: &[String]) -> Result<i32> {
    let json = wants_json(args);
    let mut options = vec![project_flag(), flag("json", None)];
    options.extend(metadata_options());
    let parsed = match args::parse(args, &options, true) {
        Ok(parsed) => parsed,
        Err(error) => return fail_with(&error, error.exit_code(), json),
    };
    let json = parsed.flag("json") || wants_json(args);
    if parsed.positionals.len() != 1 {
        return fail_with(
            &Error::msg("Usage: mabo meta set <worktree-name> [options]"),
            VALIDATION,
            json,
        );
    }
    let input = match metadata_input(&parsed, false) {
        Ok(input) => input,
        Err(error) => return fail_with(&error, error.exit_code(), json),
    };
    if input.owner.is_none()
        && input.purpose.is_none()
        && input.pr.is_none()
        && input.issue.is_none()
    {
        return fail_with(
            &Error::msg("Specify at least one of --owner, --purpose, --pr, or --issue"),
            VALIDATION,
            json,
        );
    }
    let context = match command_context(&parsed) {
        Ok(context) => context,
        Err(error) => return fail_project(&error, args, &parsed, json),
    };
    let name = &parsed.positionals[0];
    let worktree = match worktree::find_worktree(&context, name, false, None) {
        Ok(worktree) => worktree,
        Err(error @ Error::WorktreeNotFound(_)) => return fail_with(&error, NOT_FOUND, json),
        Err(error) => return fail_with(&error, error.exit_code(), json),
    };
    let input = match worktree::outside_name_to_store(&context, Path::new(&worktree.path)) {
        Ok(name) => metadata::MetadataInput { name, ..input },
        Err(error) => return fail_with(&error, error.exit_code(), json),
    };
    if let Err(error) = metadata::write(&context.git_root, Path::new(&worktree.path), &input) {
        return fail_with(&error, GENERAL, json);
    }
    let worktree = match worktree::worktree_at_path(&context, Path::new(&worktree.path)) {
        Ok(worktree) => worktree,
        Err(error) => return fail_with(&error, GENERAL, json),
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

fn requests_help(command: &Command, args: &[String]) -> bool {
    match command.name {
        // `mabo exec <name> <command> [args...]`: help flags after the name
        // belong to the command.
        "exec" => help_before_positionals(args, 1),
        // `create`/`attach --exec <command> [args...]`: help flags after
        // `--exec` belong to the command.
        "create" | "attach" => help_before_trailing_exec(args),
        _ => args.iter().any(|arg| is_help_flag(arg)),
    }
}

fn help_before_positionals(args: &[String], limit: usize) -> bool {
    let mut positionals = 0usize;
    let mut skip_value = false;
    for arg in args {
        if positionals >= limit || arg == "--" {
            return false;
        }
        if skip_value {
            // The project value is not the worktree name, even when it is `--help`.
            skip_value = false;
            continue;
        }
        if is_help_flag(arg) {
            return true;
        }
        if arg == "--project" || arg == "-p" {
            skip_value = true;
            continue;
        }
        if arg.starts_with("--project=") || (arg.starts_with("-p") && arg.len() > 2) {
            continue;
        }
        if !arg.starts_with('-') {
            positionals += 1;
        }
    }
    false
}

fn help_before_trailing_exec(args: &[String]) -> bool {
    for arg in args {
        if arg == "--" || arg == "--exec" || arg == "-x" {
            return false;
        }
        if is_help_flag(arg) {
            return true;
        }
    }
    false
}

fn is_help_flag(arg: &str) -> bool {
    arg == "-h" || arg == "--help"
}

fn project_flag() -> Opt {
    value_flag("project", Some('p'))
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
    if parsed.occurrences("project") > 1 {
        return Err(Error::validation(
            "The --project option can only be specified once".to_string(),
        ));
    }
    match parsed.value("project") {
        Some(reference) => projects::resolve_project_ref(reference).map(Some),
        None => Ok(None),
    }
}

fn gc(args: &[String]) -> Result<i32> {
    let json = wants_json(args);
    let parsed = match args::parse(
        args,
        &[
            project_flag(),
            flag("apply", None),
            flag("force", Some('f')),
            flag("merged", None),
            flag("pr", None),
            flag("orphaned", None),
            value_flag("older-than", None),
            value_flag("owner", None),
            flag("keep-branch", None),
            flag("no-hooks", None),
            flag("json", None),
        ],
        false,
    ) {
        Ok(parsed) => parsed,
        Err(error) => return fail_with(&error, error.exit_code(), json),
    };
    let json = parsed.flag("json") || wants_json(args);
    let older_than = match parsed.value("older-than") {
        Some(value) => match crate::gc::parse_duration(value) {
            Ok(duration) => Some(duration),
            Err(error) => return fail_with(&error, error.exit_code(), json),
        },
        None => None,
    };
    let owner_filter = match parsed.value("owner") {
        Some(value) => match metadata::parse_owner(value) {
            Ok(owner) => Some(owner),
            Err(error) => return fail_with(&error, error.exit_code(), json),
        },
        None => None,
    };
    let context = match command_context(&parsed) {
        Ok(context) => context,
        Err(error) => return fail_project(&error, args, &parsed, json),
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
        Err(error) => return fail_with(&error, error.exit_code(), json),
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

/// `--project --json` consumes `--json` as the value, but the user still asked for JSON.
fn fail_project(error: &Error, args: &[String], parsed: &Parsed, json: bool) -> Result<i32> {
    let option_like = parsed
        .value("project")
        .is_some_and(|value| value.starts_with('-'));
    fail_with(
        error,
        error.exit_code(),
        json || (option_like && wants_json(args)),
    )
}

fn hook_control(parsed: &Parsed, json: bool, prompt: bool) -> HookControl {
    HookControl {
        no_hooks: parsed.flag("no-hooks"),
        json,
        prompt,
    }
}

fn trust_cmd(args: &[String]) -> Result<i32> {
    let json = wants_json(args);
    let parsed = match args::parse(
        args,
        &[
            flag("yes", Some('y')),
            flag("list", None),
            flag("json", None),
        ],
        true,
    ) {
        Ok(parsed) => parsed,
        Err(error) => return fail_with(&error, error.exit_code(), json),
    };
    let json = parsed.flag("json") || wants_json(args);
    if parsed.flag("list") {
        if parsed.flag("yes") || !parsed.positionals.is_empty() {
            return fail_with(
                &Error::validation("mabo trust --list does not take a path or --yes"),
                VALIDATION,
                json,
            );
        }
        return print_trust_list(json);
    }
    if parsed.positionals.len() > 1 {
        return fail_with(
            &Error::validation("Usage: mabo trust [path]"),
            VALIDATION,
            json,
        );
    }
    let start = match trust_start(parsed.positionals.first().map(String::as_str)) {
        Ok(start) => start,
        Err(error) => return fail_with(&error, error.exit_code(), json),
    };
    let project = match trust::load_hooks(&start) {
        Ok(project) => project,
        Err(error) => return fail_with(&error, error.exit_code(), json),
    };
    if !parsed.flag("yes") {
        if json || !trust::prompts() {
            return fail_with(
                &Error::msg(
                    "mabo will not ask for trust in this environment. Re-run with --yes to trust this project.",
                ),
                GENERAL,
                json,
            );
        }
        let accepted = match trust::ask(&project, trust::TRUST_PROMPT) {
            Ok(accepted) => accepted,
            Err(error) => return fail_with(&error, error.exit_code(), json),
        };
        if !accepted {
            return fail_with(
                &Error::msg(format!("Did not trust {}", project.project)),
                GENERAL,
                json,
            );
        }
    }
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
        Err(error) => fail_with(&error, error.exit_code(), json),
    }
}

fn untrust_cmd(args: &[String]) -> Result<i32> {
    let json = wants_json(args);
    let parsed = match args::parse(args, &[flag("json", None)], true) {
        Ok(parsed) => parsed,
        Err(error) => return fail_with(&error, error.exit_code(), json),
    };
    let json = parsed.flag("json") || wants_json(args);
    if parsed.positionals.len() > 1 {
        return fail_with(
            &Error::validation("Usage: mabo untrust [path]"),
            VALIDATION,
            json,
        );
    }
    let start = match trust_start(parsed.positionals.first().map(String::as_str)) {
        Ok(start) => start,
        Err(error) => return fail_with(&error, error.exit_code(), json),
    };
    let git_root = match crate::git::git_root(&start) {
        Ok(git_root) => git_root,
        Err(error) => return fail_with(&error, error.exit_code(), json),
    };
    let key = match trust::common_dir_key(&git_root) {
        Ok(key) => key.to_string_lossy().to_string(),
        Err(error) => return fail_with(&error, error.exit_code(), json),
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
        Err(error) => fail_with(&error, error.exit_code(), json),
    }
}

fn print_trust_list(json: bool) -> Result<i32> {
    let projects = match trust::list_trusted() {
        Ok(projects) => projects,
        Err(error) => return fail_with(&error, error.exit_code(), json),
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
            "projects": projects,
        }));
    }
    if projects.is_empty() {
        println!("No trusted projects");
        return Ok(SUCCESS);
    }
    for project in projects {
        println!("{}\t{}", project.path, project.trusted_at);
    }
    Ok(SUCCESS)
}

fn trust_start(path: Option<&str>) -> Result<std::path::PathBuf> {
    match path {
        None => std::env::current_dir().map_err(|error| Error::msg(error.to_string())),
        Some(value) => {
            let path = std::path::PathBuf::from(value);
            if !path.exists() {
                return Err(Error::PathNotFound(value.to_string()));
            }
            if !path.is_dir() {
                return Err(Error::validation(format!(
                    "Path '{value}' is not a directory"
                )));
            }
            Ok(path)
        }
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
    match error {
        Error::WorktreeNotFound(_) => NOT_FOUND,
        Error::Uncommitted { .. } => VALIDATION,
        other => other.exit_code(),
    }
}

fn fail(error: &Error, code: i32) -> Result<i32> {
    fail_with(error, code, false)
}

fn fail_with(error: &Error, code: i32, json: bool) -> Result<i32> {
    if json {
        match serde_json::to_string_pretty(&error.to_json(code)) {
            Ok(text) => println!("{text}"),
            Err(render) => eprintln!("{error}\n{render}"),
        }
        return Ok(code);
    }
    let message = error.to_string();
    if message.is_empty() {
        eprintln!();
    } else {
        eprintln!("{message}");
    }
    Ok(code)
}

fn emit_json(value: &impl serde::Serialize) -> Result<i32> {
    let text =
        serde_json::to_string_pretty(value).map_err(|error| Error::msg(error.to_string()))?;
    println!("{text}");
    Ok(SUCCESS)
}

fn finish_mutation(
    json: bool,
    document: &worktree::WorktreeChangeOutput,
    exec: Option<&worktree::ExecOutcome>,
    exit_code: Option<i32>,
) -> Result<i32> {
    if json {
        emit_json(document)?;
        return Ok(exit_code.unwrap_or(SUCCESS));
    }
    if let Some(exec) = exec.filter(|exec| !exec.ok) {
        let error = if let Some(signal) = &exec.signal {
            Error::Signaled(signal.clone())
        } else if let Some(message) = &exec.error {
            Error::msg(message.clone())
        } else {
            Error::CommandFailed {
                command: exec.shell.clone(),
                code: exec.exit_code,
            }
        };
        return fail(&error, exec.exit_code);
    }
    Ok(exit_code.unwrap_or(SUCCESS))
}

fn bubble(error: Error, json: bool) -> Result<i32> {
    if json {
        let code = error.exit_code();
        fail_with(&error, code, true)
    } else {
        Err(error)
    }
}

fn wants_json(args: &[String]) -> bool {
    args.iter()
        .take_while(|arg| {
            let arg = arg.as_str();
            // `--exec` / `-x` are remainder options. Everything after them,
            // including `--json`, belongs to the command.
            arg != "--" && arg != "--exec" && arg != "-x"
        })
        .any(|arg| arg == "--json")
}

fn logger_for(json: bool) -> Logger {
    if json {
        Logger::json()
    } else {
        Logger::on()
    }
}

fn create_code(error: &Error) -> i32 {
    match error {
        Error::WorktreeAlreadyExists(_) => VALIDATION,
        Error::CommandFailed { code, .. } => *code,
        other => other.exit_code(),
    }
}

fn attach_code(error: &Error) -> i32 {
    match error {
        Error::WorktreeAlreadyExists(_) => VALIDATION,
        Error::BranchNotFound(_) => NOT_FOUND,
        Error::CommandFailed { code, .. } => *code,
        other => other.exit_code(),
    }
}

static META_COMMANDS: &[Command] = &[Command {
    name: "set",
    help_key: "meta set",
    run: meta_set,
    children: &[],
}];

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
        name: "gc",
        help_key: "gc",
        run: gc,
        children: &[],
    },
    Command {
        name: "trust",
        help_key: "trust",
        run: trust_cmd,
        children: &[],
    },
    Command {
        name: "untrust",
        help_key: "untrust",
        run: untrust_cmd,
        children: &[],
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
        name: "clone",
        help_key: "clone",
        run: clone_cmd,
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
