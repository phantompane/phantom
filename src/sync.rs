//! Fetch and integrate bases without changing published history or upstreams.
use std::collections::{BTreeSet, HashSet};
use std::path::Path;

use serde::Serialize;

use crate::context::Context;
use crate::error::{Error, Result};
use crate::{git, metadata, paths, worktree};

#[derive(Default)]
pub struct Request {
    pub names: Vec<String>,
    pub all: bool,
    pub mine: bool,
    pub no_default: bool,
    pub rebase: bool,
    pub merge: bool,
    pub force: bool,
    pub keep_conflicts: bool,
    pub agent: Option<String>,
}

#[derive(Serialize)]
pub struct Item {
    pub name: String,
    pub path: Option<String>,
    pub branch: Option<String>,
    pub base: Option<String>,
    pub status: String,
    pub strategy: Option<String>,
    pub before: Option<String>,
    pub after: Option<String>,
    pub conflicts: Vec<String>,
    pub detail: Option<String>,
    pub code: Option<String>,
}

impl Item {
    fn status(&mut self, status: &str, detail: Option<String>) {
        self.status = status.to_string();
        self.detail = detail.map(|value| short_detail(&value));
    }
}

#[derive(Serialize)]
pub struct Report {
    pub schema: u32,
    pub default: Option<Item>,
    pub worktrees: Vec<Item>,
    #[serde(skip)]
    pub exit: i32,
}

pub fn normalize_base(root: &Path, reference: &str) -> Result<String> {
    if reference.starts_with('-') || reference.is_empty() {
        return Err(Error::validation("Base must be an existing ref"));
    }
    let full = git::output(
        &["rev-parse", "--symbolic-full-name", "--verify", reference],
        Some(root),
        true,
    )?;
    if full.is_empty() || full == "HEAD" {
        return git::output(
            &["rev-parse", "--verify", &format!("{reference}^{{commit}}")],
            Some(root),
            true,
        );
    }
    if !full.starts_with("refs/") || full.lines().count() != 1 {
        return Err(Error::validation(format!(
            "Base '{reference}' must name an existing ref"
        )));
    }
    git::output(
        &["rev-parse", "--verify", &format!("{full}^{{commit}}")],
        Some(root),
        true,
    )?;
    Ok(full)
}

pub fn creation_base(root: &Path, explicit: Option<&str>) -> Result<String> {
    match explicit {
        Some(base) => normalize_base(root, base),
        None => fallback_base(root).or_else(|_| normalize_base(root, "HEAD")),
    }
}

pub fn fallback_base(root: &Path) -> Result<String> {
    let detected = git::default_branch(root)?;
    if let Some(default) = detected
        .as_deref()
        .filter(|name| name.starts_with("origin/"))
    {
        return normalize_base(root, default);
    }
    let remotes = git::output(&["remote"], Some(root), true)?;
    for remote in remotes.lines() {
        let head = git::raw_git(
            root,
            &[
                "symbolic-ref",
                "--quiet",
                &format!("refs/remotes/{remote}/HEAD"),
            ],
        )?;
        if head.code == 0 && commit(root, head.stdout.trim())?.is_some() {
            return Ok(head.stdout.trim().to_string());
        }
    }
    let default = match detected {
        Some(default) => default,
        None => {
            for name in ["main", "master"] {
                let remote = format!("refs/remotes/origin/{name}");
                if commit(root, &remote)?.is_some() {
                    return Ok(remote);
                }
            }
            return Err(Error::msg("Cannot determine the default branch"));
        }
    };
    let configured = git::raw_git(
        root,
        &["config", "--get", &format!("branch.{default}.remote")],
    )?;
    let remote_name = if configured.code == 0 && configured.stdout.trim() != "." {
        configured.stdout.trim()
    } else {
        "origin"
    };
    let remote = format!("refs/remotes/{remote_name}/{default}");
    if commit(root, &remote)?.is_some() {
        Ok(remote)
    } else {
        normalize_base(root, &format!("refs/heads/{default}"))
    }
}

fn commit(root: &Path, reference: &str) -> Result<Option<String>> {
    let result = git::raw_git(
        root,
        &[
            "rev-parse",
            "--verify",
            "--quiet",
            &format!("{reference}^{{commit}}"),
        ],
    )?;
    match result.code {
        0 => Ok(Some(result.stdout.trim().to_string())),
        1 => Ok(None),
        _ => Err(Error::msg(result.stderr)),
    }
}

