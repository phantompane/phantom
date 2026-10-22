//! Rename-only migration of state. Reads never change the filesystem.
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use crate::error::{Error, Result};

pub(crate) const LEGACY_NAME: &str = "maboroshi";

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Access {
    Read,
    Write,
}

fn present(path: &Path) -> bool {
    // Broken symlinks and inaccessible entries must not be overwritten either.
    !matches!(fs::symlink_metadata(path), Err(error) if error.kind() == io::ErrorKind::NotFound)
}

fn warn(path: &Path, detail: &str) {
    crate::output::warning_once(
        "path_migration",
        format!(
            "Warning: legacy path {} {detail}",
            crate::output::visible_text(&path.to_string_lossy())
        ),
    );
}

fn empty_directory(path: &Path) -> bool {
    fs::read_dir(path).is_ok_and(|mut entries| entries.next().is_none())
}

/// Resolve sibling product paths or metadata items in adjacent directories.
/// Never copy, merge, or replace a destination.
pub(crate) fn resolve(legacy: &Path, current: &Path, access: Access) -> PathBuf {
    resolve_with(legacy, current, access, rename_no_replace)
}

fn resolve_with(
    legacy: &Path,
    current: &Path,
    access: Access,
    rename: impl FnOnce(&Path, &Path) -> io::Result<()>,
) -> PathBuf {
    if present(current) {
        if present(legacy) && !empty_directory(legacy) {
            warn(
                legacy,
                "is ignored because the new path exists; no files were merged.",
            );
        }
        return current.to_path_buf();
    }
    if !present(legacy) {
        return current.to_path_buf();
    }
    if access == Access::Write {
        // A symlink is renamed as an entry, never traversed. Ordinary directories
        // must be inspected conservatively before moving any of their contents.
        if !safe_to_move(legacy) {
            if present(current) {
                return resolve(legacy, current, Access::Read);
            }
            warn(legacy, "was kept in place because it may contain a Git checkout; using it for this command.");
            return legacy.to_path_buf();
        }
        match rename(legacy, current) {
            Ok(()) => return current.to_path_buf(),
            Err(_) if present(current) => return resolve(legacy, current, Access::Read),
            Err(error) => warn(
                legacy,
                &format!("could not be migrated ({error}); using it for this command."),
            ),
        }
    }
    legacy.to_path_buf()
}

// Git checkout directories contain .git (file or directory), and bare/common
// directories contain HEAD and objects. Refuse unreadable or symlinked contents
// as they may conceal a checkout. A symlink at the migration root is safe to rename.
fn safe_to_move(path: &Path) -> bool {
    let Ok(metadata) = fs::symlink_metadata(path) else {
        return false;
    };
    if metadata.file_type().is_symlink() || metadata.is_file() {
        return true;
    }
    if !safe_directory(path) {
        return false;
    }
    // Check known registrations too: a damaged checkout may have lost its .git
    // entry while Git still registers the directory. Outside a repository there
    // is no invoking registration table; the recursive inspection still applies.
    if let Ok(cwd) = std::env::current_dir() {
        if crate::git::git_common_dir(&cwd).is_ok() && !registration_safe(path, &cwd) {
            return false;
        }
    }
    true
}

fn registration_safe(path: &Path, repository: &Path) -> bool {
    crate::git::list_worktrees(repository).is_ok_and(|worktrees| {
        worktrees.iter().all(|worktree| {
            let checkout = Path::new(&worktree.path);
            !crate::paths::same_location(checkout, path)
                && !crate::paths::is_strictly_inside(checkout, path)
        })
    })
}

fn safe_directory(path: &Path) -> bool {
    if present(&path.join(".git"))
        || (present(&path.join("HEAD")) && present(&path.join("objects")))
    {
        return false;
    }
    let Ok(entries) = fs::read_dir(path) else {
        return false;
    };
    for entry in entries {
        let Ok(entry) = entry else {
            return false;
        };
        let Ok(kind) = entry.file_type() else {
            return false;
        };
        if kind.is_symlink()
            || (!kind.is_file() && !kind.is_dir())
            || (kind.is_dir() && !safe_directory(&entry.path()))
        {
            return false;
        }
    }
    true
}

pub(crate) fn state_dir(access: Access) -> Result<PathBuf> {
    let base = xdg_base("XDG_STATE_HOME", ".local/state")?;
    Ok(product_dir(&base, access))
}

