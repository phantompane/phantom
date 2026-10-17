use std::fs;
use std::path::{Path, PathBuf};

use crate::context::{self, Context};
use crate::error::{Error, Result};
use crate::git::{self, GitWorktree};
use crate::names;
use crate::paths;
use crate::process;
use crate::tmux::{self, TmuxDirection};

#[derive(Debug, Clone)]
pub struct WorktreeInfo {
    pub name: String,
    pub path: String,
    pub path_to_display: String,
    pub branch: String,
    pub is_clean: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ActionKind {
    Shell,
    Exec(String),
    Tmux(TmuxDirection),
}

pub struct ActionRequest {
    pub shell: bool,
    pub exec: Option<String>,
    pub tmux: Option<TmuxDirection>,
}

pub struct Logger {
    pub enabled: bool,
}

impl Logger {
    pub fn on() -> Self {
        Self { enabled: true }
    }

    pub fn off() -> Self {
        Self { enabled: false }
    }

    fn log(&self, message: &str) {
        if self.enabled {
            println!("{message}");
        }
    }

    fn warn(&self, message: &str) {
        if self.enabled {
            eprintln!("{message}");
        }
    }
}

pub fn validate_worktree_name(name: &str) -> Result<()> {
    if name.trim().is_empty() {
        return Err(Error::msg("Phantom name cannot be empty"));
    }
    if !name
        .chars()
        .all(|char| char.is_ascii_alphanumeric() || matches!(char, '-' | '_' | '.' | '/'))
    {
        return Err(Error::msg(
            "Phantom name can only contain letters, numbers, hyphens, underscores, dots, and slashes",
        ));
    }
    if name.contains("..") {
        return Err(Error::msg("Phantom name cannot contain consecutive dots"));
    }
    Ok(())
}

pub fn list_worktrees(
    git_root: &Path,
    exclude_default: bool,
    include_prunable: bool,
) -> Result<Vec<WorktreeInfo>> {
    let git_root_string = git_root.to_string_lossy().to_string();
    let cwd = std::env::current_dir().map_err(|error| Error::msg(error.to_string()))?;
    let mut infos = Vec::new();
    let listed = git::list_worktrees(git_root)
        .map_err(|error| Error::msg(format!("Failed to list worktrees: {error}")))?;
    for worktree in listed {
        if !include_prunable && worktree.prunable {
            continue;
        }
        if exclude_default && worktree.path == git_root_string {
            continue;
        }
        infos.push(info_from_git(&worktree, &cwd));
    }
    Ok(infos)
}

fn info_from_git(worktree: &GitWorktree, cwd: &Path) -> WorktreeInfo {
    let short_head = worktree
        .head
        .as_deref()
        .map(|head| head.chars().take(7).collect::<String>())
        .unwrap_or_else(|| "HEAD".to_string());
    let branch_name = match worktree.branch.as_deref() {
        Some(branch) if branch != "(detached HEAD)" => branch.to_string(),
        _ => short_head,
    };
    let path = PathBuf::from(&worktree.path);
    let relative = paths::relative(cwd, &path);
    WorktreeInfo {
        name: branch_name.clone(),
        path: worktree.path.clone(),
        path_to_display: if relative.is_empty() {
            ".".to_string()
        } else {
            relative
        },
        branch: branch_name,
        is_clean: git::is_clean(&path),
    }
}

pub fn find_worktree(
    git_root: &Path,
    name: &str,
    exclude_default: bool,
    expected_path: Option<&Path>,
) -> Result<WorktreeInfo> {
    let worktrees = list_worktrees(git_root, exclude_default, true)?;
    worktrees
        .into_iter()
        .find(|worktree| {
            worktree.name == name
                && expected_path.is_none_or(|path| Path::new(&worktree.path) == path)
        })
        .ok_or_else(|| Error::WorktreeNotFound(name.to_string()))
}

pub fn ensure_absent(git_root: &Path, name: &str) -> Result<()> {
    if list_worktrees(git_root, false, true)?
        .iter()
        .any(|worktree| worktree.name == name)
    {
        Err(Error::WorktreeAlreadyExists(name.to_string()))
    } else {
        Ok(())
    }
}

pub struct CreateRequest<'a> {
    pub name: Option<&'a str>,
    pub base: Option<&'a str>,
    pub copy_files: &'a [String],
    pub action: ActionRequest,
    pub logger: Logger,
}

