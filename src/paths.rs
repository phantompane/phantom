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
    match common_dir {
        Some(common_dir) => claim_project_directory(directory, common_dir),
        None => fs::create_dir_all(directory).map_err(|error| {
            Error::msg(format!(
                "Failed to create worktree directory {}: {error}",
                directory.display()
            ))
        }),
    }
}

/// Remove the project directory when it has no worktrees left.
///
/// The marker file is removed with it. The parent `ptm/worktrees` directory
/// is never removed. Returns false when a worktree is still inside.
pub fn remove_project_directory_if_empty(directory: &Path) -> Result<bool> {
    let Some(parent) = directory.parent() else {
        return Ok(false);
    };
    if !parent.exists() || !fs::symlink_metadata(directory).is_ok_and(|meta| meta.is_dir()) {
        return Ok(false);
    }
    with_worktrees_lock(parent, || {
        if !fs::symlink_metadata(directory).is_ok_and(|meta| meta.is_dir()) {
            return Ok(false);
        }
        let names = directory_entries(directory)?;
        let marker = std::ffi::OsString::from(PROJECT_MARKER);
        let only_marker = names.len() == 1 && names[0] == marker;
        if !names.is_empty() && !only_marker {
            return Ok(false);
        }
        let marker_path = directory.join(PROJECT_MARKER);
        let saved = if only_marker {
            match fs::read(&marker_path) {
                Ok(bytes) => Some(bytes),
                Err(error) if error.kind() == ErrorKind::NotFound => None,
                Err(error) => {
                    return Err(Error::msg(format!(
                        "Failed to remove empty directory {}: {error}",
                        directory.display()
                    )));
                }
            }
        } else {
            None
        };
        if only_marker {
            fs::remove_file(&marker_path).map_err(|error| {
                Error::msg(format!(
                    "Failed to remove empty directory {}: {error}",
                    directory.display()
                ))
            })?;
        }
        match fs::remove_dir(directory) {
            Ok(()) => Ok(true),
            Err(error) if error.kind() == ErrorKind::NotFound => Ok(false),
            Err(error) if error.kind() == ErrorKind::DirectoryNotEmpty => {
                if let Some(bytes) = saved {
                    let _ = fs::write(&marker_path, bytes);
                }
                Ok(false)
            }
            Err(error) => Err(Error::msg(format!(
                "Failed to remove empty directory {}: {error}",
                directory.display()
            ))),
        }
    })
}

fn checkout_component(git_root: &Path) -> String {
    git_root
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

fn claim_project_directory(directory: &Path, common_dir: &Path) -> Result<()> {
    let Some(parent) = directory.parent() else {
        return Err(Error::msg(format!(
            "Worktree directory {} has no parent",
            directory.display()
        )));
    };
    with_worktrees_lock(parent, || {
        reconcile_project_directory(directory, common_dir)
    })
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
        assert!(!remove_project_directory_if_empty(&directory).expect("kept"));
        assert!(directory.is_dir());
        fs::remove_dir(directory.join("feature")).expect("remove worktree");
        assert!(remove_project_directory_if_empty(&directory).expect("removed"));
        assert!(!directory.exists());
        assert!(ceiling.is_dir());
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