fn ancestor(root: &Path, a: &str, b: &str) -> Result<bool> {
    let result = git::raw_git(root, &["merge-base", "--is-ancestor", a, b])?;
    match result.code {
        0 => Ok(true),
        1 => Ok(false),
        _ => Err(Error::msg(result.stderr)),
    }
}

fn dirty(path: &Path) -> Result<bool> {
    Ok(!git::output(
        &["status", "--porcelain=v2", "--untracked-files=all"],
        Some(path),
        false,
    )?
    .is_empty())
}

// Checkout during rebase may overwrite ignored files. Preserve those contents too.
fn ignored_would_be_overwritten(path: &Path, base: &str, rebase: bool) -> Result<bool> {
    let ignored = git::output(
        &[
            "ls-files",
            "--others",
            "--ignored",
            "--exclude-standard",
            "--directory",
            "-z",
        ],
        Some(path),
        false,
    )?;
    if ignored.is_empty() {
        return Ok(false);
    }
    // Disable rename detection so both ends of renames and copies are included.
    // -m also includes paths changed relative to each parent of merge commits.
    let fork = git::output(&["merge-base", "HEAD", base], Some(path), true)?;
    let changed = git::output(
        &[
            "log",
            "--name-only",
            "--format=",
            "-z",
            "--no-renames",
            "-m",
            &format!("{fork}..{base}"),
            "--",
        ],
        Some(path),
        false,
    )?;
    let checkout = if rebase {
        git::output(
            &[
                "log",
                "--name-only",
                "--format=",
                "-z",
                "--no-renames",
                "-m",
                &format!("{fork}..HEAD"),
                "--",
            ],
            Some(path),
            false,
        )?
    } else {
        git::output(
            &[
                "diff",
                "--name-only",
                "--no-renames",
                "-z",
                "HEAD",
                base,
                "--",
            ],
            Some(path),
            false,
        )?
    };
    let targets: HashSet<&str> = changed
        .split('\0')
        .chain(checkout.split('\0'))
        .filter(|p| !p.is_empty())
        .collect();
    let mut prefixes = HashSet::new();
    for target in &targets {
        let mut parent = *target;
        while let Some((prefix, _)) = parent.rsplit_once('/') {
            prefixes.insert(prefix);
            parent = prefix;
        }
    }
    for entry in ignored.split('\0').filter(|p| !p.is_empty()) {
        let mut entry = entry.trim_end_matches('/');
        if prefixes.contains(entry) || targets.contains(entry) {
            return Ok(true);
        }
        while let Some((parent, _)) = entry.rsplit_once('/') {
            if targets.contains(parent) {
                return Ok(true);
            }
            entry = parent;
        }
    }
    Ok(false)
}

fn remote_for(base: &str, remotes: &[String]) -> Option<String> {
    let name = base.strip_prefix("refs/remotes/")?;
    crate::tracking::split_remote(name, remotes).map(|(remote, _)| remote.to_string())
}