pub struct CreateOutcome {
    pub name: String,
    pub path: PathBuf,
    pub exit_code: Option<i32>,
}

pub fn run_create(request: CreateRequest<'_>) -> Result<CreateOutcome> {
    let action = resolve_action(&request.action)?;
    validate_action(action.as_ref())?;
    let cwd = std::env::current_dir().map_err(|error| Error::msg(error.to_string()))?;
    let git_root = git::git_root(&cwd)?;
    let context = context::create(&git_root)?;
    let name = match request.name {
        Some(name) => name.to_string(),
        None => names::generate_unique_name(
            &context.git_root,
            &context.worktrees_directory,
            &context.directory_name_separator,
        )?,
    };
    let configured = context
        .config
        .as_ref()
        .and_then(|config| config.post_create.as_ref())
        .and_then(|post| post.copy_files.clone())
        .unwrap_or_default();
    let files = merge_files(&configured, request.copy_files);
    let commands = context
        .config
        .as_ref()
        .and_then(|config| config.post_create.as_ref())
        .and_then(|post| post.commands.clone())
        .unwrap_or_default();
    let created = create_worktree(
        &context,
        &name,
        request.base.unwrap_or("HEAD"),
        &files,
        &commands,
        &request.logger,
    )?;
    request.logger.log(&format!(
        "Created worktree '{name}' at {}",
        created.path.display()
    ));
    if let Some(error) = &created.copy_error {
        request
            .logger
            .warn(&format!("\nWarning: Failed to copy some files: {error}"));
    }
    let exit_code = run_action(
        &context,
        &name,
        &created.path,
        action,
        &request.logger,
        true,
    )?;
    Ok(CreateOutcome {
        name,
        path: created.path,
        exit_code,
    })
}

pub struct CreatedWorktree {
    pub path: PathBuf,
    pub copy_error: Option<String>,
}

pub fn create_worktree(
    context: &Context,
    name: &str,
    base: &str,
    copy_files: &[String],
    commands: &[String],
    logger: &Logger,
) -> Result<CreatedWorktree> {
    validate_worktree_name(name)?;
    fs::create_dir_all(&context.worktrees_directory)
        .map_err(|error| Error::msg(error.to_string()))?;
    ensure_absent(&context.git_root, name)?;
    let path = paths::worktree_path(
        &context.worktrees_directory,
        name,
        &context.directory_name_separator,
    );
    git::add_worktree(&context.git_root, &path, name, base, true)?;
    let copy_error = if copy_files.is_empty() {
        None
    } else {
        copy_files_into(&context.git_root, &path, copy_files)
            .err()
            .map(|error| error.to_string())
    };
    if !commands.is_empty() {
        logger.log("\nRunning post-create commands...");
        run_hook_commands(
            &context.git_root,
            &context.worktrees_directory,
            name,
            commands,
            true,
            logger,
        )?;
    }
    Ok(CreatedWorktree { path, copy_error })
}

pub struct AttachRequest<'a> {
    pub name: &'a str,
    pub copy_files: &'a [String],
    pub action: ActionRequest,
    pub logger: Logger,
}

pub fn run_attach(request: AttachRequest<'_>) -> Result<PathBuf> {
    let action = resolve_action(&request.action)?;
    validate_action(action.as_ref())?;
    let cwd = std::env::current_dir().map_err(|error| Error::msg(error.to_string()))?;
    let git_root = git::git_root(&cwd)?;
    let context = context::create(&git_root)?;
    let configured = context
        .config
        .as_ref()
        .and_then(|config| config.post_create.as_ref())
        .and_then(|post| post.copy_files.clone())
        .unwrap_or_default();
    let files = merge_files(&configured, request.copy_files);
    let commands = context
        .config
        .as_ref()
        .and_then(|config| config.post_create.as_ref())
        .and_then(|post| post.commands.clone())
        .unwrap_or_default();
    let path = attach_worktree(&context, request.name, &files, &commands, &request.logger)?;
    request
        .logger
        .log(&format!("Attached phantom: {}", request.name));
    run_action(
        &context,
        request.name,
        &path,
        action,
        &request.logger,
        false,
    )?;
    Ok(path)
}

