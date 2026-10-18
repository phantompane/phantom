use std::fs;
use std::io::Write;
use std::path::{Component, Path, PathBuf};

use ignore::gitignore::{Gitignore, GitignoreBuilder};

use crate::config;
use crate::context::{self, Context};
use crate::error::{Error, Result};
use crate::git::{self, GitWorktree};
use crate::names;
use crate::paths;
use crate::process;

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
    Exec(String),
}

pub struct ActionRequest {
    pub exec: Option<String>,
}

pub struct Logger {
    pub enabled: bool,
}

impl Logger {
    pub fn on() -> Self {
        Self { enabled: true }
    }

    fn log(&self, message: &str) {
        if self.enabled {
            println!("{message}");
        }
    }

    fn warn(&self, message: &str) {
        if self.enabled {
            let _ = std::io::stdout().flush();
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
    let context = context::create(git_root)?;
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
        infos.push(info_from_git(&worktree, &cwd, &context));
    }
    Ok(infos)
}

fn info_from_git(worktree: &GitWorktree, cwd: &Path, context: &Context) -> WorktreeInfo {
    let short_head = worktree
        .head
        .as_deref()
        .map(|head| head.chars().take(7).collect::<String>())
        .unwrap_or_else(|| "HEAD".to_string());
    let branch = match worktree.branch.as_deref() {
        Some(branch) if branch != "(detached HEAD)" => branch.to_string(),
        _ => "(detached HEAD)".to_string(),
    };
    let path = PathBuf::from(&worktree.path);
    let directory_name = directory_name(&path, &context.worktrees_directory);
    let name = directory_name.unwrap_or_else(|| {
        if branch == "(detached HEAD)" {
            short_head
        } else {
            branch.clone()
        }
    });
    let relative = paths::relative(cwd, &path);
    WorktreeInfo {
        name,
        path: worktree.path.clone(),
        path_to_display: if relative.is_empty() {
            ".".to_string()
        } else {
            relative
        },
        branch,
        is_clean: git::is_clean(&path),
    }
}

fn directory_name(path: &Path, worktrees_directory: &Path) -> Option<String> {
    if !paths::is_strictly_inside(path, worktrees_directory) {
        return None;
    }
    let relative = paths::relative(worktrees_directory, path);
    if relative.is_empty() {
        None
    } else {
        Some(relative)
    }
}

fn same_worktree(worktree: &WorktreeInfo, name: &str) -> bool {
    worktree.name == name || (worktree.branch != "(detached HEAD)" && worktree.branch == name)
}

fn select_worktree(worktrees: Vec<WorktreeInfo>, name: &str) -> Result<WorktreeInfo> {
    let directories = worktrees
        .iter()
        .filter(|worktree| worktree.name == name)
        .cloned()
        .collect::<Vec<_>>();
    match directories.as_slice() {
        [found] => return Ok(found.clone()),
        [] => {}
        _ => {
            return Err(Error::msg(format!(
                "More than one worktree is named '{name}'."
            )));
        }
    }
    let branches = worktrees
        .into_iter()
        .filter(|worktree| worktree.branch != "(detached HEAD)" && worktree.branch == name)
        .collect::<Vec<_>>();
    match branches.as_slice() {
        [found] => Ok(found.clone()),
        [] => Err(Error::WorktreeNotFound(name.to_string())),
        _ => Err(Error::msg(format!(
            "Branch '{name}' matches more than one worktree. Use the worktree directory name."
        ))),
    }
}

pub fn find_worktree(
    git_root: &Path,
    name: &str,
    exclude_default: bool,
    expected_path: Option<&Path>,
) -> Result<WorktreeInfo> {
    let worktrees = list_worktrees(git_root, exclude_default, true)?
        .into_iter()
        .filter(|worktree| expected_path.is_none_or(|path| Path::new(&worktree.path) == path))
        .collect();
    select_worktree(worktrees, name)
}

pub fn ensure_absent(git_root: &Path, name: &str) -> Result<()> {
    if list_worktrees(git_root, false, true)?
        .iter()
        .any(|worktree| same_worktree(worktree, name))
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
    let commands = config::post_create_commands(context.config.as_ref());
    let created = create_worktree(
        &context,
        &name,
        request.base.unwrap_or("HEAD"),
        request.copy_files,
        commands,
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
    let hook_code = created.hook_failure.as_ref().map(|failure| {
        request.logger.warn(&failure.warning(&created.path));
        failure.code
    });
    let action_code = run_action(&name, &created.path, action, &request.logger, true)?;
    Ok(CreateOutcome {
        name,
        path: created.path,
        exit_code: combine_exit(action_code, hook_code),
    })
}

pub struct CreatedWorktree {
    pub path: PathBuf,
    pub copy_error: Option<String>,
    pub hook_failure: Option<HookFailure>,
}

pub struct AttachedWorktree {
    pub path: PathBuf,
    pub hook_failure: Option<HookFailure>,
}

pub struct AttachOutcome {
    pub path: PathBuf,
    pub exit_code: Option<i32>,
}

#[derive(Debug, Clone)]
pub struct HookFailure {
    pub command: String,
    pub code: i32,
}

impl HookFailure {
    pub fn warning(&self, path: &Path) -> String {
        format!(
            "Warning: Post-create command failed with exit code {}: {}\nThe worktree was created at {}",
            self.code, self.command, path.display()
        )
    }
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
    let copy_error = copy_included_files(&context.source_checkout, &path, copy_files)
        .err()
        .map(|error| error.to_string());
    let hook_failure = if commands.is_empty() {
        None
    } else {
        logger.log("\nRunning post-create commands...");
        run_hook_commands(
            &context.git_root,
            &context.worktrees_directory,
            name,
            commands,
            true,
            logger,
            &context.source_checkout,
        )?
    };
    Ok(CreatedWorktree {
        path,
        copy_error,
        hook_failure,
    })
}

pub struct AttachRequest<'a> {
    pub name: &'a str,
    pub copy_files: &'a [String],
    pub action: ActionRequest,
    pub logger: Logger,
}

pub fn run_attach(request: AttachRequest<'_>) -> Result<AttachOutcome> {
    let action = resolve_action(&request.action)?;
    let cwd = std::env::current_dir().map_err(|error| Error::msg(error.to_string()))?;
    let git_root = git::git_root(&cwd)?;
    let context = context::create(&git_root)?;
    let commands = config::post_create_commands(context.config.as_ref());
    let attached = attach_worktree(
        &context,
        request.name,
        request.copy_files,
        commands,
        &request.logger,
    )?;
    request
        .logger
        .log(&format!("Attached phantom: {}", request.name));
    let hook_code = attached.hook_failure.as_ref().map(|failure| {
        request.logger.warn(&failure.warning(&attached.path));
        failure.code
    });
    let action_code = run_action(request.name, &attached.path, action, &request.logger, false)?;
    Ok(AttachOutcome {
        path: attached.path,
        exit_code: combine_exit(action_code, hook_code),
    })
}

pub fn attach_worktree(
    context: &Context,
    name: &str,
    copy_files: &[String],
    commands: &[String],
    logger: &Logger,
) -> Result<AttachedWorktree> {
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
    if let Err(error) = copy_included_files(&context.source_checkout, &path, copy_files) {
        logger.warn(&format!("Warning: Failed to copy some files: {error}"));
    }
    let hook_failure = if commands.is_empty() {
        None
    } else {
        logger.log("\nRunning post-create commands...");
        run_hook_commands(
            &context.git_root,
            &context.worktrees_directory,
            name,
            commands,
            true,
            logger,
            &context.source_checkout,
        )?
    };
    Ok(AttachedWorktree { path, hook_failure })
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
    let commands = config::pre_delete_commands(context.config.as_ref());
    if !commands.is_empty() {
        println!("\nRunning pre-delete commands...");
        let _ = run_hook_commands(
            &context.git_root,
            &context.worktrees_directory,
            name,
            commands,
            false,
            &Logger::on(),
            &context.source_checkout,
        )?;
    }
    git::remove_worktree(&context.git_root, &path, force)?;
    let cleanup_warning = remove_empty_parents(&path, &context.worktrees_directory);
    let message = if worktree.branch == "(detached HEAD)" {
        format!("Deleted worktree '{name}'")
    } else if keep_branch {
        format!(
            "Deleted worktree '{name}' and kept its branch '{}'",
            worktree.branch
        )
    } else {
        match git::delete_branch(&context.git_root, &worktree.branch) {
            Ok(()) => format!(
                "Deleted worktree '{name}' and its branch '{}'",
                worktree.branch
            ),
            Err(error) => format!(
                "Deleted worktree '{name}'\nNote: Branch '{}' could not be deleted: {error}",
                worktree.branch
            ),
        }
    };
    let message = if changed > 0 {
        format!("Warning: Worktree '{name}' had uncommitted changes ({changed} files)\n{message}")
    } else {
        message
    };
    let message = if let Some(warning) = cleanup_warning {
        format!("{message}\nWarning: {warning}")
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
    if paths::normalize(&top) == paths::normalize(git_root) {
        return Ok(None);
    }
    let top = paths::normalize(&top);
    Ok(list_worktrees(git_root, true, true)?
        .into_iter()
        .find_map(|worktree| {
            (paths::normalize(Path::new(&worktree.path)) == top).then_some(worktree.name)
        }))
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

pub fn resolve_action(request: &ActionRequest) -> Result<Option<ActionKind>> {
    let mut actions = Vec::new();
    if let Some(command) = &request.exec {
        actions.push(ActionKind::Exec(command.clone()));
    }
    Ok(actions.into_iter().next())
}

fn run_action(
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
    }
}

pub fn phantom_env(name: &str, path: &Path) -> Vec<(String, String)> {
    vec![
        ("PHANTOM".to_string(), "1".to_string()),
        ("PHANTOM_NAME".to_string(), name.to_string()),
        ("PHANTOM_PATH".to_string(), path.display().to_string()),
    ]
}

fn combine_exit(action: Option<i32>, hook: Option<i32>) -> Option<i32> {
    match (action, hook) {
        (Some(code), _) if code != 0 => Some(code),
        (_, Some(code)) => Some(code),
        (action, None) => action,
    }
}

fn run_hook_commands(
    git_root: &Path,
    worktrees_directory: &Path,
    name: &str,
    commands: &[String],
    post: bool,
    logger: &Logger,
    source_checkout: &Path,
) -> Result<Option<HookFailure>> {
    let root_path = source_checkout.display().to_string();
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
            &[("PTM_ROOT_PATH", root_path.as_str())],
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
            if post {
                return Ok(Some(HookFailure {
                    command: command.clone(),
                    code,
                }));
            }
            return Err(Error::msg(format!(
                "Pre-delete command failed with exit code {code}: {command}"
            )));
        }
    }
    Ok(None)
}