pub fn run(context: &Context, request: &Request) -> Result<Report> {
    let _operation = crate::operation::lock(&context.git_root)?;
    if (request.all && request.mine)
        || ((request.all || request.mine) && !request.names.is_empty())
        || (request.rebase && request.merge)
    {
        return Err(Error::validation(
            "Conflicting sync selectors or strategies",
        ));
    }
    if request.mine && request.agent.is_none() {
        return Err(Error::validation("--mine requires MABO_AGENT_ID"));
    }
    let stored = metadata::load(&context.git_root)?;
    let listed = worktree::list_worktrees(context, true, true)?;
    let mut targets = Vec::new();
    if request.all || request.mine {
        for tree in listed {
            if metadata::find_in(&stored, Path::new(&tree.path)).is_some()
                && (!request.mine || tree.metadata.owner == request.agent)
            {
                targets.push(tree);
            }
        }
    } else if !request.names.is_empty() {
        for name in &request.names {
            worktree::validate_worktree_name(name)?;
            let tree = worktree::find_worktree(context, name, false, None)?;
            if paths::same_location(Path::new(&tree.path), &context.git_root) {
                return Err(Error::validation("Sync targets must be linked worktrees"));
            }
            if !targets
                .iter()
                .any(|item: &worktree::WorktreeInfo| item.path == tree.path)
            {
                targets.push(tree);
            }
        }
    } else {
        if let Some(name) = worktree::current_worktree_name(context)? {
            targets.push(worktree::find_worktree(context, &name, false, None)?);
        }
    }
    if request.keep_conflicts && targets.len() != 1 {
        return Err(Error::validation(
            "--keep-conflicts requires exactly one worktree target",
        ));
    }
    let fallback = if !request.no_default || targets.iter().any(|tree| tree.metadata.base.is_none())
    {
        fallback_base(&context.git_root)?
    } else {
        String::new()
    };
    let bases: Vec<String> = targets
        .iter()
        .map(|tree| {
            tree.metadata
                .base
                .clone()
                .unwrap_or_else(|| fallback.clone())
        })
        .collect();
    let remotes: Vec<String> = git::output(&["remote"], Some(&context.git_root), true)?
        .lines()
        .map(str::to_string)
        .collect();
    let mut involved = BTreeSet::new();
    for base in bases
        .iter()
        .chain((!request.no_default).then_some(&fallback))
    {
        if let Some(remote) = remote_for(base, &remotes) {
            involved.insert(remote);
        }
    }
    let mut fetch_errors = Vec::new();
    for remote in involved {
        let fetched = git::raw_git(
            &context.git_root,
            &[
                "-c",
                "core.hooksPath=/dev/null",
                "fetch",
                "--prune",
                "--",
                &remote,
            ],
        )?;
        if fetched.code != 0 {
            fetch_errors.push(format!("Fetch {remote} failed: {}", fetched.stderr.trim()));
        }
    }
    let mut report = Report {
        schema: 1,
        default: None,
        worktrees: Vec::new(),
        exit: 0,
    };
    if !request.no_default && fetch_errors.is_empty() {
        let item = sync_default(context, &fallback, &remotes);
        let item = match item {
            Ok(item) => item,
            Err(error) => failed_item("default", error),
        };
        if item.status == "failed"
            || (targets.is_empty() && matches!(item.status.as_str(), "dirty" | "diverged"))
        {
            report.exit = 1;
        }
        report.default = Some(item);
    }
    // A failed fetch must never silently integrate stale remote information.
    if !fetch_errors.is_empty() {
        let detail = fetch_errors.join("; ");
        if !request.no_default && report.default.is_none() {
            report.default = Some(failed_item("default", Error::msg(detail.clone())));
        }
        if let Some(item) = &mut report.default {
            item.status("failed", Some(detail.clone()));
        }
        for (tree, base) in targets.iter().zip(&bases) {
            let mut item = tree_item(tree, base);
            item.status("failed", Some(detail.clone()));
            report.worktrees.push(item);
        }
        report.exit = 1;
        return Ok(report);
    }
    for (tree, base) in targets.iter().zip(&bases) {
        let item = match sync_tree(context, tree, base, request) {
            Ok(item) => item,
            Err(error) => {
                let mut item = tree_item(tree, base);
                item.status("failed", Some(error.to_string()));
                item
            }
        };
        if item.code.as_deref() == Some("pushed") {
            report.exit = 3;
        } else if matches!(item.status.as_str(), "failed" | "conflict") && report.exit != 3 {
            report.exit = 1;
        }
        report.worktrees.push(item);
    }
    Ok(report)
}

fn short_detail(value: &str) -> String {
    value
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("")
        .to_string()
}

fn failed_item(name: &str, error: Error) -> Item {
    Item {
        name: name.to_string(),
        path: None,
        branch: None,
        base: None,
        status: "failed".into(),
        strategy: None,
        before: None,
        after: None,
        conflicts: Vec::new(),
        detail: Some(short_detail(&error.to_string())),
        code: None,
    }
}

fn tree_item(tree: &worktree::WorktreeInfo, base: &str) -> Item {
    Item {
        name: tree.name.clone(),
        path: Some(tree.path.clone()),
        branch: (!tree.detached).then(|| tree.branch.clone()),
        base: Some(base.to_string()),
        status: "up-to-date".into(),
        strategy: None,
        before: tree.head.clone(),
        after: tree.head.clone(),
        conflicts: Vec::new(),
        detail: None,
        code: None,
    }
}