pub fn attach_worktree(
    context: &Context,
    name: &str,
    copy_files: &[String],
    commands: &[String],
    logger: &Logger,
) -> Result<PathBuf> {
    validate_worktree_name(name)?;
    let path = paths::worktree_path(
        &context.worktrees_directory,
        name,
        &context.directory_name_separator,
    );
    if path.exists() {
        return Err(Error::WorktreeAlreadyExists(name.to_string()));
    }
    if !git::branch_exists(&context.git_root, name)? {
        return Err(Error::BranchNotFound(name.to_string()));
    }
    fs::create_dir_all(&context.worktrees_directory)
        .map_err(|error| Error::msg(error.to_string()))?;
    git::add_worktree(&context.git_root, &path, name, "HEAD", false).map_err(|error| {
        let message = error.to_string();
        if let Some(stripped) = message.strip_prefix("worktree add failed: ") {
            Error::msg(stripped.to_string())
        } else {
            error
        }
    })?;
    if !copy_files.is_empty() {
        if let Err(error) = copy_files_into(&context.git_root, &path, copy_files) {
            logger.warn(&format!("Warning: Failed to copy some files: {error}"));
        }
    }
    if !commands.is_empty() {
        logger.log("\nRunning post-create commands...");
        run_hook_commands(
            &context.git_root,
            &context.worktrees_directory,
            name,
            commands,
            true,
            logger,
        )?;
    }
    Ok(path)
}

pub struct DeleteOutcome {
    pub message: String,
}

pub fn delete_worktree(
    context: &Context,
    name: &str,
    force: bool,
    keep_branch: bool,
    expected_path: Option<&Path>,
) -> Result<DeleteOutcome> {
    let worktree = find_worktree(&context.git_root, name, true, expected_path)?;
    let path = PathBuf::from(&worktree.path);
    if !paths::is_strictly_inside(&path, &context.worktrees_directory) {
        return Err(Error::msg(format!(
            "Worktree '{name}' is not managed by Phantom and cannot be deleted."
        )));
    }
    let changed = git::status_count(&path).unwrap_or(0);
    if changed > 0 && !force {
        return Err(Error::Uncommitted {
            name: name.to_string(),
            files: changed,
        });
    }
    let commands = context
        .config
        .as_ref()
        .and_then(|config| config.pre_delete.as_ref())
        .and_then(|pre| pre.commands.clone())
        .unwrap_or_default();
    if !commands.is_empty() {
        println!("\nRunning pre-delete commands...");
        run_hook_commands(
            &context.git_root,
            &context.worktrees_directory,
            name,
            &commands,
            false,
            &Logger::on(),
        )?;
    }
    git::remove_worktree(&context.git_root, &path, force)?;
    let message = if keep_branch {
        format!("Deleted worktree '{name}' and kept its branch '{name}'")
    } else {
        match git::delete_branch(&context.git_root, name) {
            Ok(()) => format!("Deleted worktree '{name}' and its branch '{name}'"),
            Err(error) => format!(
                "Deleted worktree '{name}'\nNote: Branch '{name}' could not be deleted: {error}"
            ),
        }
    };
    let message = if changed > 0 {
        format!("Warning: Worktree '{name}' had uncommitted changes ({changed} files)\n{message}")
    } else {
        message
    };
    Ok(DeleteOutcome { message })
}

pub fn current_worktree_name(git_root: &Path) -> Result<Option<String>> {
    let cwd = std::env::current_dir().map_err(|error| Error::msg(error.to_string()))?;
    let top = match git::top_level(&cwd) {
        Ok(top) => top,
        Err(_) => return Ok(None),
    };
    if top == git_root {
        return Ok(None);
    }
    match git::current_branch(&top) {
        Ok(branch) if !branch.is_empty() => Ok(Some(branch)),
        _ => Ok(None),
    }
}

