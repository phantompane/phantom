use std::fs::{self, File, OpenOptions};
use std::io::{ErrorKind, Write};
use std::path::{Component, Path, PathBuf};

use crate::error::{Error, Result};

pub const PROJECT_MARKER: &str = ".ptm-common-dir";
const WORKTREES_LOCK: &str = ".ptm-worktrees.lock";

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

/// Where new worktrees for one repository are created.
///
/// `project_common_dir` is set only for the default XDG layout. It is the
/// canonical git common dir, and the directory may be removed when empty.
/// A `worktrees-directory` preference leaves it unset and keeps that directory.
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

/// `$XDG_DATA_HOME/ptm/worktrees/<checkout>-<hash>`, or
/// `~/.local/share/ptm/worktrees/...` when the caller already applied the fallback.
pub fn default_worktrees_directory(
    git_root: &Path,
    common_dir_key: &Path,
    data_home: &Path,
) -> WorktreesLocation {
    let name = project_directory_name(&checkout_component(git_root), common_dir_key);
    WorktreesLocation {
        path: normalize(&data_home.join("ptm").join("worktrees").join(name)),
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

/// Claim the project directory and run `body` before any last-worktree delete
/// can remove it. The lock is the same one `remove_project_directory_if_empty`
/// takes, and it stays held until `body` returns. `git worktree add` belongs
/// inside `body`. A preference directory is created without that lock.
pub fn with_worktrees_directory<T>(
    directory: &Path,
    common_dir: Option<&Path>,
    body: impl FnOnce() -> Result<T>,
) -> Result<T> {
    match common_dir {
        Some(common_dir) => {
            let Some(parent) = directory.parent() else {
                return Err(Error::msg(format!(
                    "Worktree directory {} has no parent",
                    directory.display()
                )));
            };
            with_worktrees_lock(parent, || {
                reconcile_project_directory(directory, common_dir)?;
                body()
            })
        }
        None => {
            fs::create_dir_all(directory).map_err(|error| {
                Error::msg(format!(
                    "Failed to create worktree directory {}: {error}",
                    directory.display()
                ))
            })?;
            body()
        }
    }
}

/// Result of trying to remove an empty project directory.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectDirRemoval {
    pub removed: bool,
    pub warning: Option<String>,
}

/// Remove the project directory when it holds nothing but this repository's marker.
///
/// A missing or different `.ptm-common-dir` leaves the directory in place.
/// The parent `ptm/worktrees` directory is never removed.
pub fn remove_project_directory_if_empty(
    directory: &Path,
    common_dir: &Path,
) -> Result<ProjectDirRemoval> {
    let Some(parent) = directory.parent() else {
        return Ok(ProjectDirRemoval {
            removed: false,
            warning: None,
        });
    };
    if !parent.exists() || !fs::symlink_metadata(directory).is_ok_and(|meta| meta.is_dir()) {
        return Ok(ProjectDirRemoval {
            removed: false,
            warning: None,
        });
    }
    with_worktrees_lock(parent, || {
        if !fs::symlink_metadata(directory).is_ok_and(|meta| meta.is_dir()) {
            return Ok(ProjectDirRemoval {
                removed: false,
                warning: None,
            });
        }
        let names = directory_entries(directory)?;
        let marker_name = std::ffi::OsString::from(PROJECT_MARKER);
        let only_marker = names.len() == 1 && names[0] == marker_name;
        if !names.is_empty() && !only_marker {
            return Ok(ProjectDirRemoval {
                removed: false,
                warning: None,
            });
        }
        let marker_path = directory.join(PROJECT_MARKER);
        let marker = read_marker(directory)?;
        if !marker
            .as_deref()
            .is_some_and(|existing| marker_matches(existing, common_dir))
        {
            let warning = match marker {
                Some(_) => format!(
                    "Left worktree directory {} in place because its repository marker belongs to a different repository.",
                    directory.display()
                ),
                None => format!(
                    "Left worktree directory {} in place because it has no repository marker.",
                    directory.display()
                ),
            };
            return Ok(ProjectDirRemoval {
                removed: false,
                warning: Some(warning),
            });
        }
        let saved = fs::read(&marker_path).ok();
        fs::remove_file(&marker_path).map_err(|error| {
            Error::msg(format!(
                "Failed to remove empty directory {}: {error}",
                directory.display()
            ))
        })?;
        match fs::remove_dir(directory) {
            Ok(()) => Ok(ProjectDirRemoval {
                removed: true,
                warning: None,
            }),
            Err(error) if error.kind() == ErrorKind::NotFound => Ok(ProjectDirRemoval {
                removed: false,
                warning: None,
            }),
            Err(error) if error.kind() == ErrorKind::DirectoryNotEmpty => {
                if let Some(bytes) = saved {
                    let _ = fs::write(&marker_path, bytes);
                }
                Ok(ProjectDirRemoval {
                    removed: false,
                    warning: None,
                })
            }
            Err(error) => Err(Error::msg(format!(
                "Failed to remove empty directory {}: {error}",
                directory.display()
            ))),
        }
    })
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
                "Worktree directory {} is a symlink. Refusing to reuse it.",
                directory.display()
            )));
        }
        if !metadata.is_dir() {
            return Err(Error::msg(format!(
                "Worktree directory {} is not a directory",
                directory.display()
            )));
        }
    } else {
        fs::create_dir(directory).map_err(|error| {
            Error::msg(format!(
                "Failed to create worktree directory {}: {error}",
                directory.display()
            ))
        })?;
    }
    let identity = common_dir_identity(common_dir);
    match read_marker(directory)? {
        Some(existing) if existing == identity => Ok(()),
        Some(existing) => Err(Error::msg(format!(
            "Worktree directory {} belongs to {existing}, not {identity}. Refusing to reuse another repository's worktree directory.",
            directory.display()
        ))),
        None => {
            let names = directory_entries(directory)?;
            if !names.is_empty() {
                return Err(Error::msg(format!(
                    "Worktree directory {} exists without a repository marker and is not empty. Refusing to reuse it.",
                    directory.display()
                )));
            }
            let Some(parent) = directory.parent() else {
                return Err(Error::msg(format!(
                    "Worktree directory {} has no parent",
                    directory.display()
                )));
            };
            write_marker(parent, directory, &identity)
        }
    }
}

