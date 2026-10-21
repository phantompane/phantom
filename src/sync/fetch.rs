//! Let Git interpret refspecs in an isolated ref database, then publish tracking
//! refs without ever following a symbolic ref into a local branch.
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use crate::error::{Error, Result};
use crate::git;

#[derive(PartialEq, Eq)]
struct Ref {
    oid: String,
    target: String,
}

fn tracking(reference: &str) -> bool {
    reference.starts_with("refs/") && !reference.starts_with("refs/heads/")
}

fn refs(root: &Path, prefix: &[&str], env: &[(&str, &str)]) -> Result<BTreeMap<String, Ref>> {
    let mut args = prefix.to_vec();
    args.extend([
        "for-each-ref",
        "--format=%(refname)%09%(objectname)%09%(symref)",
    ]);
    let result = git::raw_git_with_env(root, &args, env)?;
    if result.code != 0 {
        return Err(Error::msg(format!(
            "Cannot read fetch refs (exit {}): {}",
            result.code,
            result.stderr.trim()
        )));
    }
    let mut refs = BTreeMap::new();
    for line in result.stdout.lines() {
        let mut fields = line.split('\t');
        if let (Some(name), Some(oid), Some(target)) = (fields.next(), fields.next(), fields.next())
        {
            if tracking(name) {
                refs.insert(
                    name.to_string(),
                    Ref {
                        oid: oid.to_string(),
                        target: target.to_string(),
                    },
                );
            }
        }
    }
    Ok(refs)
}