fn remove_empty_parents(path: &Path, root: &Path) -> Option<String> {
    let mut current = path.parent().map(Path::to_path_buf);
    while let Some(dir) = current {
        if !paths::is_strictly_inside(&dir, root) {
            break;
        }
        match fs::remove_dir(&dir) {
            Ok(()) => current = dir.parent().map(Path::to_path_buf),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => break,
            Err(error) if error.kind() == std::io::ErrorKind::DirectoryNotEmpty => break,
            Err(error) => {
                return Some(format!(
                    "Failed to remove empty directory {}: {error}",
                    dir.display()
                ));
            }
        }
    }
    None
}

/// Copy gitignored files matched by `.worktreeinclude` and extra gitignore patterns.
///
/// Existing files are left in place. Symlinks are skipped and are not followed.
fn copy_included_files(source: &Path, target: &Path, extra: &[String]) -> Result<()> {
    let Some(matcher) = include_matcher(source, extra)? else {
        return Ok(());
    };
    for listed in gitignored_paths(source)? {
        let Some(relative) = normal_relative(&listed) else {
            continue;
        };
        if !matcher
            .matched_path_or_any_parents(relative, false)
            .is_ignore()
        {
            continue;
        }
        copy_one(source, target, relative)?;
    }
    Ok(())
}

