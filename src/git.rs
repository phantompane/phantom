use std::collections::VecDeque;
use std::path::{Path, PathBuf};

use crate::error::{Error, Result};
use crate::process;

#[derive(Debug, Clone)]
pub struct GitWorktree {
    pub path: String,
    pub branch: Option<String>,
    pub head: Option<String>,
    pub locked: bool,
    pub prunable: bool,
}

pub fn output(args: &[&str], cwd: Option<&Path>, trim_stdout: bool) -> Result<String> {
    match process::capture("git", args, cwd, trim_stdout) {
        Ok(captured) => Ok(captured.stdout),
        Err(error) => Err(repository_error(error)),
    }
}

pub fn run(args: &[&str], cwd: Option<&Path>) -> Result<()> {
    process::capture("git", args, cwd, true)
        .map(|_| ())
        .map_err(repository_error)
}

fn repository_error(error: Error) -> Error {
    if error
        .to_string()
        .to_ascii_lowercase()
        .contains("not a git repository")
    {
        Error::NotARepository
    } else {
        error
    }
}

fn git_common_dir_text(cwd: &Path) -> Result<String> {
    output(&["rev-parse", "--git-common-dir"], Some(cwd), true)
}

/// Absolute path from `git rev-parse --git-common-dir`.
///
/// Linked worktrees and `git init --separate-git-dir` share this directory.
pub fn git_common_dir(cwd: &Path) -> Result<PathBuf> {
    Ok(normalize(&cwd.join(git_common_dir_text(cwd)?)))
}

pub fn git_root(cwd: &Path) -> Result<PathBuf> {
    let common = git_common_dir_text(cwd)?;
    let common_dir = normalize(&cwd.join(&common));
    if common_dir.file_name().is_some_and(|name| name == ".git") {
        let cwd = normalize(cwd);
        if (cwd == common_dir || crate::paths::is_strictly_inside(&cwd, &common_dir))
            && !linked_worktree_under(&cwd, &common_dir)
        {
            let bare = output(&["rev-parse", "--is-bare-repository"], Some(&cwd), true)?;
            if bare == "true" {
                return Ok(common_dir);
            }
            return Err(Error::msg(format!(
                "This command must be run from a work tree. {} is inside the Git directory {}.",
                cwd.display(),
                common_dir.display()
            )));
        }
    }
    if common.ends_with("/.git") || common == ".git" {
        let parent = Path::new(&common)
            .parent()
            .map(|path| path.to_path_buf())
            .unwrap_or_else(|| PathBuf::from("."));
        return Ok(normalize(&cwd.join(parent)));
    }
    checkout_for_common_dir(cwd, &common_dir)
}

/// Main checkout for a common dir that is not `<checkout>/.git`.
///
/// The current directory's toplevel wins when its gitfile already points at
/// `common`. That is the checkout the command is running in. From a linked
/// worktree, where that gitfile points at `worktrees/<id>` instead, use
/// `core.worktree` and then the bounded gitfile search. One match is the
/// checkout. Several matches, or none, are an error. A bare repository's
/// root is `common`.
fn checkout_for_common_dir(cwd: &Path, common: &Path) -> Result<PathBuf> {
    if let Some(checkout) = checkout_containing_cwd(cwd, common) {
        return Ok(checkout);
    }
    if let Some(checkout) = configured_worktree(common) {
        if gitfile_points_at(&checkout, common) {
            return Ok(checkout);
        }
        return Err(Error::msg(format!(
            "core.worktree is set to {}, which has no .git gitfile pointing at {}.",
            checkout.display(),
            common.display()
        )));
    }
    let mut matches = gitfiles_for_common_dir(common);
    if matches.len() == 1 {
        return Ok(matches.swap_remove(0));
    }
    if matches.is_empty() {
        let bare = output(&["rev-parse", "--is-bare-repository"], Some(common), true)?;
        if bare == "true" {
            return Ok(common.to_path_buf());
        }
        return Err(Error::msg(format!(
            "No checkout points at git dir {}. Set the main checkout with `git config core.worktree <checkout>`.",
            common.display()
        )));
    }
    let listed = matches
        .iter()
        .map(|path| path.display().to_string())
        .collect::<Vec<_>>()
        .join(", ");
    Err(Error::msg(format!(
        "More than one checkout points at git dir {}: {listed}. Set the main checkout with `git config core.worktree <checkout>`.",
        common.display()
    )))
}

