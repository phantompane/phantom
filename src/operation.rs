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
    static ACTIVE: RefCell<Vec<(uuid::Uuid, String, bool)>> = const { RefCell::new(Vec::new()) };
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
            return Err(child_refusal());
        }
        Ok(())
    }

    fn register(file: Option<File>, token: String) -> Self {
        let id = uuid::Uuid::new_v4();
        ACTIVE.with_borrow_mut(|active| active.push((id, token, file.is_none())));
        Self {
            _file: file,
            id,
            _thread: PhantomData,
        }
    }
}

impl Drop for OperationLock {
    fn drop(&mut self) {
        ACTIVE.with_borrow_mut(|active| active.retain(|(id, _, _)| *id != self.id));
    }
}

fn child_refusal() -> Error {
    Error::msg("Cannot run project hooks or --exec while borrowing an ancestor's mabo operation lock; standalone exec, shell commands, and gh children are also refused")
}

pub(crate) fn check_user_command(cwd: Option<&Path>) -> Result<()> {
    if ACTIVE.with_borrow(|active| active.iter().any(|(_, _, borrowed)| *borrowed)) {
        return Err(child_refusal());
    }
    // Standalone exec and gh can be reached before registering a guard.
    // Validate inherited tokens against the flock, including stale tokens.
    if std::env::var_os(LOCK_ENV).is_some() && ACTIVE.with_borrow(|active| active.is_empty()) {
        let directory = cwd
            .map(Path::to_path_buf)
            .or_else(|| std::env::current_dir().ok());
        if let Some(root) = directory.and_then(|path| crate::git::top_level(&path).ok()) {
            lock(&root)?.check_post_release_children(true)?;
        }
    }
    Ok(())
}

pub(crate) fn configure_command(
    command: &mut Command,
    program: &str,
    cwd: Option<&Path>,
) -> Result<()> {
    if program != "git" {
        check_user_command(cwd)?;
    }
    // Also strip inherited tokens from project hooks, --exec and gh subprocesses.
    command.env_remove(LOCK_ENV);
    if program == "git" {
        let token = ACTIVE
            .with_borrow(|active| active.last().map(|(_, token, _)| token.clone()))
            .or_else(|| std::env::var(LOCK_ENV).ok());
        if let Some(token) = token {
            // Read-only intermediaries may not register a guard of their own.
            command.env(LOCK_ENV, token);
        }
    }
    Ok(())
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
                    || ACTIVE
                        .with_borrow(|active| active.iter().any(|(_, held, _)| held == &token)));
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
