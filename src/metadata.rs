use std::collections::BTreeMap;
use std::fs::{self, OpenOptions};
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};
use crate::paths;

const RECORDS_DIR: &str = "workspaces";
const PURPOSE_MAX: usize = 1024;

/// Intent and creation details recorded for one workspace.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeMetadata {
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base: Option<String>,
    /// Explicitly unknown intent must not use the repository default-base fallback.
    #[serde(default, skip_serializing_if = "is_false")]
    pub base_cleared: bool,
    #[serde(default)]
    pub purpose: Option<String>,
    #[serde(default)]
    pub created_at: Option<String>,
    #[serde(default)]
    pub updated_at: Option<String>,
    /// Full commit the branch was created from. Unknown for adopted checkouts,
    /// a new branch with no HEAD, or an existing branch without a reflog.
    #[serde(default)]
    pub created_from: Option<String>,
    #[serde(default)]
    pub links: WorktreeLinks,
    #[serde(default)]
    pub setup: Option<crate::setup::Status>,
    /// Saved workspace name, taking precedence over the directory name.
    ///
    /// Command JSON already has `name`, so this stays out of that flatten.
    /// Without a saved name, use the folder name.
    #[serde(default, skip)]
    pub name: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeLinks {
    #[serde(default)]
    pub pr: Option<WorktreeLink>,
    #[serde(default)]
    pub issue: Option<WorktreeLink>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeLink {
    #[serde(default)]
    pub number: Option<u64>,
    #[serde(default)]
    pub url: Option<String>,
}

/// Whether the branch was created with this record or already existed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BranchOrigin {
    /// `create` just allocated this checkout; its initial commit is known.
    New,
    /// Existing checkout with unknown creation time and creation commit.
    Adopted,
    /// The branch already existed. The base is its reflog, when one exists.
    Existing,
}

