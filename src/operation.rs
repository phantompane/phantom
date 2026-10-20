//! Repository-wide operation lock, independent of metadata's short write lock.
use std::cell::RefCell;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::marker::PhantomData;
use std::os::unix::fs::OpenOptionsExt;
use std::path::Path;
use std::process::Command;
use std::rc::Rc;

use crate::error::{Error, Result};

const LOCK_ENV: &str = "MABO_OPERATION_LOCK";

thread_local! {
    // Keep tokens out of the process environment: only Git children receive them.
    static ACTIVE: RefCell<Vec<(uuid::Uuid, String)>> = const { RefCell::new(Vec::new()) };
}

pub struct OperationLock {
    _file: Option<File>,
    id: uuid::Uuid,
    // Registration and cleanup must run on the same thread.
    _thread: PhantomData<Rc<()>>,
}

impl OperationLock {
    pub(crate) fn check_post_release_children(&self, has_children: bool) -> Result<()> {
        if self._file.is_none() && has_children {
            return Err(Error::msg(
                "Cannot run project hooks or --exec while borrowing an ancestor's mabo operation lock; use --no-hooks and omit --exec",
            ));
        }
        Ok(())
    }

    fn register(file: Option<File>, token: String) -> Self {
        let id = uuid::Uuid::new_v4();
        ACTIVE.with_borrow_mut(|active| active.push((id, token)));
        Self {
            _file: file,
            id,
            _thread: PhantomData,
        }
    }
}

impl Drop for OperationLock {
    fn drop(&mut self) {
        ACTIVE.with_borrow_mut(|active| active.retain(|(id, _)| *id != self.id));
    }
}

pub(crate) fn configure_command(command: &mut Command, program: &str) {
    // Also strip inherited tokens from project hooks, --exec and gh subprocesses.
    command.env_remove(LOCK_ENV);
    if program == "git" {
        ACTIVE.with_borrow(|active| {
            if let Some((_, token)) = active.last() {
                command.env(LOCK_ENV, token);
            }
        });
    }
}

pub fn lock(root: &Path) -> Result<OperationLock> {
    let dir = crate::git::git_common_dir(root)?.join("maboroshi");
    fs::create_dir_all(&dir).map_err(|error| Error::msg(error.to_string()))?;
    let mut file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .open(dir.join("operation.lock"))
        .map_err(|error| Error::msg(format!("Mabo operation lock is not writable: {error}")))?;
    match file.try_lock() {
        Ok(()) => return own(file),
        Err(std::fs::TryLockError::WouldBlock) => {
            let mut token = String::new();
            file.read_to_string(&mut token)
                .map_err(|error| Error::msg(format!("Cannot read mabo operation lock: {error}")))?;
            let inherited = std::env::var(LOCK_ENV).ok();
            let matches = !token.is_empty()
                && (inherited.as_deref() == Some(token.as_str())
                    || ACTIVE.with_borrow(|active| active.iter().any(|(_, held)| held == &token)));
            if matches {
                // Git waits for its hooks while the ancestor retains the flock.
                return Ok(OperationLock::register(None, token));
            }
            eprintln!(
                "Waiting for another mabo operation to finish ({})…",
                dir.join("operation.lock").display()
            );
        }
        Err(error) => {
            return Err(Error::msg(format!(
                "Cannot acquire mabo operation lock: {error}"
            )))
        }
    }
    file.lock()
        .map_err(|error| Error::msg(format!("Cannot acquire mabo operation lock: {error}")))?;
    own(file)
}

fn own(mut file: File) -> Result<OperationLock> {
    let token = uuid::Uuid::new_v4().to_string();
    file.seek(SeekFrom::Start(0))
        .and_then(|_| file.set_len(0))
        .and_then(|_| file.write_all(token.as_bytes()))
        .map_err(|error| Error::msg(format!("Cannot write mabo operation lock: {error}")))?;
    Ok(OperationLock::register(Some(file), token))
}