pub fn exec_in_worktree(
    git_root: &Path,
    _worktrees_directory: &Path,
    name: &str,
    command: &str,
    args: &[&str],
    env: &[(&str, &str)],
) -> Result<i32> {
    let worktree = find_worktree(git_root, name, false, None)?;
    let path = PathBuf::from(&worktree.path);
    let owned = phantom_env(&worktree.name, &path);
    let mut pairs = owned
        .iter()
        .map(|(key, value)| (key.as_str(), value.as_str()))
        .collect::<Vec<_>>();
    for (key, value) in env {
        if let Some(existing) = pairs.iter_mut().find(|(name, _)| *name == *key) {
            existing.1 = value;
        } else {
            pairs.push((key, value));
        }
    }
    process::inherit(command, args, Some(&path), &pairs)
}

pub fn select_with_fzf(git_root: &Path, exclude_default: bool) -> Result<Option<WorktreeInfo>> {
    let worktrees = list_worktrees(git_root, exclude_default, false)?;
    if worktrees.is_empty() {
        return Ok(None);
    }
    let lines = worktrees
        .iter()
        .map(|worktree| {
            let dirty = if worktree.is_clean { "" } else { " [dirty]" };
            format!("{} ({}){dirty}", worktree.name, worktree.path_to_display)
        })
        .collect::<Vec<_>>();
    let captured = match process::write_and_capture(
        "fzf",
        &["--prompt", "Select worktree> ", "--header", "Git Worktrees"],
        &lines.join("\n"),
    ) {
        Ok(captured) => captured,
        Err(Error::Spawn { details, .. }) if details.contains("ENOENT") => {
            return Err(Error::msg(
                "fzf command not found. Please install fzf first.",
            ));
        }
        Err(error) => return Err(error),
    };
    if captured.code == 1 || captured.code == 130 {
        return Ok(None);
    }
    if captured.code != 0 {
        return Err(Error::msg(format!(
            "fzf exited with code {}: {}",
            captured.code,
            captured.stderr.trim()
        )));
    }
    let selected = captured.stdout.trim();
    if selected.is_empty() {
        return Ok(None);
    }
    let name = selected.split(' ').next().unwrap_or(selected);
    worktrees
        .into_iter()
        .find(|worktree| worktree.name == name)
        .map(Some)
        .ok_or_else(|| Error::msg("Selected worktree not found"))
}

pub fn resolve_action(request: &ActionRequest) -> Result<Option<ActionKind>> {
    let mut actions = Vec::new();
    if request.shell {
        actions.push(ActionKind::Shell);
    }
    if let Some(command) = &request.exec {
        actions.push(ActionKind::Exec(command.clone()));
    }
    if let Some(direction) = request.tmux {
        actions.push(ActionKind::Tmux(direction));
    }
    if actions.len() > 1 {
        return Err(Error::ActionConflict);
    }
    Ok(actions.into_iter().next())
}

pub fn validate_action(action: Option<&ActionKind>) -> Result<()> {
    if matches!(action, Some(ActionKind::Tmux(_))) && !tmux::inside_tmux() {
        return Err(Error::TmuxRequired);
    }
    Ok(())
}

fn run_action(
    context: &Context,
    name: &str,
    path: &Path,
    action: Option<ActionKind>,
    logger: &Logger,
    return_success_code: bool,
) -> Result<Option<i32>> {
    let Some(action) = action else {
        return Ok(None);
    };
    match action {
        ActionKind::Shell => {
            logger.log(&format!(
                "\nEntering worktree '{name}' at {}",
                path.display()
            ));
            logger.log("Type 'exit' to return to your original directory\n");
            let code = open_shell(&context.git_root, name)?;
            if code == 0 {
                Ok(return_success_code.then_some(code))
            } else {
                Err(command_failure(&code))
            }
        }
        ActionKind::Exec(command) => {
            logger.log(&format!(
                "\nExecuting command in worktree '{name}': {command}"
            ));
            let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
            let env = phantom_env(name, path);
            let pairs = env
                .iter()
                .map(|(key, value)| (key.as_str(), value.as_str()))
                .collect::<Vec<_>>();
            let code = process::inherit(&shell, &["-c", &command], Some(path), &pairs)?;
            if code == 0 {
                Ok(return_success_code.then_some(code))
            } else {
                Err(Error::CommandFailed {
                    command: shell,
                    code,
                })
            }
        }
        ActionKind::Tmux(direction) => {
            logger.log(&format!(
                "\nOpening worktree '{name}' in tmux {}...",
                if direction == TmuxDirection::New {
                    "window"
                } else {
                    "pane"
                }
            ));
            let env = phantom_env(name, path);
            let window = (direction == TmuxDirection::New).then_some(name);
            tmux::open_shell(direction, path, &env, window)?;
            Ok(None)
        }
    }
}

