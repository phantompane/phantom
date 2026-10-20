//! Repository-wide operation lock, independent of metadata's short write lock.
use std::fs::{self, File, OpenOptions};
use std::os::unix::fs::OpenOptionsExt;
use std::path::Path;

use crate::error::{Error, Result};

pub fn lock(root: &Path) -> Result<File> {
    let dir = crate::git::git_common_dir(root)?.join("maboroshi");
    fs::create_dir_all(&dir).map_err(|error| Error::msg(error.to_string()))?;
    let file = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .open(dir.join("operation.lock"))
        .map_err(|error| Error::msg(format!("Mabo operation lock is not writable: {error}")))?;
    file.lock()
        .map_err(|error| Error::msg(format!("Cannot acquire mabo operation lock: {error}")))?;
    Ok(file)
}
