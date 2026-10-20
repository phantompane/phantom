use std::collections::BTreeMap;
use std::fs::{self, OpenOptions};
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};
use crate::paths;

const FILE_NAME: &str = "worktrees.json";
const RECORDS_DIR: &str = "workspaces";
const STORE_VERSION: u32 = 1;
const OWNER_MAX: usize = 256;
const PURPOSE_MAX: usize = 1024;

/// Ownership and purpose recorded for one worktree.
///
/// Absent fields stay null. There is no placeholder owner.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeMetadata {
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub owner: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base: Option<String>,
    #[serde(default)]
    pub purpose: Option<String>,
    #[serde(default)]
    pub created_at: Option<String>,
    /// Full commit the branch was created from. Absent on older records, when
    /// a new branch has no HEAD, and when an existing branch has no reflog.
    #[serde(default)]
    pub created_from: Option<String>,
    #[serde(default)]
    pub last_used_at: Option<String>,
    #[serde(default)]
    pub links: WorktreeLinks,
    /// Name saved for a worktree outside `maboroshi/worktrees`.
    ///
    /// Command JSON already has `name`, so this stays out of that flatten.
    /// Older records omit it and keep the folder name.
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
    /// `create` just pointed a new branch at HEAD. That commit is the base.
    New,
    /// The branch already existed. The base is its reflog, when one exists.
    Existing,
}