fn command_failure(code: &i32) -> Error {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
    Error::CommandFailed {
        command: shell,
        code: *code,
    }
}

pub fn open_shell(git_root: &Path, name: &str) -> Result<i32> {
    let worktree = find_worktree(git_root, name, false, None)?;
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
    let path = PathBuf::from(&worktree.path);
    let env = phantom_env(name, &path);
    let pairs = env
        .iter()
        .map(|(key, value)| (key.as_str(), value.as_str()))
        .collect::<Vec<_>>();
    process::inherit(&shell, &[], Some(&path), &pairs)
}

pub fn phantom_env(name: &str, path: &Path) -> Vec<(String, String)> {
    vec![
        ("PHANTOM".to_string(), "1".to_string()),
        ("PHANTOM_NAME".to_string(), name.to_string()),
        ("PHANTOM_PATH".to_string(), path.display().to_string()),
    ]
}

fn run_hook_commands(
    git_root: &Path,
    worktrees_directory: &Path,
    name: &str,
    commands: &[String],
    post: bool,
    logger: &Logger,
) -> Result<()> {
    for command in commands {
        if post {
            logger.log(&format!("Executing: {command}"));
        } else {
            println!("Executing pre-delete command: {command}");
        }
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
        let code = match exec_in_worktree(
            git_root,
            worktrees_directory,
            name,
            &shell,
            &["-c", command],
            &[],
        ) {
            Ok(code) => code,
            Err(error) => {
                let label = if post { "post-create" } else { "pre-delete" };
                return Err(Error::msg(format!(
                    "Failed to execute {label} command \"{command}\": {error}"
                )));
            }
        };
        if code != 0 {
            let label = if post { "Post-create" } else { "Pre-delete" };
            return Err(Error::msg(format!(
                "{label} command failed with exit code {code}: {command}"
            )));
        }
    }
    Ok(())
}

fn merge_files(configured: &[String], requested: &[String]) -> Vec<String> {
    let mut files = Vec::new();
    for file in configured.iter().chain(requested.iter()) {
        if !files.contains(file) {
            files.push(file.clone());
        }
    }
    files
}

