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

/// Canonical common dir used by trust and the default worktree directory.
///
/// `canonicalize` resolves symlinks. When the directory does not exist yet,
/// the absolute `git rev-parse --git-common-dir` path is the key.
pub fn canonical_common_dir(cwd: &Path) -> Result<PathBuf> {
    let common = git_common_dir(cwd)?;
    match std::fs::canonicalize(&common) {
        Ok(path) => Ok(normalize(&path)),
        Err(_) => Ok(common),
    }
}

/// Resolve parent aliases without losing the identity of the registered checkout.
pub(crate) fn checkout_registration_path(checkout: &Path) -> PathBuf {
    let checkout = normalize(checkout);
    match (checkout.parent(), checkout.file_name()) {
        (Some(parent), Some(name)) => {
            let parent = if parent.as_os_str().is_empty() {
                Path::new(".")
            } else {
                parent
            };
            crate::paths::canonical_location(parent).join(name)
        }
        _ => checkout,
    }
}

/// Find the admin directory from Git's registration, without trusting the
/// checkout's `.git` entry, which may point at a different worktree.
pub(crate) fn registered_git_dir(repo: &Path, checkout: &Path) -> Result<PathBuf> {
    let checkout = checkout_registration_path(checkout);
    if checkout_registration_path(repo) == checkout {
        return Ok(PathBuf::from(output(
            &["rev-parse", "--absolute-git-dir"],
            Some(repo),
            true,
        )?));
    }
    let inspect_error = |error| Error::msg(format!("Failed to inspect Git registration: {error}"));
    let entries =
        std::fs::read_dir(git_common_dir(repo)?.join("worktrees")).map_err(inspect_error)?;
    for entry in entries {
        let admin = entry.map_err(inspect_error)?.path();
        if !admin.is_dir() {
            continue;
        }
        let Ok(backlink) = std::fs::read_to_string(admin.join("gitdir")) else {
            continue;
        };
        let backlink = backlink.strip_suffix('\n').unwrap_or(&backlink);
        let backlink = admin.join(backlink);
        if backlink.file_name().is_some_and(|name| name == ".git")
            && backlink
                .parent()
                .is_some_and(|path| checkout_registration_path(path) == checkout)
        {
            return Ok(admin);
        }
    }
    Err(Error::msg(
        "No Git admin directory is registered for this workspace",
    ))
}

/// Check the checkout's actual admin directory against Git's independent registration.
pub(crate) fn matches_registered_git_dir(repo: &Path, checkout: &Path) -> Result<bool> {
    let actual = output(&["rev-parse", "--absolute-git-dir"], Some(checkout), true)?;
    let registered = registered_git_dir(repo, checkout)?;
    Ok(crate::paths::same_location(Path::new(&actual), &registered))
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

/// A linked worktree whose checkout sits inside the common dir has a gitfile
/// between `cwd` and that dir. `.git` itself and `.git/refs` do not.
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
/// current directory. `.mabo.toml` and `.worktreeinclude` are read from here,
/// and hooks receive this path as `MABO_ROOT_PATH`.
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

/// Check an observed full ref without hiding Git read failures.
pub(crate) fn reference_exists(root: &Path, reference: &str) -> Result<bool> {
    let result = raw_git(root, &["for-each-ref", "--format=%(refname)", reference])?;
    if result.code != 0 {
        return Err(Error::msg(format!(
            "Failed to read Git refs: {}",
            result.stderr.trim()
        )));
    }
    Ok(result.stdout.lines().any(|line| line == reference))
}

pub enum WorktreeAdd<'a> {
    Detach {
        base: &'a str,
    },
    Existing {
        branch: &'a str,
    },
    New {
        branch: &'a str,
        base: &'a str,
    },
    /// `start_point` is `refs/remotes/<remote>/<branch>`.
    ///
    /// A short name such as `origin/solo` is ambiguous when a local branch
    /// has that name. The full ref still sets upstream when `--track` is set.
    Track {
        branch: &'a str,
        start_point: &'a str,
    },
}

