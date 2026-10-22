//! Atomic state-file replacement and publication of imported record directories.
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::path::Path;

pub(crate) fn write(path: &Path, contents: &[u8]) -> io::Result<()> {
    write_with(path, |file| file.write_all(contents))
}

fn write_with(
    path: &Path,
    body: impl FnOnce(&mut std::fs::File) -> io::Result<()>,
) -> io::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::other("State file has no parent"))?;
    let temporary = parent.join(format!(".state-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&temporary)?;
        body(&mut file)?;
        file.sync_all()?;
        fs::rename(&temporary, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

/// Only this marker proves that all legacy records have been published.
pub(crate) const IMPORT_COMPLETE: &str = ".import-complete";

pub(crate) fn import_complete(target: &Path) -> bool {
    target.join(IMPORT_COMPLETE).is_file()
}

/// Stage the complete import before publication. If another writer created the
/// destination, add records without replacing its files or directory. Publish
/// the completion marker only after every staged record is available.
pub(crate) fn import_directory(
    target: &Path,
    legacy: &Path,
    populate: impl FnOnce(&Path) -> crate::error::Result<()>,
) -> crate::error::Result<()> {
    use crate::error::Error;
    let parent = target
        .parent()
        .ok_or_else(|| Error::msg("Record directory has no parent"))?;
    fs::create_dir_all(parent).map_err(|error| Error::msg(error.to_string()))?;
    if target.exists() {
        fs::read_dir(target).map_err(|error| {
            Error::msg(format!(
                "Failed to read imported record directory {}: {error}",
                target.display()
            ))
        })?;
    }
    if !import_complete(target) {
        let staging = parent.join(format!(".import-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&staging).map_err(|error| Error::msg(error.to_string()))?;
        let result = (|| {
            populate(&staging)?;
            write(&staging.join(IMPORT_COMPLETE), b"complete\n")
                .map_err(|error| Error::msg(error.to_string()))?;
            match fs::rename(&staging, target) {
                Ok(()) => Ok(()),
                Err(_) if target.is_dir() => {
                    if !import_complete(target) {
                        for entry in
                            fs::read_dir(&staging).map_err(|error| Error::msg(error.to_string()))?
                        {
                            let entry = entry.map_err(|error| Error::msg(error.to_string()))?;
                            if entry.file_name() == IMPORT_COMPLETE {
                                continue;
                            }
                            // A hard link atomically publishes a complete file and never
                            // replaces a record added or updated by another process.
                            let destination = target.join(entry.file_name());
                            match fs::hard_link(entry.path(), &destination) {
                                Ok(()) => {}
                                Err(error)
                                    if error.kind() == io::ErrorKind::AlreadyExists
                                        && destination.is_file() => {}
                                Err(error) => return Err(Error::msg(error.to_string())),
                            }
                        }
                        write(&target.join(IMPORT_COMPLETE), b"complete\n")
                            .map_err(|error| Error::msg(error.to_string()))?;
                    }
                    Ok(())
                }
                Err(error) => Err(Error::msg(error.to_string())),
            }
        })();
        let _ = fs::remove_dir_all(&staging);
        result?;
    }
    match crate::migration::rename_no_replace(legacy, &legacy.with_extension("json.imported")) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
            crate::output::warning_once(
                "path_migration",
                format!(
                    "Warning: {} already exists; keeping the legacy import source {} in place.",
                    legacy.with_extension("json.imported").display(),
                    legacy.display()
                ),
            );
            Ok(())
        }
        Err(error) => Err(Error::msg(format!(
            "Failed to archive {}: {error}",
            legacy.display()
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failed_import_keeps_legacy_and_removes_staging_directory() {
        let dir = std::env::temp_dir().join(format!("mabo-import-fail-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&dir).unwrap();
        let legacy = dir.join("legacy.json");
        fs::write(&legacy, "original").unwrap();
        let target = dir.join("records");
        let result = import_directory(&target, &legacy, |staging| {
            write(&staging.join("first.json"), b"first")
                .map_err(|error| crate::error::Error::msg(error.to_string()))?;
            Err(crate::error::Error::msg("injected second-record failure"))
        });
        assert!(result.is_err());
        assert_eq!(fs::read_to_string(&legacy).unwrap(), "original");
        assert!(!target.exists());
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);
        import_directory(&target, &legacy, |staging| {
            write(&staging.join("first.json"), b"first")
                .map_err(|error| crate::error::Error::msg(error.to_string()))
        })
        .unwrap();
        assert_eq!(fs::read(target.join("first.json")).unwrap(), b"first");
        assert_eq!(
            fs::read_to_string(legacy.with_extension("json.imported")).unwrap(),
            "original"
        );
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn blocked_import_destination_keeps_legacy_for_retry() {
        let dir =
            std::env::temp_dir().join(format!("mabo-import-blocked-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&dir).unwrap();
        let legacy = dir.join("legacy.json");
        fs::write(&legacy, "original").unwrap();
        let target = dir.join("records");
        fs::write(&target, "blocker").unwrap();
        let result = import_directory(&target, &legacy, |_| {
            panic!("a blocked destination must not import records");
        });
        assert!(result.is_err());
        assert_eq!(fs::read_to_string(&legacy).unwrap(), "original");
        assert!(!legacy.with_extension("json.imported").exists());
        assert_eq!(fs::read_to_string(&target).unwrap(), "blocker");
        fs::remove_file(&target).unwrap();
        import_directory(&target, &legacy, |staging| {
            for name in ["first", "second"] {
                write(&staging.join(format!("{name}.json")), name.as_bytes())
                    .map_err(|error| crate::error::Error::msg(error.to_string()))?;
                assert!(
                    legacy.is_file(),
                    "archive only after all records are written"
                );
            }
            Ok(())
        })
        .unwrap();
        assert_eq!(fs::read_dir(&target).unwrap().count(), 3);
        assert!(!legacy.exists());
        assert_eq!(
            fs::read_to_string(legacy.with_extension("json.imported")).unwrap(),
            "original"
        );
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn merging_an_import_keeps_existing_records_and_marks_completion_last() {
        let dir = std::env::temp_dir().join(format!("mabo-import-merge-{}", uuid::Uuid::new_v4()));
        let target = dir.join("records");
        fs::create_dir_all(&target).unwrap();
        let legacy = dir.join("legacy.json");
        fs::write(&legacy, "original").unwrap();
        write(&target.join("first.json"), b"concurrent update").unwrap();
        // A failed record publication must not mark or archive the import.
        fs::create_dir(target.join("second.json")).unwrap();
        let populate = |staging: &Path| {
            for name in ["first", "second"] {
                write(&staging.join(format!("{name}.json")), name.as_bytes())
                    .map_err(|error| crate::error::Error::msg(error.to_string()))?;
            }
            Ok(())
        };
        assert!(import_directory(&target, &legacy, populate).is_err());
        assert!(!import_complete(&target));
        assert_eq!(fs::read_to_string(&legacy).unwrap(), "original");
        fs::remove_dir(target.join("second.json")).unwrap();
        import_directory(&target, &legacy, populate).unwrap();
        assert!(import_complete(&target));
        assert_eq!(
            fs::read(target.join("first.json")).unwrap(),
            b"concurrent update"
        );
        assert_eq!(fs::read(target.join("second.json")).unwrap(), b"second");
        assert!(!legacy.exists());
        // Completion survives an archive failure/retry and subsequent deletion;
        // importing again must not resurrect records removed by another writer.
        fs::rename(legacy.with_extension("json.imported"), &legacy).unwrap();
        fs::remove_file(target.join("second.json")).unwrap();
        import_directory(&target, &legacy, |_| {
            panic!("completed import must not run again")
        })
        .unwrap();
        assert!(!target.join("second.json").exists());
        assert!(!legacy.exists());
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 2);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn replaces_contents_and_cleans_temporary_after_failure() {
        let dir = std::env::temp_dir().join(format!("mabo-atomic-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&dir).unwrap();
        let path = dir.join("state");
        fs::write(&path, "old").unwrap();
        write(&path, b"new").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"new");
        let error = write_with(&path, |file| {
            file.write_all(b"partial")?;
            Err(io::Error::other("injected write failure"))
        });
        assert!(error.is_err());
        assert_eq!(fs::read(&path).unwrap(), b"new");
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);
        let destination = dir.join("directory");
        fs::create_dir(&destination).unwrap();
        assert!(write(&destination, b"cannot replace directory").is_err());
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 2);
        fs::remove_dir_all(dir).unwrap();
    }
}
