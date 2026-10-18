use std::path::Path;

use serde::Serialize;
use serde_json::Value;

use crate::context;
use crate::error::{self, Error, Result};
use crate::git;
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
    pub info: WorktreeInfo,
    pub base: Option<String>,
    pub subject: GithubSubject,
}

pub enum GithubSubject {
    PullRequest { number: u64, head_ref: String },
    Issue { number: u64 },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GithubCheckoutOutput {
    version: u32,
    worktree: worktree::WorktreeJson,
    github: GithubSubjectOutput,
    copy_files: worktree::CopyFilesOutcome,
    post_create: worktree::PostCreateOutcome,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GithubSubjectOutput {
    kind: &'static str,
    number: u64,
    head_ref: Option<String>,
    already_exists: bool,
}

impl Checkout {
    pub fn to_json(&self) -> Result<Value> {
        let (kind, number, head_ref) = match &self.subject {
            GithubSubject::PullRequest { number, head_ref } => {
                ("pullRequest", *number, Some(head_ref.clone()))
            }
            GithubSubject::Issue { number } => ("issue", *number, None),
        };
        serde_json::to_value(GithubCheckoutOutput {
            version: error::JSON_VERSION,
            worktree: self.info.to_json(self.base.clone()),
            github: GithubSubjectOutput {
                kind,
                number,
                head_ref,
                already_exists: self.already_exists,
            },
            copy_files: worktree::copy_files_outcome(self.copy_error.as_deref()),
            post_create: worktree::post_create_outcome(self.hooks_ran, self.hook_failure.as_ref()),
        })
        .map_err(|error| Error::msg(error.to_string()))
    }
}

pub fn checkout(
    number: &str,
    base: Option<&str>,
    logger: &Logger,
    repository: Option<&Path>,
) -> Result<Checkout> {
    let cwd = match repository {
        Some(path) => path.to_path_buf(),
        None => std::env::current_dir().map_err(|error| Error::msg(error.to_string()))?,
    };
    let (owner, repo) = repo_info(&cwd)?;
    let host = github_host(&cwd);
    let issue = fetch_issue(&cwd, host.as_deref(), &owner, &repo, number)?;
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
        checkout_pull_request(&pull, logger, repository)
    } else {
        checkout_issue(issue.number, base, logger, repository)
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

fn checkout_pull_request(
    pull: &PullRequest,
    logger: &Logger,
    repository: Option<&Path>,
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
    if let Ok(existing) = worktree::find_worktree(&context, &worktree_name, false, None) {
        if existing.branch == worktree_name {
            let path = existing.path.clone().into();
            return Ok(Checkout {
                message: format!("PR #{} is already checked out", pull.number),
                worktree: worktree_name,
                path,
                already_exists: true,
                hook_failure: None,
                copy_error: None,
                hooks_ran: false,
                info: existing,
                base: None,
                subject: GithubSubject::PullRequest {
                    number: pull.number,
                    head_ref: pull.head_ref.clone(),
                },
            });
        }
    }
    let upstream = if pull.fork {
        format!("origin/pull/{}/head", pull.number)
    } else {
        format!("origin/{}", pull.head_ref)
    };
    let refspec = format!("{}:{worktree_name}", upstream.trim_start_matches("origin/"));
    git::fetch(git_root, "origin", &refspec)?;
    if let Err(error) = git::set_upstream(git_root, &worktree_name, &upstream) {
        eprintln!("Warning: Could not set upstream branch: {error}");
    }
    let commands = post_commands(&context);
    let attached = worktree::attach_worktree(&context, &worktree_name, &[], &commands, logger)?;
    let message = if pull.fork {
        format!(
            "Checked out PR #{} from fork {}",
            pull.number, pull.head_repo
        )
    } else {
        format!(
            "Checked out PR #{} from branch {}",
            pull.number, pull.head_ref
        )
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
        info,
        base: Some(upstream),
        subject: GithubSubject::PullRequest {
            number: pull.number,
            head_ref: pull.head_ref.clone(),
        },
    })
}

fn checkout_issue(
    number: u64,
    base: Option<&str>,
    logger: &Logger,
    repository: Option<&Path>,
) -> Result<Checkout> {
    let context = context::open(repository)?;
    let name = format!("issues/{number}");
    if let Ok(existing) = worktree::find_worktree(&context, &name, false, None) {
        let path = existing.path.clone().into();
        return Ok(Checkout {
            message: format!("Issue #{number} is already checked out"),
            worktree: name,
            path,
            already_exists: true,
            hook_failure: None,
            copy_error: None,
            hooks_ran: false,
            info: existing,
            base: None,
            subject: GithubSubject::Issue { number },
        });
    }
    let commands = post_commands(&context);
    let base = base.unwrap_or("HEAD");
    let created = worktree::create_worktree(&context, &name, base, &[], &commands, logger)?;
    let info = worktree::worktree_at_path(&context, &created.path)?;
    Ok(Checkout {
        message: format!("Created worktree '{name}' at {}", created.path.display()),
        worktree: name,
        path: created.path,
        already_exists: false,
        hook_failure: created.hook_failure,
        copy_error: created.copy_error,
        hooks_ran: created.hooks_ran,
        info,
        base: Some(base.to_string()),
        subject: GithubSubject::Issue { number },
    })
}

fn post_commands(context: &context::Context) -> Vec<String> {
    crate::config::post_create_commands(context.config.as_ref()).to_vec()
}

fn repo_info(cwd: &Path) -> Result<(String, String)> {
    let captured = process::raw("gh", &["repo", "view", "--json", "owner,name"], Some(cwd))?;
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
    let repo = value
        .get("name")
        .and_then(Value::as_str)
        .ok_or_else(|| Error::msg("Failed to get repository info: missing name"))?;
    Ok((owner.to_string(), repo.to_string()))
}

/// Host for `gh api --hostname`, from the selected repository's `origin`.
fn github_host(directory: &Path) -> Option<String> {
    let name = crate::repository::canonical_name_from_origin(directory)?;
    let host = name.split('/').next().filter(|host| !host.is_empty())?;
    Some(host.to_string())
}

fn fetch_issue(
    directory: &Path,
    host: Option<&str>,
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
    host: Option<&str>,
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

fn gh_api(directory: &Path, host: Option<&str>, path: &str) -> Result<process::Captured> {
    let mut args = vec!["api".to_string(), path.to_string()];
    if let Some(host) = host {
        args.push("--hostname".to_string());
        args.push(host.to_string());
    }
    let refs = args.iter().map(String::as_str).collect::<Vec<_>>();
    process::raw("gh", &refs, Some(directory))
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
