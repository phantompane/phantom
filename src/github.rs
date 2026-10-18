use std::path::Path;

use serde_json::Value;

use crate::context;
use crate::error::{Error, Result};
use crate::git;
use crate::process;
use crate::worktree::{self, Logger};

pub struct Checkout {
    pub message: String,
    pub worktree: String,
    pub path: std::path::PathBuf,
    pub already_exists: bool,
    pub hook_failure: Option<worktree::HookFailure>,
}

pub fn checkout(number: &str, base: Option<&str>, logger: &Logger) -> Result<Checkout> {
    let cwd = std::env::current_dir().map_err(|error| Error::msg(error.to_string()))?;
    let (owner, repo) = repo_info(&cwd)?;
    let issue = fetch_issue(&owner, &repo, number)?;
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
        checkout_pull_request(&cwd, &pull, logger)
    } else {
        checkout_issue(&cwd, issue.number, base, logger)
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

fn checkout_pull_request(cwd: &Path, pull: &PullRequest, logger: &Logger) -> Result<Checkout> {
    let git_root = git::git_root(cwd)?;
    let context = context::create(&git_root)?;
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
    if let Ok(existing) = worktree::find_worktree(&context.git_root, &worktree_name, false, None) {
        if existing.branch == worktree_name {
            return Ok(Checkout {
                message: format!("PR #{} is already checked out", pull.number),
                worktree: worktree_name,
                path: existing.path.into(),
                already_exists: true,
                hook_failure: None,
            });
        }
    }
    let upstream = if pull.fork {
        format!("origin/pull/{}/head", pull.number)
    } else {
        format!("origin/{}", pull.head_ref)
    };
    let refspec = format!("{}:{worktree_name}", upstream.trim_start_matches("origin/"));
    git::fetch(&git_root, "origin", &refspec)?;
    if let Err(error) = git::set_upstream(&git_root, &worktree_name, &upstream) {
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
    Ok(Checkout {
        message,
        worktree: worktree_name,
        path: attached.path,
        already_exists: false,
        hook_failure: attached.hook_failure,
    })
}

fn checkout_issue(
    cwd: &Path,
    number: u64,
    base: Option<&str>,
    logger: &Logger,
) -> Result<Checkout> {
    let git_root = git::git_root(cwd)?;
    let context = context::create(&git_root)?;
    let name = format!("issues/{number}");
    if let Ok(existing) = worktree::find_worktree(&context.git_root, &name, false, None) {
        return Ok(Checkout {
            message: format!("Issue #{number} is already checked out"),
            worktree: name,
            path: existing.path.into(),
            already_exists: true,
            hook_failure: None,
        });
    }
    let commands = post_commands(&context);
    let created = worktree::create_worktree(
        &context,
        &name,
        base.unwrap_or("HEAD"),
        &[],
        &commands,
        logger,
    )?;
    Ok(Checkout {
        message: format!("Created worktree '{name}' at {}", created.path.display()),
        worktree: name,
        path: created.path,
        already_exists: false,
        hook_failure: created.hook_failure,
    })
}

fn post_commands(context: &context::Context) -> Vec<String> {
    context
        .config
        .as_ref()
        .and_then(|config| config.post_create.as_ref())
        .and_then(|post| post.commands.clone())
        .unwrap_or_default()
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

fn fetch_issue(owner: &str, repo: &str, number: &str) -> Result<Option<Issue>> {
    let parsed = number.parse::<u64>().ok().filter(|value| *value > 0);
    let Some(parsed) = parsed else {
        return Err(Error::msg(format!(
            "Invalid issue or pull request number: {number}"
        )));
    };
    let path = format!("repos/{owner}/{repo}/issues/{parsed}");
    let captured = process::raw("gh", &["api", &path], None)?;
    if captured.code != 0 {
        if is_not_found(&captured) {
            return Ok(None);
        }
        return Err(Error::msg(first_detail(&captured).to_string()));
    }
    let value: Value =
        serde_json::from_str(&captured.stdout).map_err(|error| Error::msg(error.to_string()))?;
    let pull_request = if value.get("pull_request").is_some() {
        Some(fetch_pull(owner, repo, parsed)?)
    } else {
        None
    };
    Ok(Some(Issue {
        number: parsed,
        pull_request,
    }))
}

fn fetch_pull(owner: &str, repo: &str, number: u64) -> Result<PullRequest> {
    let path = format!("repos/{owner}/{repo}/pulls/{number}");
    let captured = process::raw("gh", &["api", &path], None)?;
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