/// Fields supplied at a boundary. `None` leaves the stored value alone.
#[derive(Debug, Clone, Default)]
pub struct MetadataInput {
    pub base: Option<String>,
    pub setup: Option<crate::setup::Status>,
    /// Preserve an unknown sync target instead of using the repository default.
    pub base_cleared: bool,
    pub purpose: Option<String>,
    pub pr: Option<WorktreeLink>,
    pub issue: Option<WorktreeLink>,
    /// Optional saved workspace name.
    pub name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Store {
    worktrees: Vec<StoredWorktree>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredWorktree {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    schema: Option<u32>,
    path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    name: Option<String>,
    #[serde(flatten)]
    metadata: WorktreeMetadata,
}

fn is_false(value: &bool) -> bool {
    !value
}

pub fn path_key(path: &Path) -> String {
    paths::normalize(path).to_string_lossy().into_owned()
}

/// True when a workspace record contains this path. Comparison is canonical when
/// the path exists and normalized otherwise.
pub fn records_path(git_root: &Path, path: &Path) -> Result<bool> {
    Ok(matching_path(git_root, path)?.is_some())
}

/// Stored path string for `path`, resolved while the directory still exists.
pub fn matching_path(git_root: &Path, path: &Path) -> Result<Option<String>> {
    Ok(find_in(&load(git_root)?, path).map(|(key, _)| key.clone()))
}

/// The stored record for `path`, matched the same way as [`records_path`].
pub fn find_in<'a>(
    stored: &'a BTreeMap<String, WorktreeMetadata>,
    path: &Path,
) -> Option<(&'a String, &'a WorktreeMetadata)> {
    stored
        .iter()
        .find(|(key, _)| paths::same_location(Path::new(key), path))
}

/// Records for every path in the store. A missing directory is an empty map.
pub fn load(git_root: &Path) -> Result<BTreeMap<String, WorktreeMetadata>> {
    let (store, _) = read_records(git_root, false)?;
    let mut records = BTreeMap::new();
    for record in store.worktrees {
        let mut metadata = record.metadata;
        metadata.name = record.name;
        records.insert(path_key(Path::new(&record.path)), metadata);
    }
    Ok(records)
}

/// Strict reads preserve mutation commands' refusal to use corrupt state.
pub fn load_strict(git_root: &Path) -> Result<BTreeMap<String, WorktreeMetadata>> {
    let (store, _) = read_records(git_root, true)?;
    Ok(store
        .worktrees
        .into_iter()
        .map(|mut record| {
            record.metadata.name = record.name;
            (path_key(Path::new(&record.path)), record.metadata)
        })
        .collect())
}

/// Replace any record at `path`. Creation and adoption use this
/// so a workspace removed outside mabo does not keep its previous intent.
pub fn replace(
    git_root: &Path,
    path: &Path,
    input: &MetadataInput,
    origin: BranchOrigin,
) -> Result<WorktreeMetadata> {
    if save_injected() {
        return Err(Error::msg(
            "Failed to save workspace metadata: injected failure".to_string(),
        ));
    }
    let key = path_key(path);
    with_store(git_root, Some(path), |store| {
        let previous_id = store
            .worktrees
            .iter()
            .find(|record| paths::same_location(Path::new(&record.path), path))
            .map(|record| record.metadata.id.clone());
        store
            .worktrees
            .retain(|record| !paths::same_location(Path::new(&record.path), path));
        let mut metadata = fresh_metadata(path, input, origin);
        if let Some(previous) = previous_id {
            metadata.id = previous;
        }
        store.worktrees.push(stored_worktree(key, metadata.clone()));
        Ok((metadata, true))
    })
}

/// Insert or patch the record for `path`. `set` and re-checkout use this.
/// A new record gets `createdAt` and `createdFrom`. An existing record
/// keeps omitted fields, including `createdFrom`.
pub fn write(git_root: &Path, path: &Path, input: &MetadataInput) -> Result<WorktreeMetadata> {
    patch(git_root, path, input, &[])
}

/// Apply intent edits and removals in one atomic record update.
pub fn patch(
    git_root: &Path,
    path: &Path,
    input: &MetadataInput,
    unset: &[String],
) -> Result<WorktreeMetadata> {
    let key = path_key(path);
    with_store(git_root, Some(path), |store| {
        if let Some(record) = store
            .worktrees
            .iter_mut()
            .find(|record| paths::same_location(Path::new(&record.path), path))
        {
            apply_input(&mut record.metadata, input);
            clear_fields(&mut record.metadata, unset);
            record.name = record.metadata.name.clone();
            return Ok((record.metadata.clone(), true));
        }
        let mut metadata = fresh_metadata(path, input, BranchOrigin::Existing);
        clear_fields(&mut metadata, unset);
        store.worktrees.push(stored_worktree(key, metadata.clone()));
        Ok((metadata, true))
    })
}

fn clear_fields(record: &mut WorktreeMetadata, fields: &[String]) {
    for field in fields {
        match field.as_str() {
            "purpose" => record.purpose = None,
            "base" => {
                record.base = None;
                record.base_cleared = true;
            }
            "pr" => record.links.pr = None,
            "issue" => record.links.issue = None,
            _ => {}
        }
    }
    record.updated_at = Some(iso_now());
}

fn fresh_metadata(path: &Path, input: &MetadataInput, origin: BranchOrigin) -> WorktreeMetadata {
    let mut metadata = WorktreeMetadata {
        id: Some(format!("ws_{}", uuid::Uuid::new_v4())),
        base_cleared: origin == BranchOrigin::Adopted && input.base.is_none(),
        created_at: (origin != BranchOrigin::Adopted).then(iso_now),
        updated_at: Some(iso_now()),
        created_from: recorded_creation(path, origin),
        setup: Some(crate::setup::Status::new(crate::setup::State::Unknown)),
        ..WorktreeMetadata::default()
    };
    apply_input(&mut metadata, input);
    metadata
}

fn recorded_creation(path: &Path, origin: BranchOrigin) -> Option<String> {
    match origin {
        BranchOrigin::New => crate::git::head_commit(path),
        BranchOrigin::Existing => crate::git::reflog_creation_commit(path),
        BranchOrigin::Adopted => None,
    }
}

/// Record the tip sync integrated while the branch had no commits of its own.
pub fn record_sync_tip(git_root: &Path, path: &Path, tip: &str) -> Result<()> {
    with_store(git_root, Some(path), |store| {
        let Some(record) = store
            .worktrees
            .iter_mut()
            .find(|record| paths::same_location(Path::new(&record.path), path))
        else {
            return Ok(((), false));
        };
        record.metadata.created_from = Some(tip.to_string());
        record.metadata.updated_at = Some(iso_now());
        Ok(((), true))
    })
}

/// Reject corrupt records and check that a file can be created before Git mutates.
pub fn prepare(git_root: &Path) -> Result<()> {
    read_records(git_root, true)?;
    let dir = if records_dir(git_root)?.exists() {
        records_dir(git_root)?
    } else {
        metadata_dir(git_root)?
    };
    fs::create_dir_all(&dir).map_err(|error| {
        Error::msg(format!(
            "Workspace metadata directory {} is not writable: {error}",
            dir.display()
        ))
    })?;
    let probe = dir.join(format!(".probe-{}", uuid::Uuid::new_v4()));
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&probe)
        .map_err(|error| {
            Error::msg(format!(
                "Workspace metadata directory {} is not writable: {error}",
                dir.display()
            ))
        })?;
    fs::remove_file(&probe).map_err(|error| Error::msg(error.to_string()))
}