fn read_marker(directory: &Path) -> Result<Option<String>> {
    let path = directory.join(PROJECT_MARKER);
    match fs::read_to_string(&path) {
        Ok(content) => Ok(Some(content.trim_end_matches(['\n', '\r']).to_string())),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
        Err(error) => Err(Error::msg(format!(
            "Failed to read worktree directory marker {}: {error}",
            path.display()
        ))),
    }
}

fn write_marker(parent: &Path, directory: &Path, identity: &str) -> Result<()> {
    let temp = parent.join(".ptm-common-dir.tmp");
    let target = directory.join(PROJECT_MARKER);
    {
        use std::os::unix::fs::OpenOptionsExt;
        let mut file = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o644)
            .open(&temp)
            .map_err(|error| {
                Error::msg(format!(
                    "Failed to record repository for worktree directory {}: {error}",
                    directory.display()
                ))
            })?;
        writeln!(file, "{identity}").map_err(|error| {
            Error::msg(format!(
                "Failed to record repository for worktree directory {}: {error}",
                directory.display()
            ))
        })?;
        file.sync_all().map_err(|error| {
            Error::msg(format!(
                "Failed to record repository for worktree directory {}: {error}",
                directory.display()
            ))
        })?;
    }
    fs::rename(&temp, &target).map_err(|error| {
        Error::msg(format!(
            "Failed to record repository for worktree directory {}: {error}",
            directory.display()
        ))
    })
}

fn directory_entries(directory: &Path) -> Result<Vec<std::ffi::OsString>> {
    let entries = fs::read_dir(directory).map_err(|error| {
        Error::msg(format!(
            "Failed to read worktree directory {}: {error}",
            directory.display()
        ))
    })?;
    let mut names = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|error| {
            Error::msg(format!(
                "Failed to read worktree directory {}: {error}",
                directory.display()
            ))
        })?;
        names.push(entry.file_name());
    }
    names.sort();
    Ok(names)
}

