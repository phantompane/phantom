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

/// Publish a complete import in one rename. Concurrent importers use private
/// staging directories; the first complete directory wins, without a lock.
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
    if !target.exists() {
        let staging = parent.join(format!(".import-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&staging).map_err(|error| Error::msg(error.to_string()))?;
        let result = (|| {
            populate(&staging)?;
            match fs::rename(&staging, target) {
                Ok(()) => Ok(()),
                Err(_) if target.is_dir() => Ok(()),
                Err(error) => Err(Error::msg(error.to_string())),
            }
        })();
        let _ = fs::remove_dir_all(&staging);
        result?;
    }
    match fs::rename(legacy, legacy.with_extension("json.imported")) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
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