/// Fields supplied at a boundary. `None` leaves the stored value alone.
#[derive(Debug, Clone, Default)]
pub struct MetadataInput {
    pub owner: Option<String>,
    pub base: Option<String>,
    pub purpose: Option<String>,
    pub pr: Option<WorktreeLink>,
    pub issue: Option<WorktreeLink>,
    /// Set only when recording a worktree outside `maboroshi/worktrees`.
    pub name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Store {
    version: u32,
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

pub fn metadata_file(git_root: &Path) -> Result<PathBuf> {
    Ok(metadata_dir(git_root)?.join(FILE_NAME))
}

/// Records for every path in the store. A missing file is an empty map.
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

/// Replace any record at `path`. Create, attach, and a first checkout use this
/// so a worktree removed outside mabo does not keep the previous owner.
pub fn replace(
    git_root: &Path,
    path: &Path,
    input: &MetadataInput,
    origin: BranchOrigin,
) -> Result<WorktreeMetadata> {
    if save_injected() {
        return Err(Error::msg(
            "Failed to save worktree metadata: injected failure".to_string(),
        ));
    }
    let key = path_key(path);
    with_store(git_root, |store| {
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

/// Insert or patch the record for `path`. `meta set` and re-checkout use this.
/// A new record gets both timestamps and `createdFrom`. An existing record
/// keeps omitted fields, including `createdFrom`.
pub fn write(git_root: &Path, path: &Path, input: &MetadataInput) -> Result<WorktreeMetadata> {
    let key = path_key(path);
    with_store(git_root, |store| {
        if let Some(record) = store
            .worktrees
            .iter_mut()
            .find(|record| paths::same_location(Path::new(&record.path), path))
        {
            apply_input(&mut record.metadata, input);
            record.name = record.metadata.name.clone();
            return Ok((record.metadata.clone(), true));
        }
        let metadata = fresh_metadata(path, input, BranchOrigin::Existing);
        store.worktrees.push(stored_worktree(key, metadata.clone()));
        Ok((metadata, true))
    })
}

fn fresh_metadata(path: &Path, input: &MetadataInput, origin: BranchOrigin) -> WorktreeMetadata {
    let now = iso_now();
    let mut metadata = WorktreeMetadata {
        id: Some(format!("ws_{}", uuid::Uuid::new_v4())),
        created_at: Some(now.clone()),
        last_used_at: Some(now),
        created_from: recorded_creation(path, origin),
        ..WorktreeMetadata::default()
    };
    apply_input(&mut metadata, input);
    metadata
}

fn recorded_creation(path: &Path, origin: BranchOrigin) -> Option<String> {
    match origin {
        BranchOrigin::New => crate::git::head_commit(path),
        BranchOrigin::Existing => crate::git::reflog_creation_commit(path),
    }
}

/// Record the tip sync integrated while the branch had no commits of its own.
pub fn record_sync_tip(git_root: &Path, path: &Path, tip: &str) -> Result<()> {
    with_store(git_root, |store| {
        let Some(record) = store
            .worktrees
            .iter_mut()
            .find(|record| paths::same_location(Path::new(&record.path), path))
        else {
            return Ok(((), false));
        };
        record.metadata.created_from = Some(tip.to_string());
        Ok(((), true))
    })
}

/// Bump `lastUsedAt` when a record exists. A worktree with no record is left alone.
pub fn touch(git_root: &Path, path: &Path) -> Result<Option<WorktreeMetadata>> {
    if !metadata_file(git_root)?.exists() && !records_dir(git_root)?.exists() {
        return Ok(None);
    }
    with_store(git_root, |store| {
        let Some(record) = store
            .worktrees
            .iter_mut()
            .find(|record| paths::same_location(Path::new(&record.path), path))
        else {
            return Ok((None, false));
        };
        record.metadata.last_used_at = Some(iso_now());
        record.metadata.name = record.name.clone();
        Ok((Some(record.metadata.clone()), true))
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
            "Worktree metadata directory {} is not writable: {error}",
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
                "Worktree metadata directory {} is not writable: {error}",
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
    if !metadata_file(git_root)?.exists() && !records_dir(git_root)?.exists() {
        return Ok(());
    }
    with_store(git_root, |store| {
        let before = store.worktrees.len();
        store
            .worktrees
            .retain(|record| !paths::same_location(Path::new(&record.path), path));
        Ok(((), store.worktrees.len() != before))
    })
}

pub fn resolve_owner(flag: Option<&str>, env: Option<&str>) -> Result<Option<String>> {
    if let Some(value) = flag {
        return Ok(Some(parse_owner(value)?));
    }
    match env.map(str::trim).filter(|value| !value.is_empty()) {
        Some(value) => Ok(Some(parse_owner(value)?)),
        None => Ok(None),
    }
}

pub fn parse_owner(value: &str) -> Result<String> {
    parse_text(value, "Owner", OWNER_MAX)
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
        number: link_number(value),
        url: Some(value.to_string()),
    })
}

pub fn list_suffix(metadata: &WorktreeMetadata) -> String {
    match (&metadata.owner, &metadata.purpose) {
        (Some(owner), Some(purpose)) => format!(" [{owner}] {purpose}"),
        (Some(owner), None) => format!(" [{owner}]"),
        (None, Some(purpose)) => format!(" {purpose}"),
        (None, None) => String::new(),
    }
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

fn link_number(url: &str) -> Option<u64> {
    let without_query = url.split(['?', '#']).next().unwrap_or(url);
    let path = without_query
        .split_once("://")
        .map(|(_, rest)| rest)
        .unwrap_or(without_query);
    let segments = path.split('/').filter(|segment| !segment.is_empty());
    let mut previous = None;
    for segment in segments {
        if let Some(kind) = previous {
            if matches!(kind, "pull" | "pulls" | "issues" | "issue") {
                if let Ok(number) = segment.parse::<u64>() {
                    if number > 0 {
                        return Some(number);
                    }
                }
            }
        }
        previous = Some(segment);
    }
    None
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
    if input.base.is_some() {
        metadata.base = input.base.clone();
    }
    if input.owner.is_some() {
        metadata.owner = input.owner.clone();
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

/// `maboroshi/` inside the Git common directory. A custom `worktrees-directory` does
/// not move this file, and a checkout whose `.git` is a file still shares it.
fn metadata_dir(git_root: &Path) -> Result<PathBuf> {
    Ok(crate::git::git_common_dir(git_root)?.join("maboroshi"))
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
    Ok(metadata_dir(git_root)?.join(RECORDS_DIR))
}

fn read_records(git_root: &Path, strict: bool) -> Result<(Store, Vec<String>)> {
    let dir = records_dir(git_root)?;
    if !dir.exists() {
        return Ok((validated_store(&metadata_file(git_root)?)?, Vec::new()));
    }
    let mut store = empty_store();
    let mut problems = Vec::new();
    let entries = fs::read_dir(&dir).map_err(|error| {
        Error::msg(format!(
            "Failed to read worktree metadata {}: {error}",
            dir.display()
        ))
    })?;
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
            if store.worktrees.iter().any(|existing| {
                paths::same_location(Path::new(&existing.path), Path::new(&record.path))
            }) {
                return Err(Error::msg("duplicate path"));
            }
            record.metadata.name = record.name.clone();
            Ok(record)
        })();
        match result {
            Ok(record) => store.worktrees.push(record),
            Err(error) => {
                let message = format!("Worktree metadata file {} {error}", file.display());
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
    let legacy = metadata_file(git_root)?;
    if legacy.exists() {
        crate::atomic::import_directory(&dir, &legacy, |staging| {
            let mut store = validated_store(&legacy)?;
            for record in &mut store.worktrees {
                record.schema = Some(2);
                record.metadata.id = Some(format!("ws_{}", uuid::Uuid::new_v4()));
                save_record(staging, record)?;
            }
            Ok(())
        })?;
    } else {
        fs::create_dir_all(&dir).map_err(|error| {
            Error::msg(format!(
                "Worktree metadata directory {} is not writable: {error}",
                dir.display()
            ))
        })?;
    }
    Ok(())
}

fn save_record(dir: &Path, record: &StoredWorktree) -> Result<()> {
    let id = record
        .metadata
        .id
        .as_deref()
        .ok_or_else(|| Error::msg("Missing workspace id"))?;
    let body = serde_json::to_vec_pretty(record).map_err(|error| Error::msg(error.to_string()))?;
    crate::atomic::write(&dir.join(format!("{id}.json")), &body)
        .map_err(|error| Error::msg(format!("Failed to save worktree metadata: {error}")))
}

fn with_store<T>(git_root: &Path, body: impl FnOnce(&mut Store) -> Result<(T, bool)>) -> Result<T> {
    ensure_records(git_root)?;
    let (mut store, _) = read_records(git_root, true)?;
    let before = store.worktrees.clone();
    let (value, dirty) = body(&mut store)?;
    if dirty {
        let dir = records_dir(git_root)?;
        for record in &store.worktrees {
            if !before.contains(record) {
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

fn validated_store(path: &Path) -> Result<Store> {
    let store = read_store(path)?;
    let mut seen = std::collections::BTreeSet::new();
    for record in &store.worktrees {
        let key = path_key(Path::new(&record.path));
        if key.is_empty() {
            return Err(Error::msg(format!(
                "Worktree metadata file {} contains a record without a path",
                path.display()
            )));
        }
        if !seen.insert(key) {
            return Err(Error::msg(format!(
                "Worktree metadata file {} contains a duplicate path",
                path.display()
            )));
        }
    }
    Ok(store)
}

fn read_store(path: &Path) -> Result<Store> {
    let content = match fs::read_to_string(path) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(empty_store());
        }
        Err(error) => {
            return Err(Error::msg(format!(
                "Worktree metadata file {} could not be read: {error}",
                path.display()
            )));
        }
    };
    let value: serde_json::Value = serde_json::from_str(&content).map_err(|error| {
        Error::msg(format!(
            "Worktree metadata file {} contains invalid JSON: {error}",
            path.display()
        ))
    })?;
    if !value.is_object() {
        return Err(Error::msg(format!(
            "Worktree metadata file {} is not a JSON object",
            path.display()
        )));
    }
    let version = value
        .get("version")
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    if version.as_u64() != Some(u64::from(STORE_VERSION)) {
        return Err(Error::msg(format!(
            "Worktree metadata file {} has unsupported version: {version}",
            path.display()
        )));
    }
    serde_json::from_value(value).map_err(|error| {
        Error::msg(format!(
            "Worktree metadata file {} has an invalid shape: {error}",
            path.display()
        ))
    })
}

fn empty_store() -> Store {
    Store {
        version: STORE_VERSION,
        worktrees: Vec::new(),
    }
}

fn iso_now() -> String {
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
        path
    }

    #[test]
    fn missing_file_loads_as_empty() {
        let root = root();
        assert!(load(&root).expect("load").is_empty());
        assert!(!metadata_file(&root).expect("file").exists());
    }

    #[test]
    fn write_patches_without_clearing_omitted_fields() {
        let root = root();
        let path = root.join("worktrees/feature");
        let created = write(
            &root,
            &path,
            &MetadataInput {
                owner: Some("grok".to_string()),
                purpose: Some("fix the flake".to_string()),
                pr: Some(WorktreeLink {
                    number: Some(774),
                    url: None,
                }),
                ..MetadataInput::default()
            },
        )
        .expect("create");
        assert_eq!(created.owner.as_deref(), Some("grok"));
        assert_eq!(created.created_at, created.last_used_at);

        let updated = write(
            &root,
            &path,
            &MetadataInput {
                purpose: Some("land the fix".to_string()),
                ..MetadataInput::default()
            },
        )
        .expect("update");
        assert_eq!(updated.owner.as_deref(), Some("grok"));
        assert_eq!(updated.purpose.as_deref(), Some("land the fix"));
        assert_eq!(
            updated.links.pr.as_ref().and_then(|link| link.number),
            Some(774)
        );
        assert_eq!(updated.created_at, created.created_at);
        assert_eq!(load(&root).expect("load").len(), 1);
    }

    #[test]
    fn touch_and_remove_are_idempotent() {
        let root = root();
        let path = root.join("worktrees/feature");
        assert!(touch(&root, &path).expect("missing").is_none());
        assert!(!metadata_file(&root).expect("file").exists());
        remove(&root, &path).expect("missing remove");

        let created = write(&root, &path, &MetadataInput::default()).expect("write");
        let file = records_dir(&root)
            .unwrap()
            .join(format!("{}.json", created.id.as_deref().unwrap()));
        let mut document: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&file).expect("file")).expect("json");
        document["lastUsedAt"] = serde_json::json!("2000-01-01T00:00:00.000Z");
        fs::write(
            &file,
            format!(
                "{}\n",
                serde_json::to_string_pretty(&document).expect("encode")
            ),
        )
        .expect("rewrite");
        let touched = touch(&root, &path).expect("touch").expect("record");
        assert_eq!(touched.created_at, created.created_at);
        assert_ne!(
            touched.last_used_at.as_deref(),
            Some("2000-01-01T00:00:00.000Z")
        );
        remove(&root, &path).expect("remove");
        remove(&root, &path).expect("remove again");
        assert!(load(&root).expect("load").is_empty());
    }

    #[test]
    fn corrupt_or_unknown_version_is_not_overwritten() {
        let root = root();
        fs::create_dir_all(metadata_dir(&root).expect("dir")).expect("dir");
        let file = metadata_file(&root).expect("file");
        fs::write(&file, "{not json").expect("corrupt");
        let error = write(&root, &root.join("wt"), &MetadataInput::default()).expect_err("write");
        assert!(error.to_string().contains("invalid JSON"));
        assert_eq!(fs::read_to_string(&file).expect("kept"), "{not json");

        let duplicate = "{\n  \"version\": 1,\n  \"worktrees\": [\n    {\"path\": \"/tmp/a\", \"owner\": \"first\"},\n    {\"path\": \"/tmp/a\", \"owner\": \"second\"}\n  ]\n}\n";
        fs::write(&file, duplicate).expect("duplicate");
        let error = replace(
            &root,
            Path::new("/tmp/b"),
            &MetadataInput::default(),
            BranchOrigin::Existing,
        )
        .expect_err("dup");
        assert!(error.to_string().contains("duplicate path"));
        assert_eq!(fs::read_to_string(&file).expect("kept"), duplicate);

        fs::write(&file, "{\n  \"version\": 2,\n  \"worktrees\": []\n}\n").expect("version");
        let error = load(&root).expect_err("version");
        assert!(error.to_string().contains("unsupported version"));
        assert!(fs::read_to_string(&file)
            .expect("kept")
            .contains("\"version\": 2"));
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
                        owner: Some(name),
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
                .and_then(|item| item.owner.as_deref()),
            Some("one")
        );
        assert_eq!(
            records
                .get(&path_key(&root.join("two")))
                .and_then(|item| item.owner.as_deref()),
            Some("two")
        );
    }

    #[test]
    fn imports_alpha6_on_first_write_and_preserves_all_fields() {
        let root = root();
        let legacy = metadata_file(&root).unwrap();
        fs::create_dir_all(legacy.parent().unwrap()).unwrap();
        let fixture = include_str!("../tests/fixtures/alpha6/worktrees.json");
        fs::write(&legacy, fixture).unwrap();
        let before = load(&root).unwrap();
        assert_eq!(before.len(), 2);
        assert!(
            !records_dir(&root).unwrap().exists(),
            "read-only load migrated"
        );
        write(&root, &root.join("new"), &MetadataInput::default()).unwrap();
        assert!(!legacy.exists());
        assert_eq!(
            fs::read_to_string(legacy.with_extension("json.imported")).unwrap(),
            fixture
        );
        let after = load(&root).unwrap();
        assert_eq!(after.len(), 3);
        for (path, old) in before {
            let mut imported = after[&path].clone();
            assert!(imported.id.as_deref().unwrap().starts_with("ws_"));
            imported.id = None;
            assert_eq!(imported, old);
        }
        assert_eq!(
            fs::read_dir(records_dir(&root).unwrap()).unwrap().count(),
            3
        );
    }

    #[test]
    fn corrupt_individual_record_keeps_healthy_metadata_readable() {
        let root = root();
        let one = write(
            &root,
            &root.join("one"),
            &MetadataInput {
                owner: Some("one".into()),
                ..MetadataInput::default()
            },
        )
        .unwrap();
        write(
            &root,
            &root.join("two"),
            &MetadataInput {
                owner: Some("two".into()),
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
            records[&path_key(&root.join("two"))].owner.as_deref(),
            Some("two")
        );
        assert!(read_problem(&root)
            .unwrap()
            .contains(file.to_str().unwrap()));
        assert!(write(&root, &root.join("three"), &MetadataInput::default()).is_err());
        assert_eq!(fs::read_to_string(file).unwrap(), "broken");
    }

    #[test]
    fn simultaneous_first_writes_import_legacy_without_losing_records() {
        let root = Arc::new(root());
        let legacy = metadata_file(&root).unwrap();
        fs::create_dir_all(legacy.parent().unwrap()).unwrap();
        fs::write(
            &legacy,
            include_str!("../tests/fixtures/alpha6/worktrees.json"),
        )
        .unwrap();
        let gate = Arc::new(Barrier::new(8));
        let handles = (0..8)
            .map(|index| {
                let root = Arc::clone(&root);
                let gate = Arc::clone(&gate);
                thread::spawn(move || {
                    gate.wait();
                    write(
                        &root,
                        &root.join(format!("new-{index}")),
                        &MetadataInput::default(),
                    )
                    .unwrap();
                })
            })
            .collect::<Vec<_>>();
        for handle in handles {
            handle.join().unwrap();
        }
        assert_eq!(load(&root).unwrap().len(), 10);
        assert!(!legacy.exists());
        assert!(legacy.with_extension("json.imported").is_file());
    }

    #[test]
    fn parses_owner_purpose_and_links() {
        assert_eq!(parse_owner("  grok  ").expect("owner"), "grok");
        assert!(parse_owner(" ").is_err());
        assert!(parse_owner("a\nb").is_err());
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
        assert_eq!(
            resolve_owner(Some("flag"), Some("env")).expect("flag"),
            Some("flag".to_string())
        );
        assert_eq!(
            resolve_owner(None, Some("  env  ")).expect("env"),
            Some("env".to_string())
        );
        assert_eq!(resolve_owner(None, Some("  ")).expect("blank"), None);
        assert_eq!(resolve_owner(None, None).expect("none"), None);
    }
}