pub(crate) fn config_dir(access: Access) -> Result<PathBuf> {
    let base = xdg_base("XDG_CONFIG_HOME", ".config")?;
    Ok(product_dir(&base, access))
}

fn xdg_base(variable: &str, fallback: &str) -> Result<PathBuf> {
    if let Some(value) = std::env::var_os(variable).filter(|value| !value.is_empty()) {
        let path = PathBuf::from(value);
        if path.is_absolute() {
            return Ok(path);
        }
    }
    let home = std::env::var_os("HOME")
        .filter(|value| !value.is_empty())
        .ok_or_else(|| Error::msg("HOME is not set"))?;
    Ok(PathBuf::from(home).join(fallback))
}

pub(crate) fn product_dir(base: &Path, access: Access) -> PathBuf {
    resolve(&base.join(LEGACY_NAME), &base.join("mabo"), access)
}

/// Metadata is resolved item by item: the old worktrees/ checkout tree never moves.
pub(crate) fn metadata_item(common: &Path, item: &str, access: Access) -> PathBuf {
    let legacy = common.join(LEGACY_NAME).join(item);
    let old_records = common.join(LEGACY_NAME).join("workspaces");
    if access == Access::Write
        && present(&old_records)
        && !present(&common.join("mabo/workspaces"))
        && !metadata_only(&old_records)
    {
        warn(&old_records, "was kept in place because its contents may include a Git checkout; using it for this command.");
        return metadata_item(common, item, Access::Read);
    }
    let current = common.join("mabo").join(item);
    if access == Access::Write && present(&legacy) && !present(&current) {
        let safe = if item == "workspaces" {
            metadata_only(&legacy) && registration_safe(&legacy, common)
        } else {
            fs::symlink_metadata(&legacy).is_ok_and(|meta| meta.is_file())
        };
        if !safe {
            if present(&current) {
                return resolve(&legacy, &current, Access::Read);
            }
            warn(&legacy, "was kept in place because its contents may include a Git checkout; using it for this command.");
            return legacy;
        }
        if let Err(error) = fs::create_dir_all(common.join("mabo")) {
            if present(&current) {
                return resolve(&legacy, &current, Access::Read);
            }
            warn(
                &legacy,
                &format!("could not be migrated ({error}); using it for this command."),
            );
            return legacy;
        }
    }
    resolve(&legacy, &current, access)
}

fn metadata_only(path: &Path) -> bool {
    // Do not follow a workspaces symlink: its target may contain checkouts.
    if !fs::symlink_metadata(path).is_ok_and(|meta| meta.is_dir()) {
        return false;
    }
    let Ok(entries) = fs::read_dir(path) else {
        return false;
    };
    entries.into_iter().all(|entry| {
        let Ok(entry) = entry else {
            return false;
        };
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            return false;
        };
        entry.file_type().is_ok_and(|kind| kind.is_file())
            && (name == crate::atomic::IMPORT_COMPLETE
                || name.ends_with(".json")
                || name
                    .strip_prefix(".state-")
                    .and_then(|s| s.strip_suffix(".tmp"))
                    .is_some_and(|id| uuid::Uuid::parse_str(id).is_ok()))
    })
}

/// The exclusive variant of rename closes the destination-existence race.
#[cfg(any(target_os = "linux", target_os = "macos"))]
pub(crate) fn rename_no_replace(from: &Path, to: &Path) -> io::Result<()> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    let from = CString::new(from.as_os_str().as_bytes()).map_err(io::Error::other)?;
    let to = CString::new(to.as_os_str().as_bytes()).map_err(io::Error::other)?;
    #[cfg(target_os = "linux")]
    let result = {
        unsafe extern "C" {
            fn renameat2(
                oldfd: i32,
                old: *const std::ffi::c_char,
                newfd: i32,
                new: *const std::ffi::c_char,
                flags: u32,
            ) -> i32;
        }
        // SAFETY: both C strings live through the call. AT_FDCWD=-100,
        // RENAME_NOREPLACE=1; the kernel atomically refuses an existing target.
        unsafe { renameat2(-100, from.as_ptr(), -100, to.as_ptr(), 1) }
    };
    #[cfg(target_os = "macos")]
    let result = {
        unsafe extern "C" {
            fn renamex_np(
                old: *const std::ffi::c_char,
                new: *const std::ffi::c_char,
                flags: u32,
            ) -> i32;
        }
        // SAFETY: valid C strings; RENAME_EXCL=4 refuses an existing target.
        unsafe { renamex_np(from.as_ptr(), to.as_ptr(), 4) }
    };
    if result == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
