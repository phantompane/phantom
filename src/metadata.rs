use std::collections::BTreeMap;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};
use crate::paths;

const FILE_NAME: &str = "worktrees.json";
const LOCK_NAME: &str = "worktrees.lock";
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
    pub owner: Option<String>,
    #[serde(default)]
    pub purpose: Option<String>,
    #[serde(default)]
    pub created_at: Option<String>,
    #[serde(default)]
    pub last_used_at: Option<String>,
    #[serde(default)]
    pub links: WorktreeLinks,
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

/// Fields supplied at a boundary. `None` leaves the stored value alone.
#[derive(Debug, Clone, Default)]
pub struct MetadataInput {
    pub owner: Option<String>,
    pub purpose: Option<String>,
    pub pr: Option<WorktreeLink>,
    pub issue: Option<WorktreeLink>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Store {
    version: u32,
    worktrees: Vec<StoredWorktree>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredWorktree {
    path: String,
    #[serde(flatten)]
    metadata: WorktreeMetadata,
}

pub fn path_key(path: &Path) -> String {
    paths::normalize(path).to_string_lossy().into_owned()
}

pub fn metadata_file(git_root: &Path) -> PathBuf {
    metadata_dir(git_root).join(FILE_NAME)
}

/// Records for every path in the store. A missing file is an empty map.
pub fn load(git_root: &Path) -> Result<BTreeMap<String, WorktreeMetadata>> {
    let store = read_store(&metadata_file(git_root))?;
    let mut records = BTreeMap::new();
    for record in store.worktrees {
        let key = path_key(Path::new(&record.path));
        if key.is_empty() {
            return Err(Error::msg(
                "Worktree metadata record is missing a path".to_string(),
            ));
        }
        if records.insert(key, record.metadata).is_some() {
            return Err(Error::msg(
                "Worktree metadata contains a duplicate path".to_string(),
            ));
        }
    }
    Ok(records)
}

/// Insert or patch the record for `path`. A new record gets both timestamps.
pub fn write(git_root: &Path, path: &Path, input: &MetadataInput) -> Result<WorktreeMetadata> {
    let key = path_key(path);
    with_store(git_root, |store| {
        let now = iso_now();
        if let Some(record) = store.worktrees.iter_mut().find(|record| record.path == key) {
            apply_input(&mut record.metadata, input);
            return Ok((record.metadata.clone(), true));
        }
        let mut metadata = WorktreeMetadata {
            created_at: Some(now.clone()),
            last_used_at: Some(now),
            ..WorktreeMetadata::default()
        };
        apply_input(&mut metadata, input);
        store.worktrees.push(StoredWorktree {
            path: key,
            metadata: metadata.clone(),
        });
        Ok((metadata, true))
    })
}

/// Bump `lastUsedAt` when a record exists. A worktree with no record is left alone.
pub fn touch(git_root: &Path, path: &Path) -> Result<Option<WorktreeMetadata>> {
    if !metadata_file(git_root).exists() {
        return Ok(None);
    }
    let key = path_key(path);
    with_store(git_root, |store| {
        let Some(record) = store.worktrees.iter_mut().find(|record| record.path == key) else {
            return Ok((None, false));
        };
        record.metadata.last_used_at = Some(iso_now());
        Ok((Some(record.metadata.clone()), true))
    })
}

/// Drop the record for `path`. Missing records are already the end state.
pub fn remove(git_root: &Path, path: &Path) -> Result<()> {
    if !metadata_file(git_root).exists() {
        return Ok(());
    }
    let key = path_key(path);
    with_store(git_root, |store| {
        let before = store.worktrees.len();
        store.worktrees.retain(|record| record.path != key);
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

fn apply_input(metadata: &mut WorktreeMetadata, input: &MetadataInput) {
    if input.owner.is_some() {
        metadata.owner = input.owner.clone();
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

/// Parent of the default worktrees directory. A custom `worktrees-directory`
/// does not move this file.
fn metadata_dir(git_root: &Path) -> PathBuf {
    let worktrees = paths::worktrees_directory(git_root, None);
    match worktrees.parent() {
        Some(parent) => parent.to_path_buf(),
        None => git_root.join(".git").join("ptm"),
    }
}

fn with_store<T>(git_root: &Path, body: impl FnOnce(&mut Store) -> Result<(T, bool)>) -> Result<T> {
    let dir = metadata_dir(git_root);
    fs::create_dir_all(&dir).map_err(|error| {
        Error::msg(format!(
            "Failed to create worktree metadata directory: {error}"
        ))
    })?;
    let lock = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .open(dir.join(LOCK_NAME))
        .map_err(|error| Error::msg(format!("Failed to lock worktree metadata: {error}")))?;
    lock.lock()
        .map_err(|error| Error::msg(format!("Failed to lock worktree metadata: {error}")))?;
    let path = dir.join(FILE_NAME);
    let mut store = read_store(&path)?;
    let (value, dirty) = body(&mut store)?;
    if dirty {
        write_store(&path, &dir, &store)?;
    }
    let _ = lock.unlock();
    Ok(value)
}

fn read_store(path: &Path) -> Result<Store> {
    let content = match fs::read_to_string(path) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(empty_store());
        }
        Err(error) => {
            return Err(Error::msg(format!(
                "Failed to read worktree metadata: {error}"
            )));
        }
    };
    let value: serde_json::Value = serde_json::from_str(&content)
        .map_err(|error| Error::msg(format!("Worktree metadata contains invalid JSON: {error}")))?;
    if !value.is_object() {
        return Err(Error::msg(
            "Worktree metadata is not a JSON object".to_string(),
        ));
    }
    let version = value
        .get("version")
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    if version.as_u64() != Some(u64::from(STORE_VERSION)) {
        return Err(Error::msg(format!(
            "Unsupported worktree metadata version: {version}"
        )));
    }
    serde_json::from_value(value)
        .map_err(|error| Error::msg(format!("Worktree metadata has an invalid shape: {error}")))
}

fn write_store(path: &Path, dir: &Path, store: &Store) -> Result<()> {
    let temporary = dir.join(format!(
        ".{FILE_NAME}.tmp-{}-{}",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    let body = format!(
        "{}\n",
        serde_json::to_string_pretty(store)
            .map_err(|error| Error::msg(format!("Failed to encode worktree metadata: {error}")))?
    );
    let write_result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&temporary)
            .map_err(|error| Error::msg(format!("Failed to save worktree metadata: {error}")))?;
        file.write_all(body.as_bytes())
            .map_err(|error| Error::msg(format!("Failed to save worktree metadata: {error}")))?;
        file.sync_all()
            .map_err(|error| Error::msg(format!("Failed to save worktree metadata: {error}")))?;
        Ok(())
    })();
    if let Err(error) = write_result {
        let _ = fs::remove_file(&temporary);
        return Err(error);
    }
    let renamed = fs::rename(&temporary, path);
    if renamed.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    renamed.map_err(|error| Error::msg(format!("Failed to save worktree metadata: {error}")))?;
    let _ = File::open(dir).and_then(|directory| directory.sync_all());
    Ok(())
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
            "ptm-metadata-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&path).expect("root");
        path
    }

    #[test]
    fn missing_file_loads_as_empty() {
        let root = root();
        assert!(load(&root).expect("load").is_empty());
        assert!(!metadata_file(&root).exists());
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
        assert!(!metadata_file(&root).exists());
        remove(&root, &path).expect("missing remove");

        let created = write(&root, &path, &MetadataInput::default()).expect("write");
        let mut document: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(metadata_file(&root)).expect("file"))
                .expect("json");
        document["worktrees"][0]["lastUsedAt"] = serde_json::json!("2000-01-01T00:00:00.000Z");
        fs::write(
            metadata_file(&root),
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
        fs::create_dir_all(metadata_dir(&root)).expect("dir");
        let file = metadata_file(&root);
        fs::write(&file, "{not json").expect("corrupt");
        let error = write(&root, &root.join("wt"), &MetadataInput::default()).expect_err("write");
        assert!(error.to_string().contains("invalid JSON"));
        assert_eq!(fs::read_to_string(&file).expect("kept"), "{not json");

        fs::write(&file, "{\n  \"version\": 2,\n  \"worktrees\": []\n}\n").expect("version");
        let error = load(&root).expect_err("version");
        assert!(error
            .to_string()
            .contains("Unsupported worktree metadata version"));
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
