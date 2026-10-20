use std::collections::BTreeSet;
use std::path::Path;

use crate::error::{Error, Result};
use crate::git;
use crate::worktree::validate_worktree_name;

#[derive(Debug)]
pub(crate) enum AttachPlan {
    Existing { branch: String },
    Track { branch: String, start_point: String },
}

pub(crate) struct AttachLookup {
    pub directory: String,
    pub outcome: std::result::Result<AttachPlan, Error>,
}

pub(crate) fn lookup_attach(git_root: &Path, name: &str) -> Result<AttachLookup> {
    let catalog = Catalog::read(git_root)?;
    Ok(decide(&catalog, name))
}

pub(crate) fn reject_remote_create(git_root: &Path, name: &str) -> Result<()> {
    let catalog = Catalog::read(git_root)?;
    match catalog.exact(name) {
        Hits::None => Ok(()),
        Hits::One(hit) => Err(Error::Validation(remote_taken(name, &[hit.remote]))),
        Hits::Many(remotes) => Err(Error::Validation(remote_taken(name, &remotes))),
    }
}

/// Branch names that already exist on a configured remote.
///
/// Nameless create consults this once, then skips those candidates.
pub(crate) fn remote_tracking_branch_names(git_root: &Path) -> Result<BTreeSet<String>> {
    Ok(Catalog::read(git_root)?.tracked_branches())
}

struct Catalog {
    /// Longest configured remote first, so a slash inside a remote name wins
    /// over a shorter remote plus a branch prefix.
    remotes: Vec<String>,
    heads: BTreeSet<String>,
    tracking: BTreeSet<String>,
}

struct Qualified {
    branch: String,
    start_point: String,
}

struct Hit {
    remote: String,
    start_point: String,
}

enum Hits {
    None,
    One(Hit),
    Many(Vec<String>),
}

impl Catalog {
    fn read(git_root: &Path) -> Result<Self> {
        let remotes = git::output(&["remote"], Some(git_root), true)?;
        let tracking = git::output(
            &[
                "for-each-ref",
                "--format=%(refname)%00%(symref)",
                "refs/remotes",
            ],
            Some(git_root),
            true,
        )?;
        let heads = git::output(
            &["for-each-ref", "--format=%(refname)", "refs/heads"],
            Some(git_root),
            true,
        )?;
        Ok(Self::parse(&remotes, &tracking, &heads))
    }

    fn parse(remotes_stdout: &str, tracking_stdout: &str, heads_stdout: &str) -> Self {
        let mut remotes: Vec<String> = remotes_stdout
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .map(str::to_string)
            .collect();
        remotes.sort_by(|left, right| right.len().cmp(&left.len()).then_with(|| left.cmp(right)));
        let remotes_longest = remotes.clone();

        let mut tracking = BTreeSet::new();
        for line in tracking_stdout.lines().filter(|line| !line.is_empty()) {
            let (refname, symref) = line.split_once('\0').unwrap_or((line, ""));
            // `refs/remotes/<remote>/HEAD` is a symbolic ref, not a branch.
            if !symref.is_empty() {
                continue;
            }
            let Some(rest) = refname.strip_prefix("refs/remotes/") else {
                continue;
            };
            let Some((remote, branch)) = split_remote(rest, &remotes_longest) else {
                continue;
            };
            tracking.insert(format!("refs/remotes/{remote}/{branch}"));
        }

        let mut heads = BTreeSet::new();
        for line in heads_stdout.lines() {
            if let Some(name) = line.trim().strip_prefix("refs/heads/") {
                if !name.is_empty() {
                    heads.insert(name.to_string());
                }
            }
        }

        Self {
            remotes,
            heads,
            tracking,
        }
    }

    fn qualify(&self, name: &str) -> Option<Qualified> {
        for remote in &self.remotes {
            let Some(rest) = name.strip_prefix(remote.as_str()) else {
                continue;
            };
            let Some(branch) = rest.strip_prefix('/') else {
                continue;
            };
            if branch.is_empty() || validate_worktree_name(branch).is_err() {
                continue;
            }
            let start_point = format!("refs/remotes/{remote}/{branch}");
            if !self.tracking.contains(&start_point) {
                continue;
            }
            return Some(Qualified {
                branch: branch.to_string(),
                start_point,
            });
        }
        None
    }