fn copy_files_into(source_root: &Path, target_root: &Path, patterns: &[String]) -> Result<()> {
    for file in resolve_patterns(source_root, patterns)? {
        let source = source_root.join(&file);
        let target = target_root.join(&file);
        match fs::metadata(&source) {
            Ok(metadata) if metadata.is_file() => {
                if let Some(parent) = target.parent() {
                    fs::create_dir_all(parent)
                        .map_err(|error| Error::msg(format!("Failed to copy {file}: {error}")))?;
                }
                fs::copy(&source, &target)
                    .map_err(|error| Error::msg(format!("Failed to copy {file}: {error}")))?;
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(Error::msg(format!("Failed to copy {file}: {error}"))),
        }
    }
    Ok(())
}

fn resolve_patterns(source_root: &Path, patterns: &[String]) -> Result<Vec<String>> {
    let mut files = Vec::new();
    for pattern in patterns {
        let normalized = pattern.replace('\\', "/");
        for alternative in expand_braces(&normalized) {
            if !has_magic(&alternative) {
                if !files.contains(&alternative) {
                    files.push(alternative);
                }
                continue;
            }
            collect_pattern(source_root, &alternative, &mut files)?;
        }
    }
    Ok(files)
}

fn collect_pattern(root: &Path, pattern: &str, files: &mut Vec<String>) -> Result<()> {
    let segments = pattern
        .split('/')
        .filter(|segment| !segment.is_empty())
        .collect::<Vec<_>>();
    let prefix_len = segments
        .iter()
        .position(|segment| *segment == "**" || segment_has_magic(segment))
        .unwrap_or(segments.len());
    let start = root.join(segments[..prefix_len].join("/"));
    let rest = &segments[prefix_len..];
    if rest.is_empty() {
        return Ok(());
    }
    let max_dir_depth = if rest.contains(&"**") {
        None
    } else {
        Some(rest.len().saturating_sub(1))
    };
    walk_matching(root, &start, 0, max_dir_depth, pattern, files)
}

fn walk_matching(
    root: &Path,
    dir: &Path,
    depth: usize,
    max_dir_depth: Option<usize>,
    pattern: &str,
    files: &mut Vec<String>,
) -> Result<()> {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        // A literal prefix can name a file, or pass through a file. That is no match.
        Err(error)
            if error.kind() == std::io::ErrorKind::NotFound
                || error.kind() == std::io::ErrorKind::NotADirectory =>
        {
            return Ok(());
        }
        Err(error) => return Err(Error::msg(format!("Failed to resolve pattern: {error}"))),
    };
    for entry in entries {
        let entry =
            entry.map_err(|error| Error::msg(format!("Failed to resolve pattern: {error}")))?;
        let path = entry.path();
        let relative = match path.strip_prefix(root) {
            Ok(relative) => relative.to_string_lossy().replace('\\', "/"),
            Err(_) => continue,
        };
        if relative.split('/').any(|segment| segment == ".git") {
            continue;
        }
        let file_type = match entry.file_type() {
            Ok(file_type) => file_type,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(Error::msg(format!("Failed to resolve pattern: {error}"))),
        };
        // file_type does not follow symlinks, so a directory link is not a directory.
        if file_type.is_dir() {
            let descend = match max_dir_depth {
                Some(limit) => depth < limit,
                None => true,
            };
            if descend {
                walk_matching(root, &path, depth + 1, max_dir_depth, pattern, files)?;
            }
            continue;
        }
        if copyable_file(&path) && glob_matches(pattern, &relative) && !files.contains(&relative) {
            files.push(relative);
        }
    }
    Ok(())
}

fn copyable_file(path: &Path) -> bool {
    match fs::metadata(path) {
        Ok(metadata) => metadata.is_file(),
        Err(_) => false,
    }
}

fn segment_has_magic(segment: &str) -> bool {
    segment
        .chars()
        .any(|char| matches!(char, '*' | '?' | '[' | '{'))
}

fn has_magic(pattern: &str) -> bool {
    pattern
        .chars()
        .any(|char| matches!(char, '*' | '?' | '[' | '{'))
}

fn expand_braces(pattern: &str) -> Vec<String> {
    let chars = pattern.chars().collect::<Vec<_>>();
    let Some(open) = chars.iter().position(|char| *char == '{') else {
        return vec![pattern.to_string()];
    };
    let Some(close) = matching_brace(&chars, open) else {
        return vec![pattern.to_string()];
    };
    let prefix = chars[..open].iter().collect::<String>();
    let body = chars[open + 1..close].iter().collect::<String>();
    let suffix = chars[close + 1..].iter().collect::<String>();
    let mut expanded = Vec::new();
    for alternative in split_brace_alternatives(&body) {
        for alternative in expand_braces(&alternative) {
            for suffix in expand_braces(&suffix) {
                expanded.push(format!("{prefix}{alternative}{suffix}"));
            }
        }
    }
    if expanded.is_empty() {
        vec![pattern.to_string()]
    } else {
        expanded
    }
}

fn matching_brace(chars: &[char], open: usize) -> Option<usize> {
    let mut depth = 0;
    for (index, char) in chars.iter().enumerate().skip(open) {
        if *char == '{' {
            depth += 1;
        } else if *char == '}' {
            depth -= 1;
            if depth == 0 {
                return Some(index);
            }
        }
    }
    None
}