/// Report corrupt records while allowing readers to use all healthy records.
pub fn read_problem(git_root: &Path) -> Option<String> {
    match read_records(git_root, false) {
        Ok((_, problems)) if !problems.is_empty() => Some(problems.join("; ")),
        Err(error) => Some(error.to_string()),
        _ => None,
    }
}

/// Drop the record for `path`. Missing records are already the end state.
pub fn remove(git_root: &Path, path: &Path) -> Result<()> {
    if !records_dir(git_root)?.exists() {
        return Ok(());
    }
    with_store(git_root, None, |store| {
        let before = store.worktrees.len();
        store
            .worktrees
            .retain(|record| !paths::same_location(Path::new(&record.path), path));
        Ok(((), store.worktrees.len() != before))
    })
}

pub fn parse_purpose(value: &str) -> Result<String> {
    parse_text(value, "Purpose", PURPOSE_MAX)
}

pub fn parse_link(value: &str) -> Result<WorktreeLink> {
    let value = value.trim();
    if value.is_empty() {
        return Err(Error::validation(
            "A pull request or issue link cannot be empty".to_string(),
        ));
    }
    let bare = value.strip_prefix('#').unwrap_or(value);
    if !bare.is_empty() && bare.chars().all(|char| char.is_ascii_digit()) {
        let number = parse_number(bare)?;
        return Ok(WorktreeLink {
            number: Some(number),
            url: None,
        });
    }
    if !(value.starts_with("https://") || value.starts_with("http://"))
        || value.chars().any(char::is_whitespace)
    {
        return Err(Error::validation(
            "A pull request or issue link must be a number or an http(s) URL".to_string(),
        ));
    }
    Ok(WorktreeLink {
        number: link_target(value).map(|(_, number)| number),
        url: Some(value.to_string()),
    })
}

pub fn list_suffix(metadata: &WorktreeMetadata) -> String {
    metadata
        .purpose
        .as_ref()
        .map(|purpose| format!(" {purpose}"))
        .unwrap_or_default()
}

fn parse_text(value: &str, label: &str, max: usize) -> Result<String> {
    let value = value.trim();
    if value.is_empty() {
        return Err(Error::validation(format!("{label} cannot be empty")));
    }
    if value.chars().any(|char| char == '\n' || char == '\r') {
        return Err(Error::validation(format!(
            "{label} cannot contain a newline"
        )));
    }
    if value.chars().count() > max {
        return Err(Error::validation(format!(
            "{label} cannot be longer than {max} characters"
        )));
    }
    Ok(value.to_string())
}

fn parse_number(value: &str) -> Result<u64> {
    let number = value.parse::<u64>().map_err(|_| {
        Error::validation(
            "A pull request or issue number must be an integer from 1 to 18446744073709551615"
                .to_string(),
        )
    })?;
    if number == 0 {
        return Err(Error::validation(
            "A pull request or issue number must be at least 1".to_string(),
        ));
    }
    Ok(number)
}

/// Read the kind and number together from the terminal URL path pair.
pub(crate) fn link_target(url: &str) -> Option<(&str, u64)> {
    let clean = url.split(['?', '#']).next()?.trim_end_matches('/');
    let (_, authority_and_path) = clean.split_once("://")?;
    let (_, path) = authority_and_path.split_once('/')?;
    let (prefix, number) = path.rsplit_once('/')?;
    let kind = prefix.rsplit('/').next()?;
    if !matches!(kind, "pull" | "pulls" | "issues" | "issue") {
        return None;
    }
    let number = number.parse::<u64>().ok()?;
    (number > 0).then_some((kind, number))
}