/// A linked worktree stored under `<repo>/.git/ptm/worktrees` has a gitfile
/// between `cwd` and the common dir. `.git` itself and `.git/refs` do not.
fn linked_worktree_under(cwd: &Path, common_dir: &Path) -> bool {
    if cwd == common_dir {
        return false;
    }
    let mut current = cwd.to_path_buf();
    while current != *common_dir {
        if current.join(".git").is_file() {
            return true;
        }
        if !current.pop() {
            return false;
        }
    }
    false
}

/// Toplevel of `cwd` when its `.git` gitfile points at `common`.
///
/// This is not a search. The command is already inside that checkout, including
/// when another directory has a gitfile for the same common dir.
fn checkout_containing_cwd(cwd: &Path, common: &Path) -> Option<PathBuf> {
    let top = top_level(cwd).ok()?;
    gitfile_points_at(&top, common).then(|| normalize(&top))
}

fn configured_worktree(common: &Path) -> Option<PathBuf> {
    let config = common.join("config");
    let config = config.to_str()?;
    let value = output(
        &["config", "--file", config, "--get", "core.worktree"],
        Some(common),
        true,
    )
    .ok()?;
    if value.is_empty() {
        return None;
    }
    let path = PathBuf::from(value);
    let resolved = if path.is_absolute() {
        path
    } else {
        common.join(path)
    };
    Some(normalize(&resolved))
}

const CHECKOUT_SEARCH_ANCESTORS: usize = 8;
const CHECKOUT_SEARCH_DEPTH: usize = 4;
const CHECKOUT_SEARCH_DIRS: u32 = 256;

/// Gitfiles under the closest ancestor that has at least one.
///
/// The walk stops at that ancestor, so copies beside each other are reported
/// together. It visits at most [`CHECKOUT_SEARCH_DIRS`] directories and does
/// not refuse to enter a wide directory.
fn gitfiles_for_common_dir(common: &Path) -> Vec<PathBuf> {
    let Some(mut ancestor) = common.parent().map(Path::to_path_buf) else {
        return Vec::new();
    };
    let mut visited = 0u32;
    for _ in 0..CHECKOUT_SEARCH_ANCESTORS {
        if ancestor.file_name().is_some_and(|name| name == ".git") {
            let Some(parent) = ancestor.parent().map(Path::to_path_buf) else {
                break;
            };
            ancestor = parent;
            continue;
        }
        let mut found = Vec::new();
        search_gitfiles(&ancestor, common, &mut visited, &mut found);
        if !found.is_empty() {
            found.sort();
            found.dedup();
            return found;
        }
        if visited >= CHECKOUT_SEARCH_DIRS {
            break;
        }
        let Some(parent) = ancestor.parent().map(Path::to_path_buf) else {
            break;
        };
        if parent == ancestor {
            break;
        }
        ancestor = parent;
    }
    Vec::new()
}

fn search_gitfiles(start: &Path, common: &Path, visited: &mut u32, found: &mut Vec<PathBuf>) {
    let mut pending = VecDeque::new();
    pending.push_back((start.to_path_buf(), 0usize));
    while let Some((dir, depth)) = pending.pop_front() {
        if *visited >= CHECKOUT_SEARCH_DIRS {
            return;
        }
        *visited += 1;
        if gitfile_points_at(&dir, common) {
            found.push(normalize(&dir));
        }
        if depth == CHECKOUT_SEARCH_DEPTH {
            continue;
        }
        for child in checkout_child_dirs(&dir, common) {
            pending.push_back((child, depth + 1));
        }
    }
}

fn checkout_child_dirs(dir: &Path, common: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut children = Vec::new();
    for entry in entries.flatten() {
        if !entry.file_type().is_ok_and(|kind| kind.is_dir()) {
            continue;
        }
        let path = entry.path();
        if path.file_name().is_some_and(|name| name == ".git") {
            continue;
        }
        if normalize(&path) == normalize(common) {
            continue;
        }
        children.push(path);
    }
    children.sort();
    children
}