fn with_worktrees_lock<T>(parent: &Path, body: impl FnOnce() -> Result<T>) -> Result<T> {
    use std::os::unix::fs::OpenOptionsExt;
    fs::create_dir_all(parent).map_err(|error| {
        Error::msg(format!(
            "Failed to create worktree directory {}: {error}",
            parent.display()
        ))
    })?;
    let lock = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .open(parent.join(WORKTREES_LOCK))
        .map_err(|error| {
            Error::msg(format!(
                "Failed to lock worktree directory {}: {error}",
                parent.display()
            ))
        })?;
    lock_file(&lock, parent)?;
    let result = body();
    let _ = lock.unlock();
    result
}

fn lock_file(lock: &File, parent: &Path) -> Result<()> {
    lock.lock().map_err(|error| {
        Error::msg(format!(
            "Failed to lock worktree directory {}: {error}",
            parent.display()
        ))
    })
}

pub fn worktree_path(directory: &Path, name: &str, separator: &str) -> PathBuf {
    let directory_name = if separator == "/" {
        name.to_string()
    } else {
        name.replace('/', separator)
    };
    normalize(&directory.join(directory_name))
}

/// `$XDG_CONFIG_HOME/ptm/config.toml`, or `~/.config/ptm/config.toml` when
/// `XDG_CONFIG_HOME` is unset, empty, or relative.
pub fn user_config_file(home: &Path, xdg_config_home: Option<&Path>) -> PathBuf {
    let config_home = match xdg_config_home {
        Some(path) if path.is_absolute() => path.to_path_buf(),
        _ => home.join(".config"),
    };
    ptm_config_file(&config_home)
}

pub fn user_config_path() -> Result<PathBuf> {
    if let Some(xdg) = absolute_xdg_config_home() {
        return Ok(ptm_config_file(&xdg));
    }
    let Some(home) = std::env::var_os("HOME").filter(|value| !value.is_empty()) else {
        return Err(Error::msg("HOME is not set"));
    };
    Ok(user_config_file(Path::new(&home), None))
}

