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
    pub force: bool,
    /// `MABO_AGENT_ID` after trimming. Empty and unset are `None`.
    pub agent_id: Option<String>,
    pub owner_filter: Option<String>,
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
    OlderThan,
}

impl Reason {
    fn label(self) -> &'static str {
        match self {
            Self::Merged => "merged",
            Self::PullRequest => "pullRequest",
            Self::Orphaned => "orphaned",
            Self::OlderThan => "olderThan",
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
    pub owner: Option<String>,
    pub reasons: Vec<Reason>,
    pub action: Action,
    pub detail: Option<String>,
    pub branch_deleted: Option<bool>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub version: u32,
    pub applied: bool,
    pub candidates: Vec<CandidateEntry>,
    #[serde(skip)]
    pub lines: Vec<String>,
    pub error: Option<JsonErrorBody>,
}

impl Report {
    pub fn exit_code(&self) -> i32 {
        if self.error.is_some() {
            error::GENERAL
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
    if !merged && !pull_request && !orphaned && older_than.is_none() {
        return Selection {
            merged: true,
            pull_request: true,
            orphaned: true,
            older_than: None,
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
    let facts = gather(context, &request.policy)?;
    warn_unavailable_pull_requests(&facts, &request.policy);
    let verdicts = classify(&facts, &request.policy);
    let skip_untrusted = crate::trust::blocks_gc(
        &context.git_root,
        crate::config::pre_delete_commands(context.config.as_ref()),
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
        let entry = if request.apply {
            apply_verdict(context, request, logger, verdict)
        } else {
            preview(verdict)
        };
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
    owner: Option<String>,
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
    /// `Some(true)` means commits on the tip are outside the default branch and
    /// outside every remote-tracking ref, and they are not already landed there.
    /// `None` means the query did not run.
    unpushed: Option<bool>,
    /// Set when this tip is exactly a merged `refs/pull/<n>/head`.
    published_tip: Option<String>,
    merged: bool,
    pr: PullRequestState,
    last_used_at: Option<SystemTime>,
    created_at: Option<SystemTime>,
}

#[derive(Clone, Copy)]
enum Hold {
    Protected,
    DefaultBranch,
    Locked,
    OtherAgent,
    StatusUnknown,
    Dirty,
    Unpushed,
    PrUnavailable,
    Untrusted,
}

impl Hold {
    fn detail(self) -> &'static str {
        match self {
            Self::Protected => "current worktree",
            Self::DefaultBranch => "default branch",
            Self::Locked => "locked",
            Self::PrUnavailable => "pr status unavailable",
            Self::OtherAgent => "other agent",
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
        published_tip: Option<String>,
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
    qualifies_other_agent: bool,
    matches: fn(&WorktreeFacts, &Policy) -> bool,
}

static CRITERIA: &[Criterion] = &[
    Criterion {
        reason: Reason::Merged,
        qualifies_other_agent: true,
        matches: |facts, _| facts.merged,
    },
    Criterion {
        reason: Reason::PullRequest,
        qualifies_other_agent: true,
        matches: |facts, _| facts.pr == PullRequestState::ClosedOrMerged,
    },
    Criterion {
        reason: Reason::Orphaned,
        qualifies_other_agent: true,
        matches: |facts, _| orphaned(facts),
    },
    Criterion {
        reason: Reason::OlderThan,
        qualifies_other_agent: false,
        matches: |facts, policy| age_hit(facts, policy),
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
    let Some(anchor) = facts.last_used_at.or(facts.created_at) else {
        return false;
    };
    policy
        .now
        .duration_since(anchor)
        .is_ok_and(|elapsed| elapsed >= limit)
}

fn owner_in_scan(owner: Option<&str>, policy: &Policy) -> bool {
    match &policy.owner_filter {
        Some(wanted) => owner == Some(wanted.as_str()),
        None => true,
    }
}

fn is_other_agent(facts: &WorktreeFacts, policy: &Policy) -> bool {
    if policy.owner_filter.is_some() {
        return false;
    }
    let Some(owner) = facts.subject.owner.as_deref() else {
        return false;
    };
    match &policy.agent_id {
        None => true,
        Some(agent) => owner != agent,
    }
}

fn classify(facts: &[WorktreeFacts], policy: &Policy) -> Vec<Verdict> {
    let mut verdicts = Vec::new();
    for facts in facts {
        if !owner_in_scan(facts.subject.owner.as_deref(), policy) {
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
        if let Some(hold) = hold(facts, policy, &reasons) {
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
            Reason::OlderThan => self.older_than.is_some(),
        }
    }
}

fn hold(facts: &WorktreeFacts, policy: &Policy, reasons: &[Reason]) -> Option<Hold> {
    if facts.is_default {
        return Some(Hold::DefaultBranch);
    }
    if facts.is_current {
        return Some(Hold::Protected);
    }
    if facts.locked {
        return Some(Hold::Locked);
    }
    if is_other_agent(facts, policy) && !qualifies_other_agent(reasons) {
        return Some(Hold::OtherAgent);
    }
    if facts.directory == DirState::Unknown && !(policy.force && facts.registered) {
        return Some(Hold::StatusUnknown);
    }
    if facts.dirty == Dirty::Unknown && !policy.force {
        return Some(Hold::StatusUnknown);
    }
    if facts.dirty == Dirty::Changed && !policy.force {
        return Some(Hold::Dirty);
    }
    if facts.unpushed != Some(false)
        && facts.registered
        && facts.directory == DirState::Present
        && !policy.force
    {
        return Some(Hold::Unpushed);
    }
    None
}

fn qualifies_other_agent(reasons: &[Reason]) -> bool {
    CRITERIA
        .iter()
        .any(|row| row.qualifies_other_agent && reasons.contains(&row.reason))
}

fn removal_kind(facts: &WorktreeFacts, reasons: Vec<Reason>) -> Removal {
    let subject = facts.subject.clone();
    if facts.registered && facts.directory == DirState::Present {
        return Removal::Delete {
            subject,
            reasons,
            published_tip: facts.published_tip.clone(),
        };
    }
    Removal::DropRegistration {
        subject,
        reasons,
        git_listed: facts.registered,
        unpushed: facts.unpushed,
        branch_missing: facts.branch_missing,
    }
}

fn gather(context: &Context, policy: &Policy) -> Result<Vec<WorktreeFacts>> {
    let stored = metadata::load(&context.git_root)?;
    let common_dir = git::canonical_common_dir(&context.git_root)?;
    let listed = git::list_worktrees(&context.git_root)
        .map_err(|error| Error::msg(format!("Failed to list worktrees: {error}")))?;
    let base = git::default_branch(&context.git_root)?;
    let current = current_worktree_path(context);
    let mut pull_requests = BTreeMap::new();
    let mut rows = BTreeMap::new();
    for worktree in listed {
        let path = PathBuf::from(&worktree.path);
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
        if !owner_in_scan(record.and_then(|record| record.owner.as_deref()), policy) {
            continue;
        }
        let mut facts = observe_listed(
            context,
            policy,
            &base,
            current.as_deref(),
            &worktree,
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
        if rows.contains_key(key) || !owner_in_scan(record.owner.as_deref(), policy) {
            continue;
        }
        let path = PathBuf::from(key);
        if paths::normalize(&path) == paths::normalize(&context.git_root) {
            continue;
        }
        if directory_state(&path) != DirState::Absent {
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

fn observe_listed(
    context: &Context,
    policy: &Policy,
    base: &Option<String>,
    current: Option<&Path>,
    worktree: &git::GitWorktree,
    record: Option<&WorktreeMetadata>,
    pull_requests: &mut BTreeMap<String, PullRequestStatus>,
) -> WorktreeFacts {
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
    let reachability = git::tip_reachability(
        &context.git_root,
        branch.as_deref(),
        worktree.head.as_deref(),
        base,
    );
    let merged = match (&branch, base) {
        (Some(name), Some(base_name)) => {
            let moved = !still_at_creation_point(&context.git_root, name, created_from);
            let ancestor = is_ancestor(&context.git_root, name, base_name);
            moved && (ancestor || reachability.landed)
        }
        _ => false,
    };
    let is_default = match (&branch, base) {
        (Some(branch), Some(base)) => branch == local_default_name(base),
        _ => false,
    };
    let unpushed = reachability.unpushed;
    let pr_link = record.and_then(|item| item.links.pr.as_ref());
    let pr = pull_state(policy, &context.git_root, pr_link, pull_requests);
    let published_tip = merged_pull_head(
        policy,
        &context.git_root,
        pr_link,
        worktree.head.as_deref(),
        unpushed,
        pull_requests,
    );
    let unpushed = if published_tip.is_some() {
        Some(false)
    } else {
        unpushed
    };
    let dirty = match directory {
        DirState::Absent => Dirty::Absent,
        DirState::Unknown => Dirty::Unknown,
        DirState::Present => match git::status_count(&path) {
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
            owner: metadata.owner.clone(),
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
        published_tip,
        merged,
        pr,
        last_used_at: metadata.last_used_at.as_deref().and_then(parse_time),
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
            owner: record.owner.clone(),
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
        published_tip: None,
        merged: false,
        pr: pull_state(
            policy,
            &context.git_root,
            record.links.pr.as_ref(),
            pull_requests,
        ),
        last_used_at: record.last_used_at.as_deref().and_then(parse_time),
        created_at: record.created_at.as_deref().and_then(parse_time),
    }
}

/// A merged pull request whose worktree is still exactly `refs/pull/<n>/head`.
/// Local commits on top stay unpushed.
fn merged_pull_head(
    policy: &Policy,
    git_root: &Path,
    link: Option<&WorktreeLink>,
    head: Option<&str>,
    unpushed: Option<bool>,
    pull_requests: &BTreeMap<String, PullRequestStatus>,
) -> Option<String> {
    if unpushed != Some(true) || !policy.selection.pull_request {
        return None;
    }
    let link = link?;
    let number = link.number?;
    let query = pull_request_query(git_root, link)?;
    if pull_requests.get(&query.key).copied() != Some(PullRequestStatus::Merged) {
        return None;
    }
    let pull_head = git::remote_pull_head(git_root, number)?;
    let head = head?.trim();
    if !head.eq_ignore_ascii_case(pull_head.trim()) {
        return None;
    }
    Some(pull_head)
}

fn warn_unavailable_pull_requests(facts: &[WorktreeFacts], policy: &Policy) {
    if !policy.selection.pull_request {
        return;
    }
    for facts in facts {
        if facts.pr == PullRequestState::Unavailable {
            eprintln!(
                "Warning: pull request status unavailable for {}",
                facts.subject.name
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

fn local_default_name(base: &str) -> &str {
    base.strip_prefix("origin/").unwrap_or(base)
}

fn still_at_creation_point(git_root: &Path, branch: &str, created_from: Option<&str>) -> bool {
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
    let Ok(reflog) = git(git_root, &["reflog", "show", "--format=%H", &spec]) else {
        return false;
    };
    if reflog.code != 0 {
        return false;
    }
    let Some(oldest) = reflog
        .stdout
        .lines()
        .next_back()
        .map(str::trim)
        .filter(|line| !line.is_empty())
    else {
        return false;
    };
    oldest.eq_ignore_ascii_case(&tip_sha)
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
    let Ok(captured) = git(git_root, &["merge-base", "--is-ancestor", tip, base]) else {
        return false;
    };
    captured.code == 0
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

fn preview(verdict: Verdict) -> CandidateEntry {
    match verdict {
        Verdict::Remove(removal) => entry_from_removal(&removal, Action::WouldRemove, None, None),
        Verdict::Skip {
            subject,
            reasons,
            hold,
        } => CandidateEntry {
            name: subject.name,
            path: subject.path.display().to_string(),
            branch: subject.branch,
            owner: subject.owner,
            reasons,
            action: Action::Skipped,
            detail: Some(hold.detail().to_string()),
            branch_deleted: None,
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
            name: subject.name,
            path: subject.path.display().to_string(),
            branch: subject.branch,
            owner: subject.owner,
            reasons,
            action: Action::Skipped,
            detail: Some(hold.detail().to_string()),
            branch_deleted: None,
        },
        Verdict::Remove(Removal::Delete {
            subject,
            reasons,
            published_tip,
        }) => apply_delete(context, request, logger, subject, reasons, published_tip),
        Verdict::Remove(Removal::DropRegistration {
            subject,
            reasons,
            git_listed,
            unpushed,
            branch_missing,
        }) => apply_drop(
            context,
            request,
            subject,
            reasons,
            git_listed,
            unpushed,
            branch_missing,
        ),
    }
}

fn apply_delete(
    context: &Context,
    request: &Request,
    logger: &Logger,
    subject: Subject,
    reasons: Vec<Reason>,
    published_tip: Option<String>,
) -> CandidateEntry {
    let info = match worktree::worktree_at_path(context, &subject.path) {
        Ok(info) => info,
        Err(error) => {
            return failed(subject, reasons, error.to_string());
        }
    };
    match worktree::delete_worktree(
        context,
        &info.name,
        &worktree::DeleteOptions {
            force: request.policy.force,
            keep_branch: request.keep_branch,
            allow_current: false,
            published_tip,
        },
        Some(&subject.path),
        logger,
        crate::trust::HookControl {
            no_hooks: request.no_hooks,
            json: false,
            prompt: false,
        },
    ) {
        Ok(outcome) => {
            let failed_metadata = outcome.metadata_error.is_some();
            CandidateEntry {
                name: subject.name,
                path: subject.path.display().to_string(),
                branch: subject.branch,
                owner: subject.owner,
                reasons,
                action: if failed_metadata {
                    Action::Failed
                } else {
                    Action::Removed
                },
                detail: outcome.metadata_error.or(outcome.branch_error),
                branch_deleted: Some(outcome.branch_deleted),
            }
        }
        Err(error) if matches!(error.error, Error::Untrusted(_)) => CandidateEntry {
            name: subject.name,
            path: subject.path.display().to_string(),
            branch: subject.branch,
            owner: subject.owner,
            reasons,
            action: Action::Skipped,
            detail: Some(Hold::Untrusted.detail().to_string()),
            branch_deleted: None,
        },
        Err(error) => failed(subject, reasons, error.error.to_string()),
    }
}

fn apply_drop(
    context: &Context,
    request: &Request,
    subject: Subject,
    reasons: Vec<Reason>,
    git_listed: bool,
    unpushed: Option<bool>,
    branch_missing: bool,
) -> CandidateEntry {
    if git_listed {
        if let Err(error) = unregister(&context.git_root, &subject.path) {
            return failed(subject, reasons, error.to_string());
        }
    }
    if let Err(error) = metadata::remove(&context.git_root, &subject.path) {
        return CandidateEntry {
            name: subject.name,
            path: subject.path.display().to_string(),
            branch: subject.branch,
            owner: subject.owner,
            reasons,
            action: Action::Failed,
            detail: Some(error.to_string()),
            branch_deleted: Some(false),
        };
    }
    let (branch_deleted, detail) =
        drop_branch(context, request, &subject, unpushed, branch_missing);
    CandidateEntry {
        name: subject.name,
        path: subject.path.display().to_string(),
        branch: subject.branch,
        owner: subject.owner,
        reasons,
        action: Action::Removed,
        detail,
        branch_deleted: Some(branch_deleted),
    }
}

fn drop_branch(
    context: &Context,
    request: &Request,
    subject: &Subject,
    unpushed: Option<bool>,
    branch_missing: bool,
) -> (bool, Option<String>) {
    let Some(branch) = subject.branch.as_deref() else {
        return (false, None);
    };
    if branch_missing || request.keep_branch {
        return (false, None);
    }
    if unpushed != Some(false) && !request.policy.force {
        let detail = if unpushed == Some(true) {
            "kept the branch because it has unpushed commits"
        } else {
            "kept the branch because its commits could not be checked"
        };
        return (false, Some(detail.to_string()));
    }
    match git::delete_branch(&context.git_root, branch) {
        Ok(()) => (true, None),
        Err(error) => (false, Some(error.to_string())),
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
        name: subject.name,
        path: subject.path.display().to_string(),
        branch: subject.branch,
        owner: subject.owner,
        reasons,
        action: Action::Failed,
        detail: Some(detail),
        branch_deleted: None,
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
        owner: subject.owner.clone(),
        reasons: reasons.clone(),
        action,
        detail,
        branch_deleted,
    }
}

fn finish(candidates: Vec<CandidateEntry>, applied: bool, first_failure: Option<String>) -> Report {
    let mut lines = candidates.iter().map(human_line).collect::<Vec<_>>();
    lines.push(summary(&candidates, applied));
    let error = first_failure.map(|message| JsonErrorBody {
        message,
        code: "error".to_string(),
        exit_code: error::GENERAL,
    });
    Report {
        version: error::JSON_VERSION,
        applied,
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
            force: false,
            agent_id: None,
            owner_filter: None,
        }
    }

    fn feature() -> WorktreeFacts {
        WorktreeFacts {
            subject: Subject {
                path: PathBuf::from("/repo/.git/maboroshi/worktrees/feature"),
                name: "feature".to_string(),
                branch: Some("feature".to_string()),
                owner: None,
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
            published_tip: None,
            last_used_at: None,
            created_at: None,
        }
    }

    fn removal_name(verdicts: &[Verdict]) -> Option<&str> {
        match verdicts {
            [Verdict::Remove(removal)] => Some(match removal {
                Removal::Delete { subject, .. } | Removal::DropRegistration { subject, .. } => {
                    subject.name.as_str()
                }
            }),
            _ => None,
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
        assert!(!age_only.merged && !age_only.pull_request && !age_only.orphaned);
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
        let mut forced = policy();
        forced.force = true;
        let mut dirty = feature();
        dirty.dirty = Dirty::Changed;
        assert!(matches!(
            classify(&[dirty], &forced).as_slice(),
            [Verdict::Remove(Removal::Delete { .. })]
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
    fn other_agents_are_kept_unless_merged_orphaned_or_closed() {
        let mut old = feature();
        old.merged = false;
        old.subject.owner = Some("other".to_string());
        old.last_used_at = Some(SystemTime::UNIX_EPOCH);
        let mut aged = policy();
        aged.selection = selection_from_flags(false, false, false, Some(Duration::from_secs(60)));
        aged.now = SystemTime::UNIX_EPOCH + Duration::from_secs(120);
        assert!(matches!(
            classify(&[old.clone()], &aged).as_slice(),
            [Verdict::Skip {
                hold: Hold::OtherAgent,
                ..
            }]
        ));
        let mut named = aged.clone();
        named.owner_filter = Some("other".to_string());
        assert!(matches!(
            classify(&[old], &named).as_slice(),
            [Verdict::Remove(Removal::Delete { .. })]
        ));

        let mut merged = feature();
        merged.subject.owner = Some("other".to_string());
        assert_eq!(
            removal_name(&classify(&[merged], &policy())),
            Some("feature")
        );
    }

    #[test]
    fn current_and_locked_worktrees_stay() {
        let mut current = feature();
        current.is_current = true;
        let mut forced = policy();
        forced.force = true;
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
    fn missing_directory_drops_the_registration_and_age_uses_last_used() {
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
        recent.last_used_at = Some(SystemTime::UNIX_EPOCH + Duration::from_secs(1_000));
        recent.created_at = Some(SystemTime::UNIX_EPOCH);
        let mut aged = policy();
        aged.now = SystemTime::UNIX_EPOCH + Duration::from_secs(1_500);
        aged.selection =
            selection_from_flags(false, false, false, Some(Duration::from_secs(1_000)));
        assert!(classify(&[recent], &aged).is_empty());
    }

    #[test]
    fn open_pull_request_does_not_match_and_owner_filter_omits_others() {
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

        let mut mine = feature();
        mine.subject.owner = Some("me".to_string());
        let mut other = feature();
        other.subject.name = "other".to_string();
        other.subject.owner = Some("other".to_string());
        let mut filtered = policy();
        filtered.owner_filter = Some("me".to_string());
        let verdicts = classify(&[mine, other], &filtered);
        assert_eq!(removal_name(&verdicts), Some("feature"));
    }
}
