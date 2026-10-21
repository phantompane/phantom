use std::fs::{self, OpenOptions};
use std::io::{ErrorKind, Write};
use std::path::{Component, Path, PathBuf};

use crate::error::{Error, Result};

pub const PROJECT_MARKER: &str = ".maboroshi-common-dir";

pub fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => match out.components().next_back() {
                Some(Component::Normal(_)) => {
                    out.pop();
                }
                Some(Component::RootDir) | Some(Component::Prefix(_)) => {}
                _ => out.push(".."),
            },
            Component::RootDir => out.push(component),
            Component::Normal(part) => out.push(part),
            Component::Prefix(prefix) => out.push(prefix.as_os_str()),
        }
    }
    out
}

pub fn relative(from: &Path, to: &Path) -> String {
    let from = normalize(from);
    let to = normalize(to);
    let from_components = from.components().collect::<Vec<_>>();
    let to_components = to.components().collect::<Vec<_>>();
    let mut shared = 0;
    while shared < from_components.len()
        && shared < to_components.len()
        && from_components[shared] == to_components[shared]
    {
        shared += 1;
    }
    let mut out = PathBuf::new();
    for component in &from_components[shared..] {
        if !matches!(component, Component::RootDir | Component::Prefix(_)) {
            out.push("..");
        }
    }
    for component in &to_components[shared..] {
        out.push(component.as_os_str());
    }
    if out.as_os_str().is_empty() {
        String::new()
    } else {
        out.to_string_lossy().replace('\\', "/")
    }
}

/// Where new workspaces for one repository are created.
///
/// `project_common_dir` is set only for the default XDG layout. It is the
/// canonical git common dir used to claim the directory with a marker.
/// The directory and marker stay in place after the last workspace is deleted.
/// A `workspace-root` preference leaves it unset.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorktreesLocation {
    pub path: PathBuf,
    pub project_common_dir: Option<PathBuf>,
}

pub fn configured_worktrees_directory(git_root: &Path, configured: &str) -> WorktreesLocation {
    let path = if Path::new(configured).is_absolute() {
        normalize(Path::new(configured))
    } else {
        normalize(&git_root.join(configured))
    };
    WorktreesLocation {
        path,
        project_common_dir: None,
    }
}

/// `$XDG_DATA_HOME/maboroshi/workspaces/<checkout>-<hash>`, or
/// `~/.local/share/maboroshi/workspaces/...` when the caller already applied the fallback.
pub fn default_worktrees_directory(
    git_root: &Path,
    common_dir_key: &Path,
    data_home: &Path,
) -> WorktreesLocation {
    let name = project_directory_name(&checkout_component(git_root), common_dir_key);
    WorktreesLocation {
        path: normalize(&data_home.join("maboroshi").join("workspaces").join(name)),
        project_common_dir: Some(common_dir_key.to_path_buf()),
    }
}

pub fn project_directory_name(checkout_name: &str, common_dir_key: &Path) -> String {
    format!(
        "{}-{}",
        sanitize_checkout_name(checkout_name),
        common_dir_digest(common_dir_key)
    )
}

/// True when `name` has the `<checkout>-<hash>` shape in either workspace layout.
pub fn is_project_directory(name: &std::ffi::OsStr, common_dir: &Path) -> bool {
    let Some(name) = name.to_str() else {
        return false;
    };
    let digest = common_dir_digest(common_dir);
    let Some((prefix, suffix)) = name.rsplit_once('-') else {
        return false;
    };
    !prefix.is_empty() && suffix == digest
}

/// Absolute path for `mabo list`. Paths under `HOME` use a `~` prefix.
pub fn list_path(path: &Path) -> String {
    let absolute = canonical_location(path);
    if let Some(home) = std::env::var_os("HOME").filter(|value| !value.is_empty()) {
        let home = canonical_location(Path::new(&home));
        if absolute == home {
            return "~".to_string();
        }
        if is_strictly_inside(&absolute, &home) {
            return format!("~/{}", relative(&home, &absolute));
        }
    }
    absolute.to_string_lossy().into_owned()
}