// Read private state directly, including registrations whose checkout is missing.
fn operation_state(path: &Path, state: &str) -> Result<Option<String>> {
    match std::fs::read_to_string(path.join(state)) {
        Ok(value) => Ok(Some(value)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(Error::msg(format!(
            "Cannot inspect Git state {state}: {error}"
        ))),
    }
}

fn active_operation(path: &Path) -> Result<Option<&'static str>> {
    let git_dir = git::output(&["rev-parse", "--absolute-git-dir"], Some(path), true)?;
    for (state, operation) in [
        ("rebase-merge", "rebase"),
        ("rebase-apply", "rebase"),
        ("MERGE_HEAD", "merge"),
        ("CHERRY_PICK_HEAD", "cherry-pick"),
        ("REVERT_HEAD", "revert"),
        ("BISECT_START", "bisect"),
        ("sequencer", "sequencer"),
    ] {
        if Path::new(&git_dir)
            .join(state)
            .try_exists()
            .map_err(|error| Error::msg(error.to_string()))?
        {
            return Ok(Some(operation));
        }
    }
    Ok(None)
}

fn branch_reservation(context: &Context, local: &str) -> Result<Option<(String, &'static str)>> {
    let common = git::git_common_dir(&context.git_root)?;
    let mut dirs = vec![common.clone()];
    match std::fs::read_dir(common.join("worktrees")) {
        Ok(entries) => {
            for entry in entries {
                let entry = entry.map_err(|error| Error::msg(error.to_string()))?;
                if entry
                    .file_type()
                    .map_err(|error| Error::msg(error.to_string()))?
                    .is_dir()
                {
                    dirs.push(entry.path());
                }
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(Error::msg(error.to_string())),
    }
    for path in dirs {
        for (state, operation) in [
            ("rebase-merge/head-name", "rebased"),
            ("rebase-apply/head-name", "rebased"),
            ("rebase-merge/update-refs", "rebased"),
            ("BISECT_START", "bisected"),
        ] {
            if let Some(value) = operation_state(&path, state)? {
                if value.lines().any(|line| {
                    line == local || line == local.strip_prefix("refs/heads/").unwrap_or(local)
                }) {
                    let checkout = if path == common {
                        context.git_root.clone()
                    } else {
                        operation_state(&path, "gitdir")?
                            .and_then(|value| {
                                Path::new(value.trim()).parent().map(Path::to_path_buf)
                            })
                            .unwrap_or_else(|| path.clone())
                    };
                    return Ok(Some((checkout.display().to_string(), operation)));
                }
            }
        }
    }
    Ok(None)
}

fn sync_default(context: &Context, base: &str, remotes: &[String]) -> Result<Item> {
    let local_name = if let Some(rest) = base.strip_prefix("refs/remotes/") {
        crate::tracking::split_remote(rest, remotes)
            .map(|(_, branch)| branch)
            .ok_or_else(|| {
                Error::msg(format!(
                    "No configured remote matches default base '{base}'"
                ))
            })?
    } else {
        base.strip_prefix("refs/heads/")
            .ok_or_else(|| Error::msg("Default branch must name a branch"))?
    };
    let local = format!("refs/heads/{local_name}");
    let root = &context.git_root;
    let before = commit(root, &local)?;
    let mut item = Item {
        name: local_name.to_string(),
        path: None,
        branch: Some(local.clone()),
        base: Some(base.to_string()),
        status: "up-to-date".into(),
        strategy: Some("ff-only".into()),
        before: before.clone(),
        after: before.clone(),
        conflicts: Vec::new(),
        detail: None,
        code: None,
    };
    let target = commit(root, base)?.ok_or_else(|| Error::msg("Default base no longer exists"))?;
    let trees = worktree::list_worktrees(context, false, true)?;
    if let Some((path, operation)) = branch_reservation(context, &local)? {
        item.path = Some(path.clone());
        item.status(
            "dirty",
            Some(format!("{local_name} is being {operation} in {path}")),
        );
        return Ok(item);
    }
    let checked = trees
        .into_iter()
        .find(|tree| !tree.detached && tree.branch == local_name);
    if let Some(tree) = &checked {
        item.path = Some(tree.path.clone());
    }
    if let Some(tree) = &checked {
        if !Path::new(&tree.path).is_dir() {
            item.status("dirty", Some("Worktree directory is missing".into()));
            return Ok(item);
        }
        if let Some(operation) = active_operation(Path::new(&tree.path))? {
            item.status(
                "dirty",
                Some(format!("{operation} in progress in {}", tree.path)),
            );
            return Ok(item);
        }
    }
    if before.as_deref() == Some(&target) {
        return Ok(item);
    }
    if let Some(before) = &before {
        if !ancestor(root, before, &target)? {
            item.status("diverged", None);
            return Ok(item);
        }
    }
    if let Some(tree) = checked {
        let path = Path::new(&tree.path);
        if ignored_would_be_overwritten(path, base, false)? {
            item.status("dirty", Some("Ignored files would be overwritten".into()));
            return Ok(item);
        }
        let result = git::raw_git(
            path,
            &[
                "-c",
                "core.hooksPath=/dev/null",
                "-c",
                "merge.autoStash=false",
                "merge",
                "--no-squash",
                "--commit",
                "--no-verify-signatures",
                "--ff-only",
                "--no-edit",
                base,
            ],
        )?;
        if result.code != 0 {
            item.status(
                if dirty(path)? { "dirty" } else { "failed" },
                Some(result.stderr.trim().into()),
            );
            return Ok(item);
        }
    } else {
        git::output(
            &[
                "-c",
                "core.hooksPath=/dev/null",
                "update-ref",
                &local,
                &target,
                before.as_deref().unwrap_or(""),
            ],
            Some(root),
            true,
        )?;
    }
    item.after = Some(target);
    item.status("updated", None);
    Ok(item)
}

fn sync_tree(
    context: &Context,
    tree: &worktree::WorktreeInfo,
    base: &str,
    request: &Request,
) -> Result<Item> {
    let mut item = tree_item(tree, base);
    let path = Path::new(&tree.path);
    if !path.is_dir() || tree.orphaned {
        item.status(
            "dirty",
            Some("Worktree directory is missing or registration is orphaned".into()),
        );
        return Ok(item);
    }
    let operation = active_operation(path)?;
    if tree.detached {
        item.status("detached", operation.map(|op| format!("{op} in progress")));
        return Ok(item);
    }
    if let Some(operation) = operation {
        item.status("dirty", Some(format!("{operation} in progress")));
        return Ok(item);
    }
    if let Some((reserved_path, operation)) =
        branch_reservation(context, &format!("refs/heads/{}", tree.branch))?
    {
        item.status(
            "dirty",
            Some(format!(
                "{} is being {operation} in {reserved_path}",
                tree.branch
            )),
        );
        return Ok(item);
    }
    if dirty(path)? {
        item.status("dirty", None);
        return Ok(item);
    }
    let base_exists = commit(path, base)?.is_some();
    let other_owner = request.all
        && request.agent.is_some()
        && tree.metadata.owner.is_some()
        && tree.metadata.owner != request.agent;
    if !base_exists && other_owner {
        item.status("owned", None);
        return Ok(item);
    }
    if !base_exists {
        item.status(
            "base-gone",
            Some(format!(
                "Set a new base: mabo meta set {} --base <ref>",
                tree.name
            )),
        );
        return Ok(item);
    }
    let reachability = git::tip_reachability(
        path,
        Some(&tree.branch),
        tree.head.as_deref(),
        &Some(base.to_string()),
    );
    let moved = !crate::gc::still_at_creation_point(
        path,
        &tree.branch,
        tree.metadata.created_from.as_deref(),
        base,
        !metadata::records_path(&context.git_root, path)?,
    );
    if moved
        && (ancestor(path, "HEAD", base)?
            || reachability.landed
            || git::changes_landed(path, "HEAD", base))
    {
        item.status(
            "merged",
            Some("Use mabo gc to remove landed worktrees".into()),
        );
        return Ok(item);
    }
    if request.all
        && request.agent.is_some()
        && tree.metadata.owner.is_some()
        && tree.metadata.owner != request.agent
    {
        item.status("owned", None);
        return Ok(item);
    }
    let own = git::output(
        &["rev-list", &format!("{base}..HEAD"), "--"],
        Some(path),
        true,
    )?;
    let unpublished = git::output(
        &["rev-list", "HEAD", "--not", base, "--remotes", "--"],
        Some(path),
        true,
    )?;
    let unpublished: BTreeSet<&str> = unpublished.lines().collect();
    let pushed = own.lines().any(|sha| !unpublished.contains(sha));
    let strategy = if request.merge || (!request.rebase && pushed) {
        "merge"
    } else {
        "rebase"
    };
    item.strategy = Some(strategy.into());
    if ancestor(path, base, "HEAD")? {
        return Ok(item);
    }
    if request.rebase && pushed && !request.force {
        item.status(
            "failed",
            Some("Published commits require --force with --rebase".into()),
        );
        item.code = Some("pushed".into());
        return Ok(item);
    }
    if ignored_would_be_overwritten(path, base, strategy == "rebase")? {
        item.status("dirty", Some("Ignored files would be overwritten".into()));
        return Ok(item);
    }
    let short_base = base
        .strip_prefix("refs/remotes/")
        .or_else(|| base.strip_prefix("refs/heads/"))
        .unwrap_or(base);
    let message = format!("Merge {short_base} into {}", tree.branch);
    let args = if own.is_empty() {
        vec![
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "merge.autoStash=false",
            "merge",
            "--no-squash",
            "--commit",
            "--ff-only",
            "--no-gpg-sign",
            "--no-verify-signatures",
            base,
        ]
    } else if strategy == "merge" {
        vec![
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "merge.autoStash=false",
            "-c",
            "commit.gpgSign=false",
            "merge",
            "--no-squash",
            "--commit",
            "--ff",
            "--no-gpg-sign",
            "--no-verify-signatures",
            "--no-edit",
            "--no-verify",
            "-m",
            &message,
            base,
        ]
    } else {
        vec![
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "rebase.autoStash=false",
            "-c",
            "rebase.autoSquash=false",
            "-c",
            "rebase.rebaseMerges=false",
            "-c",
            "rebase.updateRefs=false",
            "-c",
            "commit.gpgSign=false",
            "rebase",
            "--no-autostash",
            base,
        ]
    };
    let action = format!("mabo sync: fast-forward to {base}");
    let result = if own.is_empty() {
        git::raw_git_with_env(path, &args, &[("GIT_REFLOG_ACTION", &action)])?
    } else {
        git::raw_git(path, &args)?
    };
    // A successful exit alone does not prove integration finished (e.g. --no-commit).
    let mut pending = None;
    for state in ["MERGE_HEAD", "rebase-merge", "rebase-apply"] {
        let state_path = git::output(&["rev-parse", "--git-path", state], Some(path), true)?;
        if path.join(state_path).exists() {
            pending = Some(if state == "MERGE_HEAD" {
                "merge"
            } else {
                "rebase"
            });
            break;
        }
    }
    let incomplete = result.code == 0 && (pending.is_some() || dirty(path)?);
    if result.code != 0 || incomplete {
        let files = git::output(
            &["diff", "--name-only", "--diff-filter=U", "-z"],
            Some(path),
            false,
        )?;
        item.conflicts = files
            .split('\0')
            .filter(|file| !file.is_empty())
            .map(str::to_string)
            .collect();
        if let Some(operation) = pending.filter(|_| incomplete || !request.keep_conflicts) {
            let abort = git::raw_git(
                path,
                &["-c", "core.hooksPath=/dev/null", operation, "--abort"],
            )?;
            if abort.code != 0 {
                return Err(Error::msg(format!(
                    "Cannot abort {operation}: {}",
                    abort.stderr
                )));
            }
        }
        if incomplete {
            // Squash can leave an index without operation state to abort. The
            // preflight required a clean tree; reset --merge preserves ignored files.
            if let Some(before) = item.before.as_deref() {
                git::output(
                    &["-c", "core.hooksPath=/dev/null", "reset", "--merge", before],
                    Some(path),
                    true,
                )?;
            }
            item.after = git::head_commit(path);
            item.status(
                "failed",
                Some(format!("{strategy} incomplete; worktree restored")),
            );
            return Ok(item);
        }
        item.after = git::head_commit(path);
        item.status(
            if item.conflicts.is_empty() {
                "failed"
            } else {
                "conflict"
            },
            Some(if item.conflicts.is_empty() {
                short_detail(&result.stderr)
            } else if request.keep_conflicts {
                format!("{strategy} left in progress")
            } else {
                format!("{strategy} aborted; worktree unchanged")
            }),
        );
        return Ok(item);
    }
    item.after = git::head_commit(path);
    if own.is_empty() {
        if let Some(tip) = item.after.as_deref() {
            metadata::record_sync_tip(&context.git_root, path, tip)?;
        }
    }
    item.status(
        if item.after == item.before {
            "up-to-date"
        } else {
            "updated"
        },
        None,
    );
    Ok(item)
}
