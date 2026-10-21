//! Workspace allocation and record-only lifecycle operations.
use std::path::Path;

use serde_json::{json, Value};

use crate::context::Context;
use crate::error::{Error, Result};
use crate::metadata::{self, BranchOrigin, MetadataInput};
use crate::output::visible_text;
use crate::{config, git, github, names, paths, sync, tracking, trust, worktree};

pub(crate) struct Request<'a> {
    pub name: Option<&'a str>,
    pub base: Option<&'a str>,
    pub branch: Option<&'a str>,
    pub pr: Option<&'a str>,
    pub issue: Option<&'a str>,
    pub detach: bool,
    pub reuse: bool,
    pub copy_files: &'a [String],
    pub metadata: MetadataInput,
    pub hooks: trust::HookControl,
}

// Observed names are literal. A stale record is not an existing checkout.
fn existing(context: &Context, name: &str) -> Result<Option<worktree::WorktreeInfo>> {
    match worktree::find_including_orphaned(context, name, false, None) {
        Ok(tree) if !tree.orphaned => match std::fs::metadata(&tree.path) {
            Ok(meta) => Ok(meta.is_dir().then_some(tree)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(Error::msg(format!("Failed to inspect workspace: {error}"))),
        },
        Ok(_) => Ok(None),
        Err(Error::WorktreeNotFound(_)) => Ok(None),
        Err(error) => Err(error),
    }
}

fn matches_link(
    actual: Option<&metadata::WorktreeLink>,
    requested: Option<&metadata::WorktreeLink>,
) -> bool {
    requested.is_none_or(|wanted| {
        actual.is_some_and(|actual| {
            actual.number == wanted.number
                && (actual.url.is_none() || wanted.url.is_none() || actual.url == wanted.url)
        })
    })
}

pub(crate) fn create(
    context: &Context,
    mut request: Request<'_>,
    logger: &worktree::Logger,
) -> Result<i32> {
    if [
        request.base.is_some(),
        request.branch.is_some(),
        request.pr.is_some(),
    ]
    .into_iter()
    .filter(|set| *set)
    .count()
        > 1
        || (request.detach && (request.branch.is_some() || request.pr.is_some()))
    {
        return Err(Error::validation(
            "Use one of --base, --branch, or --pr; --detach accepts only --base and --issue",
        ));
    }
    if let Some(name) = request.name {
        worktree::validate_worktree_name(name)?;
    }
    metadata::load_strict(&context.git_root)?;
    let issue = request
        .issue
        .filter(|_| request.branch.is_none() && request.pr.is_none())
        .map(|reference| github::resolve(&context.source_checkout, reference, false))
        .transpose()?;
    let subject = request
        .pr
        .map(|reference| github::resolve(&context.source_checkout, reference, true))
        .transpose()?;
    let pull = subject.as_ref().and_then(|subject| subject.pull.as_ref());
    if let Some(issue) = &issue {
        request.metadata.issue = Some(issue.link.clone());
        if request.metadata.purpose.is_none() && request.branch.is_none() && pull.is_none() {
            request.metadata.purpose = issue
                .title
                .as_deref()
                .map(metadata::parse_purpose)
                .transpose()?;
        }
    }
    if let Some(subject) = &subject {
        request.metadata.pr = Some(subject.link.clone());
    }
    let lookup = request
        .branch
        .map(|branch| {
            if request.name.is_some() {
                tracking::lookup_attach(&context.source_checkout, branch)
            } else {
                tracking::parse_attach_name(&context.source_checkout, branch)
            }
        })
        .transpose()?;
    let pull_branch = pull.map(|pull| {
        let owner = pull.head_repo.split('/').next().unwrap_or("");
        if pull.fork && !owner.is_empty() {
            format!("{owner}/{}", pull.head_ref)
        } else {
            pull.head_ref.clone()
        }
    });
    let name = match request.name {
        Some(name) => name.to_owned(),
        None => {
            if let Some(branch) = &pull_branch {
                branch.clone()
            } else if let Some(lookup) = &lookup {
                lookup.directory.clone()
            } else if let Some(issue) = &issue {
                format!("issues/{}", issue.link.number.unwrap_or_default())
            } else {
                names::generate_unique_name(
                    &context.git_root,
                    &context.worktrees_directory,
                    &context.directory_name_separator,
                    &tracking::remote_tracking_branch_names(&context.git_root)?,
                )?
            }
        }
    };
    // GitHub head names are observed values; they are not user NAME arguments.
    let mut branch = pull_branch.clone();
    let mut tracking_ref = None;
    if let Some(lookup) = lookup {
        match lookup.outcome? {
            tracking::AttachPlan::Existing { branch: value } => branch = Some(value),
            tracking::AttachPlan::Track {
                branch: value,
                start_point,
            } => {
                branch = Some(value);
                tracking_ref = Some(start_point);
            }
        }
    }
    let base = if let Some(pull) = pull {
        let candidate = pull
            .base_ref
            .as_ref()
            .map(|base| format!("refs/remotes/origin/{base}"));
        match candidate {
            Some(base) if git::reference_exists(&context.source_checkout, &base)? => base,
            _ => sync::creation_base(&context.source_checkout, None)?,
        }
    } else if branch.is_none() {
        sync::creation_base(&context.source_checkout, request.base)?
    } else {
        sync::creation_base(&context.source_checkout, None)?
    };
    request.metadata.base = (branch.is_none() || pull.is_some()).then(|| base.clone());
    request.metadata.name = Some(name.clone());
    let kind = if request.detach {
        "detach"
    } else if pull.is_some() {
        "pr"
    } else if branch.is_some() {
        "branch"
    } else if issue.is_some() {
        "issue"
    } else {
        "new"
    };
    let mut source = json!({"kind":kind, "base":base});
    if let Some(branch) = &branch {
        source["branch"] = json!(branch);
    }
    if kind == "branch" {
        source["ref"] = json!(tracking_ref
            .clone()
            .unwrap_or_else(|| format!("refs/heads/{}", branch.as_deref().unwrap_or_default())));
    }
    if let Some(pull) = pull {
        source["number"] = json!(pull.number);
        source["url"] = json!(subject.as_ref().and_then(|s| s.link.url.as_ref()));
        source["headRef"] = json!(pull.head_ref);
        source["headRepository"] = json!(pull.head_repo);
    }
    if let Some(link) = &request.metadata.issue {
        source["issue"] = json!(link);
        if kind == "issue" {
            source["number"] = json!(link.number);
            source["url"] = json!(link.url);
        }
    }
    if let Some(tree) = existing(context, &name)? {
        let source_matches = if pull.is_some() {
            tree.branch == branch.as_deref().unwrap_or_default()
                && (tree.metadata.links.pr.is_none()
                    || matches_link(
                        tree.metadata.links.pr.as_ref(),
                        request.metadata.pr.as_ref(),
                    ))
        } else if let Some(branch) = &branch {
            !tree.detached && tree.branch == *branch
        } else {
            tree.detached == request.detach
                && (request.detach || tree.branch == name)
                && tree.metadata.base.as_deref() == Some(&base)
        };
        if !request.reuse
            || !source_matches
            || !matches_link(
                tree.metadata.links.issue.as_ref(),
                request.metadata.issue.as_ref(),
            )
        {
            return Err(Error::WorktreeAlreadyExists(name));
        }
        let tree = if tree.metadata.links.pr.is_none() && request.metadata.pr.is_some() {
            metadata::write(
                &context.git_root,
                Path::new(&tree.path),
                &MetadataInput {
                    pr: request.metadata.pr.clone(),
                    name: worktree::outside_name_to_store(context, Path::new(&tree.path))?,
                    ..MetadataInput::default()
                },
            )?;
            worktree::worktree_at_path(context, Path::new(&tree.path))?
        } else {
            tree
        };
        source["reused"] = json!(true);
        return report(&tree, source, None, false, None, None, &[], logger);
    }
    let path = paths::worktree_path(
        &context.worktrees_directory,
        &name,
        &context.directory_name_separator,
    );
    if path.exists() {
        return Err(Error::WorktreeAlreadyExists(name));
    }
    if branch.is_none() && !request.detach {
        if git::branch_exists(&context.git_root, &name)? {
            return Err(Error::Status {
                code: "exists_remote",
                message: format!(
                    "Branch '{}' already exists. Use `mabo create --branch {}`.",
                    visible_text(&name),
                    visible_text(&name)
                ),
            });
        }
        tracking::reject_remote_create(&context.git_root, &name)?;
    }
    // Refuse a branch already checked out under another workspace name before fetching.
    if let Some(branch) = &branch {
        if existing(context, branch)?.is_some() {
            return Err(Error::WorktreeAlreadyExists(name));
        }
    }
    let commands = trust::authorize(
        &context.git_root,
        config::post_create_commands(context.config.as_ref()),
        config::pre_delete_commands(context.config.as_ref()),
        trust::HookKind::PostCreate,
        request.hooks,
    )?;
    metadata::prepare(&context.git_root)?;
    let branch_existed = branch
        .as_deref()
        .map(|branch| git::branch_exists(&context.git_root, branch))
        .transpose()?
        .unwrap_or(false);
    let result = (|| {
        if let Some(pull) = pull {
            let fetched = github::fetch_pull_head(
                &context.git_root,
                pull,
                branch.as_deref().unwrap_or_default(),
            )?;
            source["checkout"] = json!(match fetched {
                github::PullFetch::Branch => "branch",
                github::PullFetch::Fork | github::PullFetch::DeletedHead => "pullHead",
            });
        }
        paths::with_worktrees_directory(
            &context.worktrees_directory,
            context.project_common_dir.as_deref(),
            || {
                let add = if request.detach {
                    git::WorktreeAdd::Detach { base: &base }
                } else if let Some(branch) = &branch {
                    if let Some(start_point) = &tracking_ref {
                        git::WorktreeAdd::Track {
                            branch,
                            start_point,
                        }
                    } else {
                        git::WorktreeAdd::Existing { branch }
                    }
                } else {
                    git::WorktreeAdd::New {
                        branch: &name,
                        base: &base,
                    }
                };
                git::add_worktree(&context.git_root, &path, add)
            },
        )
    })();
    if let Err(error) = result {
        if pull.is_some() && !branch_existed {
            if let Some(branch) = &branch {
                if git::branch_exists(&context.git_root, branch)? {
                    git::delete_branch(&context.git_root, branch)?;
                }
            }
        }
        return Err(error);
    }
    let metadata_error = metadata::replace(
        &context.git_root,
        &path,
        &request.metadata,
        if branch.is_some() {
            BranchOrigin::Existing
        } else {
            BranchOrigin::New
        },
    )
    .err()
    .map(|error| error.to_string());
    let mut copied = Vec::new();
    let copy_error = worktree::copy_files_recorded(
        &context.source_checkout,
        &path,
        request.copy_files,
        &mut copied,
    )
    .err()
    .map(|error| error.to_string());
    let failure = if commands.is_empty() {
        None
    } else {
        logger.log("\nRunning post-create commands...");
        worktree::run_hook_commands(
            context,
            &worktree::worktree_at_path(context, &path)?,
            &commands,
            true,
            logger,
        )?
    };
    source["reused"] = json!(false);
    report(
        &worktree::worktree_at_path(context, &path)?,
        source,
        metadata_error.as_deref(),
        !commands.is_empty(),
        failure.as_ref(),
        copy_error.as_deref(),
        &copied,
        logger,
    )
}

#[allow(clippy::too_many_arguments)]
fn report(
    tree: &worktree::WorktreeInfo,
    source: Value,
    metadata_error: Option<&str>,
    ran: bool,
    failure: Option<&worktree::HookFailure>,
    copy_error: Option<&str>,
    copied: &[String],
    logger: &worktree::Logger,
) -> Result<i32> {
    logger.log(&format!(
        "{} workspace '{}' at {}",
        if source["reused"] == true {
            "Reused"
        } else {
            "Created"
        },
        visible_text(&tree.name),
        visible_text(&tree.path)
    ));
    if let Some(error) = metadata_error {
        logger.warn(
            "metadata_save",
            &format!("Warning: {}", visible_text(error)),
        );
    }
    if let Some(error) = copy_error {
        logger.warn(
            "copy_files",
            &format!(
                "Warning: Failed to copy some files: {}",
                visible_text(error)
            ),
        );
    }
    if let Some(failure) = failure {
        logger.warn("post_create", &failure.warning(Path::new(&tree.path)));
    }
    crate::output::data(
        &json!({"workspace":tree.to_json(None), "source":source, "setup":worktree::post_create_outcome(ran, failure), "copy":{"copied":copied,"error":copy_error}, "metadata":worktree::metadata_save_outcome(metadata_error)}),
    )?;
    if metadata_error.is_some() || copy_error.is_some() || failure.is_some() {
        return Err(Error::status(
            crate::error::PARTIAL,
            "Workspace created but setup did not complete",
        ));
    }
    Ok(0)
}

pub(crate) fn adopt(
    context: &Context,
    path: &Path,
    mut input: MetadataInput,
) -> Result<worktree::WorktreeInfo> {
    let path = paths::canonical_location(path);
    let trees = worktree::list_worktrees(context, false, true)?;
    let tree = trees
        .iter()
        .find(|tree| {
            !tree.orphaned && !tree.is_default && paths::same_location(Path::new(&tree.path), &path)
        })
        .ok_or_else(|| Error::WorktreeNotFound(visible_text(&path.to_string_lossy())))?;
    if !path.is_dir() || !path.join(".git").is_file() {
        return Err(Error::WorktreeNotFound(path.to_string_lossy().into_owned()));
    }
    let observed = git::top_level(&path)?;
    if !paths::same_location(&path, &observed)
        || git::canonical_common_dir(&path)? != git::canonical_common_dir(&context.git_root)?
    {
        return Err(Error::WorktreeNotFound(path.to_string_lossy().into_owned()));
    }
    if metadata::records_path(&context.git_root, &path)? {
        return Err(Error::WorktreeAlreadyExists(tree.name.clone()));
    }
    let name = input.name.clone().unwrap_or_else(|| tree.name.clone());
    if trees.iter().any(|other| {
        !other.orphaned
            && other.name == name
            && !paths::same_location(Path::new(&other.path), &path)
    }) {
        return Err(Error::WorktreeAlreadyExists(name));
    }
    if let Some(base) = &input.base {
        input.base = Some(sync::normalize_base(&path, base)?);
    }
    input.name = Some(name);
    metadata::replace(&context.git_root, &path, &input, BranchOrigin::Adopted)?;
    worktree::worktree_at_path(context, &path)
}