fn stored_worktree(path: String, metadata: WorktreeMetadata) -> StoredWorktree {
    StoredWorktree {
        schema: Some(2),
        path,
        name: metadata.name.clone(),
        metadata,
    }
}

fn apply_input(metadata: &mut WorktreeMetadata, input: &MetadataInput) {
    if input.setup.is_some() {
        metadata.setup = input.setup.clone();
    }
    if input.base_cleared {
        metadata.base = None;
        metadata.base_cleared = true;
    }
    if input.base.is_some() {
        metadata.base = input.base.clone();
        metadata.base_cleared = false;
    }
    if input.name.is_some() {
        metadata.name = input.name.clone();
    }
    if input.purpose.is_some() {
        metadata.purpose = input.purpose.clone();
    }
    if input.pr.is_some() {
        metadata.links.pr = input.pr.clone();
    }
    if input.issue.is_some() {
        metadata.links.issue = input.issue.clone();
    }
}

/// `mabo/` inside the Git common directory. A custom `workspace-root` does
/// not move this directory, and a checkout whose `.git` is a file still shares it.
fn metadata_dir(git_root: &Path) -> Result<PathBuf> {
    Ok(crate::git::git_common_dir(git_root)?.join("mabo"))
}

fn save_injected() -> bool {
    #[cfg(debug_assertions)]
    {
        std::env::var("MABO_TEST_FAIL_METADATA_SAVE")
            .ok()
            .as_deref()
            == Some("1")
    }
    #[cfg(not(debug_assertions))]
    {
        false
    }
}

pub fn records_dir(git_root: &Path) -> Result<PathBuf> {
    Ok(crate::git::git_common_dir(git_root)?
        .join("mabo")
        .join(RECORDS_DIR))
}

fn read_records(git_root: &Path, strict: bool) -> Result<(Store, Vec<String>)> {
    let (mut store, problems) = read_all_records(git_root, strict)?;
    deduplicate(&mut store);
    Ok((store, problems))
}

/// Concurrent first writers can publish different IDs for the same path. Keep
/// the oldest record intact; the next write removes the other files it read.
fn deduplicate(store: &mut Store) {
    store.worktrees.sort_by(|a, b| {
        (&a.metadata.created_at, &a.metadata.id).cmp(&(&b.metadata.created_at, &b.metadata.id))
    });
    let mut paths = Vec::new();
    store.worktrees.retain(|record| {
        let path = Path::new(&record.path);
        if paths
            .iter()
            .any(|existing: &PathBuf| paths::same_location(existing, path))
        {
            false
        } else {
            paths.push(path.to_path_buf());
            true
        }
    });
}

fn read_all_records(git_root: &Path, strict: bool) -> Result<(Store, Vec<String>)> {
    let dir = records_dir(git_root)?;
    let mut store = empty_store();
    let mut problems = Vec::new();
    let entries = match fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok((store, problems)),
        Err(error) => {
            return Err(Error::msg(format!(
                "Failed to read workspace metadata {}: {error}",
                dir.display()
            )))
        }
    };
    let mut files = entries
        .map(|entry| entry.map(|entry| entry.path()))
        .collect::<std::io::Result<Vec<_>>>()
        .map_err(|error| Error::msg(error.to_string()))?;
    files.sort();
    for file in files {
        // Atomic-write temporary files are deliberately invisible to readers.
        if file.extension().is_none_or(|ext| ext != "json") {
            continue;
        }
        let result = (|| {
            let bytes = fs::read(&file).map_err(|error| Error::msg(error.to_string()))?;
            let mut record: StoredWorktree = serde_json::from_slice(&bytes)
                .map_err(|error| Error::msg(format!("contains invalid JSON or shape: {error}")))?;
            let id = record
                .metadata
                .id
                .as_deref()
                .ok_or_else(|| Error::msg("missing id"))?;
            let valid_id = id
                .strip_prefix("ws_")
                .and_then(|id| uuid::Uuid::parse_str(id).ok())
                .is_some_and(|id| id.get_version_num() == 4);
            if record.schema != Some(2)
                || !valid_id
                || file.file_stem().and_then(|s| s.to_str()) != Some(id)
            {
                return Err(Error::msg("unsupported schema or invalid workspace id"));
            }
            if path_key(Path::new(&record.path)).is_empty() {
                return Err(Error::msg("record without a path"));
            }
            record.metadata.name = record.name.clone();
            Ok(record)
        })();
        match result {
            Ok(record) => store.worktrees.push(record),
            Err(error) => {
                let message = format!("Workspace metadata file {} {error}", file.display());
                if strict {
                    return Err(Error::msg(message));
                }
                problems.push(message);
            }
        }
    }
    Ok((store, problems))
}

