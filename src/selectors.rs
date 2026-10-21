//! Shared selector and observed workspace state. All reads leave records untouched.
use std::path::Path;

use crate::context::Context;
use crate::error::{Error, Result};
use crate::{git, metadata, paths, worktree::WorktreeInfo};

/// Parsed user input can be resolved again without revalidating observed names.
/// Internal callers construct `Name` directly for names obtained from Git or metadata.
#[derive(Debug, Clone)]
pub(crate) enum Selector {
    Name(String),
    Special(String),
}

impl Selector {
    pub(crate) fn parse(input: &str) -> Result<Self> {
        if input == "."
            || input.starts_with("pr:")
            || input.starts_with("issue:")
            || input.starts_with("https://")
            || input.starts_with("http://")
        {
            Ok(Self::Special(input.to_owned()))
        } else {
            crate::worktree::validate_worktree_name(input)?;
            Ok(Self::Name(input.to_owned()))
        }
    }

    pub(crate) fn as_str(&self) -> &str {
        match self {
            Self::Name(value) | Self::Special(value) => value,
        }
    }

    pub(crate) fn resolve_including_orphaned(
        &self,
        context: &Context,
        exclude_default: bool,
        expected_path: Option<&Path>,
    ) -> Result<WorktreeInfo> {
        if let Self::Name(name) = self {
            return crate::worktree::find_including_orphaned(
                context,
                name,
                exclude_default,
                expected_path,
            );
        }
        let input = self.as_str();
        let listed = crate::worktree::list_worktrees(context, false, true)?;
        let mut found = matches(context, &listed, input)?;
        found.retain(|tree| {
            expected_path.is_none_or(|path| paths::same_location(Path::new(&tree.path), path))
        });
        match found.as_slice() {
            [tree] if exclude_default && tree.is_default => Err(Error::Status {
                code: "primary",
                message: "The primary checkout cannot be selected for this operation".into(),
            }),
            [tree] => Ok(tree.clone()),
            [] => Err(Error::WorktreeNotFound(input.into())),
            _ => Err(Error::Status {
                code: "ambiguous",
                message: format!(
                    "Selector '{input}' matches multiple workspaces; use a workspace name"
                ),
            }),
        }
    }
}

/// Interpret a user selector at the command boundary, then resolve it.
pub(crate) fn resolve_including_orphaned(
    context: &Context,
    input: &str,
    exclude_default: bool,
    expected_path: Option<&Path>,
) -> Result<WorktreeInfo> {
    Selector::parse(input)?.resolve_including_orphaned(context, exclude_default, expected_path)
}

pub(crate) fn resolve(
    context: &Context,
    input: &str,
    exclude_default: bool,
    expected_path: Option<&Path>,
) -> Result<WorktreeInfo> {
    let found = resolve_including_orphaned(context, input, exclude_default, expected_path)?;
    crate::worktree::require_live(found, input)
}

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
