use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use serde::Serialize;

use crate::context::Context;
use crate::error::{self, Error, JsonErrorBody, Result};
use crate::git::{self};
use crate::github::{self, PullRequestStatus};
use crate::metadata::{self, WorktreeLink, WorktreeMetadata};
use crate::paths;
use crate::process;
use crate::worktree::{self, Logger};

pub struct Request {
    pub policy: Policy,
    pub apply: bool,
    pub keep_branch: bool,
    pub no_hooks: bool,
}

#[derive(Clone)]
pub struct Policy {
    pub selection: Selection,
    pub now: SystemTime,
}

#[derive(Clone)]
pub struct Selection {
    pub merged: bool,
    pub pull_request: bool,
    pub orphaned: bool,
    pub older_than: Option<Duration>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Reason {
    Merged,
    PullRequest,
    Orphaned,
}

impl Reason {
    fn label(self) -> &'static str {
        match self {
            Self::Merged => "merged",
            Self::PullRequest => "pullRequest",
            Self::Orphaned => "orphaned",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum Action {
    #[serde(rename = "wouldRemove")]
    WouldRemove,
    #[serde(rename = "removed")]
    Removed,
    #[serde(rename = "skipped")]
    Skipped,
    #[serde(rename = "failed")]
    Failed,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CandidateEntry {
    pub name: String,
    pub path: String,
    pub branch: Option<String>,
    pub reasons: Vec<Reason>,
    pub action: Action,
    pub detail: Option<String>,
    pub branch_deleted: Option<bool>,
    pub workspace: serde_json::Value,
    /// A checkout, registration, or metadata record was removed, even if a
    /// later step failed. This is independent of the candidate's action.
    #[serde(skip)]
    changed: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub version: u32,
    pub applied: bool,
    pub plan: bool,
    #[serde(rename = "items")]
    pub candidates: Vec<CandidateEntry>,
    #[serde(skip)]
    pub lines: Vec<String>,
    pub error: Option<JsonErrorBody>,
}

impl Report {
    pub fn exit_code(&self) -> i32 {
        if self.error.is_some() {
            if self.candidates.iter().any(|entry| entry.changed) {
                error::PARTIAL
            } else {
                error::GENERAL
            }
        } else {
            error::SUCCESS
        }
    }
}

pub fn parse_duration(value: &str) -> Result<Duration> {
    let value = value.trim();
    let mut chars = value.chars();
    let Some(unit) = chars.next_back() else {
        return Err(duration_error());
    };
    let digits = chars.as_str();
    if digits.is_empty() || !digits.chars().all(|char| char.is_ascii_digit()) {
        return Err(duration_error());
    }
    let count: u64 = digits.parse().map_err(|_| duration_error())?;
    if count == 0 {
        return Err(duration_error());
    }
    let unit = unit.to_ascii_lowercase().to_string();
    let factor = match unit.as_str() {
        "m" => 60,
        "h" => 3_600,
        "d" => 86_400,
        "w" => 7 * 86_400,
        _ => return Err(duration_error()),
    };
    let seconds = count.checked_mul(factor).ok_or_else(duration_error)?;
    Ok(Duration::from_secs(seconds))
}

fn duration_error() -> Error {
    Error::validation(
        "`--older-than` expects a positive integer and a unit of m, h, d, or w (for example 14d)"
            .to_string(),
    )
}

pub fn selection_from_flags(
    merged: bool,
    pull_request: bool,
    orphaned: bool,
    older_than: Option<Duration>,
) -> Selection {
    if !merged && !pull_request && !orphaned {
        return Selection {
            merged: true,
            pull_request: true,
            orphaned: true,
            older_than,
        };
    }
    Selection {
        merged,
        pull_request,
        orphaned,
        older_than,
    }
}

pub fn run(context: &Context, request: &Request, logger: &Logger) -> Result<Report> {
    // Gathering facts, rendering workspaces and resolving hint selectors all
    // inspect status; fsmonitor must not run anywhere in a read-only plan.
    let _hooks = (!request.apply).then(crate::process::suppress_git_hooks);
    let facts = gather(context, &request.policy, None)?;
    let mut workspaces = worktree::list_worktrees(context, false, true)?;
    let common = git::canonical_common_dir(&context.git_root)?;
    for (key, record) in metadata::load_strict(&context.git_root)? {
        let path = Path::new(&key);
        if !paths::same_location(path, &context.git_root)
            && !workspaces
                .iter()
                .any(|tree| paths::same_location(path, Path::new(&tree.path)))
        {
            workspaces.push(worktree::orphaned_info(context, path, &record, &common));
        }
    }
    warn_unavailable_pull_requests(&facts, &request.policy);
    let verdicts = classify(&facts, &request.policy);
    let skip_untrusted = crate::trust::blocks_gc(
        &context.git_root,
        crate::config::pre_remove_commands(context.config.as_ref()),
        request.no_hooks,
    )?;
    let mut candidates = Vec::with_capacity(verdicts.len());
    let mut first_failure = None;
    for verdict in verdicts {
        let verdict = if skip_untrusted {
            hold_untrusted(verdict)
        } else {
            verdict
        };
        let mut entry = if request.apply {
            apply_verdict(context, request, logger, verdict)
        } else {
            preview(context, verdict)
        };
        entry.workspace = workspaces
            .iter()
            .find(|tree| paths::same_location(Path::new(&tree.path), Path::new(&entry.path)))
            .map(|tree| serde_json::to_value(tree.to_json(None)))
            .transpose()
            .map_err(|error| Error::msg(error.to_string()))?
            .unwrap_or_else(|| serde_json::json!({"name": entry.name, "path": entry.path}));
        if entry.action == Action::Failed && first_failure.is_none() {
            first_failure = entry.detail.clone();
        }
        candidates.push(entry);
    }
    Ok(finish(candidates, request.apply, first_failure))
}

#[derive(Clone)]
struct Subject {
    path: PathBuf,
    name: String,
    branch: Option<String>,
    head: Option<String>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum DirState {
    Present,
    Absent,
    Unknown,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Dirty {
    Clean,
    Changed,
    Unknown,
    Absent,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum PullRequestState {
    Unlinked,
    Unavailable,
    Open,
    ClosedOrMerged,
}

#[derive(Clone)]
struct WorktreeFacts {
    subject: Subject,
    registered: bool,
    directory: DirState,
    prunable: bool,
    branch_missing: bool,
    is_default: bool,
    is_current: bool,
    locked: bool,
    dirty: Dirty,
    /// `Some(true)` means the tip is not integrated into its base and does not
    /// exactly match its own upstream. Unknown state is protected too.
    unpushed: Option<bool>,
    merged: bool,
    pr: PullRequestState,
    created_at: Option<SystemTime>,
}

#[derive(Clone, Copy)]
enum Hold {
    Protected,
    DefaultBranch,
    Locked,
    StatusUnknown,
    Dirty,
    Unpushed,
    PrUnavailable,
    Untrusted,
}

impl Hold {
    fn detail(self) -> &'static str {
        match self {
            Self::Protected => "current workspace",
            Self::DefaultBranch => "default branch",
            Self::Locked => "locked",
            Self::PrUnavailable => "pr status unavailable",
            Self::StatusUnknown => "status unknown",
            Self::Dirty => "dirty",
            Self::Unpushed => "unpushed",
            Self::Untrusted => "untrusted hooks",
        }
    }
}

enum Verdict {
    Remove(Removal),
    Skip {
        subject: Subject,
        reasons: Vec<Reason>,
        hold: Hold,
    },
}

enum Removal {
    Delete {
        subject: Subject,
        reasons: Vec<Reason>,
    },
    DropRegistration {
        subject: Subject,
        reasons: Vec<Reason>,
        git_listed: bool,
        unpushed: Option<bool>,
        branch_missing: bool,
    },
}

struct Criterion {
    reason: Reason,
    matches: fn(&WorktreeFacts, &Policy) -> bool,
}

static CRITERIA: &[Criterion] = &[
    Criterion {
        reason: Reason::Merged,
        matches: |facts, _| facts.merged,
    },
    Criterion {
        reason: Reason::PullRequest,
        matches: |facts, _| facts.pr == PullRequestState::ClosedOrMerged,
    },
    Criterion {
        reason: Reason::Orphaned,
        matches: |facts, _| orphaned(facts),
    },
];

fn orphaned(facts: &WorktreeFacts) -> bool {
    if facts.registered {
        facts.prunable || facts.directory == DirState::Absent || facts.branch_missing
    } else {
        facts.directory == DirState::Absent
    }
}

fn age_hit(facts: &WorktreeFacts, policy: &Policy) -> bool {
    let Some(limit) = policy.selection.older_than else {
        return false;
    };
    let Some(anchor) = facts.created_at else {
        return false;
    };
    policy
        .now
        .duration_since(anchor)
        .is_ok_and(|elapsed| elapsed >= limit)
}

fn classify(facts: &[WorktreeFacts], policy: &Policy) -> Vec<Verdict> {
    let mut verdicts = Vec::new();
    for facts in facts {
        if policy.selection.older_than.is_some() && !age_hit(facts, policy) {
            continue;
        }
        let reasons = CRITERIA
            .iter()
            .filter(|row| policy.selection.selects(row.reason) && (row.matches)(facts, policy))
            .map(|row| row.reason)
            .collect::<Vec<_>>();
        if reasons.is_empty() {
            if policy.selection.pull_request && facts.pr == PullRequestState::Unavailable {
                verdicts.push(Verdict::Skip {
                    subject: facts.subject.clone(),
                    reasons: vec![Reason::PullRequest],
                    hold: Hold::PrUnavailable,
                });
            }
            continue;
        }
        if let Some(hold) = hold(facts, policy) {
            verdicts.push(Verdict::Skip {
                subject: facts.subject.clone(),
                reasons,
                hold,
            });
            continue;
        }
        verdicts.push(Verdict::Remove(removal_kind(facts, reasons)));
    }
    verdicts
}

impl Selection {
    fn selects(&self, reason: Reason) -> bool {
        match reason {
            Reason::Merged => self.merged,
            Reason::PullRequest => self.pull_request,
            Reason::Orphaned => self.orphaned,
        }
    }
}

fn hold(facts: &WorktreeFacts, _policy: &Policy) -> Option<Hold> {
    if facts.is_default {
        return Some(Hold::DefaultBranch);
    }
    if facts.is_current {
        return Some(Hold::Protected);
    }
    if facts.locked {
        return Some(Hold::Locked);
    }
    if facts.directory == DirState::Unknown {
        return Some(Hold::StatusUnknown);
    }
    if facts.dirty == Dirty::Unknown {
        return Some(Hold::StatusUnknown);
    }
    if facts.dirty == Dirty::Changed {
        return Some(Hold::Dirty);
    }
    if facts.unpushed != Some(false)
        && facts.registered
        && (facts.directory == DirState::Present || facts.subject.branch.is_none())
    {
        return Some(Hold::Unpushed);
    }
    None
}

fn removal_kind(facts: &WorktreeFacts, reasons: Vec<Reason>) -> Removal {
    let subject = facts.subject.clone();
    if facts.registered && facts.directory == DirState::Present {
        return Removal::Delete { subject, reasons };
    }
    Removal::DropRegistration {
        subject,
        reasons,
        git_listed: facts.registered,
        unpushed: facts.unpushed,
        branch_missing: facts.branch_missing,
    }
}

// Re-verification must refresh metadata and Git state,
// but observing unrelated worktrees would repeat their GitHub queries per target.
fn gather(context: &Context, policy: &Policy, target: Option<&Path>) -> Result<Vec<WorktreeFacts>> {
    let stored = metadata::load_strict(&context.git_root)?;
    let common_dir = git::canonical_common_dir(&context.git_root)?;
    let listed = git::list_worktrees(&context.git_root)
        .map_err(|error| Error::msg(format!("Failed to list workspaces: {error}")))?;
    let base = crate::sync::fallback_base(&context.git_root).ok();
    let name = base
        .as_deref()
        .and_then(|base| crate::sync::default_local_branch(&context.git_root, base).ok());
    if name.is_none() {
        crate::output::warning(
            "default_branch_unavailable",
            "Warning: cannot resolve the default branch; keeping all branch workspaces",
        );
    }
    let default = DefaultBranch { base, name };
    let current = current_worktree_path(context);
    let mut pull_requests = BTreeMap::new();
    let mut rows = BTreeMap::new();
    for worktree in &listed {
        let path = PathBuf::from(&worktree.path);
        if target.is_some_and(|target| !paths::same_location(target, &path)) {
            continue;
        }
        if paths::same_location(&path, &context.git_root) {
            continue;
        }
        let found = metadata::find_in(&stored, &path);
        let inside = paths::is_strictly_inside(&path, &context.worktrees_directory);
        let recorded = found.is_some();
        if !inside && !recorded {
            continue;
        }
        let recorded_path = found.map(|(key, _)| key.clone());
        let key = recorded_path
            .clone()
            .unwrap_or_else(|| metadata::path_key(&path));
        let record = found.map(|(_, record)| record);
        let mut facts = observe_listed(
            context,
            policy,
            &default,
            current.as_deref(),
            worktree,
            record,
            &mut pull_requests,
        );
        let short_head = worktree
            .head
            .as_deref()
            .map(|head| head.chars().take(7).collect::<String>())
            .unwrap_or_else(|| "HEAD".to_string());
        let branch_name = worktree
            .branch
            .as_deref()
            .filter(|branch| !branch.is_empty() && *branch != "(detached HEAD)");
        facts.subject.name = worktree::resolve_worktree_name(
            &path,
            &context.worktrees_directory,
            recorded_path.as_deref().map(Path::new),
            record.and_then(|item| item.name.as_deref()),
            &common_dir,
            branch_name,
            &short_head,
        );
        rows.insert(key, facts);
    }
    for (key, record) in &stored {
        if rows.contains_key(key) {
            continue;
        }
        let path = PathBuf::from(key);
        if target.is_some_and(|target| !paths::same_location(target, &path)) {
            continue;
        }
        if paths::normalize(&path) == paths::normalize(&context.git_root) {
            continue;
        }
        if listed
            .iter()
            .any(|tree| paths::same_location(&path, Path::new(&tree.path)))
        {
            continue;
        }
        let mut facts = observe_record(context, policy, &path, record, &mut pull_requests);
        facts.subject.name = worktree::resolve_worktree_name(
            &path,
            &context.worktrees_directory,
            Some(&path),
            record.name.as_deref(),
            &common_dir,
            None,
            "HEAD",
        );
        rows.insert(key.clone(), facts);
    }
    Ok(rows.into_values().collect())
}

struct DefaultBranch {
    base: Option<String>,
    name: Option<String>,
}

fn observe_listed(
    context: &Context,
    policy: &Policy,
    default: &DefaultBranch,
    current: Option<&Path>,
    worktree: &git::GitWorktree,
    record: Option<&WorktreeMetadata>,
    pull_requests: &mut BTreeMap<String, PullRequestStatus>,
) -> WorktreeFacts {
    let base = record
        .and_then(|record| record.base.clone())
        .or_else(|| default.base.clone());
    let path = PathBuf::from(&worktree.path);
    let directory = directory_state(&path);
    let detached = worktree.branch.as_deref() == Some("(detached HEAD)");
    let branch = worktree
        .branch
        .as_deref()
        .filter(|branch| !detached && !branch.is_empty())
        .map(ToOwned::to_owned);
    let branch_missing = match &branch {
        Some(name) => git::branch_exists(&context.git_root, name).ok() == Some(false),
        None => false,
    };
    let created_from = record.and_then(|item| item.created_from.as_deref());
    let tip = branch
        .as_ref()
        .map(|branch| format!("refs/heads/{branch}"))
        .or_else(|| worktree.head.clone());
    let integrated = tip
        .as_deref()
        .zip(base.as_deref())
        .is_some_and(|(tip, base)| git::retirement_integrated(&context.git_root, tip, base));
    let moved = match (&branch, &base) {
        (Some(name), Some(base)) => !still_at_creation_point(
            &context.git_root,
            name,
            created_from,
            base,
            record.is_none(),
        ),
        (None, _) => worktree
            .head
            .as_deref()
            .zip(created_from)
            .is_some_and(|(head, created)| {
                // A detached checkout has no branch creation reflog to consult.
                // Require a known creation commit and a different current HEAD.
                let spec = format!("{created}^{{commit}}");
                git::raw_git(
                    &context.git_root,
                    &["rev-parse", "--verify", "--quiet", &spec],
                )
                .is_ok_and(|created| {
                    created.code == 0 && !created.stdout.trim().eq_ignore_ascii_case(head)
                })
            }),
        _ => false,
    };
    let merged = moved && integrated;
    let preserved =
        integrated || git::retirement_upstream_matches(&context.git_root, branch.as_deref());
    // An unresolved remote mapping must not prevent orphan-record cleanup or
    // accidentally allow deletion of the checkout holding the default branch.
    let is_default = branch
        .as_deref()
        .is_some_and(|branch| default.name.as_deref() == Some(branch) || default.name.is_none());
    let unpushed = Some(!preserved);
    let pr_link = record.and_then(|item| item.links.pr.as_ref());
    let pr = pull_state(policy, &context.git_root, pr_link, pull_requests);
    let dirty = match directory {
        DirState::Absent => Dirty::Absent,
        DirState::Unknown => Dirty::Unknown,
        DirState::Present => match git::retirement_status_count(&path) {
            Ok(0) => Dirty::Clean,
            Ok(_) => Dirty::Changed,
            Err(_) => Dirty::Unknown,
        },
    };
    let metadata = record.cloned().unwrap_or_default();
    WorktreeFacts {
        subject: Subject {
            name: String::new(),
            path,
            branch,
            head: worktree.head.clone(),
        },
        registered: true,
        directory,
        prunable: worktree.prunable,
        branch_missing,
        is_default,
        is_current: current
            .is_some_and(|current| paths::same_location(current, Path::new(&worktree.path))),
        locked: worktree.locked,
        dirty,
        unpushed,
        merged,
        pr,

        created_at: metadata.created_at.as_deref().and_then(parse_time),
    }
}

fn observe_record(
    context: &Context,
    policy: &Policy,
    path: &Path,
    record: &WorktreeMetadata,
    pull_requests: &mut BTreeMap<String, PullRequestStatus>,
) -> WorktreeFacts {
    WorktreeFacts {
        subject: Subject {
            name: String::new(),
            path: path.to_path_buf(),
            branch: None,
            head: None,
        },
        registered: false,
        directory: DirState::Absent,
        prunable: false,
        branch_missing: false,
        is_default: false,
        is_current: false,
        locked: false,
        dirty: Dirty::Absent,
        unpushed: None,
        merged: false,
        pr: pull_state(
            policy,
            &context.git_root,
            record.links.pr.as_ref(),
            pull_requests,
        ),

        created_at: record.created_at.as_deref().and_then(parse_time),
    }
}

fn warn_unavailable_pull_requests(facts: &[WorktreeFacts], policy: &Policy) {
    if !policy.selection.pull_request {
        return;
    }
    for facts in facts {
        if facts.pr == PullRequestState::Unavailable {
            crate::output::warning(
                "pull_request_unavailable",
                format!(
                    "Warning: pull request status unavailable for {}",
                    facts.subject.name
                ),
            );
        }
    }
}

struct PullRequestQuery {
    key: String,
    view: String,
}

fn pull_state(
    policy: &Policy,
    git_root: &Path,
    link: Option<&WorktreeLink>,
    pull_requests: &mut BTreeMap<String, PullRequestStatus>,
) -> PullRequestState {
    if !policy.selection.pull_request {
        return PullRequestState::Unlinked;
    }
    let Some(link) = link else {
        return PullRequestState::Unlinked;
    };
    if link.number.is_none() && link.url.as_deref().unwrap_or("").is_empty() {
        return PullRequestState::Unlinked;
    }
    let Some(query) = pull_request_query(git_root, link) else {
        return PullRequestState::Unavailable;
    };
    let status = pull_requests
        .entry(query.key)
        .or_insert_with(|| github::pull_request_state(git_root, &query.view));
    match *status {
        PullRequestStatus::Open => PullRequestState::Open,
        PullRequestStatus::Closed | PullRequestStatus::Merged => PullRequestState::ClosedOrMerged,
        PullRequestStatus::Unavailable => PullRequestState::Unavailable,
    }
}

fn pull_request_query(git_root: &Path, link: &WorktreeLink) -> Option<PullRequestQuery> {
    if let Some(url) = link
        .url
        .as_deref()
        .map(str::trim)
        .filter(|url| !url.is_empty())
    {
        return Some(PullRequestQuery {
            key: url.to_string(),
            view: url.to_string(),
        });
    }
    let number = link.number?;
    let repo = github::current_repo_name(git_root)?;
    Some(PullRequestQuery {
        key: format!("{repo}#{number}"),
        view: number.to_string(),
    })
}

/// A stale metadata record has neither a Git registration nor a directory.
pub(crate) fn orphaned_record(path: &Path, listed: &[git::GitWorktree]) -> bool {
    !listed
        .iter()
        .any(|worktree| paths::same_location(path, Path::new(&worktree.path)))
        && directory_state(path) == DirState::Absent
}

fn directory_state(path: &Path) -> DirState {
    match std::fs::metadata(path) {
        Ok(metadata) if metadata.is_dir() => DirState::Present,
        Ok(_) => DirState::Present,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => DirState::Absent,
        Err(_) => DirState::Unknown,
    }
}

fn current_worktree_path(context: &Context) -> Option<PathBuf> {
    let cwd = std::env::current_dir().ok()?;
    let top = git::top_level(&cwd).ok()?;
    if paths::same_location(&top, &context.git_root) {
        return None;
    }
    Some(top)
}

fn parse_time(value: &str) -> Option<SystemTime> {
    let parsed = chrono::DateTime::parse_from_rfc3339(value).ok()?;
    let seconds = u64::try_from(parsed.timestamp()).ok()?;
    Some(SystemTime::UNIX_EPOCH + Duration::from_secs(seconds))
}

pub(crate) fn still_at_creation_point(
    git_root: &Path,
    branch: &str,
    created_from: Option<&str>,
    base: &str,
    unrecorded: bool,
) -> bool {
    let Some(tip_sha) = branch_tip(git_root, branch) else {
        return false;
    };
    if let Some(created) = created_from
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return created.eq_ignore_ascii_case(&tip_sha);
    }
    let spec = format!("refs/heads/{branch}");
    let Ok(reflog) = git(git_root, &["reflog", "show", "--format=%H%x09%gs", &spec]) else {
        return unrecorded;
    };
    if reflog.code != 0 {
        return unrecorded;
    }
    let mut entries: Vec<_> = reflog.stdout.lines().collect();
    let Some(oldest) = entries.pop() else {
        return unrecorded;
    };
    let Some((creation, subject)) = oldest.split_once('\t') else {
        return unrecorded;
    };
    if creation.eq_ignore_ascii_case(&tip_sha) {
        return true;
    }
    // An expired creation entry cannot establish whether this branch had work.
    // Keep it rather than infer a landing from incomplete history.
    if !subject.starts_with("branch: Created from ") {
        return true;
    }
    entries.iter().all(|entry| {
        entry.split_once('\t').is_some_and(|(_, subject)| {
            subject.starts_with("mabo sync: fast-forward to ")
                && subject.ends_with(": Fast-forward")
        })
    }) && is_ancestor(git_root, branch, base)
}

fn branch_tip(git_root: &Path, branch: &str) -> Option<String> {
    let spec = format!("{branch}^{{commit}}");
    let Ok(tip) = git(git_root, &["rev-parse", "--verify", "--quiet", &spec]) else {
        return None;
    };
    if tip.code != 0 {
        return None;
    }
    let tip_sha = tip.stdout.trim();
    if tip_sha.is_empty() {
        None
    } else {
        Some(tip_sha.to_string())
    }
}

fn is_ancestor(git_root: &Path, tip: &str, base: &str) -> bool {
    git(git_root, &["merge-base", "--is-ancestor", tip, base])
        .is_ok_and(|captured| captured.code == 0)
}

fn git(git_root: &Path, args: &[&str]) -> Result<process::Captured> {
    process::raw("git", args, Some(git_root))
}

fn hold_untrusted(verdict: Verdict) -> Verdict {
    match verdict {
        Verdict::Remove(Removal::Delete {
            subject, reasons, ..
        }) => Verdict::Skip {
            subject,
            reasons,
            hold: Hold::Untrusted,
        },
        other => other,
    }
}

fn hold_detail(context: &Context, hold: Hold, subject: &Subject) -> String {
    let (status, permission) = match hold {
        Hold::Dirty => ("dirty", "--discard-changes"),
        Hold::Unpushed => ("unpreserved", "--delete-unpreserved-branch"),
        _ => return hold.detail().to_string(),
    };
    let root = crate::allocation::shell_quote(context.git_root.as_os_str());
    // Names observed in Git need not be legal or unique user selectors. Links
    // can still select a missing checkout; verify each candidate independently.
    let mut candidates = vec![subject.name.clone()];
    if let Ok(records) = metadata::load_strict(&context.git_root) {
        if let Some(record) = records.get(&metadata::path_key(&subject.path)) {
            for (kind, link) in [("pr", &record.links.pr), ("issue", &record.links.issue)] {
                if let Some(link) = link {
                    if let Some(number) = link.number {
                        candidates.push(format!("{kind}:{number}"));
                    }
                    if let Some(url) = &link.url {
                        candidates.push(url.clone());
                    }
                }
            }
        }
    }
    let selector = candidates.into_iter().find(|candidate| {
        crate::selectors::resolve_including_orphaned(context, candidate, false, None)
            .is_ok_and(|tree| paths::same_location(Path::new(&tree.path), &subject.path))
    });
    let command = if let Some(selector) = selector {
        let selector = crate::allocation::shell_quote(std::ffi::OsStr::new(&selector));
        format!("mabo -R {root} remove {permission} -- {selector}")
    } else if subject.path.is_dir() {
        let path = crate::allocation::shell_quote(subject.path.as_os_str());
        format!("(cd {path} && mabo -R {root} remove . {permission})")
    } else {
        // There is nowhere to cd and no unambiguous mabo selector. Git accepts
        // the exact missing path and removes only this registration. A remaining
        // metadata record can be cleaned by a subsequent orphan gc.
        let path = crate::allocation::shell_quote(subject.path.as_os_str());
        return format!(
            "{status}; directory missing; Git removal discards this workspace registration and its HEAD reflog; use git -C {root} worktree remove --force -- {path}"
        );
    };
    format!("{status}; use {command}")
}

fn preview(context: &Context, verdict: Verdict) -> CandidateEntry {
    match verdict {
        Verdict::Remove(removal) => entry_from_removal(&removal, Action::WouldRemove, None, None),
        Verdict::Skip {
            subject,
            reasons,
            hold,
        } => CandidateEntry {
            name: subject.name.clone(),
            path: subject.path.display().to_string(),
            branch: subject.branch.clone(),
            reasons,
            action: Action::Skipped,
            detail: Some(hold_detail(context, hold, &subject)),
            branch_deleted: None,
            workspace: serde_json::Value::Null,
            changed: false,
        },
    }
}

fn apply_verdict(
    context: &Context,
    request: &Request,
    logger: &Logger,
    verdict: Verdict,
) -> CandidateEntry {
    match verdict {
        Verdict::Skip {
            subject,
            reasons,
            hold,
        } => CandidateEntry {
            name: subject.name.clone(),
            path: subject.path.display().to_string(),
            branch: subject.branch.clone(),
            reasons,
            action: Action::Skipped,
            detail: Some(hold_detail(context, hold, &subject)),
            branch_deleted: None,
            workspace: serde_json::Value::Null,
            changed: false,
        },
        Verdict::Remove(Removal::Delete { subject, reasons }) => {
            apply_delete(context, request, logger, subject, reasons)
        }
        Verdict::Remove(Removal::DropRegistration {
            subject, reasons, ..
        }) => apply_drop(context, request, subject, reasons),
    }
}

fn apply_delete(
    context: &Context,
    request: &Request,
    logger: &Logger,
    subject: Subject,
    reasons: Vec<Reason>,
) -> CandidateEntry {
    let info = match worktree::worktree_at_path(context, &subject.path) {
        Ok(info) => info,
        Err(error) => {
            return failed(subject, reasons, error.to_string());
        }
    };
    let options = worktree::RemoveOptions {
        discard_changes: false,
        keep_branch: request.keep_branch,
        delete_unpreserved_branch: false,
    };
    let plan = match worktree::preflight_remove_named(
        context,
        &info.name,
        &options,
        Some(&subject.path),
    ) {
        Ok(plan) => plan,
        Err(error) => return removal_failure(context, subject, reasons, error.error),
    };
    match worktree::commit_remove_checked(
        context,
        plan,
        &options,
        logger,
        crate::trust::HookControl {
            no_hooks: request.no_hooks,
            json: false,
            prompt: false,
        },
        || {
            let facts = gather(context, &request.policy, Some(&subject.path))?;
            for verdict in classify(&facts, &request.policy) {
                match verdict {
                    Verdict::Remove(Removal::Delete {
                        subject: current, ..
                    }) if current.path == subject.path => return Ok(()),
                    Verdict::Skip {
                        subject: current,
                        hold,
                        ..
                    } if current.path == subject.path => {
                        let code = match hold {
                            Hold::Dirty => "dirty",
                            Hold::Unpushed => "unpreserved",
                            Hold::Untrusted => "untrusted",
                            _ => "refused",
                        };
                        return Err(Error::Status {
                            code,
                            message: hold_detail(context, hold, &subject),
                        });
                    }
                    _ => {}
                }
            }
            Err(Error::msg(
                "Workspace no longer qualifies for gc after pre-remove commands",
            ))
        },
    ) {
        Ok(outcome) => {
            let failed_metadata =
                outcome.metadata_error.is_some() || outcome.branch_error.is_some();
            CandidateEntry {
                name: subject.name.clone(),
                path: subject.path.display().to_string(),
                branch: subject.branch,
                reasons,
                action: if failed_metadata {
                    Action::Failed
                } else {
                    Action::Removed
                },
                detail: outcome.metadata_error.or(outcome.branch_error),
                branch_deleted: Some(outcome.branch_deleted),
                workspace: serde_json::Value::Null,
                changed: true,
            }
        }
        Err(error) => removal_failure(context, subject, reasons, error.error),
    }
}

fn removal_failure(
    context: &Context,
    subject: Subject,
    reasons: Vec<Reason>,
    error: Error,
) -> CandidateEntry {
    let hold = match error.json_code(error.exit_code()) {
        "dirty" => Some(Hold::Dirty),
        "unpreserved" => Some(Hold::Unpushed),
        "untrusted" => Some(Hold::Untrusted),
        _ => None,
    };
    if let Some(hold) = hold {
        return preview(
            context,
            Verdict::Skip {
                subject,
                reasons,
                hold,
            },
        );
    }
    failed(subject, reasons, error.to_string())
}

fn apply_drop(
    context: &Context,
    request: &Request,
    subject: Subject,
    reasons: Vec<Reason>,
) -> CandidateEntry {
    let facts = match gather(context, &request.policy, Some(&subject.path)) {
        Ok(facts) => facts,
        Err(error) => return failed(subject, reasons, error.to_string()),
    };
    // The path can be reused while earlier targets run project hooks.
    // Never apply another branch's safety verdict to the planned branch.
    if facts.iter().any(|facts| {
        facts.subject.path == subject.path
            && (facts.subject.branch != subject.branch || facts.subject.head != subject.head)
    }) {
        return CandidateEntry {
            name: subject.name.clone(),
            path: subject.path.display().to_string(),
            branch: subject.branch,
            reasons,
            action: Action::Skipped,
            detail: Some("Workspace branch or HEAD changed since gc planning".into()),
            branch_deleted: None,
            workspace: serde_json::Value::Null,
            changed: false,
        };
    }
    let fresh = classify(&facts, &request.policy);
    let Some((git_listed, _unpushed, _branch_missing)) =
        fresh.iter().find_map(|verdict| match verdict {
            Verdict::Remove(Removal::DropRegistration {
                subject: current,
                git_listed,
                unpushed,
                branch_missing,
                ..
            }) if current.path == subject.path => Some((*git_listed, *unpushed, *branch_missing)),
            _ => None,
        })
    else {
        return failed(
            subject,
            reasons,
            "Workspace no longer qualifies for gc".into(),
        );
    };
    if git_listed {
        if let Err(error) = unregister(&context.git_root, &subject.path) {
            return failed(subject, reasons, error.to_string());
        }
    }
    if let Err(error) = metadata::remove(&context.git_root, &subject.path) {
        return CandidateEntry {
            name: subject.name.clone(),
            path: subject.path.display().to_string(),
            branch: subject.branch,
            reasons,
            action: Action::Failed,
            detail: Some(error.to_string()),
            branch_deleted: Some(false),
            workspace: serde_json::Value::Null,
            changed: git_listed,
        };
    }
    let (branch_deleted, detail) = (false, None);
    CandidateEntry {
        name: subject.name.clone(),
        path: subject.path.display().to_string(),
        branch: subject.branch,
        reasons,
        action: Action::Removed,
        detail,
        branch_deleted: Some(branch_deleted),
        workspace: serde_json::Value::Null,
        changed: true,
    }
}

fn unregister(git_root: &Path, path: &Path) -> Result<()> {
    match git::remove_worktree(git_root, path, true) {
        Ok(()) => Ok(()),
        Err(error) if error.to_string().contains("not a working tree") => Ok(()),
        Err(error) => Err(error),
    }
}

fn failed(subject: Subject, reasons: Vec<Reason>, detail: String) -> CandidateEntry {
    CandidateEntry {
        name: subject.name.clone(),
        path: subject.path.display().to_string(),
        branch: subject.branch,
        reasons,
        action: Action::Failed,
        detail: Some(detail),
        branch_deleted: None,
        workspace: serde_json::Value::Null,
        changed: false,
    }
}

fn entry_from_removal(
    removal: &Removal,
    action: Action,
    detail: Option<String>,
    branch_deleted: Option<bool>,
) -> CandidateEntry {
    let (subject, reasons) = match removal {
        Removal::Delete {
            subject, reasons, ..
        }
        | Removal::DropRegistration {
            subject, reasons, ..
        } => (subject, reasons),
    };
    CandidateEntry {
        name: subject.name.clone(),
        path: subject.path.display().to_string(),
        branch: subject.branch.clone(),
        reasons: reasons.clone(),
        action,
        detail,
        branch_deleted,
        workspace: serde_json::Value::Null,
        changed: false,
    }
}

fn finish(candidates: Vec<CandidateEntry>, applied: bool, first_failure: Option<String>) -> Report {
    let mut lines = candidates.iter().map(human_line).collect::<Vec<_>>();
    lines.push(summary(&candidates, applied));
    let error = first_failure.map(|message| JsonErrorBody {
        message,
        code: "failed".to_string(),
        details: None,
    });
    Report {
        version: error::JSON_VERSION,
        applied,
        plan: !applied,
        candidates,
        lines,
        error,
    }
}

fn human_line(entry: &CandidateEntry) -> String {
    let reasons = entry
        .reasons
        .iter()
        .map(|reason| reason.label())
        .collect::<Vec<_>>()
        .join(", ");
    let verb = match entry.action {
        Action::WouldRemove => "would remove",
        Action::Removed => "removed",
        Action::Skipped => "skip",
        Action::Failed => "failed",
    };
    match &entry.detail {
        Some(detail) => format!("{verb} {} [{reasons}] {detail}", entry.name),
        None => format!("{verb} {} [{reasons}]", entry.name),
    }
}

fn summary(candidates: &[CandidateEntry], applied: bool) -> String {
    let would = candidates
        .iter()
        .filter(|entry| entry.action == Action::WouldRemove)
        .count();
    let removed = candidates
        .iter()
        .filter(|entry| entry.action == Action::Removed)
        .count();
    let skipped = candidates
        .iter()
        .filter(|entry| entry.action == Action::Skipped)
        .count();
    let failed = candidates
        .iter()
        .filter(|entry| entry.action == Action::Failed)
        .count();
    if !applied {
        if would == 0 && skipped == 0 {
            return "Nothing to clean up.".to_string();
        }
        if would == 0 {
            return format!("Dry run. Nothing would be removed. {skipped} skipped.");
        }
        return format!(
            "Dry run. {would} would be removed, {skipped} skipped. Re-run with --apply to remove them."
        );
    }
    if removed == 0 && skipped == 0 && failed == 0 {
        return "Nothing to clean up.".to_string();
    }
    format!("Removed {removed}. Skipped {skipped}. Failed {failed}.")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn policy() -> Policy {
        Policy {
            selection: selection_from_flags(false, false, false, None),
            now: SystemTime::UNIX_EPOCH,
        }
    }

    fn feature() -> WorktreeFacts {
        WorktreeFacts {
            subject: Subject {
                path: PathBuf::from("/repo/.git/maboroshi/worktrees/feature"),
                name: "feature".to_string(),
                branch: Some("feature".to_string()),
                head: None,
            },
            registered: true,
            directory: DirState::Present,
            prunable: false,
            branch_missing: false,
            is_default: false,
            is_current: false,
            locked: false,
            dirty: Dirty::Clean,
            unpushed: Some(false),
            merged: true,
            pr: PullRequestState::Unlinked,
            created_at: None,
        }
    }

    #[test]
    fn duration_units_and_rejections() {
        assert_eq!(
            parse_duration("14d").expect("days"),
            Duration::from_secs(14 * 86_400)
        );
        assert_eq!(
            parse_duration("2W").expect("weeks"),
            Duration::from_secs(14 * 86_400)
        );
        assert_eq!(
            parse_duration("48h").expect("hours"),
            Duration::from_secs(48 * 3_600)
        );
        assert_eq!(
            parse_duration("30m").expect("minutes"),
            Duration::from_secs(1_800)
        );
        assert!(parse_duration("0d").is_err());
        assert!(parse_duration("14").is_err());
        assert!(parse_duration("1.5d").is_err());
        assert_eq!(
            parse_duration("0d").expect_err("zero").exit_code(),
            error::VALIDATION
        );
    }

    #[test]
    fn default_selection_omits_age_and_flags_replace_it() {
        let defaults = selection_from_flags(false, false, false, None);
        assert!(defaults.merged && defaults.pull_request && defaults.orphaned);
        assert!(defaults.older_than.is_none());
        let age_only = selection_from_flags(false, false, false, Some(Duration::from_secs(60)));
        assert!(age_only.merged && age_only.pull_request && age_only.orphaned);
        assert!(age_only.older_than.is_some());
    }

    #[test]
    fn merged_clean_worktree_is_removed_and_a_dirty_one_is_skipped() {
        let clean = classify(&[feature()], &policy());
        assert!(matches!(
            clean.as_slice(),
            [Verdict::Remove(Removal::Delete { .. })]
        ));
        let mut dirty = feature();
        dirty.dirty = Dirty::Changed;
        let skipped = classify(&[dirty], &policy());
        assert!(matches!(
            skipped.as_slice(),
            [Verdict::Skip {
                hold: Hold::Dirty,
                ..
            }]
        ));
    }

    #[test]
    fn unpushed_and_unknown_commits_hold_a_live_worktree() {
        let mut local = feature();
        local.merged = false;
        local.unpushed = Some(true);
        local.pr = PullRequestState::ClosedOrMerged;
        assert!(matches!(
            classify(&[local], &policy()).as_slice(),
            [Verdict::Skip {
                hold: Hold::Unpushed,
                ..
            }]
        ));
        let mut unknown = feature();
        unknown.unpushed = None;
        assert!(matches!(
            classify(&[unknown], &policy()).as_slice(),
            [Verdict::Skip {
                hold: Hold::Unpushed,
                ..
            }]
        ));
    }

    #[test]
    fn age_alone_cannot_select_a_workspace() {
        let mut old = feature();
        old.merged = false;
        old.created_at = Some(SystemTime::UNIX_EPOCH);
        let mut aged = policy();
        aged.selection = selection_from_flags(false, false, false, Some(Duration::from_secs(60)));
        aged.now = SystemTime::UNIX_EPOCH + Duration::from_secs(120);
        assert!(classify(&[old], &aged).is_empty());
    }

    #[test]
    fn current_and_locked_worktrees_stay() {
        let mut current = feature();
        current.is_current = true;
        let forced = policy();
        assert!(matches!(
            classify(&[current], &forced).as_slice(),
            [Verdict::Skip {
                hold: Hold::Protected,
                ..
            }]
        ));
        let mut locked = feature();
        locked.locked = true;
        assert!(matches!(
            classify(&[locked], &forced).as_slice(),
            [Verdict::Skip {
                hold: Hold::Locked,
                ..
            }]
        ));
    }

    #[test]
    fn missing_directory_drops_the_registration_and_age_uses_creation() {
        let mut gone = feature();
        gone.directory = DirState::Absent;
        gone.prunable = true;
        gone.merged = false;
        assert!(matches!(
            classify(&[gone], &policy()).as_slice(),
            [Verdict::Remove(Removal::DropRegistration {
                git_listed: true,
                ..
            })]
        ));

        let mut record = feature();
        record.registered = false;
        record.directory = DirState::Absent;
        record.merged = false;
        record.branch_missing = false;
        record.prunable = false;
        assert!(matches!(
            classify(&[record], &policy()).as_slice(),
            [Verdict::Remove(Removal::DropRegistration {
                git_listed: false,
                ..
            })]
        ));

        let mut recent = feature();
        recent.merged = false;
        recent.created_at = Some(SystemTime::UNIX_EPOCH + Duration::from_secs(1_000));
        let mut aged = policy();
        aged.now = SystemTime::UNIX_EPOCH + Duration::from_secs(1_500);
        aged.selection =
            selection_from_flags(false, false, false, Some(Duration::from_secs(1_000)));
        assert!(classify(&[recent], &aged).is_empty());
    }

    #[test]
    fn open_pull_request_does_not_match() {
        let mut open = feature();
        open.merged = false;
        open.pr = PullRequestState::Open;
        assert!(classify(&[open], &policy()).is_empty());

        let mut closed = feature();
        closed.merged = false;
        closed.unpushed = Some(false);
        closed.pr = PullRequestState::ClosedOrMerged;
        assert!(matches!(
            classify(&[closed], &policy()).as_slice(),
            [Verdict::Remove(Removal::Delete { .. })]
        ));

        let mut unavailable = feature();
        unavailable.merged = false;
        unavailable.pr = PullRequestState::Unavailable;
        assert!(matches!(
            classify(&[unavailable], &policy()).as_slice(),
            [Verdict::Skip {
                hold: Hold::PrUnavailable,
                ..
            }]
        ));
    }
}