fn include_matcher(source: &Path, extra: &[String]) -> Result<Option<Gitignore>> {
    let include_path = source.join(".worktreeinclude");
    let has_file = match fs::symlink_metadata(&include_path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            return Err(Error::msg(
                "Failed to read .worktreeinclude: refusing to follow a symlink",
            ));
        }
        Ok(metadata) if metadata.is_file() => true,
        Ok(_) => {
            return Err(Error::msg(
                "Failed to read .worktreeinclude: expected a file",
            ));
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(error) => {
            return Err(Error::msg(format!(
                "Failed to read .worktreeinclude: {error}"
            )));
        }
    };
    if !has_file && extra.is_empty() {
        return Ok(None);
    }
    let mut builder = GitignoreBuilder::new(source);
    if has_file {
        if let Some(error) = builder.add(&include_path) {
            return Err(Error::msg(format!(
                "Failed to read .worktreeinclude: {error}"
            )));
        }
    }
    for pattern in extra {
        let pattern = pattern.replace('\\', "/");
        builder
            .add_line(Some(include_path.clone()), &pattern)
            .map_err(|error| Error::msg(format!("Invalid copy pattern '{pattern}': {error}")))?;
    }
    builder.build().map(Some).map_err(|error| {
        if has_file {
            Error::msg(format!("Failed to read .worktreeinclude: {error}"))
        } else {
            Error::msg(format!("Invalid copy pattern: {error}"))
        }
    })
}