struct TemporaryRepository(PathBuf);
impl Drop for TemporaryRepository {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn path_text(path: &Path) -> Result<&str> {
    path.to_str()
        .ok_or_else(|| Error::msg("Fetch repository path is not UTF-8"))
}

// Flatten the effective configuration while still in the source repository.
// In particular, includeIf.gitdir/hasconfig and worktree config must be evaluated
// there, not against the temporary Git directory. Git supplies canonical keys.
fn configuration(root: &Path) -> Result<String> {
    let listed = super::checked_output(&["config", "--null", "--list", "--includes"], root, false)?;
    let quote = |value: &str| {
        value
            .replace('\\', "\\\\")
            .replace('"', "\\\"")
            .replace('\n', "\\n")
            .replace('\t', "\\t")
            .replace('\u{8}', "\\b")
    };
    let mut config = String::new();
    for entry in listed.split('\0').filter(|entry| !entry.is_empty()) {
        let (key, value) = match entry.split_once('\n') {
            Some((key, value)) => (key, Some(value)),
            None => (entry, None),
        };
        // Keep the temporary repository's format, which git init selected.
        if key.starts_with("include.")
            || key.starts_with("includeif.")
            || matches!(
                key,
                "core.repositoryformatversion"
                    | "core.worktree"
                    | "extensions.objectformat"
                    | "extensions.refstorage"
                    | "extensions.worktreeconfig"
            )
        {
            continue;
        }
        let (section, variable) = key
            .rsplit_once('.')
            .ok_or_else(|| Error::msg("Invalid effective Git configuration key"))?;
        if let Some((section, subsection)) = section.split_once('.') {
            config.push_str(&format!("[{section} \"{}\"]\n", quote(subsection)));
        } else {
            config.push_str(&format!("[{section}]\n"));
        }
        match value {
            Some(value) => config.push_str(&format!("{variable} = \"{}\"\n", quote(value))),
            None => config.push_str(&format!("{variable}\n")),
        }
    }
    Ok(config)
}

pub(super) fn fetch(root: &Path, remote: &str) -> Result<()> {
    let before = refs(root, &[], &[])?;
    let configuration = configuration(root)?;
    let common = git::git_common_dir(root)?;
    let objects = root.join(super::checked_output(
        &["rev-parse", "--git-path", "objects"],
        root,
        true,
    )?);
    let format = super::checked_output(&["rev-parse", "--show-object-format"], root, true)?;
    let temporary_path = std::env::temp_dir().join(format!("mabo-fetch-{}", uuid::Uuid::new_v4()));
    // create_dir reserves a fresh private ref database, including for dangling
    // symrefs that for-each-ref cannot see. No user ref is a fetch destination.
    let mut builder = std::fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder
        .create(&temporary_path)
        .map_err(|error| Error::msg(error.to_string()))?;
    let temporary = TemporaryRepository(temporary_path);
    let directory = path_text(&temporary.0)?;
    super::checked_output(
        &[
            "init",
            "--bare",
            "--template=",
            &format!("--object-format={format}"),
            directory,
        ],
        root,
        true,
    )?;
    // git init can apply shared-repository permissions from global config.
    // Keep the effective configuration private even in that environment.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&temporary.0, std::fs::Permissions::from_mode(0o700))
            .map_err(|error| Error::msg(error.to_string()))?;
    }
    let config = temporary.0.join("config");
    let mut initialized =
        std::fs::read_to_string(&config).map_err(|error| Error::msg(error.to_string()))?;
    initialized.push_str(&configuration);
    std::fs::write(&config, initialized).map_err(|error| Error::msg(error.to_string()))?;
    let env = [
        ("GIT_DIR", directory),
        ("GIT_COMMON_DIR", directory),
        ("GIT_OBJECT_DIRECTORY", path_text(&objects)?),
        ("GIT_CONFIG_GLOBAL", "/dev/null"),
        ("GIT_CONFIG_NOSYSTEM", "1"),
        ("GIT_CONFIG_COUNT", "0"),
        ("GIT_CONFIG_PARAMETERS", ""),
    ];
    let prefix = [
        "-c",
        "core.bare=true",
        "-c",
        "core.logAllRefUpdates=false",
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "core.fsmonitor=false",
    ];
    let run = |args: &[&str]| -> Result<()> {
        let args: Vec<_> = prefix.iter().copied().chain(args.iter().copied()).collect();
        let result = git::raw_git_with_env(root, &args, &env)?;
        if result.code != 0 {
            return Err(Error::msg(format!(
                "Fetch {remote} failed (exit {}): {}",
                result.code,
                result.stderr.trim()
            )));
        }
        Ok(())
    };
    // Seed tracking refs so Git itself applies negative exclusions and pruning
    // against the observed state. Ordinary aliases are seeded as direct refs:
    // fetch can then update their value without dereferencing the user's alias.
    // Preserve remote HEAD aliases to retain Git's followRemoteHEAD semantics.
    for (name, value) in &before {
        if name.starts_with("refs/remotes/") && name.ends_with("/HEAD") && tracking(&value.target) {
            run(&["symbolic-ref", name, &value.target])?;
        } else {
            run(&["update-ref", "--no-deref", name, &value.oid])?;
        }
    }
    let shallow = common.join("shallow");
    if shallow.is_file() {
        std::fs::copy(&shallow, temporary.0.join("shallow"))
            .map_err(|error| Error::msg(error.to_string()))?;
    }
    // Relative remote URLs still resolve from the original checkout. Objects
    // go straight into its object store; refs, reflogs and pruning stay isolated.
    run(&[
        "fetch",
        "--prune",
        "--no-auto-maintenance",
        "--no-recurse-submodules",
        "--",
        remote,
    ])?;
    let after = refs(root, &prefix, &env)?;
    for (name, value) in &after {
        if before.get(name) == Some(value) {
            continue;
        }
        if tracking(&value.target) {
            super::checked_output(&["symbolic-ref", name, &value.target], root, true)?;
        } else {
            // --no-deref also replaces an unresolved symref, without creating
            // its missing local-branch target. Never promote refs/heads/.
            super::checked_output(&["update-ref", "--no-deref", name, &value.oid], root, true)?;
        }
    }
    for name in before.keys().filter(|name| !after.contains_key(*name)) {
        super::checked_output(&["update-ref", "--no-deref", "-d", name], root, true)?;
    }
    std::fs::copy(temporary.0.join("FETCH_HEAD"), common.join("FETCH_HEAD"))
        .map_err(|error| Error::msg(error.to_string()))?;
    Ok(())
}