fn split_brace_alternatives(body: &str) -> Vec<String> {
    let mut alternatives = Vec::new();
    let mut current = String::new();
    let mut depth = 0_i32;
    for char in body.chars() {
        match char {
            '{' => {
                depth += 1;
                current.push(char);
            }
            '}' => {
                depth = depth.saturating_sub(1);
                current.push(char);
            }
            ',' if depth == 0 => {
                alternatives.push(std::mem::take(&mut current));
            }
            _ => current.push(char),
        }
    }
    alternatives.push(current);
    alternatives
}

fn glob_matches(pattern: &str, path: &str) -> bool {
    let pattern_segments = pattern.split('/').collect::<Vec<_>>();
    let path_segments = path
        .split('/')
        .filter(|segment| !segment.is_empty())
        .collect::<Vec<_>>();
    match_segments(&pattern_segments, &path_segments)
}

fn match_segments(pattern: &[&str], path: &[&str]) -> bool {
    let Some(head) = pattern.first() else {
        return path.is_empty();
    };
    if *head == "**" {
        if match_segments(&pattern[1..], path) {
            return true;
        }
        return !path.is_empty() && match_segments(pattern, &path[1..]);
    }
    let Some(segment) = path.first() else {
        return false;
    };
    segment_matches(head, segment) && match_segments(&pattern[1..], &path[1..])
}

fn segment_matches(pattern: &str, text: &str) -> bool {
    match_atom(pattern.as_bytes(), text.as_bytes())
}

fn match_atom(pattern: &[u8], text: &[u8]) -> bool {
    if pattern.is_empty() {
        return text.is_empty();
    }
    match pattern[0] {
        b'*' => {
            if match_atom(&pattern[1..], text) {
                return true;
            }
            !text.is_empty() && match_atom(pattern, &text[1..])
        }
        b'?' => !text.is_empty() && match_atom(&pattern[1..], &text[1..]),
        b'[' => {
            let Some(end) = pattern.iter().skip(1).position(|byte| *byte == b']') else {
                return !text.is_empty()
                    && pattern[0] == text[0]
                    && match_atom(&pattern[1..], &text[1..]);
            };
            let class = &pattern[1..end + 1];
            let rest = &pattern[end + 2..];
            if text.is_empty() {
                return false;
            }
            class_matches(class, text[0]) && match_atom(rest, &text[1..])
        }
        byte => !text.is_empty() && byte == text[0] && match_atom(&pattern[1..], &text[1..]),
    }
}