/// `$XDG_DATA_HOME` when it is absolute. An unset, empty, or relative value
/// falls back to `~/.local/share`.
pub fn data_home(home: Option<&Path>, xdg_data_home: Option<&Path>) -> Result<PathBuf> {
    if let Some(path) = xdg_data_home {
        if !path.as_os_str().is_empty() && path.is_absolute() {
            return Ok(path.to_path_buf());
        }
    }
    let Some(home) = home.filter(|path| !path.as_os_str().is_empty()) else {
        return Err(Error::msg("HOME is not set"));
    };
    Ok(home.join(".local").join("share"))
}

pub fn data_home_from_env() -> Result<PathBuf> {
    let xdg = std::env::var_os("XDG_DATA_HOME").filter(|value| !value.is_empty());
    let home = std::env::var_os("HOME").filter(|value| !value.is_empty());
    data_home(
        home.as_deref().map(Path::new),
        xdg.as_deref().map(Path::new),
    )
}

pub fn ensure_worktrees_directory(directory: &Path, common_dir: Option<&Path>) -> Result<()> {
    with_worktrees_directory(directory, common_dir, || Ok(()))
}

/// Claim the project directory before adding a worktree.
pub fn with_worktrees_directory<T>(
    directory: &Path,
    common_dir: Option<&Path>,
    body: impl FnOnce() -> Result<T>,
) -> Result<T> {
    match common_dir {
        Some(common_dir) => {
            let parent = directory
                .parent()
                .ok_or_else(|| Error::msg("Workspace directory has no parent"))?;
            fs::create_dir_all(parent).map_err(|error| {
                Error::msg(format!(
                    "Failed to create workspace directory {}: {error}",
                    parent.display()
                ))
            })?;
            reconcile_project_directory(directory, common_dir)?;
            body()
        }
        None => {
            fs::create_dir_all(directory).map_err(|error| {
                Error::msg(format!(
                    "Failed to create workspace directory {}: {error}",
                    directory.display()
                ))
            })?;
            body()
        }
    }
}

fn marker_matches(existing: &str, common_dir: &Path) -> bool {
    existing == common_dir_identity(common_dir) || same_location(Path::new(existing), common_dir)
}

/// Canonical path when it exists, otherwise the normalized path.
pub fn canonical_location(path: &Path) -> PathBuf {
    match fs::canonicalize(path) {
        Ok(path) => normalize(&path),
        Err(_) => normalize(path),
    }
}

pub fn same_location(left: &Path, right: &Path) -> bool {
    canonical_location(left) == canonical_location(right)
}

fn checkout_component(git_root: &Path) -> String {
    let canonical = fs::canonicalize(git_root).unwrap_or_else(|_| git_root.to_path_buf());
    canonical
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "repo".to_string())
}

fn sanitize_checkout_name(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    for ch in name.chars() {
        if ch.is_alphanumeric() || matches!(ch, '.' | '_' | '-') {
            out.push(ch);
        } else {
            out.push('-');
        }
    }
    if out.is_empty() || out.chars().all(|ch| ch == '.') {
        "repo".to_string()
    } else {
        out
    }
}

fn common_dir_digest(path: &Path) -> String {
    use sha2::{Digest, Sha256};
    use std::os::unix::ffi::OsStrExt;

    let digest = Sha256::digest(path.as_os_str().as_bytes());
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(8);
    for byte in digest.iter().take(4) {
        out.push(HEX[(*byte >> 4) as usize] as char);
        out.push(HEX[(*byte & 0x0f) as usize] as char);
    }
    out
}