fn ensure_records(git_root: &Path) -> Result<()> {
    let dir = records_dir(git_root)?;
    fs::create_dir_all(&dir).map_err(|error| {
        Error::msg(format!(
            "Workspace metadata directory {} is not writable: {error}",
            dir.display()
        ))
    })
}

fn save_record(dir: &Path, record: &StoredWorktree) -> Result<()> {
    let id = record
        .metadata
        .id
        .as_deref()
        .ok_or_else(|| Error::msg("Missing workspace id"))?;
    let body = serde_json::to_vec_pretty(record).map_err(|error| Error::msg(error.to_string()))?;
    crate::atomic::write(&dir.join(format!("{id}.json")), &body)
        .map_err(|error| Error::msg(format!("Failed to save workspace metadata: {error}")))
}

fn with_store<T>(
    git_root: &Path,
    rewrite: Option<&Path>,
    body: impl FnOnce(&mut Store) -> Result<(T, bool)>,
) -> Result<T> {
    ensure_records(git_root)?;
    let (mut store, _) = read_all_records(git_root, true)?;
    let before = store.worktrees.clone();
    deduplicate(&mut store);
    let duplicates = before.len() != store.worktrees.len();
    let (value, dirty) = body(&mut store)?;
    if dirty || duplicates {
        let dir = records_dir(git_root)?;
        for record in &store.worktrees {
            // Explicit updates normalize the target to the current schema even
            // when supplied values match. Other records retain their files.
            if !before.contains(record)
                || rewrite.is_some_and(|path| paths::same_location(Path::new(&record.path), path))
            {
                save_record(&dir, record)?;
            }
        }
        for record in &before {
            if !store
                .worktrees
                .iter()
                .any(|after| after.metadata.id == record.metadata.id)
            {
                if let Some(id) = &record.metadata.id {
                    match fs::remove_file(dir.join(format!("{id}.json"))) {
                        Ok(()) => {}
                        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                        Err(error) => return Err(Error::msg(error.to_string())),
                    }
                }
            }
        }
    }
    Ok(value)
}

fn empty_store() -> Store {
    Store {
        worktrees: Vec::new(),
    }
}