fn gitignored_paths(source: &Path) -> Result<Vec<String>> {
    let stdout = git::output(
        &[
            "ls-files",
            "--others",
            "--ignored",
            "--exclude-standard",
            "-z",
        ],
        Some(source),
        false,
    )
    .map_err(|error| Error::msg(format!("Failed to list gitignored files: {error}")))?;
    Ok(stdout
        .split('\0')
        .filter(|path| !path.is_empty())
        .map(ToOwned::to_owned)
        .collect())
}

fn normal_relative(path: &str) -> Option<&Path> {
    let path = Path::new(path);
    if path.as_os_str().is_empty() || path.is_absolute() {
        return None;
    }
    path.components()
        .all(|component| matches!(component, Component::Normal(_)))
        .then_some(path)
}

fn copy_one(source_root: &Path, target_root: &Path, relative: &Path) -> Result<()> {
    let source = source_root.join(relative);
    let metadata = match fs::symlink_metadata(&source) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(copy_error(relative, error)),
    };
    // Skip symlinks instead of following them out of the repository.
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Ok(());
    }
    let target = target_root.join(relative);
    match fs::symlink_metadata(&target) {
        Ok(_) => return Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(copy_error(relative, error)),
    }
    ensure_real_parents(target_root, relative)?;
    fs::copy(&source, &target).map_err(|error| copy_error(relative, error))?;
    Ok(())
}

fn ensure_real_parents(root: &Path, relative: &Path) -> Result<()> {
    let Some(parent) = relative
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    else {
        return Ok(());
    };
    let mut current = root.to_path_buf();
    for component in parent.components() {
        current.push(component);
        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(Error::msg(format!(
                    "Failed to copy {}: refusing to follow a symlink",
                    relative.display()
                )));
            }
            Ok(metadata) if metadata.is_dir() => {}
            Ok(_) => {
                return Err(Error::msg(format!(
                    "Failed to copy {}: parent is not a directory",
                    relative.display()
                )));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                if let Err(error) = fs::create_dir(&current) {
                    if error.kind() != std::io::ErrorKind::AlreadyExists {
                        return Err(copy_error(relative, error));
                    }
                }
            }
            Err(error) => return Err(copy_error(relative, error)),
        }
    }
    Ok(())
}