fn common_dir_identity(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn reconcile_project_directory(directory: &Path, common_dir: &Path) -> Result<()> {
    if let Ok(metadata) = fs::symlink_metadata(directory) {
        if metadata.file_type().is_symlink() {
            return Err(Error::msg(format!(
                "Workspace directory {} is a symlink. Refusing to reuse it.",
                directory.display()
            )));
        }
        if !metadata.is_dir() {
            return Err(Error::msg(format!(
                "Workspace directory {} is not a directory",
                directory.display()
            )));
        }
    } else {
        fs::create_dir(directory)
            .or_else(|error| {
                if error.kind() == ErrorKind::AlreadyExists {
                    Ok(())
                } else {
                    Err(error)
                }
            })
            .map_err(|error| {
                Error::msg(format!(
                    "Failed to create workspace directory {}: {error}",
                    directory.display()
                ))
            })?;
    }
    match read_marker(directory)? {
        Some(existing) if marker_matches(&existing, common_dir) => Ok(()),
        Some(existing) => Err(Error::msg(format!(
            "Workspace directory {} belongs to {existing}, not {}. Refusing to reuse another repository's workspace directory.",
            directory.display(),
            common_dir_identity(common_dir)
        ))),
        None => {
            let names = directory_entries(directory)?;
            if !names.is_empty() {
                // A concurrent creator may have published the marker after
                // our first read. Its complete marker is safe to reuse.
                if read_marker(directory)?.as_deref().is_some_and(|existing| marker_matches(existing, common_dir)) {
                    return Ok(());
                }
                return Err(Error::msg(format!(
                    "Workspace directory {} exists without a repository marker and is not empty. Refusing to reuse it.",
                    directory.display()
                )));
            }
            let Some(parent) = directory.parent() else {
                return Err(Error::msg(format!(
                    "Workspace directory {} has no parent",
                    directory.display()
                )));
            };
            write_marker(parent, directory, &common_dir_identity(common_dir))
        }
    }
}

fn read_marker(directory: &Path) -> Result<Option<String>> {
    let path = directory.join(PROJECT_MARKER);
    match fs::read_to_string(&path) {
        Ok(content) => Ok(Some(content.trim_end_matches(['\n', '\r']).to_string())),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
        Err(error) => Err(Error::msg(format!(
            "Failed to read workspace directory marker {}: {error}",
            path.display()
        ))),
    }
}

fn write_marker(parent: &Path, directory: &Path, identity: &str) -> Result<()> {
    let temp = parent.join(format!(
        ".maboroshi-common-dir-{}.tmp",
        uuid::Uuid::new_v4()
    ));
    let target = directory.join(PROJECT_MARKER);
    let written = write_marker_file(&temp, &target, directory, identity);
    if written.is_err() {
        let _ = fs::remove_file(&temp);
    }
    written
}

fn write_marker_file(temp: &Path, target: &Path, directory: &Path, identity: &str) -> Result<()> {
    use std::os::unix::fs::OpenOptionsExt;
    let mut file = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o644)
        .open(temp)
        .map_err(|error| marker_error(directory, &error))?;
    writeln!(file, "{identity}").map_err(|error| marker_error(directory, &error))?;
    file.sync_all()
        .map_err(|error| marker_error(directory, &error))?;
    let result = match fs::hard_link(temp, target) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == ErrorKind::AlreadyExists => {
            match fs::read_to_string(target) {
                Ok(existing) if existing.trim_end() == identity => Ok(()),
                _ => Err(marker_error(directory, &error)),
            }
        }
        Err(error) => Err(marker_error(directory, &error)),
    };
    let _ = fs::remove_file(temp);
    result
}

fn marker_error(directory: &Path, error: &std::io::Error) -> Error {
    Error::msg(format!(
        "Failed to record repository for workspace directory {}: {error}",
        directory.display()
    ))
}