pub(crate) fn iso_now() -> String {
    let now = chrono::Utc::now();
    format!("{}Z", now.format("%Y-%m-%dT%H:%M:%S%.3f"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Barrier};
    use std::thread;

    fn root() -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "mabo-metadata-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&path).expect("root");
        let init = std::process::Command::new("git")
            .args(["init", "-b", "main"])
            .current_dir(&path)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .output()
            .expect("git init");
        assert!(
            init.status.success(),
            "{}",
            String::from_utf8_lossy(&init.stderr)
        );
        crate::test_git::configure_repo(&path);
        path
    }

    #[test]
    fn missing_file_loads_as_empty() {
        let root = root();
        assert!(load(&root).expect("load").is_empty());
        assert!(!records_dir(&root).expect("directory").exists());
    }

    #[test]
    fn write_patches_without_clearing_omitted_fields() {
        let root = root();
        let path = root.join("worktrees/feature");
        let created = write(
            &root,
            &path,
            &MetadataInput {
                purpose: Some("fix the flake".to_string()),
                pr: Some(WorktreeLink {
                    number: Some(774),
                    url: None,
                }),
                ..MetadataInput::default()
            },
        )
        .expect("create");
        assert!(created.created_at.is_some());

        let updated = write(
            &root,
            &path,
            &MetadataInput {
                purpose: Some("land the fix".to_string()),
                ..MetadataInput::default()
            },
        )
        .expect("update");
        assert_eq!(updated.purpose.as_deref(), Some("land the fix"));
        assert_eq!(
            updated.links.pr.as_ref().and_then(|link| link.number),
            Some(774)
        );
        assert_eq!(updated.created_at, created.created_at);
        assert_eq!(load(&root).expect("load").len(), 1);
    }

    #[test]
    fn remove_is_idempotent() {
        let root = root();
        let path = root.join("worktrees/feature");
        remove(&root, &path).expect("missing remove");
        write(&root, &path, &MetadataInput::default()).expect("write");
        remove(&root, &path).expect("remove");
        remove(&root, &path).expect("remove again");
        assert!(load(&root).expect("load").is_empty());
    }

    #[test]
    fn simultaneous_first_writes_to_one_path_converge_on_the_oldest_record() {
        // The smaller ID must lose when its timestamp is newer, and win ties.
        for dates in [
            ["2026-10-21T00:00:01Z", "2026-10-21T00:00:00Z"],
            ["2026-10-21T00:00:00Z", "2026-10-21T00:00:00Z"],
        ] {
            let root = Arc::new(root());
            let path = root.join("topic");
            let barrier = Arc::new(Barrier::new(2));
            let mut handles = Vec::new();
            for (index, date) in dates.into_iter().enumerate() {
                let root = Arc::clone(&root);
                let barrier = Arc::clone(&barrier);
                let path = path.clone();
                handles.push(thread::spawn(move || {
                    with_store(&root, None, |store| {
                        assert!(store.worktrees.is_empty());
                        // Both writers have read the empty store before either
                        // publishes a file, just like competing first meta sets.
                        barrier.wait();
                        let metadata = WorktreeMetadata {
                            id: Some(format!("ws_00000000-0000-4000-8000-{index:012}")),
                            purpose: Some(format!("purpose-{index}")),
                            base: Some(format!("base-{index}")),
                            created_at: Some(date.into()),
                            name: Some(format!("name-{index}")),
                            ..WorktreeMetadata::default()
                        };
                        store
                            .worktrees
                            .push(stored_worktree(path_key(&path), metadata.clone()));
                        Ok((metadata, true))
                    })
                    .unwrap()
                }));
            }
            let written = handles
                .into_iter()
                .map(|handle| handle.join().unwrap())
                .collect::<Vec<_>>();
            let winner = if dates[0] == dates[1] {
                &written[0]
            } else {
                &written[1]
            };
            let dir = records_dir(&root).unwrap();
            assert_eq!(fs::read_dir(&dir).unwrap().count(), 2);
            assert_eq!(load(&root).unwrap()[&path_key(&path)], *winner);
            assert_eq!(load_strict(&root).unwrap()[&path_key(&path)], *winner);
            assert!(read_problem(&root).is_none());
            assert_eq!(
                fs::read_dir(&dir).unwrap().count(),
                2,
                "readers do not write"
            );

            // Any subsequent write removes the duplicates it read, even when
            // it updates another path. Canonical fields stay together.
            write(&root, &root.join("other"), &MetadataInput::default()).unwrap();
            assert_eq!(fs::read_dir(&dir).unwrap().count(), 2);
            assert_eq!(load_strict(&root).unwrap()[&path_key(&path)], *winner);
            let patched = write(
                &root,
                &path,
                &MetadataInput {
                    purpose: Some("patched".into()),
                    ..MetadataInput::default()
                },
            )
            .unwrap();
            assert_eq!(patched.id, winner.id);
            assert_eq!(patched.base, winner.base);
            assert_eq!(patched.purpose.as_deref(), Some("patched"));
            remove(&root, &path).unwrap();
            assert_eq!(load_strict(&root).unwrap().len(), 1);
            assert!(!load(&root).unwrap().contains_key(&path_key(&path)));
            fs::remove_dir_all(root.as_path()).unwrap();
        }
    }

    #[test]
    fn concurrent_writes_keep_both_records() {
        let root = Arc::new(root());
        let barrier = Arc::new(Barrier::new(2));
        let mut handles = Vec::new();
        for name in ["one", "two"] {
            let root = Arc::clone(&root);
            let barrier = Arc::clone(&barrier);
            let name = name.to_string();
            handles.push(thread::spawn(move || {
                barrier.wait();
                write(
                    &root,
                    &root.join(&name),
                    &MetadataInput {
                        purpose: Some(name),
                        ..MetadataInput::default()
                    },
                )
                .expect("write")
            }));
        }
        for handle in handles {
            handle.join().expect("join");
        }
        let records = load(&root).expect("load");
        assert_eq!(records.len(), 2);
        assert_eq!(
            records
                .get(&path_key(&root.join("one")))
                .and_then(|item| item.purpose.as_deref()),
            Some("one")
        );
        assert_eq!(
            records
                .get(&path_key(&root.join("two")))
                .and_then(|item| item.purpose.as_deref()),
            Some("two")
        );
    }

    #[test]
    fn corrupt_individual_record_keeps_healthy_metadata_readable() {
        let root = root();
        let one = write(
            &root,
            &root.join("one"),
            &MetadataInput {
                purpose: Some("one".into()),
                ..MetadataInput::default()
            },
        )
        .unwrap();
        write(
            &root,
            &root.join("two"),
            &MetadataInput {
                purpose: Some("two".into()),
                ..MetadataInput::default()
            },
        )
        .unwrap();
        let file = records_dir(&root)
            .unwrap()
            .join(format!("{}.json", one.id.unwrap()));
        fs::write(&file, "broken").unwrap();
        let records = load(&root).unwrap();
        assert_eq!(records.len(), 1);
        assert_eq!(
            records[&path_key(&root.join("two"))].purpose.as_deref(),
            Some("two")
        );
        assert!(read_problem(&root)
            .unwrap()
            .contains(file.to_str().unwrap()));
        assert!(write(&root, &root.join("three"), &MetadataInput::default()).is_err());
        assert_eq!(fs::read_to_string(file).unwrap(), "broken");
    }

    #[test]
    fn invalid_schema_ids_and_paths_are_never_overwritten() {
        let root = root();
        let metadata = write(&root, &root.join("one"), &MetadataInput::default()).unwrap();
        let dir = records_dir(&root).unwrap();
        let file = dir.join(format!("{}.json", metadata.id.unwrap()));
        let valid: serde_json::Value = serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
        for (field, value) in [
            ("schema", serde_json::json!(1)),
            ("schema", serde_json::Value::Null),
            ("id", serde_json::Value::Null),
            (
                "id",
                serde_json::json!(format!("ws_{}", uuid::Uuid::new_v4())),
            ),
            (
                "id",
                serde_json::json!("ws_550e8400-e29b-11d4-a716-446655440000"),
            ),
            ("path", serde_json::json!("")),
            ("path", serde_json::Value::Null),
        ] {
            let mut invalid = valid.clone();
            invalid[field] = value;
            let bytes = serde_json::to_vec(&invalid).unwrap();
            fs::write(&file, &bytes).unwrap();
            assert!(load_strict(&root).is_err(), "{invalid}");
            assert!(load(&root).unwrap().is_empty(), "{invalid}");
            assert!(write(&root, &root.join("two"), &MetadataInput::default()).is_err());
            assert_eq!(fs::read(&file).unwrap(), bytes);
            assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);
        }
    }

    #[test]
    fn link_numbers_use_only_the_terminal_kind_number_pair() {
        for kind in ["pull", "pulls", "issues", "issue"] {
            let url = format!("https://git.example.com/pull/123/{kind}/42/?plain=1#details");
            assert_eq!(parse_link(&url).unwrap().number, Some(42), "{url}");
        }
        for suffix in ["pull/0", "issues/not-a-number", "pull/42/files", "other/42"] {
            let url = format!("https://git.example.com/pull/123/{suffix}");
            assert_eq!(parse_link(&url).unwrap().number, None, "{url}");
        }
    }

    #[test]
    fn parses_purpose_and_links() {
        assert_eq!(parse_purpose("  grok  ").expect("purpose"), "grok");
        assert!(parse_purpose(" ").is_err());
        assert!(parse_purpose("a\nb").is_err());
        assert!(parse_purpose("fix the flake").is_ok());
        let number = parse_link("#774").expect("number");
        assert_eq!(number.number, Some(774));
        assert!(number.url.is_none());
        let url = parse_link("https://github.com/phantompane/phantom/pull/774").expect("url");
        assert_eq!(url.number, Some(774));
        assert!(url.url.unwrap().contains("/pull/774"));
        let issue =
            parse_link("https://github.com/phantompane/phantom/issues/12?plain=1").expect("issue");
        assert_eq!(issue.number, Some(12));
        assert!(parse_link("0").is_err());
        assert!(parse_link("not a link").is_err());
    }
}
