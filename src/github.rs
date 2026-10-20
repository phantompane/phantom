use std::path::Path;

use serde::Serialize;
use serde_json::Value;

use crate::context;
use crate::error::{self, Error, Result};
use crate::git;
use crate::metadata::{self, MetadataInput, WorktreeLink};
use crate::process;
use crate::worktree::{self, Logger, WorktreeInfo};

pub struct Checkout {
    pub message: String,
    pub worktree: String,
    pub path: std::path::PathBuf,
    pub already_exists: bool,
    pub hook_failure: Option<worktree::HookFailure>,
    pub copy_error: Option<String>,
    pub hooks_ran: bool,
    pub metadata_error: Option<String>,
    pub info: WorktreeInfo,
    pub base: Option<String>,
    pub subject: GithubSubject,
}

pub enum GithubSubject {
    PullRequest {
        number: u64,
        head_ref: String,
        source: Option<PullSource>,
    },
    Issue {
        number: u64,
    },
}

#[derive(Clone, Copy)]
pub enum PullSource {
    Branch,
    PullHead,
}

impl PullSource {
    fn json_name(self) -> &'static str {
        match self {
            Self::Branch => "branch",
            Self::PullHead => "pullHead",
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GithubCheckoutOutput {
    version: u32,
    worktree: worktree::WorktreeJson,
    github: GithubSubjectOutput,
    copy_files: worktree::CopyFilesOutcome,
    post_create: worktree::PostCreateOutcome,
    metadata: worktree::MetadataSaveOutcome,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GithubSubjectOutput {
    kind: &'static str,
    number: u64,
    head_ref: Option<String>,
    already_exists: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    source: Option<&'static str>,
}

impl Checkout {
    pub fn to_json(&self) -> Result<Value> {
        let (kind, number, head_ref, source) = match &self.subject {
            GithubSubject::PullRequest {
                number,
                head_ref,
                source,
            } => (
                "pullRequest",
                *number,
                Some(head_ref.clone()),
                source.map(PullSource::json_name),
            ),
            GithubSubject::Issue { number } => ("issue", *number, None, None),
        };
        serde_json::to_value(GithubCheckoutOutput {
            version: error::JSON_VERSION,
            worktree: self.info.to_json(self.base.clone()),
            github: GithubSubjectOutput {
                kind,
                number,
                head_ref,
                already_exists: self.already_exists,
                source,
            },
            copy_files: worktree::copy_files_outcome(self.copy_error.as_deref()),
            post_create: worktree::post_create_outcome(self.hooks_ran, self.hook_failure.as_ref()),
            metadata: worktree::metadata_save_outcome(self.metadata_error.as_deref()),
        })
        .map_err(|error| Error::msg(error.to_string()))
    }
}

pub fn checkout(
    number: &str,
    base: Option<&str>,
    logger: &Logger,
    repository: Option<&Path>,
    metadata: MetadataInput,
    hooks: crate::trust::HookControl,
) -> Result<Checkout> {
    let cwd = match repository {
        Some(path) => path.to_path_buf(),
        None => std::env::current_dir().map_err(|error| Error::msg(error.to_string()))?,
    };
    let repo = repo_info(&cwd)?;
    let issue = fetch_issue(&cwd, &repo.host, &repo.owner, &repo.name, number)?;
    let Some(issue) = issue else {
        return Err(Error::msg(format!(
            "GitHub issue or pull request #{number} not found or you don't have permission to access it."
        )));
    };
    if let Some(pull) = issue.pull_request {
        if base.is_some() {
            return Err(Error::msg(format!(
                "The --base option cannot be used with pull requests. Pull request #{number} already has a branch '{}'.",
                pull.head_ref
            )));
        }
        checkout_pull_request(&pull, &repo, logger, repository, metadata, hooks)
    } else {
        checkout_issue(
            issue.number,
            base,
            &repo,
            logger,
            repository,
            metadata,
            hooks,
        )
    }
}

struct Issue {
    number: u64,
    pull_request: Option<PullRequest>,
}

struct PullRequest {
    number: u64,
    fork: bool,
    head_ref: String,
    head_repo: String,
}

/// `refs/pull/<n>/head` still exists after GitHub deletes the head branch.
fn pull_head_refspec(number: u64, local_branch: &str) -> String {
    format!("refs/pull/{number}/head:{local_branch}")
}

enum PullFetch {
    Branch { upstream: String },
    Fork,
    DeletedHead,
}

fn fetch_pull_head(git_root: &Path, pull: &PullRequest, local_branch: &str) -> Result<PullFetch> {
    if pull.fork {
        git::fetch(
            git_root,
            "origin",
            &pull_head_refspec(pull.number, local_branch),
        )?;
        git::clear_branch_upstream(git_root, local_branch);
        return Ok(PullFetch::Fork);
    }
    if git::remote_has_branch(git_root, "origin", &pull.head_ref)? {
        match fetch_head_branch(git_root, &pull.head_ref, local_branch) {
            Ok(upstream) => return Ok(PullFetch::Branch { upstream }),
            Err(error) if missing_remote_ref(&error) => {}
            Err(error) => return Err(error),
        }
    }
    git::fetch(
        git_root,
        "origin",
        &pull_head_refspec(pull.number, local_branch),
    )?;
    git::clear_branch_upstream(git_root, local_branch);
    Ok(PullFetch::DeletedHead)
}

fn fetch_head_branch(git_root: &Path, head_ref: &str, local_branch: &str) -> Result<String> {
    let tracking = format!("+refs/heads/{head_ref}:refs/remotes/origin/{head_ref}");
    git::fetch(git_root, "origin", &tracking)?;
    let upstream = format!("origin/{head_ref}");
    git::ensure_branch(git_root, local_branch, &upstream)?;
    git::set_upstream(git_root, local_branch, &upstream)?;
    Ok(upstream)
}

fn missing_remote_ref(error: &Error) -> bool {
    error.to_string().contains("couldn't find remote ref")
}

fn checkout_pull_request(
    pull: &PullRequest,
    repo: &RepoIdentity,
    logger: &Logger,
    repository: Option<&Path>,
    mut metadata: MetadataInput,
    hooks: crate::trust::HookControl,
) -> Result<Checkout> {
    let context = context::open(repository)?;
    let git_root = &context.git_root;
    let worktree_name = if pull.fork {
        let owner = pull.head_repo.split('/').next().unwrap_or("");
        if owner.is_empty() {
            pull.head_ref.clone()
        } else {
            format!("{owner}/{}", pull.head_ref)
        }
    } else {
        pull.head_ref.clone()
    };
    metadata.pr = Some(subject_link(repo, pull.number, "pull"));
    if let Ok(existing) = worktree::find_worktree(&context, &worktree_name, false, None) {
        if existing.branch == worktree_name {
            let info = record_existing_checkout(&context, Path::new(&existing.path), &metadata)?;
            let path = info.path.clone().into();
            return Ok(Checkout {
                message: format!("PR #{} is already checked out", pull.number),
                worktree: worktree_name,
                path,
                already_exists: true,
                hook_failure: None,
                copy_error: None,
                hooks_ran: false,
                metadata_error: None,
                info,
                base: None,
                subject: GithubSubject::PullRequest {
                    number: pull.number,
                    head_ref: pull.head_ref.clone(),
                    source: None,
                },
            });
        }
    }
    let post = post_commands(&context);
    let commands = crate::trust::authorize(
        git_root,
        &post,
        crate::config::pre_delete_commands(context.config.as_ref()),
        crate::trust::HookKind::PostCreate,
        hooks,
    )?;
    metadata::prepare(git_root)?;
    let fetched = fetch_pull_head(git_root, pull, &worktree_name)?;
    let attached =
        worktree::attach_worktree(&context, &worktree_name, &[], &commands, logger, &metadata)?;
    let (message, base, source) = match fetched {
        PullFetch::Branch { upstream } => (
            format!(
                "Checked out PR #{} from branch {}",
                pull.number, pull.head_ref
            ),
            Some(upstream),
            Some(PullSource::Branch),
        ),
        PullFetch::Fork => (
            format!(
                "Checked out PR #{} from fork {}",
                pull.number, pull.head_repo
            ),
            None,
            Some(PullSource::PullHead),
        ),
        PullFetch::DeletedHead => (
            format!(
                "Checked out PR #{} from pull/{}/head (head branch deleted; no upstream)",
                pull.number, pull.number
            ),
            None,
            Some(PullSource::PullHead),
        ),
    };
    let info = worktree::worktree_at_path(&context, &attached.path)?;
    Ok(Checkout {
        message,
        worktree: worktree_name,
        path: attached.path,
        already_exists: false,
        hook_failure: attached.hook_failure,
        copy_error: attached.copy_error,
        hooks_ran: attached.hooks_ran,
        metadata_error: attached.metadata_error,
        info,
        base,
        subject: GithubSubject::PullRequest {
            number: pull.number,
            head_ref: pull.head_ref.clone(),
            source,
        },
    })
}

fn checkout_issue(
    number: u64,
    base: Option<&str>,
    repo: &RepoIdentity,
    logger: &Logger,
    repository: Option<&Path>,
    mut metadata: MetadataInput,
    hooks: crate::trust::HookControl,
) -> Result<Checkout> {
    let context = context::open(repository)?;
    let name = format!("issues/{number}");
    metadata.issue = Some(subject_link(repo, number, "issues"));
    if let Ok(existing) = worktree::find_worktree(&context, &name, false, None) {
        let info = record_existing_checkout(&context, Path::new(&existing.path), &metadata)?;
        let path = info.path.clone().into();
        return Ok(Checkout {
            message: format!("Issue #{number} is already checked out"),
            worktree: name,
            path,
            already_exists: true,
            hook_failure: None,
            copy_error: None,
            hooks_ran: false,
            metadata_error: None,
            info,
            base: None,
            subject: GithubSubject::Issue { number },
        });
    }
    let post = post_commands(&context);
    let commands = crate::trust::authorize(
        &context.git_root,
        &post,
        crate::config::pre_delete_commands(context.config.as_ref()),
        crate::trust::HookKind::PostCreate,
        hooks,
    )?;
    let base = base.unwrap_or("HEAD");
    let created =
        worktree::create_worktree(&context, &name, base, &[], &commands, logger, &metadata)?;
    let info = worktree::worktree_at_path(&context, &created.path)?;
    Ok(Checkout {
        message: format!(
            "Created worktree '{name}' at {}",
            crate::paths::canonical_location(&created.path).display()
        ),
        worktree: name,
        path: created.path,
        already_exists: false,
        hook_failure: created.hook_failure,
        copy_error: created.copy_error,
        hooks_ran: created.hooks_ran,
        metadata_error: created.metadata_error,
        info,
        base: Some(base.to_string()),
        subject: GithubSubject::Issue { number },
    })
}

/// An existing record keeps its owner, purpose, createdAt, and createdFrom.
/// Links are updated and lastUsedAt moves. A worktree with no record yet is a
/// first checkout and stores the owner. `createdFrom` is that branch's reflog
/// creation commit when the reflog exists.
fn record_existing_checkout(
    context: &context::Context,
    path: &Path,
    metadata: &MetadataInput,
) -> Result<worktree::WorktreeInfo> {
    let known = metadata::records_path(&context.git_root, path)?;
    if known {
        metadata::write(
            &context.git_root,
            path,
            &MetadataInput {
                pr: metadata.pr.clone(),
                issue: metadata.issue.clone(),
                ..MetadataInput::default()
            },
        )?;
        metadata::touch(&context.git_root, path)?;
    } else {
        let name = worktree::outside_name_to_store(context, path)?;
        metadata::write(
            &context.git_root,
            path,
            &MetadataInput {
                name,
                ..metadata.clone()
            },
        )?;
    }
    worktree::worktree_at_path(context, path)
}

fn subject_link(repo: &RepoIdentity, number: u64, kind: &str) -> WorktreeLink {
    WorktreeLink {
        number: Some(number),
        url: Some(format!(
            "https://{}/{}/{}/{kind}/{number}",
            repo.host, repo.owner, repo.name
        )),
    }
}

fn post_commands(context: &context::Context) -> Vec<String> {
    crate::config::post_create_commands(context.config.as_ref()).to_vec()
}

struct RepoIdentity {
    owner: String,
    name: String,
    /// Hostname for `gh api --hostname`, from `gh repo view`'s web `url`.
    host: String,
}

fn repo_info(cwd: &Path) -> Result<RepoIdentity> {
    let captured = process::raw(
        "gh",
        &["repo", "view", "--json", "url,owner,name"],
        Some(cwd),
    )?;
    if captured.code != 0 {
        return Err(Error::msg(format!(
            "Failed to get repository info: {}",
            first_detail(&captured)
        )));
    }
    let value: Value = serde_json::from_str(&captured.stdout)
        .map_err(|error| Error::msg(format!("Failed to get repository info: {error}")))?;
    let owner = value
        .pointer("/owner/login")
        .and_then(Value::as_str)
        .ok_or_else(|| Error::msg("Failed to get repository info: missing owner"))?;
    let name = value
        .get("name")
        .and_then(Value::as_str)
        .ok_or_else(|| Error::msg("Failed to get repository info: missing name"))?;
    let url = value
        .get("url")
        .and_then(Value::as_str)
        .ok_or_else(|| Error::msg("Failed to get repository info: missing url"))?;
    Ok(RepoIdentity {
        owner: owner.to_string(),
        name: name.to_string(),
        host: host_from_web_url(url)?,
    })
}

/// Host only, with no port, from the web URL `gh repo view` returns.
fn host_from_web_url(url: &str) -> Result<String> {
    let Some((scheme, rest)) = url.split_once("://") else {
        return Err(Error::msg(format!(
            "Failed to get repository info: url '{url}' has no host"
        )));
    };
    if !matches!(scheme, "http" | "https") {
        return Err(Error::msg(format!(
            "Failed to get repository info: url '{url}' is not an http(s) URL"
        )));
    }
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    let hostport = match authority.rsplit_once('@') {
        Some((_, host)) if !host.is_empty() => host,
        Some(_) => {
            return Err(Error::msg(format!(
                "Failed to get repository info: url '{url}' has no host"
            )))
        }
        None => authority,
    };
    let host = if let Some(inside) = hostport.strip_prefix('[') {
        let end = inside.find(']').ok_or_else(|| {
            Error::msg(format!(
                "Failed to get repository info: url '{url}' has no host"
            ))
        })?;
        &inside[..end]
    } else if let Some((host, port)) = hostport.rsplit_once(':') {
        if host.is_empty() || port.is_empty() || !port.chars().all(|char| char.is_ascii_digit()) {
            return Err(Error::msg(format!(
                "Failed to get repository info: url '{url}' has no host"
            )));
        }
        host
    } else {
        hostport
    };
    if host.is_empty() {
        return Err(Error::msg(format!(
            "Failed to get repository info: url '{url}' has no host"
        )));
    }
    Ok(host.to_ascii_lowercase())
}

fn fetch_issue(
    directory: &Path,
    host: &str,
    owner: &str,
    repo: &str,
    number: &str,
) -> Result<Option<Issue>> {
    let parsed = number.parse::<u64>().ok().filter(|value| *value > 0);
    let Some(parsed) = parsed else {
        return Err(Error::msg(format!(
            "Invalid issue or pull request number: {number}"
        )));
    };
    let path = format!("repos/{owner}/{repo}/issues/{parsed}");
    let captured = gh_api(directory, host, &path)?;
    if captured.code != 0 {
        if is_not_found(&captured) {
            return Ok(None);
        }
        return Err(Error::msg(first_detail(&captured).to_string()));
    }
    let value: Value =
        serde_json::from_str(&captured.stdout).map_err(|error| Error::msg(error.to_string()))?;
    let pull_request = if value.get("pull_request").is_some() {
        Some(fetch_pull(directory, host, owner, repo, parsed)?)
    } else {
        None
    };
    Ok(Some(Issue {
        number: parsed,
        pull_request,
    }))
}

fn fetch_pull(
    directory: &Path,
    host: &str,
    owner: &str,
    repo: &str,
    number: u64,
) -> Result<PullRequest> {
    let path = format!("repos/{owner}/{repo}/pulls/{number}");
    let captured = gh_api(directory, host, &path)?;
    if captured.code != 0 {
        return Err(Error::msg(first_detail(&captured).to_string()));
    }
    let value: Value =
        serde_json::from_str(&captured.stdout).map_err(|error| Error::msg(error.to_string()))?;
    let head_ref = value
        .pointer("/head/ref")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let head_repo = value
        .pointer("/head/repo/full_name")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let base_repo = value
        .pointer("/base/repo/full_name")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    Ok(PullRequest {
        number,
        fork: !head_repo.is_empty() && head_repo != base_repo,
        head_ref,
        head_repo,
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PullRequestStatus {
    Open,
    Closed,
    Merged,
    Unavailable,
}

/// `gh pr view <target> --json state`. `target` is a pull request URL or a
/// number in the repository `gh` resolves from `cwd`. A missing `gh`, a
/// non-zero exit, or an unreadable body is `Unavailable`.
pub fn pull_request_state(cwd: &Path, target: &str) -> PullRequestStatus {
    let Ok(captured) = process::raw("gh", &["pr", "view", target, "--json", "state"], Some(cwd))
    else {
        return PullRequestStatus::Unavailable;
    };
    if captured.code != 0 {
        return PullRequestStatus::Unavailable;
    }
    let Ok(value) = serde_json::from_str::<Value>(&captured.stdout) else {
        return PullRequestStatus::Unavailable;
    };
    match value
        .get("state")
        .and_then(Value::as_str)
        .map(str::to_ascii_uppercase)
        .as_deref()
    {
        Some("OPEN") => PullRequestStatus::Open,
        Some("CLOSED") => PullRequestStatus::Closed,
        Some("MERGED") => PullRequestStatus::Merged,
        _ => PullRequestStatus::Unavailable,
    }
}

/// `owner/repo` from `gh repo view` when that command can name the checkout.
pub fn current_repo_name(cwd: &Path) -> Option<String> {
    let Ok(captured) = process::raw(
        "gh",
        &["repo", "view", "--json", "nameWithOwner"],
        Some(cwd),
    ) else {
        return None;
    };
    if captured.code != 0 {
        return None;
    }
    let Ok(value) = serde_json::from_str::<Value>(&captured.stdout) else {
        return None;
    };
    value
        .get("nameWithOwner")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(ToOwned::to_owned)
}

fn gh_api(directory: &Path, host: &str, path: &str) -> Result<process::Captured> {
    let args = ["api", path, "--hostname", host];
    process::raw("gh", &args, Some(directory))
}

fn is_not_found(captured: &process::Captured) -> bool {
    let detail = format!("{} {}", captured.stderr, captured.stdout).to_ascii_lowercase();
    detail.contains("404") || detail.contains("not found")
}

fn first_detail(captured: &process::Captured) -> String {
    let stderr = captured.stderr.trim();
    if !stderr.is_empty() {
        stderr.to_string()
    } else {
        captured.stdout.trim().to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn web_url_host_drops_the_port() {
        assert_eq!(
            host_from_web_url("https://ghe.corp.example/acme/tool").expect("host"),
            "ghe.corp.example"
        );
        assert_eq!(
            host_from_web_url("https://ghe.corp.example:8443/acme/tool").expect("port"),
            "ghe.corp.example"
        );
        assert_eq!(
            host_from_web_url("https://github.com/acme/tool").expect("github"),
            "github.com"
        );
        assert_eq!(
            host_from_web_url("https://GitHub.com/acme/tool").expect("case"),
            "github.com"
        );
    }
}