fn gitfile_points_at(dir: &Path, common: &Path) -> bool {
    let gitfile = dir.join(".git");
    if !gitfile.is_file() {
        return false;
    }
    let Ok(text) = std::fs::read_to_string(&gitfile) else {
        return false;
    };
    let Some(raw) = text.trim().strip_prefix("gitdir:") else {
        return false;
    };
    let raw = raw.trim();
    if raw.is_empty() {
        return false;
    }
    let target = Path::new(raw);
    let resolved = if target.is_absolute() {
        target.to_path_buf()
    } else {
        dir.join(target)
    };
    same_path(&resolved, common)
}

fn same_path(left: &Path, right: &Path) -> bool {
    match (std::fs::canonicalize(left), std::fs::canonicalize(right)) {
        (Ok(left), Ok(right)) => left == right,
        _ => normalize(left) == normalize(right),
    }
}

pub fn current_branch(cwd: &Path) -> Result<String> {
    output(&["branch", "--show-current"], Some(cwd), true)
}

pub fn top_level(cwd: &Path) -> Result<PathBuf> {
    Ok(PathBuf::from(output(
        &["rev-parse", "--show-toplevel"],
        Some(cwd),
        true,
    )?))
}

/// Checkout the command is running in: `git rev-parse --show-toplevel` of the
/// current directory. `.ptm.toml` and `.worktreeinclude` are read from here,
/// and hooks receive this path as `PTM_ROOT_PATH`.
pub fn source_checkout(fallback: &Path) -> PathBuf {
    let Ok(cwd) = std::env::current_dir() else {
        return fallback.to_path_buf();
    };
    top_level(&cwd).unwrap_or_else(|_| fallback.to_path_buf())
}

/// HEAD of `worktree`, when it is a real commit.
pub fn head_commit(worktree: &Path) -> Option<String> {
    verified_commit(worktree, "HEAD")
}

/// Oldest `refs/heads` reflog entry for the branch checked out at `worktree`.
///
/// `None` when that reflog is missing or empty. HEAD is not a substitute.
/// An existing branch can already have moved, and storing its tip would hide
/// a merged branch from gc.
pub fn reflog_creation_commit(worktree: &Path) -> Option<String> {
    let branch = output(
        &["symbolic-ref", "--quiet", "--short", "HEAD"],
        Some(worktree),
        true,
    )
    .ok()?;
    let branch = branch.trim();
    if branch.is_empty() {
        return None;
    }
    let spec = format!("refs/heads/{branch}");
    let reflog = output(
        &["reflog", "show", "--format=%H", &spec],
        Some(worktree),
        true,
    )
    .ok()?;
    reflog
        .lines()
        .next_back()
        .map(str::trim)
        .filter(|sha| is_commit_sha(sha))
        .map(ToOwned::to_owned)
}

fn verified_commit(cwd: &Path, spec: &str) -> Option<String> {
    let text = output(&["rev-parse", "--verify", "--quiet", spec], Some(cwd), true).ok()?;
    let sha = text.trim();
    if !is_commit_sha(sha) {
        return None;
    }
    Some(sha.to_string())
}

fn is_commit_sha(sha: &str) -> bool {
    sha.len() >= 4
        && sha.bytes().all(|byte| byte.is_ascii_hexdigit())
        && sha.bytes().any(|byte| byte != b'0')
}

pub fn branch_exists(git_root: &Path, name: &str) -> Result<bool> {
    let stdout = output(&["branch", "--list", name], Some(git_root), true)
        .map_err(|error| Error::msg(format!("Failed to check branch existence: {error}")))?;
    Ok(!stdout.trim().is_empty())
}

pub fn add_worktree(
    git_root: &Path,
    path: &Path,
    branch: &str,
    base: &str,
    create_branch: bool,
) -> Result<()> {
    let path = path.to_string_lossy();
    if create_branch {
        run(
            &["worktree", "add", path.as_ref(), "-b", branch, base],
            Some(git_root),
        )
    } else {
        run(&["worktree", "add", path.as_ref(), branch], Some(git_root))
    }
    .map_err(|error| Error::msg(format!("worktree add failed: {error}")))
}