fn ptm_config_file(config_home: &Path) -> PathBuf {
    config_home.join("ptm").join("config.toml")
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
    let relative_path = relative(directory, path);
    !relative_path.is_empty()
        && !relative_path.starts_with("..")
        && !Path::new(&relative_path).is_absolute()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relative_paths_match_node() {
        assert_eq!(relative(Path::new("/repo"), Path::new("/repo")), "");
        assert_eq!(
            relative(
                Path::new("/repo"),
                Path::new("/repo/.git/ptm/worktrees/listed")
            ),
            ".git/ptm/worktrees/listed"
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
            PathBuf::from("/home/u/.local/share/ptm/worktrees/repo-6b4ca2db")
        );
        assert_eq!(location.project_common_dir.as_deref(), Some(git_dir));
        let separate_location = default_worktrees_directory(root, separate, data);
        assert_eq!(
            separate_location.path,
            PathBuf::from("/home/u/.local/share/ptm/worktrees/repo-0d78ac9a")
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
            "ptm-spell-{}-{}",
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
            PathBuf::from("/home/u/.local/share/ptm/worktrees/real-name-0d78ac9a")
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
            "ptm-claim-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        let directory = root.join("ptm/worktrees/repo-abcdef12");
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
    fn project_directory_is_removed_only_when_empty() {
        let root = std::env::temp_dir().join(format!(
            "ptm-empty-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        let ceiling = root.join("ptm/worktrees");
        let directory = ceiling.join("repo-abcdef12");
        let common = Path::new("/repos/one/.git");
        ensure_worktrees_directory(&directory, Some(common)).expect("claim");
        fs::create_dir_all(directory.join("feature")).expect("worktree");
        assert!(
            !remove_project_directory_if_empty(&directory, common)
                .expect("kept")
                .removed
        );
        assert!(directory.is_dir());
        fs::remove_dir(directory.join("feature")).expect("remove worktree");
        assert!(
            remove_project_directory_if_empty(&directory, common)
                .expect("removed")
                .removed
        );
        assert!(!directory.exists());
        assert!(ceiling.is_dir());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn project_directory_removal_requires_this_repository_marker() {
        let root = std::env::temp_dir().join(format!(
            "ptm-marker-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        let ours = root.join("ours");
        let foreign = root.join("foreign");
        let unmarked = root.join("unmarked");
        let common = Path::new("/repos/one/.git");
        for directory in [&ours, &foreign, &unmarked] {
            fs::create_dir_all(directory.join("feature")).expect("worktree");
            fs::remove_dir(directory.join("feature")).expect("empty");
        }
        fs::write(ours.join(PROJECT_MARKER), "/repos/one/.git\n").expect("ours");
        fs::write(foreign.join(PROJECT_MARKER), "/other/.git\n").expect("foreign");
        let removed = remove_project_directory_if_empty(&ours, common).expect("ours");
        assert!(removed.removed);
        assert!(removed.warning.is_none());
        assert!(!ours.exists());
        let kept = remove_project_directory_if_empty(&foreign, common).expect("foreign");
        assert!(!kept.removed);
        assert!(kept
            .warning
            .as_deref()
            .is_some_and(|warning| warning.contains("different repository")));
        assert_eq!(
            fs::read_to_string(foreign.join(PROJECT_MARKER)).expect("marker"),
            "/other/.git\n"
        );
        let missing = remove_project_directory_if_empty(&unmarked, common).expect("missing");
        assert!(!missing.removed);
        assert!(missing
            .warning
            .as_deref()
            .is_some_and(|warning| warning.contains("no repository marker")));
        assert!(unmarked.is_dir());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn empty_unmarked_project_directory_is_claimed() {
        let root = std::env::temp_dir().join(format!(
            "ptm-reclaim-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        let directory = root.join("ptm/worktrees/repo-abcdef12");
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
    fn create_holds_the_project_directory_until_the_worktree_exists() {
        let root = std::env::temp_dir().join(format!(
            "ptm-hold-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        let directory = root.join("ptm/worktrees/repo-abcdef12");
        let common = Path::new("/repos/one/.git");
        let handle = with_worktrees_directory(&directory, Some(common), || {
            let dir = directory.clone();
            let (started, start_receiver) = std::sync::mpsc::channel();
            let common_dir = common.to_path_buf();
            let handle = std::thread::spawn(move || {
                started.send(()).expect("started");
                remove_project_directory_if_empty(&dir, &common_dir)
            });
            start_receiver.recv().expect("remover started");
            std::thread::sleep(std::time::Duration::from_millis(100));
            assert!(
                directory.is_dir(),
                "last delete removed the project directory during create"
            );
            assert!(
                directory.join(PROJECT_MARKER).is_file(),
                "last delete removed the repository marker during create"
            );
            fs::create_dir(directory.join("feature")).expect("worktree");
            Ok(handle)
        })
        .expect("held");
        let removed = handle.join().expect("remover").expect("remove");
        assert!(
            !removed.removed,
            "delete removed a directory that create had filled"
        );
        assert!(directory.join("feature").is_dir());
        assert!(directory.join(PROJECT_MARKER).is_file());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn concurrent_claims_for_the_same_repository_succeed() {
        let root = std::env::temp_dir().join(format!(
            "ptm-race-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        let directory = root.join("ptm/worktrees/repo-abcdef12");
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
            PathBuf::from("/tmp/xdg/ptm/config.toml")
        );
        assert_eq!(
            user_config_file(home, None),
            PathBuf::from("/home/phantom/.config/ptm/config.toml")
        );
        assert_eq!(
            user_config_file(home, Some(Path::new("relative"))),
            PathBuf::from("/home/phantom/.config/ptm/config.toml")
        );
        assert_eq!(
            user_config_file(home, Some(Path::new(""))),
            PathBuf::from("/home/phantom/.config/ptm/config.toml")
        );
    }
}
