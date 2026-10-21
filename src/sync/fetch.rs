//! Conservative preflight for ordinary fetches in the invoking repository.
use std::collections::BTreeSet;
use std::path::Path;

use crate::error::{Error, Result, REFUSED};
use crate::git;

pub(super) fn check(root: &Path, involved: &BTreeSet<String>) -> Result<()> {
    if involved.is_empty() {
        return Ok(());
    }
    // Check every involved remote before fetching any of them. Negative
    // refspecs intentionally do not relax this conservative destination guard.
    for remote in involved {
        let configured = git::raw_git(
            root,
            &[
                "config",
                "--null",
                "--get-all",
                &format!("remote.{remote}.fetch"),
            ],
        )?;
        if configured.code != 0 && configured.code != 1 {
            return Err(Error::msg(format!(
                "Cannot read remote.{remote}.fetch (exit {}): {}",
                configured.code,
                configured.stderr.trim()
            )));
        }
        for spec in configured
            .stdout
            .split('\0')
            .filter(|spec| !spec.is_empty())
        {
            let positive = spec.strip_prefix('+').unwrap_or(spec);
            if positive.starts_with('^') {
                continue;
            }
            // A missing or empty destination only writes FETCH_HEAD. Leave
            // refspec validity and all other fetch semantics to Git.
            if let Some((_, destination)) = positive.split_once(':') {
                if !destination.is_empty()
                    && !destination.starts_with("refs/remotes/")
                    && !destination.starts_with("refs/tags/")
                {
                    return Err(Error::status(REFUSED, format!(
                        "Unsafe remote.{remote}.fetch refspec '{spec}'; sync requires destinations under refs/remotes/ or refs/tags/. Configure safe tracking destinations before retrying (negative refspec exclusions do not relax this check)"
                    )));
                }
            }
        }
    }
    // for-each-ref omits dangling symrefs. This is a documented limit shared
    // with ordinary git fetch; do not introduce a separate ref database/parser.
    let symbols = super::checked_output(
        &[
            "for-each-ref",
            "--format=%(refname)%09%(symref)",
            "refs/remotes/",
        ],
        root,
        true,
    )?;
    for (name, target) in symbols.lines().filter_map(|line| line.split_once('\t')) {
        if !target.is_empty() && !target.starts_with("refs/remotes/") {
            return Err(Error::status(REFUSED, format!(
                "Unsafe remote-tracking symbolic ref '{name}' points outside refs/remotes/ to '{target}'. Repair or remove this symbolic ref before retrying sync"
            )));
        }
    }
    Ok(())
}

pub(super) fn fetch(root: &Path, remote: &str) -> Result<()> {
    super::checked_output(
        &[
            "fetch",
            "--prune",
            "--no-auto-maintenance",
            "--no-recurse-submodules",
            "--",
            remote,
        ],
        root,
        true,
    )
    .map_err(|error| Error::msg(format!("Fetch {remote} failed: {error}")))?;
    Ok(())
}
