//! Shared selector and observed workspace state. All reads leave records untouched.
use std::path::Path;

use crate::context::Context;
use crate::error::{Error, Result};
use crate::{git, metadata, paths, worktree::WorktreeInfo};

#[derive(Debug, Clone, serde::Serialize)]
pub struct RepoJson {
    pub root: String,
    pub name: String,
}

pub(crate) fn repo_json(root: &Path) -> RepoJson {
    RepoJson {
        root: root.to_string_lossy().into_owned(),
        name: crate::projects::canonical_name(root),
    }
}

pub(crate) fn is_current(path: &Path) -> bool {
    std::env::current_dir()
        .ok()
        .and_then(|cwd| git::top_level(&cwd).ok())
        .is_some_and(|top| paths::same_location(&top, path))
}

pub(crate) fn matches(
    context: &Context,
    listed: &[WorktreeInfo],
    selector: &str,
) -> Result<Vec<WorktreeInfo>> {
    if selector == "." {
        let cwd = std::env::current_dir().map_err(|e| Error::msg(e.to_string()))?;
        let root = git::git_root(&cwd).map_err(|_| Error::WorktreeNotFound(".".into()))?;
        if !paths::same_location(&root, &context.git_root) {
            return Err(Error::validation(
                "Selector '.' cannot be combined with a different -R/--repo; use a workspace name",
            ));
        }
        let top = git::top_level(&cwd)?;
        return Ok(listed
            .iter()
            .filter(|tree| paths::same_location(&top, Path::new(&tree.path)))
            .cloned()
            .collect());
    }
    let (pr, link) = if let Some(number) = selector.strip_prefix("pr:") {
        (true, metadata::parse_link(number)?)
    } else if let Some(number) = selector.strip_prefix("issue:") {
        (false, metadata::parse_link(number)?)
    } else {
        let (kind, _) = metadata::link_target(selector).ok_or_else(|| {
            Error::validation("Selector URL must identify a pull request or issue")
        })?;
        (
            matches!(kind, "pull" | "pulls"),
            metadata::parse_link(selector)?,
        )
    };
    if link.number.is_none()
        || (selector.contains(':') && !selector.starts_with("http") && link.url.is_some())
    {
        return Err(Error::validation(
            "Selector requires a positive PR or issue number",
        ));
    }
    Ok(listed
        .iter()
        .filter(|tree| {
            let stored = if pr {
                &tree.metadata.links.pr
            } else {
                &tree.metadata.links.issue
            };
            stored.as_ref().is_some_and(|stored| {
                if let Some(url) = &link.url {
                    if let Some(saved) = &stored.url {
                        return url_identity(saved) == url_identity(url);
                    }
                    // A bare number belongs to this repository, never another repository's URL.
                    let prefix = url_identity(url)
                        .rsplit_once('/')
                        .and_then(|(path, _)| path.rsplit_once('/'))
                        .map(|(repository, _)| repository)
                        .unwrap_or("");
                    let identity = prefix.split_once("://").map(|(_, rest)| rest);
                    if identity != Some(repo_json(&context.git_root).name.as_str()) {
                        return false;
                    }
                }
                stored.number == link.number
            })
        })
        .cloned()
        .collect())
}

fn url_identity(url: &str) -> &str {
    url.split(['?', '#'])
        .next()
        .unwrap_or(url)
        .trim_end_matches('/')
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct UpstreamJson {
    pub r#ref: String,
    pub ahead: Option<u64>,
    pub behind: Option<u64>,
    pub gone: bool,
}

pub(crate) fn upstream(tree: &WorktreeInfo) -> Option<UpstreamJson> {
    if tree.detached || tree.orphaned {
        return None;
    }
    let branch_ref = format!("refs/heads/{}", tree.branch);
    let refs = git::output(
        &[
            "for-each-ref",
            "--format=%(refname)%00%(upstream)",
            &branch_ref,
        ],
        Some(&tree.repo_root),
        true,
    )
    .ok()?;
    let reference = refs
        .lines()
        .filter_map(|line| line.split_once('\0'))
        .find(|(name, _)| *name == branch_ref)?
        .1
        .to_owned();
    if reference.is_empty() {
        return None;
    }
    let gone = match git::raw_git(
        &tree.repo_root,
        &["show-ref", "--verify", "--quiet", &reference],
    )
    .ok()?
    .code
    {
        0 => false,
        1 => true,
        _ => return None,
    };
    let counts = if gone {
        None
    } else {
        git::output(
            &[
                "rev-list",
                "--left-right",
                "--count",
                &format!("HEAD...{reference}"),
            ],
            Some(Path::new(&tree.path)),
            true,
        )
        .ok()
    };
    let mut counts = counts.as_deref().unwrap_or("").split_whitespace();
    Some(UpstreamJson {
        r#ref: reference,
        ahead: counts.next().and_then(|s| s.parse().ok()),
        behind: counts.next().and_then(|s| s.parse().ok()),
        gone,
    })
}