fn directory_entries(directory: &Path) -> Result<Vec<std::ffi::OsString>> {
    let entries = fs::read_dir(directory).map_err(|error| {
        Error::msg(format!(
            "Failed to read workspace directory {}: {error}",
            directory.display()
        ))
    })?;
    let mut names = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|error| {
            Error::msg(format!(
                "Failed to read workspace directory {}: {error}",
                directory.display()
            ))
        })?;
        names.push(entry.file_name());
    }
    names.sort();
    Ok(names)
}

pub fn worktree_path(directory: &Path, name: &str, separator: &str) -> PathBuf {
    let directory_name = if separator == "/" {
        name.to_string()
    } else {
        name.replace('/', separator)
    };
    normalize(&directory.join(directory_name))
}

/// `$XDG_CONFIG_HOME/maboroshi/config.toml`, or `~/.config/maboroshi/config.toml` when
/// `XDG_CONFIG_HOME` is unset, empty, or relative.
pub fn user_config_file(home: &Path, xdg_config_home: Option<&Path>) -> PathBuf {
    let config_home = match xdg_config_home {
        Some(path) if path.is_absolute() => path.to_path_buf(),
        _ => home.join(".config"),
    };
    mabo_config_file(&config_home)
}

pub fn user_config_path() -> Result<PathBuf> {
    if let Some(xdg) = absolute_xdg_config_home() {
        return Ok(mabo_config_file(&xdg));
    }
    let Some(home) = std::env::var_os("HOME").filter(|value| !value.is_empty()) else {
        return Err(Error::msg("HOME is not set"));
    };
    Ok(user_config_file(Path::new(&home), None))
}

fn mabo_config_file(config_home: &Path) -> PathBuf {
    config_home.join("maboroshi").join("config.toml")
}

fn absolute_xdg_config_home() -> Option<PathBuf> {
    let value = std::env::var_os("XDG_CONFIG_HOME")?;
    if value.is_empty() {
        return None;
    }
    let path = PathBuf::from(value);
    path.is_absolute().then_some(path)
}