fn copy_error(relative: &Path, error: impl std::fmt::Display) -> Error {
    Error::msg(format!("Failed to copy {}: {error}", relative.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(name: &str, branch: &str) -> WorktreeInfo {
        WorktreeInfo {
            name: name.to_string(),
            path: format!("/worktrees/{name}"),
            path_to_display: name.to_string(),
            branch: branch.to_string(),
            is_clean: true,
        }
    }

    #[test]
    fn directory_name_beats_a_branch_and_ambiguous_branches_error() {
        let preferred = select_worktree(
            vec![sample("a", "topic"), sample("topic", "other")],
            "topic",
        )
        .expect("directory");
        assert_eq!(preferred.name, "topic");
        assert_eq!(preferred.branch, "other");

        let fallback = select_worktree(vec![sample("a", "topic")], "topic").expect("branch");
        assert_eq!(fallback.name, "a");

        let error = select_worktree(vec![sample("a", "topic"), sample("b", "topic")], "topic")
            .expect_err("ambiguous");
        assert!(error.to_string().contains("more than one"));
        assert!(matches!(
            select_worktree(vec![sample("a", "other")], "topic"),
            Err(Error::WorktreeNotFound(_))
        ));
    }

    #[test]
    fn rejects_invalid_names() {
        assert!(validate_worktree_name("").is_err());
        assert!(validate_worktree_name("feature/test").is_ok());
        assert!(validate_worktree_name("has space").is_err());
        assert!(validate_worktree_name("bad..name").is_err());
    }

    #[test]
    fn copies_only_matching_gitignored_files() {
        let repo = CopyRepo::new();
        fs::write(repo.root.join("tracked.env"), "committed\n").expect("tracked");
        repo.git(&["add", "tracked.env"]);
        repo.git(&["commit", "-m", "track env"]);
        fs::write(repo.root.join(".gitignore"), "*.env\n*.log\nvendor/\n").expect("gitignore");
        fs::write(
            repo.root.join(".worktreeinclude"),
            "*.env\nnested/**\n!nested/skip.env\nvendor/\n!vendor/skip.json\n",
        )
        .expect("include");
        fs::create_dir_all(repo.root.join("nested/deep")).expect("nested");
        fs::create_dir_all(repo.root.join("vendor")).expect("vendor");
        fs::write(repo.root.join("secret.env"), "secret\n").expect("secret");
        fs::write(repo.root.join("nested/deep/inner.env"), "inner\n").expect("inner");
        fs::write(repo.root.join("nested/skip.env"), "skip\n").expect("skip");
        fs::write(repo.root.join("nested/deep/note.txt"), "note\n").expect("note");
        fs::write(repo.root.join("notes.log"), "log\n").expect("log");
        fs::write(repo.root.join("vendor/config.json"), "config\n").expect("config");
        fs::write(repo.root.join("vendor/skip.json"), "skipped\n").expect("vendor skip");
        fs::write(repo.root.join("tracked.env"), "dirty\n").expect("dirty");

        let target = repo.root.join("target-copy");
        fs::create_dir_all(target.join("vendor")).expect("target vendor");
        fs::write(target.join("secret.env"), "already\n").expect("existing");
        copy_included_files(&repo.root, &target, &["notes.log".to_string()]).expect("copy");

        assert_eq!(read(&target.join("secret.env")), "already\n");
        assert_eq!(read(&target.join("nested/deep/inner.env")), "inner\n");
        assert_eq!(read(&target.join("vendor/config.json")), "config\n");
        assert_eq!(read(&target.join("notes.log")), "log\n");
        assert!(!target.join("nested/skip.env").exists());
        assert!(!target.join("nested/deep/note.txt").exists());
        assert!(!target.join("vendor/skip.json").exists());
        assert!(!target.join("tracked.env").exists());
        assert!(!target.join("README.md").exists());
    }

    #[test]
    fn skips_symlinks_instead_of_following_them() {
        let repo = CopyRepo::new();
        let outside = repo.root.join("outside-tree");
        fs::create_dir_all(&outside).expect("outside");
        fs::write(outside.join("secret.env"), "nope\n").expect("outside secret");
        fs::write(repo.root.join("real.env"), "real\n").expect("real");
        std::os::unix::fs::symlink(repo.root.join("real.env"), repo.root.join("link.env"))
            .expect("file link");
        std::os::unix::fs::symlink(&outside, repo.root.join("outside")).expect("dir link");
        fs::write(repo.root.join(".gitignore"), "*.env\noutside\n").expect("gitignore");
        fs::write(repo.root.join(".worktreeinclude"), "*\n").expect("include");

        let target = repo.root.join("target-copy");
        fs::create_dir_all(&target).expect("target");
        copy_included_files(&repo.root, &target, &[]).expect("copy");

        assert_eq!(read(&target.join("real.env")), "real\n");
        assert!(!target.join("link.env").exists());
        assert!(!target.join("outside").exists());
        assert!(!target.join("secret.env").exists());
        assert!(!target.join("outside/secret.env").exists());
    }

    #[test]
    fn symlinked_worktreeinclude_is_not_followed() {
        let repo = CopyRepo::new();
        let elsewhere = repo.root.join("elsewhere");
        fs::create_dir_all(&elsewhere).expect("elsewhere");
        fs::write(elsewhere.join("include"), "*.env\n").expect("include");
        std::os::unix::fs::symlink(
            elsewhere.join("include"),
            repo.root.join(".worktreeinclude"),
        )
        .expect("symlink include");
        fs::write(repo.root.join(".gitignore"), "*.env\n").expect("gitignore");
        fs::write(repo.root.join("secret.env"), "secret\n").expect("secret");
        let target = repo.root.join("target-copy");
        fs::create_dir_all(&target).expect("target");

        let error = copy_included_files(&repo.root, &target, &[]).expect_err("symlink include");
        assert!(error.to_string().contains("symlink"), "{error}");
        assert!(!target.join("secret.env").exists());
    }

    struct CopyRepo {
        root: PathBuf,
    }

    impl CopyRepo {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "phantom-include-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .expect("clock")
                    .as_nanos()
            ));
            fs::create_dir_all(root.join(".home")).expect("home");
            fs::create_dir_all(root.join(".template")).expect("template");
            let repo = Self { root };
            repo.git(&["init", "-b", "main"]);
            repo.git(&["config", "user.email", "phantom@example.com"]);
            repo.git(&["config", "user.name", "Phantom"]);
            fs::write(repo.root.join(".git-exclude"), "").expect("exclude");
            repo.git(&[
                "config",
                "core.excludesFile",
                repo.root
                    .join(".git-exclude")
                    .to_str()
                    .expect("exclude path"),
            ]);
            fs::write(repo.root.join("README.md"), "readme\n").expect("readme");
            repo.git(&["add", "README.md"]);
            repo.git(&["commit", "-m", "init"]);
            repo
        }

        fn git(&self, args: &[&str]) {
            let output = std::process::Command::new("git")
                .args(args)
                .current_dir(&self.root)
                .env("GIT_CONFIG_NOSYSTEM", "1")
                .env("HOME", self.root.join(".home"))
                .env("GIT_TEMPLATE_DIR", self.root.join(".template"))
                .output()
                .expect("git");
            assert!(
                output.status.success(),
                "git {} failed: {}",
                args.join(" "),
                String::from_utf8_lossy(&output.stderr)
            );
        }
    }

    impl Drop for CopyRepo {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    fn read(path: &Path) -> String {
        fs::read_to_string(path).unwrap_or_else(|error| panic!("read {}: {error}", path.display()))
    }
}