pub fn remove_worktree(git_root: &Path, path: &Path, force: bool) -> Result<()> {
    let path = path.to_string_lossy();
    let result = if force {
        run(
            &["worktree", "remove", "--force", path.as_ref()],
            Some(git_root),
        )
    } else {
        run(&["worktree", "remove", path.as_ref()], Some(git_root))
    };
    result.map_err(|error| Error::msg(format!("worktree remove failed: {error}")))
}

pub fn delete_branch(git_root: &Path, branch: &str) -> Result<()> {
    run(&["branch", "-D", branch], Some(git_root))
        .map_err(|error| Error::msg(format!("branch delete failed: {error}")))
}

pub fn status_count(cwd: &Path) -> Result<usize> {
    let stdout = output(&["status", "--porcelain"], Some(cwd), false)?;
    Ok(stdout.lines().filter(|line| !line.is_empty()).count())
}

pub fn is_clean(cwd: &Path) -> bool {
    status_count(cwd).map(|count| count == 0).unwrap_or(true)
}

pub fn list_worktrees(git_root: &Path) -> Result<Vec<GitWorktree>> {
    let stdout = output(&["worktree", "list", "--porcelain"], Some(git_root), true)?;
    Ok(parse_worktrees(&stdout))
}

pub fn fetch(cwd: &Path, remote: &str, refspec: &str) -> Result<()> {
    run(&["fetch", remote, refspec], Some(cwd))
        .map_err(|error| Error::msg(format!("git fetch failed: {error}")))
}

pub fn set_upstream(git_root: &Path, branch: &str, upstream: &str) -> Result<()> {
    run(
        &["branch", "--set-upstream-to", upstream, branch],
        Some(git_root),
    )
}

pub fn parse_worktrees(stdout: &str) -> Vec<GitWorktree> {
    let mut worktrees = Vec::new();
    let mut current: Option<GitWorktree> = None;
    for line in stdout.lines().filter(|line| !line.is_empty()) {
        if let Some(path) = line.strip_prefix("worktree ") {
            if let Some(worktree) = current.take() {
                worktrees.push(worktree);
            }
            current = Some(GitWorktree {
                path: path.to_string(),
                branch: None,
                head: None,
                locked: false,
                prunable: false,
            });
        } else if let Some(worktree) = current.as_mut() {
            if let Some(head) = line.strip_prefix("HEAD ") {
                worktree.head = Some(head.to_string());
            } else if let Some(branch) = line.strip_prefix("branch ") {
                worktree.branch = Some(
                    branch
                        .strip_prefix("refs/heads/")
                        .unwrap_or(branch)
                        .to_string(),
                );
            } else if line == "detached" {
                worktree.branch = Some("(detached HEAD)".to_string());
            } else if line.starts_with("locked") {
                worktree.locked = true;
            } else if line.starts_with("prunable") {
                worktree.prunable = true;
            }
        }
    }
    if let Some(worktree) = current {
        worktrees.push(worktree);
    }
    worktrees
}

fn normalize(path: &Path) -> PathBuf {
    crate::paths::normalize(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rewrites_missing_repository_errors() {
        let error = repository_error(Error::msg(
            "fatal: not a git repository (or any of the parent directories): .git",
        ));
        assert!(matches!(error, Error::NotARepository));
        assert_eq!(error.exit_code(), crate::error::NOT_REPOSITORY);
        assert!(!error.to_string().to_ascii_lowercase().contains("fatal:"));
        let other = repository_error(Error::msg("fatal: not something else"));
        assert!(matches!(other, Error::Message(_)));
    }

    #[test]
    fn parses_porcelain() {
        let text = "\
worktree /repo
HEAD abcdef1234567890
branch refs/heads/main

worktree /repo/.git/ptm/worktrees/feature
HEAD 1234567890abcdef
branch refs/heads/feature/name
prunable
";
        let worktrees = parse_worktrees(text);
        assert_eq!(worktrees.len(), 2);
        assert_eq!(worktrees[0].branch.as_deref(), Some("main"));
        assert_eq!(worktrees[1].branch.as_deref(), Some("feature/name"));
        assert!(worktrees[1].prunable);
    }
}