pub fn is_strictly_inside(path: &Path, directory: &Path) -> bool {
    let path = canonical_location(path);
    let directory = canonical_location(directory);
    let relative_path = relative(&directory, &path);
    !relative_path.is_empty()
        && !relative_path.starts_with("..")
        && !Path::new(&relative_path).is_absolute()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn symlink_inside_the_worktrees_directory_is_inside() {
        let root = std::env::temp_dir().join(format!(
            "mabo-inside-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        let project = root.join("project");
        let feature = project.join("feature");
        fs::create_dir_all(&feature).expect("feature");
        let via = root.join("via");
        std::os::unix::fs::symlink(&project, &via).expect("symlink");
        let spelled = via.join("feature");
        assert!(is_strictly_inside(&spelled, &project));
        assert!(!is_strictly_inside(&spelled, &feature));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn relative_paths_match_node() {
        assert_eq!(relative(Path::new("/repo"), Path::new("/repo")), "");
        assert_eq!(
            relative(
                Path::new("/repo"),
                Path::new("/repo/.git/maboroshi/worktrees/listed")
            ),
            ".git/maboroshi/worktrees/listed"
        );
        assert_eq!(relative(Path::new("/repo/a"), Path::new("/repo/b")), "../b");
    }

    #[test]
    fn default_worktrees_directory_uses_xdg_and_the_common_dir() {
        let root = Path::new("/repo");
        let git_dir = Path::new("/repo/.git");
        let separate = Path::new("/var/sep.git");
        let data = Path::new("/home/u/.local/share");
        let location = default_worktrees_directory(root, git_dir, data);
        assert_eq!(
            location.path,
            PathBuf::from("/home/u/.local/share/maboroshi/workspaces/repo-6b4ca2db")
        );
        assert_eq!(location.project_common_dir.as_deref(), Some(git_dir));
        let separate_location = default_worktrees_directory(root, separate, data);
        assert_eq!(
            separate_location.path,
            PathBuf::from("/home/u/.local/share/maboroshi/workspaces/repo-0d78ac9a")
        );
        assert_ne!(location.path, separate_location.path);
        assert_eq!(
            project_directory_name("widget", Path::new("/tmp/a/.git")),
            "widget-d450d81f"
        );
        assert_eq!(
            project_directory_name("widget", Path::new("/tmp/b/.git")),
            "widget-ac3760e0"
        );
        assert_eq!(
            project_directory_name("My Repo", git_dir),
            "My-Repo-6b4ca2db"
        );
        assert_eq!(project_directory_name("..", git_dir), "repo-6b4ca2db");
        assert_eq!(
            project_directory_name(".hidden", git_dir),
            ".hidden-6b4ca2db"
        );
    }

    #[test]
    fn symlink_checkout_uses_the_canonical_directory_name() {
        let root = std::env::temp_dir().join(format!(
            "mabo-spell-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        let checkout = root.join("real-name");
        fs::create_dir_all(&checkout).expect("checkout");
        let link = root.join("link-name");
        std::os::unix::fs::symlink(&checkout, &link).expect("symlink");
        let nested = root.join("nested");
        fs::create_dir_all(&nested).expect("nested");
        let indirect = nested.join("again");
        std::os::unix::fs::symlink(&link, &indirect).expect("indirect");
        let common = Path::new("/var/sep.git");
        let data = Path::new("/home/u/.local/share");
        let from_real = default_worktrees_directory(&checkout, common, data);
        let from_link = default_worktrees_directory(&link, common, data);
        let from_indirect = default_worktrees_directory(&indirect, common, data);
        assert_eq!(from_real.path, from_link.path);
        assert_eq!(from_real.path, from_indirect.path);
        assert_eq!(
            from_real.path,
            PathBuf::from("/home/u/.local/share/maboroshi/workspaces/real-name-0d78ac9a")
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn configured_worktrees_directory_stays_relative_to_the_repo() {
        let root = Path::new("/repo");
        assert_eq!(
            configured_worktrees_directory(root, "/var/wt").path,
            PathBuf::from("/var/wt")
        );
        assert!(configured_worktrees_directory(root, "/var/wt")
            .project_common_dir
            .is_none());
        assert_eq!(
            configured_worktrees_directory(root, "custom/trees").path,
            PathBuf::from("/repo/custom/trees")
        );
    }

    #[test]
    fn data_home_ignores_a_relative_xdg_data_home() {
        let home = Path::new("/home/phantom");
        let fallback = PathBuf::from("/home/phantom/.local/share");
        assert_eq!(
            data_home(Some(home), Some(Path::new("/tmp/xdg"))).expect("absolute"),
            PathBuf::from("/tmp/xdg")
        );
        assert_eq!(data_home(Some(home), None).expect("unset"), fallback);
        assert_eq!(
            data_home(Some(home), Some(Path::new(""))).expect("empty"),
            fallback
        );
        assert_eq!(
            data_home(Some(home), Some(Path::new("relative"))).expect("relative"),
            fallback
        );
        assert!(data_home(None, None).is_err());
        assert!(data_home(None, Some(Path::new("relative"))).is_err());
    }

    #[test]
    fn project_directory_claim_rejects_a_different_repository() {
        let root = std::env::temp_dir().join(format!(
            "mabo-claim-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        let directory = root.join("maboroshi/worktrees/repo-abcdef12");
        let first = Path::new("/repos/one/.git");
        let second = Path::new("/repos/two/.git");
        ensure_worktrees_directory(&directory, Some(first)).expect("claim");
        ensure_worktrees_directory(&directory, Some(first)).expect("same repo");
        let conflict = ensure_worktrees_directory(&directory, Some(second)).expect_err("conflict");
        let message = conflict.to_string();
        assert!(message.contains("/repos/one/.git"), "{message}");
        assert!(message.contains("/repos/two/.git"), "{message}");
        assert!(message.contains("Refusing to reuse"), "{message}");
        fs::create_dir_all(directory.join("feature")).expect("worktree");
        fs::remove_file(directory.join(PROJECT_MARKER)).expect("drop marker");
        let unmarked = ensure_worktrees_directory(&directory, Some(first)).expect_err("unmarked");
        assert!(
            unmarked.to_string().contains("without a repository marker"),
            "{unmarked}"
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn empty_unmarked_project_directory_is_claimed() {
        let root = std::env::temp_dir().join(format!(
            "mabo-reclaim-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        let directory = root.join("maboroshi/worktrees/repo-abcdef12");
        fs::create_dir_all(&directory).expect("empty");
        let common = Path::new("/repos/one/.git");
        ensure_worktrees_directory(&directory, Some(common)).expect("reclaim");
        assert_eq!(
            fs::read_to_string(directory.join(PROJECT_MARKER))
                .expect("marker")
                .trim_end(),
            "/repos/one/.git"
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn claim_accepts_a_marker_for_the_same_canonical_directory() {
        let root = std::env::temp_dir().join(format!(
            "mabo-marker-link-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        let real = root.join("real.git");
        fs::create_dir_all(&real).expect("real");
        let link = root.join("link.git");
        std::os::unix::fs::symlink(&real, &link).expect("symlink");
        let directory = root.join("maboroshi/worktrees/repo");
        fs::create_dir_all(&directory).expect("project");
        fs::write(
            directory.join(PROJECT_MARKER),
            format!("{}\n", link.display()),
        )
        .expect("marker");
        ensure_worktrees_directory(&directory, Some(&real)).expect("same directory");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn failed_marker_publication_removes_the_temp_file() {
        let root = std::env::temp_dir().join(format!(
            "mabo-marker-tmp-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        let parent = root.join("parent");
        let directory = parent.join("project");
        fs::create_dir_all(&directory).expect("project");
        fs::create_dir(directory.join(PROJECT_MARKER)).expect("block rename");
        let error = write_marker(&parent, &directory, "/repos/one/.git").expect_err("rename");
        assert!(error.to_string().contains("Failed to record"), "{error}");
        assert_eq!(fs::read_dir(&parent).unwrap().count(), 1);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn concurrent_claims_for_the_same_repository_succeed() {
        let root = std::env::temp_dir().join(format!(
            "mabo-race-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        let directory = root.join("maboroshi/worktrees/repo-abcdef12");
        let common = Path::new("/repos/one/.git");
        std::thread::scope(|scope| {
            for _ in 0..8 {
                scope.spawn(|| {
                    ensure_worktrees_directory(&directory, Some(common)).expect("claim");
                });
            }
        });
        let marker = fs::read_to_string(directory.join(PROJECT_MARKER)).expect("marker");
        assert_eq!(marker.trim_end(), "/repos/one/.git");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn flattens_directory_names() {
        let path = worktree_path(Path::new("/tmp/worktrees"), "feature/test", "-");
        assert_eq!(path, PathBuf::from("/tmp/worktrees/feature-test"));
    }

    #[test]
    fn user_config_file_follows_xdg_config_home() {
        let home = Path::new("/home/phantom");
        let xdg = Path::new("/tmp/xdg");
        assert_eq!(
            user_config_file(home, Some(xdg)),
            PathBuf::from("/tmp/xdg/maboroshi/config.toml")
        );
        assert_eq!(
            user_config_file(home, None),
            PathBuf::from("/home/phantom/.config/maboroshi/config.toml")
        );
        assert_eq!(
            user_config_file(home, Some(Path::new("relative"))),
            PathBuf::from("/home/phantom/.config/maboroshi/config.toml")
        );
        assert_eq!(
            user_config_file(home, Some(Path::new(""))),
            PathBuf::from("/home/phantom/.config/maboroshi/config.toml")
        );
    }
}