pub(crate) fn rename_no_replace(_from: &Path, _to: &Path) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "exclusive rename is unavailable",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path =
                std::env::temp_dir().join(format!("mabo-migration-{}", uuid::Uuid::new_v4()));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn exclusive_rename_never_replaces_files_or_empty_directories() {
        let fixture = Fixture::new();
        for directories in [false, true] {
            let old = fixture.0.join(format!("old-{directories}"));
            let new = fixture.0.join(format!("new-{directories}"));
            if directories {
                fs::create_dir(&old).unwrap();
                fs::write(old.join("saved"), "old data").unwrap();
                fs::create_dir(&new).unwrap();
            } else {
                fs::write(&old, "old data").unwrap();
                fs::write(&new, "new data").unwrap();
            }
            assert_eq!(
                rename_no_replace(&old, &new).unwrap_err().kind(),
                io::ErrorKind::AlreadyExists
            );
            assert!(old.exists());
            if directories {
                assert!(empty_directory(&new));
            } else {
                assert_eq!(fs::read_to_string(&new).unwrap(), "new data");
            }
            assert_eq!(resolve(&old, &new, Access::Write), new);
        }
    }

    #[test]
    fn concurrent_directory_migrations_keep_the_original_data() {
        let fixture = Fixture::new();
        let old = fixture.0.join(LEGACY_NAME);
        fs::create_dir(&old).unwrap();
        fs::write(old.join("saved"), "original").unwrap();
        let gate = std::sync::Barrier::new(8);
        std::thread::scope(|scope| {
            let handles = (0..8)
                .map(|_| {
                    scope.spawn(|| {
                        gate.wait();
                        product_dir(&fixture.0, Access::Write)
                    })
                })
                .collect::<Vec<_>>();
            for handle in handles {
                assert_eq!(handle.join().unwrap(), fixture.0.join("mabo"));
            }
        });
        assert!(!old.exists());
        assert_eq!(
            fs::read_to_string(fixture.0.join("mabo/saved")).unwrap(),
            "original"
        );
    }

    #[test]
    fn failed_rename_rechecks_a_concurrent_destination_without_merging() {
        let fixture = Fixture::new();
        let old = fixture.0.join(LEGACY_NAME);
        let current = fixture.0.join("mabo");
        fs::create_dir(&old).unwrap();
        fs::write(old.join("saved"), "old data").unwrap();
        let resolved = resolve_with(&old, &current, Access::Write, |_, destination| {
            fs::create_dir(destination)?;
            fs::write(destination.join("other"), "winner data")?;
            Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "concurrent winner",
            ))
        });
        assert_eq!(resolved, current);
        assert_eq!(fs::read_to_string(old.join("saved")).unwrap(), "old data");
        assert_eq!(
            fs::read_to_string(current.join("other")).unwrap(),
            "winner data"
        );
        assert!(!current.join("saved").exists());
    }

    #[test]
    fn symlink_root_is_renamed_without_moving_its_checkout_target() {
        let fixture = Fixture::new();
        let target = fixture.0.join("checkout");
        fs::create_dir_all(target.join(".git")).unwrap();
        fs::write(target.join("saved"), "saved").unwrap();
        let old = fixture.0.join(LEGACY_NAME);
        std::os::unix::fs::symlink(&target, &old).unwrap();
        let new = fixture.0.join("mabo");
        assert_eq!(resolve(&old, &new, Access::Read), old);
        assert_eq!(resolve(&old, &new, Access::Write), new);
        assert_eq!(fs::read_link(new).unwrap(), target);
        assert!(target.join(".git").is_dir());
        assert_eq!(fs::read_to_string(target.join("saved")).unwrap(), "saved");
    }

    #[test]
    fn possible_checkout_and_unknown_metadata_contents_stay_in_place() {
        for entry in [
            "nested/.git",
            "workspaces/nested/.git",
            "workspaces/unknown",
            "workspaces/link",
        ] {
            let fixture = Fixture::new();
            let legacy = fixture.0.join(LEGACY_NAME);
            let entry_path = legacy.join(entry);
            fs::create_dir_all(entry_path.parent().unwrap()).unwrap();
            if entry.ends_with(".git") {
                fs::create_dir(&entry_path).unwrap();
            } else if entry.ends_with("link") {
                std::os::unix::fs::symlink("missing", &entry_path).unwrap();
            } else {
                fs::write(&entry_path, "saved").unwrap();
            }
            if entry.starts_with("workspaces") {
                assert_eq!(
                    metadata_item(&fixture.0, "workspaces", Access::Write),
                    legacy.join("workspaces")
                );
            } else {
                assert_eq!(product_dir(&fixture.0, Access::Write), legacy);
            }
            assert!(fs::symlink_metadata(entry_path).is_ok());
            assert!(!fixture.0.join("mabo").exists());
        }
    }

    #[test]
    fn metadata_only_accepts_known_regular_files() {
        for (name, allowed) in [
            (".import-complete".to_owned(), true),
            ("ws_record.json".to_owned(), true),
            ("record.json".to_owned(), true),
            (format!(".state-{}.tmp", uuid::Uuid::new_v4()), true),
            (".state-invalid.tmp".to_owned(), false),
            (".import-complete.tmp".to_owned(), false),
            ("unknown".to_owned(), false),
            // import_directory stages beside workspaces/, never inside it.
            (format!(".import-{}", uuid::Uuid::new_v4()), false),
        ] {
            for kind in ["file", "directory", "symlink"] {
                let fixture = Fixture::new();
                let records = fixture.0.join("workspaces");
                fs::create_dir(&records).unwrap();
                let entry = records.join(&name);
                match kind {
                    "file" => fs::write(&entry, "saved").unwrap(),
                    "directory" => fs::create_dir(&entry).unwrap(),
                    _ => {
                        let target = fixture.0.join("target");
                        fs::write(&target, "saved").unwrap();
                        std::os::unix::fs::symlink(target, &entry).unwrap();
                    }
                }
                assert_eq!(
                    metadata_only(&records),
                    allowed && kind == "file",
                    "{name}: {kind}"
                );
            }
        }
    }

    #[test]
    fn metadata_migration_moves_only_metadata_and_atomic_writer_files() {
        let fixture = Fixture::new();
        let output = crate::test_git::command("git")
            .args(["init", "--bare"])
            .arg(&fixture.0)
            .output()
            .unwrap();
        assert!(output.status.success());
        let legacy = fixture.0.join(LEGACY_NAME);
        fs::create_dir_all(legacy.join("workspaces")).unwrap();
        fs::create_dir_all(legacy.join("worktrees/live/.git")).unwrap();
        let staging = legacy.join(format!(".import-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&staging).unwrap();
        for item in [
            "workspaces/.import-complete",
            "workspaces/ws_record.json",
            "worktrees.json",
            "worktrees.json.imported",
        ] {
            fs::write(legacy.join(item), item).unwrap();
        }
        let temporary = format!("workspaces/.state-{}.tmp", uuid::Uuid::new_v4());
        fs::write(legacy.join(&temporary), "pending").unwrap();
        for item in ["workspaces", "worktrees.json", "worktrees.json.imported"] {
            assert_eq!(
                metadata_item(&fixture.0, item, Access::Read),
                legacy.join(item)
            );
            assert_eq!(
                metadata_item(&fixture.0, item, Access::Write),
                fixture.0.join("mabo").join(item)
            );
        }
        assert!(legacy.join("worktrees/live/.git").is_dir());
        assert!(staging.is_dir());
        assert!(fixture.0.join("mabo").join(temporary).is_file());
    }

    #[test]
    fn rename_failure_uses_legacy_and_keeps_every_file() {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let fixture = Fixture::new();
        if fs::metadata(&fixture.0).unwrap().uid() == 0 {
            crate::output::errln!(
                "Skipping permission-denied rename test: root bypasses directory permissions"
            );
            return;
        }
        let old = fixture.0.join(LEGACY_NAME);
        fs::create_dir(&old).unwrap();
        fs::write(old.join("saved"), "saved").unwrap();
        fs::set_permissions(&fixture.0, fs::Permissions::from_mode(0o555)).unwrap();
        let resolved = product_dir(&fixture.0, Access::Write);
        fs::set_permissions(&fixture.0, fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(resolved, old);
        assert_eq!(fs::read_to_string(old.join("saved")).unwrap(), "saved");
        assert!(!fixture.0.join("mabo").exists());
    }
}