pub fn add_worktree(git_root: &Path, path: &Path, add: WorktreeAdd<'_>) -> Result<()> {
    let path = path.to_string_lossy();
    let args: Vec<&str> = match add {
        WorktreeAdd::Detach { base } => vec!["worktree", "add", "--detach", path.as_ref(), base],
        WorktreeAdd::Existing { branch } => vec!["worktree", "add", path.as_ref(), branch],
        WorktreeAdd::New { branch, base } => {
            vec![
                "worktree",
                "add",
                "--no-track",
                path.as_ref(),
                "-b",
                branch,
                base,
            ]
        }
        WorktreeAdd::Track {
            branch,
            start_point,
        } => vec![
            "worktree",
            "add",
            path.as_ref(),
            "-b",
            branch,
            "--track",
            start_point,
        ],
    };
    run(&args, Some(git_root)).map_err(|error| Error::msg(format!("worktree add failed: {error}")))
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

pub(crate) fn default_branch(git_root: &Path) -> Result<Option<String>> {
    let symbolic = raw_git(
        git_root,
        &[
            "symbolic-ref",
            "--quiet",
            "--short",
            "refs/remotes/origin/HEAD",
        ],
    )?;
    if symbolic.code == 0 {
        let name = symbolic.stdout.trim();
        if !name.is_empty() && verify_commit(git_root, name)? {
            return Ok(Some(name.to_string()));
        }
    }
    if verify_commit(git_root, "refs/heads/main")? {
        return Ok(Some("main".to_string()));
    }
    if verify_commit(git_root, "refs/heads/master")? {
        return Ok(Some("master".to_string()));
    }
    Ok(None)
}

pub(crate) struct TipReachability {
    /// The upstream ref is gone, the tip differs from the merge base, and a
    /// clean merge into the default branch leaves that branch's tree unchanged.
    pub landed: bool,
}

pub(crate) fn tip_reachability(
    git_root: &Path,
    branch: Option<&str>,
    head: Option<&str>,
    base: &Option<String>,
) -> TipReachability {
    let Some(base) = base.as_deref() else {
        return TipReachability { landed: false };
    };
    // A bare name prefers `refs/tags` over `refs/heads`, so a tag with the
    // branch's name hides the branch tip and those commits look pushed.
    let Some(tip) = branch_tip_spec(branch, head) else {
        return TipReachability { landed: false };
    };
    let Some(unpushed) = commits_outside_base_and_remotes(git_root, &tip, base) else {
        return TipReachability { landed: false };
    };
    if !unpushed {
        return TipReachability { landed: false };
    }
    let landed = branch.is_some_and(|name| {
        upstream_missing(git_root, name) && changes_landed(git_root, &tip, base)
    });
    TipReachability { landed }
}

/// Retirement uses the selected base and the branch's own upstream only.
/// Unlike sync's publication check, an unrelated remote is not preservation.
pub(crate) fn retirement_integrated(root: &Path, tip: &str, base: &str) -> bool {
    let Some(base) = retirement_destination(root, tip, base) else {
        return false;
    };
    if raw_git(root, &["merge-base", "--is-ancestor", tip, &base])
        .is_ok_and(|result| result.code == 0)
    {
        return true;
    }
    retirement_changes_landed(root, tip, &base)
}

// Evidence must survive deleting the checkout and its branch. Object IDs and
// detached/pseudo refs prove reachability now, but do not provide a retained ref.
// Require the resolved ref to live in the common Git directory, so removing a
// linked checkout cannot remove it. Custom fetch namespaces are valid too.
fn retirement_destination(root: &Path, tip: &str, destination: &str) -> Option<String> {
    fn shared_ref(root: &Path, spec: &str) -> Option<String> {
        let full = raw_git(
            root,
            &["rev-parse", "--symbolic-full-name", "--verify", spec],
        )
        .ok()?;
        if full.code != 0 || full.stdout.lines().count() != 1 {
            return None;
        }
        let full = full.stdout.trim();
        let symbolic = raw_git(root, &["symbolic-ref", "--quiet", full]).ok()?;
        let reference = match symbolic.code {
            0 => symbolic.stdout.trim(),
            1 => full,
            _ => return None,
        };
        if !reference.starts_with("refs/") {
            return None;
        }
        let location = raw_git(root, &["rev-parse", "--git-path", reference]).ok()?;
        if location.code != 0 || location.stdout.lines().count() != 1 {
            return None;
        }
        let common = git_common_dir(root).ok()?;
        (normalize(&root.join(location.stdout.trim())) == normalize(&common.join(reference)))
            .then(|| reference.to_owned())
    }
    let destination = shared_ref(root, destination)?;
    if tip.starts_with("refs/") && shared_ref(root, tip)? == destination {
        return None;
    }
    Some(destination)
}

pub(crate) fn retirement_preserved(
    root: &Path,
    branch: Option<&str>,
    head: Option<&str>,
    base: Option<&str>,
) -> bool {
    let Some(tip) = branch_tip_spec(branch, head) else {
        return false;
    };
    if base.is_some_and(|base| retirement_integrated(root, &tip, base)) {
        return true;
    }
    let Some(branch) = branch else {
        return false;
    };
    let reference = format!("refs/heads/{branch}");
    let Ok(refs) = raw_git(
        root,
        &[
            "for-each-ref",
            "--format=%(refname)%00%(upstream)",
            &reference,
        ],
    ) else {
        return false;
    };
    let Some(upstream) = refs
        .stdout
        .lines()
        .filter_map(|line| line.split_once('\0'))
        .find_map(|(name, upstream)| {
            (name == reference && !upstream.is_empty()).then_some(upstream)
        })
    else {
        return false;
    };
    let Some(upstream) = retirement_destination(root, &tip, upstream) else {
        return false;
    };
    let resolve = |spec: &str| {
        raw_git(root, &["rev-parse", "--verify", "--quiet", spec])
            .ok()
            .filter(|result| result.code == 0)
            .map(|result| result.stdout.trim().to_string())
    };
    match (resolve(&tip), resolve(&upstream)) {
        (Some(tip), Some(upstream)) => tip == upstream,
        _ => false,
    }
}

// Prove preservation through exact tree-entry transitions, never textual patches.
// Each transition includes the path, modes and full before/after object IDs, so
// repeated contexts, whitespace, binary data and gitlinks cannot compare equal
// unless the complete entries match. Checking base history also recognizes work
// that landed before later base edits. All commands are read-only: merge-tree
// --write-tree can refresh existing object mtimes, even with an alternate store.
fn retirement_changes_landed(root: &Path, tip: &str, base: &str) -> bool {
    let Ok(ancestor) = raw_git(root, &["merge-base", "--all", base, tip]) else {
        return false;
    };
    if ancestor.code != 0 || ancestor.stdout.split_whitespace().count() != 1 {
        return false;
    }
    let ancestor = ancestor.stdout.trim();
    let Some(delta) = retirement_tree_delta(root, ancestor, tip) else {
        return false;
    };
    if delta.is_empty() {
        return false;
    }
    let Some(landed) = retirement_history_trees(root, &format!("{ancestor}..{base}"), false) else {
        return false;
    };
    // A complete squash must preserve every changed entry in one base commit.
    if landed.contains(&delta) {
        return true;
    }
    // Rebased history must preserve every commit's complete tree transition.
    // Merges outside the base require the complete-squash proof above: checking
    // just their non-merge ancestors would omit unique conflict resolutions.
    retirement_history_trees(root, &format!("{base}..{tip}"), true).is_some_and(|commits| {
        !commits.is_empty()
            && commits
                .iter()
                .all(|delta| !delta.is_empty() && landed.contains(delta))
    })
}

fn retirement_history_trees(
    root: &Path,
    range: &str,
    require_linear: bool,
) -> Option<Vec<Vec<u8>>> {
    let history = raw_git(root, &["rev-list", "--parents", range]).ok()?;
    if history.code != 0 {
        return None;
    }
    let mut deltas = Vec::new();
    for line in history.stdout.lines() {
        let mut ids = line.split_whitespace();
        let commit = ids.next()?;
        let parent = ids.next()?;
        if ids.next().is_some() {
            if require_linear {
                // Do not omit any workspace merge's conflict resolution.
                return None;
            }
            // A base merge need not be a candidate; its ordinary ancestors
            // can still independently prove preservation.
            continue;
        }
        deltas.push(retirement_tree_delta(root, parent, commit)?);
    }
    Some(deltas)
}

fn retirement_tree_delta(root: &Path, before: &str, after: &str) -> Option<Vec<u8>> {
    let diff = raw_git_bytes(
        root,
        &[
            "diff-tree",
            "-r",
            "--raw",
            "-z",
            "--no-commit-id",
            "--no-abbrev",
            "--no-ext-diff",
            "--no-textconv",
            "--no-color",
            "--no-renames",
            "--no-relative",
            "--ignore-submodules=none",
            "--submodule=short",
            "-O/dev/null",
            before,
            after,
            "--",
        ],
    )
    .ok()?;
    diff.status.success().then_some(diff.stdout)
}

/// Count all content a checkout removal would lose, including ignored files.
pub(crate) fn retirement_status_count(cwd: &Path) -> Result<usize> {
    let stdout = output(
        &[
            "--no-optional-locks",
            "status",
            "--porcelain",
            "-z",
            "--ignored",
            "--untracked-files=all",
        ],
        Some(cwd),
        false,
    )?;
    Ok(stdout.split('\0').filter(|entry| !entry.is_empty()).count())
}

fn branch_tip_spec(branch: Option<&str>, head: Option<&str>) -> Option<String> {
    match branch {
        Some(name) => Some(format!("refs/heads/{name}")),
        None => head
            .filter(|sha| sha.bytes().any(|byte| byte != b'0'))
            .map(ToOwned::to_owned),
    }
}

fn commits_outside_base_and_remotes(git_root: &Path, tip: &str, base: &str) -> Option<bool> {
    // `--not` stays in effect for `--remotes`, so those commits are excluded.
    // A second `--not` would include them again. The trailing `--` keeps a
    // branch name that matches a worktree directory from being read as a path.
    let captured = raw_git(
        git_root,
        &["rev-list", "--count", tip, "--not", base, "--remotes", "--"],
    )
    .ok()?;
    if captured.code != 0 {
        return None;
    }
    let count = captured.stdout.trim().parse::<u64>().ok()?;
    Some(count > 0)
}

fn upstream_missing(git_root: &Path, branch: &str) -> bool {
    let spec = format!("refs/heads/{branch}@{{upstream}}");
    match raw_git(git_root, &["rev-parse", "--verify", "--quiet", &spec]) {
        Ok(captured) => captured.code != 0 || captured.stdout.trim().is_empty(),
        Err(_) => false,
    }
}

pub(crate) fn changes_landed(git_root: &Path, tip: &str, base: &str) -> bool {
    let Ok(merge_base) = raw_git(git_root, &["merge-base", base, tip]) else {
        return false;
    };
    if merge_base.code != 0 {
        return false;
    }
    let merge_base = merge_base.stdout.trim();
    if merge_base.is_empty() {
        return false;
    }
    // An empty diff merges cleanly into every tree. Those commits are still
    // absent from the default branch, so only a non-empty diff can count.
    let Ok(diff) = raw_git(git_root, &["diff", "--quiet", merge_base, tip]) else {
        return false;
    };
    if diff.code != 1 {
        return false;
    }
    let Ok(merged) = raw_git(git_root, &["merge-tree", "--write-tree", base, tip]) else {
        return false;
    };
    if merged.code != 0 {
        return false;
    }
    let Some(tree) = merged
        .stdout
        .lines()
        .next()
        .map(str::trim)
        .filter(|line| !line.is_empty())
    else {
        return false;
    };
    let spec = format!("{base}^{{tree}}");
    let Ok(base_tree) = raw_git(git_root, &["rev-parse", "--verify", "--quiet", &spec]) else {
        return false;
    };
    base_tree.code == 0 && base_tree.stdout.trim() == tree
}

fn verify_commit(git_root: &Path, name: &str) -> Result<bool> {
    let spec = format!("{name}^{{commit}}");
    let captured = raw_git(git_root, &["rev-parse", "--verify", "--quiet", &spec])?;
    Ok(captured.code == 0)
}

fn raw_git_bytes(root: &Path, args: &[&str]) -> Result<std::process::Output> {
    process::raw_bytes("git", args, Some(root), &[], None)
}

pub(crate) fn raw_git(git_root: &Path, args: &[&str]) -> Result<process::Captured> {
    process::raw("git", args, Some(git_root))
}

pub(crate) fn raw_git_with_env(
    git_root: &Path,
    args: &[&str],
    env: &[(&str, &str)],
) -> Result<process::Captured> {
    process::raw_with_env("git", args, Some(git_root), env)
}

pub fn status_count(cwd: &Path) -> Result<usize> {
    let stdout = output(
        &["--no-optional-locks", "status", "--porcelain"],
        Some(cwd),
        false,
    )?;
    Ok(stdout.lines().filter(|line| !line.is_empty()).count())
}

pub fn is_clean(cwd: &Path) -> bool {
    status_count(cwd).map(|count| count == 0).unwrap_or(true)
}

pub fn list_worktrees(git_root: &Path) -> Result<Vec<GitWorktree>> {
    let stdout = output(
        &["worktree", "list", "--porcelain", "-z"],
        Some(git_root),
        false,
    )?;
    Ok(parse_worktrees(&stdout))
}

pub fn fetch(cwd: &Path, remote: &str, refspec: &str) -> Result<()> {
    run(&["fetch", remote, refspec], Some(cwd))
        .map_err(|error| Error::msg(format!("git fetch failed: {error}")))
}

/// True when `origin` advertises `refs/heads/<branch>` exactly.
pub fn remote_has_branch(git_root: &Path, remote: &str, branch: &str) -> Result<bool> {
    let captured = raw_git(git_root, &["ls-remote", "--heads", remote, branch])
        .map_err(|error| Error::msg(format!("git ls-remote failed: {error}")))?;
    if captured.code != 0 {
        let detail = first_output(&captured);
        return Err(Error::msg(format!("git ls-remote failed: {detail}")));
    }
    let wanted = format!("refs/heads/{branch}");
    Ok(captured.stdout.lines().any(|line| {
        line.split(['\t', ' '])
            .nth(1)
            .is_some_and(|name| name == wanted)
    }))
}

/// Create `name` at `start`, or fast-forward it there.
pub fn ensure_branch(git_root: &Path, name: &str, start: &str) -> Result<()> {
    if !branch_exists(git_root, name)? {
        return run(&["branch", name, start], Some(git_root))
            .map_err(|error| Error::msg(format!("Failed to create branch {name}: {error}")));
    }
    let branch_ref = format!("refs/heads/{name}");
    let ancestor = raw_git(
        git_root,
        &["merge-base", "--is-ancestor", &branch_ref, start],
    )?;
    if ancestor.code != 0 {
        return Err(Error::msg(format!(
            "Local branch {name} has commits that are not in {start}"
        )));
    }
    let current = raw_git(git_root, &["rev-parse", &branch_ref])?;
    let target = raw_git(git_root, &["rev-parse", start])?;
    if current.code != 0 || target.code != 0 {
        return Err(Error::msg(format!(
            "Failed to resolve branch {name} or {start}"
        )));
    }
    if current.stdout.trim() == target.stdout.trim() {
        return Ok(());
    }
    run(&["branch", "-f", name, start], Some(git_root))
        .map_err(|error| Error::msg(format!("Failed to update branch {name}: {error}")))
}

/// Configure tracking even when the remote's fetch refspec excludes this branch.
pub fn set_branch_tracking(
    git_root: &Path,
    branch: &str,
    remote: &str,
    head_ref: &str,
) -> Result<()> {
    run(
        &["config", &format!("branch.{branch}.remote"), remote],
        Some(git_root),
    )?;
    run(
        &[
            "config",
            &format!("branch.{branch}.merge"),
            &format!("refs/heads/{head_ref}"),
        ],
        Some(git_root),
    )
}

/// Drop `branch.<name>.remote` and `branch.<name>.merge` when they are set.
pub fn clear_branch_upstream(git_root: &Path, branch: &str) {
    let _ = run(&["branch", "--unset-upstream", branch], Some(git_root));
    for suffix in ["remote", "merge"] {
        let key = format!("branch.{branch}.{suffix}");
        let _ = raw_git(git_root, &["config", "--unset", &key]);
    }
}

fn first_output(captured: &process::Captured) -> String {
    let stderr = captured.stderr.trim();
    if !stderr.is_empty() {
        stderr.to_string()
    } else {
        captured.stdout.trim().to_string()
    }
}

pub fn parse_worktrees(stdout: &str) -> Vec<GitWorktree> {
    let mut worktrees = Vec::new();
    let mut current: Option<GitWorktree> = None;
    let fields: Box<dyn Iterator<Item = &str> + '_> = if stdout.contains('\0') {
        Box::new(stdout.split('\0'))
    } else {
        Box::new(stdout.lines())
    };
    for line in fields.filter(|line| !line.is_empty()) {
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
    fn review11_registration_scan_still_refuses_an_unregistered_checkout() {
        let root =
            std::env::temp_dir().join(format!("mabo-git-registration-{}", uuid::Uuid::new_v4()));
        let repo = root.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        run(&["init", "--template=", "-b", "main"], Some(&repo)).unwrap();
        crate::test_git::configure_repo(&repo);
        let registrations = git_common_dir(&repo).unwrap().join("worktrees");
        std::fs::create_dir_all(registrations.join("broken")).unwrap();
        std::fs::write(registrations.join("pending.lock"), "").unwrap();
        std::fs::create_dir_all(registrations.join("unreadable/gitdir")).unwrap();
        let other_admin = registrations.join("other");
        std::fs::create_dir(&other_admin).unwrap();
        std::fs::write(
            other_admin.join("gitdir"),
            format!("{}\n", root.join("other/.git").display()),
        )
        .unwrap();
        let checkout = root.join("unregistered");
        std::fs::create_dir(&checkout).unwrap();
        // A checkout's own gitfile cannot substitute for a matching backlink.
        std::fs::write(
            checkout.join(".git"),
            format!("gitdir: {}\n", other_admin.display()),
        )
        .unwrap();
        let error = registered_git_dir(&repo, &checkout).unwrap_err();
        assert_eq!(
            error.to_string(),
            "No Git admin directory is registered for this workspace"
        );
        assert_eq!(error.exit_code(), crate::error::GENERAL);
        std::fs::remove_dir_all(root).unwrap();
    }

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

worktree /repo/.git/maboroshi/worktrees/feature
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