fn class_matches(class: &[u8], byte: u8) -> bool {
    if class.is_empty() {
        return false;
    }
    let (negated, class) = if class[0] == b'!' || class[0] == b'^' {
        (true, &class[1..])
    } else {
        (false, class)
    };
    let mut matched = false;
    let mut index = 0;
    while index < class.len() {
        if index + 2 < class.len() && class[index + 1] == b'-' {
            let start = class[index];
            let end = class[index + 2];
            if byte >= start && byte <= end {
                matched = true;
                break;
            }
            index += 3;
        } else {
            if class[index] == byte {
                matched = true;
                break;
            }
            index += 1;
        }
    }
    matched != negated
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_invalid_names() {
        assert!(validate_worktree_name("").is_err());
        assert!(validate_worktree_name("feature/test").is_ok());
        assert!(validate_worktree_name("has space").is_err());
        assert!(validate_worktree_name("bad..name").is_err());
    }

    #[test]
    fn matches_v6_copy_globs() {
        let root = std::env::temp_dir().join(format!(
            "phantom-glob-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        fs::create_dir_all(root.join("config/db")).expect("dirs");
        fs::create_dir_all(root.join("nested/deep")).expect("nested");
        fs::write(root.join(".env"), "a").expect("env");
        fs::write(root.join("local.env"), "b").expect("local");
        fs::write(root.join("config.json"), "c").expect("json");
        fs::write(root.join("readme.md"), "d").expect("md");
        fs::write(root.join("config/db/database.local.yml"), "e").expect("yml");
        fs::create_dir_all(root.join(".git")).expect("gitdir");
        fs::write(root.join("nested/deep/file.txt"), "f").expect("txt");
        fs::write(root.join(".git/config"), "g").expect("git");

        let braces = resolve_patterns(&root, &["*.{env,json}".to_string()]).expect("braces");
        assert!(braces.contains(&"local.env".to_string()));
        assert!(braces.contains(&"config.json".to_string()));
        assert!(!braces.contains(&"readme.md".to_string()));

        let dot = resolve_patterns(&root, &["*.env".to_string()]).expect("dot");
        assert!(dot.contains(&".env".to_string()));

        let recursive =
            resolve_patterns(&root, &["config/**/*.local.yml".to_string()]).expect("recursive");
        assert_eq!(recursive, vec!["config/db/database.local.yml".to_string()]);

        let directory = resolve_patterns(&root, &["nested/**".to_string()]).expect("dir");
        assert_eq!(directory, vec!["nested/deep/file.txt".to_string()]);

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn copy_globs_skip_directory_symlinks_and_unrelated_trees() {
        let root = std::env::temp_dir().join(format!(
            "phantom-glob-link-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        let outside = std::env::temp_dir().join(format!(
            "phantom-glob-outside-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        fs::create_dir_all(root.join("keep")).expect("keep");
        fs::create_dir_all(root.join("nested")).expect("nested");
        fs::create_dir_all(root.join("deep/a")).expect("deep");
        fs::create_dir_all(&outside).expect("outside");
        fs::write(root.join(".env"), "a").expect("env");
        fs::write(root.join("real.env"), "b").expect("real");
        fs::write(root.join("nested/.env"), "c").expect("nested env");
        fs::write(root.join("keep/note.txt"), "d").expect("note");
        fs::write(root.join("deep/a/file.txt"), "e").expect("deep file");
        fs::write(outside.join("secret.txt"), "no").expect("secret");
        std::os::unix::fs::symlink(&root, root.join("cycle")).expect("cycle");
        std::os::unix::fs::symlink(root.join("nested"), root.join("nested/again")).expect("again");
        std::os::unix::fs::symlink(&outside, root.join("outside")).expect("outside link");
        std::os::unix::fs::symlink(root.join("real.env"), root.join("link.env"))
            .expect("file link");

        let all = resolve_patterns(&root, &["**".to_string()]).expect("all");
        assert!(all.contains(&".env".to_string()));
        assert!(all.contains(&"keep/note.txt".to_string()));
        assert!(all.contains(&"link.env".to_string()));
        assert!(!all.iter().any(|path| path.contains("secret")));
        assert!(!all.iter().any(|path| path.starts_with("outside/")));
        assert!(!all.iter().any(|path| path.starts_with("cycle/")));
        assert!(!all.iter().any(|path| path.starts_with("nested/again/")));

        let root_env = resolve_patterns(&root, &["*.env".to_string()]).expect("root env");
        assert!(root_env.contains(&".env".to_string()));
        assert!(root_env.contains(&"link.env".to_string()));
        assert!(!root_env.iter().any(|path| path.contains('/')));

        let prefixed = resolve_patterns(&root, &["keep/*.txt".to_string()]).expect("prefix");
        assert_eq!(prefixed, vec!["keep/note.txt".to_string()]);

        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&outside);
    }

    #[test]
    fn glob_prefix_that_is_a_file_matches_nothing() {
        let root = std::env::temp_dir().join(format!(
            "phantom-glob-file-prefix-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        fs::create_dir_all(&root).expect("root");
        fs::write(root.join("config"), "not a directory").expect("file");
        fs::write(root.join("other.json"), "{}").expect("json");

        let files = resolve_patterns(&root, &["config/*.json".to_string()]).expect("prefix file");
        assert!(files.is_empty());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn glob_intermediate_component_that_is_a_file_matches_nothing() {
        let root = std::env::temp_dir().join(format!(
            "phantom-glob-file-mid-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        fs::create_dir_all(&root).expect("root");
        fs::write(root.join("config"), "not a directory").expect("file");

        let files =
            resolve_patterns(&root, &["config/local/*.json".to_string()]).expect("mid file");
        assert!(files.is_empty());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn rejects_conflicting_actions() {
        let error = resolve_action(&ActionRequest {
            shell: true,
            exec: Some("true".to_string()),
            tmux: None,
        })
        .expect_err("conflict");
        assert!(matches!(error, Error::ActionConflict));
    }
}