    fn tracked_branches(&self) -> BTreeSet<String> {
        let mut names = BTreeSet::new();
        for reference in &self.tracking {
            let Some(rest) = reference.strip_prefix("refs/remotes/") else {
                continue;
            };
            for remote in &self.remotes {
                let Some(after) = rest.strip_prefix(remote.as_str()) else {
                    continue;
                };
                let Some(branch) = after.strip_prefix('/') else {
                    continue;
                };
                if !branch.is_empty() {
                    names.insert(branch.to_string());
                }
            }
        }
        names
    }

    fn exact(&self, name: &str) -> Hits {
        let mut remotes: Vec<String> = self
            .remotes
            .iter()
            .filter(|remote| {
                self.tracking
                    .contains(&format!("refs/remotes/{remote}/{name}"))
            })
            .cloned()
            .collect();
        remotes.sort();
        match remotes.len() {
            0 => Hits::None,
            1 => {
                let remote = remotes.remove(0);
                let start_point = format!("refs/remotes/{remote}/{name}");
                Hits::One(Hit {
                    remote,
                    start_point,
                })
            }
            _ => Hits::Many(remotes),
        }
    }
}

fn split_remote<'a>(rest: &'a str, remotes: &'a [String]) -> Option<(&'a str, &'a str)> {
    for remote in remotes {
        let Some(after) = rest.strip_prefix(remote.as_str()) else {
            continue;
        };
        let Some(branch) = after.strip_prefix('/') else {
            continue;
        };
        if branch.is_empty() {
            continue;
        }
        return Some((remote.as_str(), branch));
    }
    None
}

fn decide(catalog: &Catalog, name: &str) -> AttachLookup {
    if catalog.heads.contains(name) {
        return lookup_ok(
            name.to_string(),
            AttachPlan::Existing {
                branch: name.to_string(),
            },
        );
    }
    if let Some(qualified) = catalog.qualify(name) {
        let branch = qualified.branch;
        if catalog.heads.contains(&branch) {
            return lookup_ok(branch.clone(), AttachPlan::Existing { branch });
        }
        return lookup_ok(
            branch.clone(),
            AttachPlan::Track {
                branch,
                start_point: qualified.start_point,
            },
        );
    }
    match catalog.exact(name) {
        Hits::None => AttachLookup {
            directory: name.to_string(),
            outcome: Err(Error::BranchNotFound(name.to_string())),
        },
        Hits::One(hit) => lookup_ok(
            name.to_string(),
            AttachPlan::Track {
                branch: name.to_string(),
                start_point: hit.start_point,
            },
        ),
        Hits::Many(remotes) => AttachLookup {
            directory: name.to_string(),
            outcome: Err(Error::Validation(ambiguous(name, &remotes))),
        },
    }
}

fn lookup_ok(directory: String, plan: AttachPlan) -> AttachLookup {
    AttachLookup {
        directory,
        outcome: Ok(plan),
    }
}

fn ambiguous(branch: &str, remotes: &[String]) -> String {
    format!(
        "Branch '{branch}' exists on more than one remote ({}). Run `mabo attach <remote>/{branch}`.",
        remotes.join(", ")
    )
}

fn remote_taken(branch: &str, remotes: &[String]) -> String {
    format!(
        "Branch '{branch}' already exists as a remote-tracking branch ({}). Run `mabo attach {branch}`.",
        remotes.join(", ")
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn catalog() -> Catalog {
        Catalog::parse(
            "origin\nupstream\nfeature\n",
            "\
refs/remotes/origin/HEAD\0refs/remotes/origin/main
refs/remotes/origin/feature/teammate\0
refs/remotes/upstream/feature/teammate\0
refs/remotes/origin/solo\0
refs/remotes/upstream/solo\0
refs/remotes/stale/solo\0
",
            "refs/heads/main\nrefs/heads/origin/solo\n",
        )
    }

    #[test]
    fn one_remote_branch_tracks_the_full_ref() {
        let catalog = Catalog::parse(
            "origin\n",
            "refs/remotes/origin/feature/teammate\0\n",
            "refs/heads/main\n",
        );
        let lookup = decide(&catalog, "feature/teammate");
        assert_eq!(lookup.directory, "feature/teammate");
        match lookup.outcome.expect("plan") {
            AttachPlan::Track {
                branch,
                start_point,
            } => {
                assert_eq!(branch, "feature/teammate");
                assert_eq!(start_point, "refs/remotes/origin/feature/teammate");
            }
            AttachPlan::Existing { .. } => panic!("expected a tracking plan"),
        }
    }

    #[test]
    fn qualified_name_drops_the_remote_prefix() {
        let catalog = Catalog::parse(
            "origin\n",
            "refs/remotes/origin/feature/teammate\0\n",
            "refs/heads/main\n",
        );
        let lookup = decide(&catalog, "origin/feature/teammate");
        assert_eq!(lookup.directory, "feature/teammate");
        match lookup.outcome.expect("plan") {
            AttachPlan::Track {
                branch,
                start_point,
            } => {
                assert_eq!(branch, "feature/teammate");
                assert_eq!(start_point, "refs/remotes/origin/feature/teammate");
            }
            AttachPlan::Existing { .. } => panic!("expected a tracking plan"),
        }
    }

    #[test]
    fn several_remotes_list_every_match() {
        let lookup = decide(&catalog(), "solo");
        let message = lookup.outcome.expect_err("ambiguous").to_string();
        assert_eq!(
            message,
            "Branch 'solo' exists on more than one remote (origin, upstream). Run `mabo attach <remote>/solo`."
        );
        assert!(!message.contains("stale"));
    }

    #[test]
    fn a_local_branch_of_the_raw_name_wins() {
        let lookup = decide(&catalog(), "origin/solo");
        match lookup.outcome.expect("plan") {
            AttachPlan::Existing { branch } => assert_eq!(branch, "origin/solo"),
            AttachPlan::Track { .. } => panic!("local branch should win"),
        }
    }

    #[test]
    fn an_existing_remainder_is_not_retargeted() {
        let catalog = Catalog::parse(
            "origin\n",
            "refs/remotes/origin/feature/teammate\0\n",
            "refs/heads/feature/teammate\n",
        );
        let lookup = decide(&catalog, "origin/feature/teammate");
        match lookup.outcome.expect("plan") {
            AttachPlan::Existing { branch } => assert_eq!(branch, "feature/teammate"),
            AttachPlan::Track { .. } => panic!("existing local branch should be attached"),
        }
    }

    #[test]
    fn a_remote_named_like_a_branch_prefix_only_wins_when_its_ref_exists() {
        let lookup = decide(&catalog(), "feature/teammate");
        let message = lookup.outcome.expect_err("ambiguous").to_string();
        assert!(message.contains("origin"));
        assert!(message.contains("upstream"));
    }

    #[test]
    fn create_refuses_the_branch_portion_only() {
        let catalog = Catalog::parse("origin\n", "refs/remotes/origin/feature/teammate\0\n", "");
        match catalog.exact("feature/teammate") {
            Hits::One(hit) => {
                assert_eq!(hit.remote, "origin");
                assert_eq!(hit.start_point, "refs/remotes/origin/feature/teammate");
            }
            _ => panic!("expected one remote"),
        }
        assert!(matches!(
            catalog.exact("origin/feature/teammate"),
            Hits::None
        ));
    }

    #[test]
    fn tracked_branch_names_skip_symbolic_head_and_removed_remotes() {
        let names = catalog().tracked_branches();
        assert!(names.contains("feature/teammate"));
        assert!(names.contains("solo"));
        assert!(!names.contains("HEAD"));
        assert!(!names.contains("main"));
    }
}
