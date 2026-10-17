use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant, SystemTime};

use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};
use crate::git;
use crate::process;

const REGISTRY_FILE: &str = "projects.json";
const LOCK_DIR: &str = "projects.lock";
const OWNER_FILE: &str = "owner.json";
const RECOVERY_DIR: &str = "projects.lock.recovery";
const REGISTRY_VERSION: u32 = 1;
const LIST_VERSION: u32 = 2;
const LOCK_TIMEOUT: Duration = Duration::from_millis(5_000);
const LOCK_RETRY: Duration = Duration::from_millis(20);
const STALE_LOCK: Duration = Duration::from_millis(30_000);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRecord {
    pub id: String,
    pub name: String,
    pub root_path: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct RegistryState {
    version: u32,
    projects: Vec<ProjectRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct LockOwner {
    token: String,
    pid: u32,
    #[serde(rename = "createdAt")]
    created_at: String,
    #[serde(rename = "processIdentity")]
    process_identity: Option<String>,
}

#[derive(Clone)]
struct LockObservation {
    token: Option<String>,
}

pub struct ProjectRegistryStore {
    data_dir: PathBuf,
}

impl ProjectRegistryStore {
    pub fn new(data_dir: PathBuf) -> Self {
        Self { data_dir }
    }

    pub fn default_store() -> Result<Self> {
        Ok(Self::new(default_data_dir()?))
    }

    pub fn list(&self) -> Result<Vec<ProjectRecord>> {
        Ok(self.load()?.projects)
    }

    pub fn add(&self, root_path: &Path) -> Result<(ProjectRecord, bool)> {
        let normalized = normalize_root(root_path)?;
        let mut added = None;
        self.update(|state| {
            if let Some(existing) = state
                .projects
                .iter()
                .find(|project| project.root_path == normalized)
            {
                added = Some((existing.clone(), false));
                return Ok(());
            }
            let project = ProjectRecord {
                id: format!("proj_{}", uuid::Uuid::new_v4()),
                name: Path::new(&normalized)
                    .file_name()
                    .map(|name| name.to_string_lossy().to_string())
                    .unwrap_or_default(),
                root_path: normalized.clone(),
                created_at: iso_now(),
            };
            added = Some((project.clone(), true));
            state.projects.push(project);
            Ok(())
        })?;
        added.ok_or_else(|| Error::Projects("Project add did not produce a record".to_string()))
    }

    pub fn remove(&self, id: &str) -> Result<Option<ProjectRecord>> {
        let mut removed = None;
        self.update(|state| {
            if let Some(index) = state.projects.iter().position(|project| project.id == id) {
                removed = Some(state.projects.remove(index));
            }
            Ok(())
        })?;
        Ok(removed)
    }

    fn update(&self, mut updater: impl FnMut(&mut RegistryState) -> Result<()>) -> Result<()> {
        self.with_lock(|| {
            let mut state = self.load()?;
            updater(&mut state)?;
            validate_state(&state)?;
            self.save(&state)
        })
    }

    fn load(&self) -> Result<RegistryState> {
        let path = self.data_dir.join(REGISTRY_FILE);
        let content = match fs::read_to_string(&path) {
            Ok(content) => content,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(empty_registry());
            }
            Err(error) => return Err(Error::Projects(error.to_string())),
        };
        let value: serde_json::Value = serde_json::from_str(&content).map_err(|error| {
            Error::Projects(format!("Projects registry contains invalid JSON: {error}"))
        })?;
        if !value.is_object() {
            return Err(Error::Projects(
                "Projects registry is not a JSON object".to_string(),
            ));
        }
        let version = value
            .get("version")
            .cloned()
            .unwrap_or(serde_json::Value::Null);
        if version.as_u64() != Some(u64::from(REGISTRY_VERSION)) {
            return Err(Error::Projects(format!(
                "Unsupported projects registry version: {version}"
            )));
        }
        let state: RegistryState = serde_json::from_value(value).map_err(|error| {
            Error::Projects(format!("Projects registry has an invalid shape: {error}"))
        })?;
        validate_state(&state)?;
        Ok(state)
    }

    fn save(&self, state: &RegistryState) -> Result<()> {
        fs::create_dir_all(&self.data_dir).map_err(|error| Error::Projects(error.to_string()))?;
        let registry = self.data_dir.join(REGISTRY_FILE);
        let temporary = self.data_dir.join(format!(
            ".{REGISTRY_FILE}.tmp-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let body = format!(
            "{}\n",
            serde_json::to_string_pretty(state)
                .map_err(|error| Error::Projects(error.to_string()))?
        );
        {
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&temporary)
                .map_err(|error| Error::Projects(error.to_string()))?;
            file.write_all(body.as_bytes())
                .map_err(|error| Error::Projects(error.to_string()))?;
            file.sync_all()
                .map_err(|error| Error::Projects(error.to_string()))?;
        }
        let renamed = fs::rename(&temporary, &registry);
        if renamed.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        renamed.map_err(|error| Error::Projects(error.to_string()))?;
        sync_dir(&self.data_dir)?;
        Ok(())
    }

    fn with_lock(&self, operation: impl FnOnce() -> Result<()>) -> Result<()> {
        fs::create_dir_all(&self.data_dir).map_err(|error| Error::Projects(error.to_string()))?;
        let lock_path = self.data_dir.join(LOCK_DIR);
        let recovery_path = self.data_dir.join(RECOVERY_DIR);
        let mut deadline = Instant::now() + LOCK_TIMEOUT;
        let mut initialized = false;
        let mut snapshot: Option<LockObservation> = None;
        let owner = loop {
            if self.has_active_recovery(&recovery_path)? {
                deadline = self.wait_for_lock(
                    deadline,
                    &lock_path,
                    &recovery_path,
                    &mut initialized,
                    &mut snapshot,
                )?;
                continue;
            }
            let candidate = create_owner()?;
            match mkdir_exclusive(&lock_path) {
                Ok(()) => {
                    if let Err(error) = write_owner(&lock_path.join(OWNER_FILE), &candidate) {
                        self.release_main_lock(&lock_path, &candidate.token, &recovery_path)?;
                        return Err(error);
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                    if self.recover_stale_lock(&lock_path, &recovery_path)? {
                        continue;
                    }
                    deadline = self.wait_for_lock(
                        deadline,
                        &lock_path,
                        &recovery_path,
                        &mut initialized,
                        &mut snapshot,
                    )?;
                    continue;
                }
                Err(error) => return Err(Error::Projects(error.to_string())),
            }
            let recovery_active = self.has_active_recovery(&recovery_path)?;
            let still_owns = directory_owned_by(&lock_path, &candidate.token)?;
            if recovery_active || !still_owns {
                if still_owns {
                    self.release_main_lock(&lock_path, &candidate.token, &recovery_path)?;
                }
                deadline = self.wait_for_lock(
                    deadline,
                    &lock_path,
                    &recovery_path,
                    &mut initialized,
                    &mut snapshot,
                )?;
                continue;
            }
            break candidate;
        };
        let stop = Arc::new(AtomicBool::new(false));
        let heartbeat_stop = Arc::clone(&stop);
        let heartbeat_path = lock_path.clone();
        let handle = thread::spawn(move || {
            let interval = STALE_LOCK / 3;
            let mut elapsed = Duration::ZERO;
            while !heartbeat_stop.load(Ordering::Relaxed) {
                thread::sleep(Duration::from_millis(20));
                elapsed += Duration::from_millis(20);
                if elapsed >= interval {
                    elapsed = Duration::ZERO;
                    if let Ok(file) = File::open(&heartbeat_path) {
                        let _ = file.set_modified(SystemTime::now());
                    }
                }
            }
        });
        let result = operation();
        stop.store(true, Ordering::Relaxed);
        let _ = handle.join();
        self.release_main_lock(&lock_path, &owner.token, &recovery_path)?;
        result
    }

    fn recover_stale_lock(&self, lock_path: &Path, recovery_path: &Path) -> Result<bool> {
        match lock_path.metadata() {
            Ok(metadata) => {
                if !is_stale(&metadata)? {
                    return Ok(false);
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(true),
            Err(error) => return Err(Error::Projects(error.to_string())),
        }
        let owner = create_owner()?;
        fs::create_dir_all(recovery_path).map_err(|error| Error::Projects(error.to_string()))?;
        let marker = recovery_path.join(&owner.token);
        mkdir_exclusive(&marker).map_err(|error| Error::Projects(error.to_string()))?;
        let wrote = write_owner(&marker.join(OWNER_FILE), &owner);
        if let Err(error) = wrote {
            let _ = fs::remove_dir_all(&marker);
            return Err(error);
        }
        let recovered = self.recover_with_marker(lock_path, &marker, &owner.token);
        release_owned_dir(&marker, &owner.token)?;
        recovered
    }

    fn recover_with_marker(&self, lock_path: &Path, marker: &Path, token: &str) -> Result<bool> {
        match lock_path.metadata() {
            Ok(metadata) => {
                if !is_stale(&metadata)? {
                    return Ok(false);
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(true),
            Err(error) => return Err(Error::Projects(error.to_string())),
        }
        if let Some(owner) = read_owner(lock_path)? {
            if owner_alive(&owner) {
                return Ok(false);
            }
        }
        if !directory_owned_by(marker, token)? {
            return Ok(false);
        }
        let stale = PathBuf::from(format!(
            "{}.stale-{}",
            lock_path.display(),
            uuid::Uuid::new_v4()
        ));
        match fs::rename(lock_path, &stale) {
            Ok(()) => {
                let _ = fs::remove_dir_all(&stale);
                Ok(true)
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(true),
            Err(error) => Err(Error::Projects(error.to_string())),
        }
    }

    fn has_active_recovery(&self, recovery_path: &Path) -> Result<bool> {
        fs::create_dir_all(recovery_path).map_err(|error| Error::Projects(error.to_string()))?;
        let entries =
            fs::read_dir(recovery_path).map_err(|error| Error::Projects(error.to_string()))?;
        for entry in entries {
            let entry = entry.map_err(|error| Error::Projects(error.to_string()))?;
            let marker = entry.path();
            let metadata = match marker.metadata() {
                Ok(metadata) => metadata,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => return Err(Error::Projects(error.to_string())),
            };
            if !is_stale(&metadata)? {
                return Ok(true);
            }
            if let Some(owner) = read_owner(&marker)? {
                if owner_alive(&owner) {
                    return Ok(true);
                }
            }
            let _ = fs::remove_dir_all(&marker);
        }
        let remaining =
            fs::read_dir(recovery_path).map_err(|error| Error::Projects(error.to_string()))?;
        Ok(remaining.count() > 0)
    }

    fn release_main_lock(&self, lock_path: &Path, token: &str, recovery_path: &Path) -> Result<()> {
        let owner = create_owner()?;
        fs::create_dir_all(recovery_path).map_err(|error| Error::Projects(error.to_string()))?;
        let marker = recovery_path.join(&owner.token);
        mkdir_exclusive(&marker).map_err(|error| Error::Projects(error.to_string()))?;
        write_owner(&marker.join(OWNER_FILE), &owner)?;
        if directory_owned_by(lock_path, token)? {
            let _ = fs::remove_dir_all(lock_path);
        }
        release_owned_dir(&marker, &owner.token)?;
        Ok(())
    }

    fn wait_for_lock(
        &self,
        mut deadline: Instant,
        lock_path: &Path,
        recovery_path: &Path,
        initialized: &mut bool,
        snapshot: &mut Option<LockObservation>,
    ) -> Result<Instant> {
        let current = read_observation(lock_path)?;
        if !*initialized {
            *snapshot = current.clone();
            *initialized = true;
        } else if !same_holder(snapshot.as_ref(), current.as_ref()) {
            *snapshot = current;
            deadline = Instant::now() + LOCK_TIMEOUT;
        }
        if Instant::now() >= deadline {
            return Err(Error::Projects(format!(
                "Timed out waiting for projects registry lock at {}. Inspect {} for abandoned recovery markers.",
                lock_path.display(),
                recovery_path.display()
            )));
        }
        thread::sleep(LOCK_RETRY);
        Ok(deadline)
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "source", rename_all = "camelCase")]
pub enum ProjectListEntry {
    #[serde(rename = "registry")]
    Registry {
        id: String,
        name: String,
        #[serde(rename = "rootPath")]
        root_path: String,
        #[serde(rename = "createdAt")]
        created_at: String,
    },
    #[serde(rename = "ghq")]
    Ghq {
        name: String,
        #[serde(rename = "rootPath")]
        root_path: String,
    },
}

pub struct ProjectCatalog {
    pub version: u32,
    pub projects: Vec<ProjectListEntry>,
    pub warnings: Vec<String>,
}

pub fn list_catalog(include_ghq: bool) -> Result<ProjectCatalog> {
    let store = ProjectRegistryStore::default_store()?;
    list_catalog_with(&store, include_ghq)
}

pub fn list_catalog_with(
    store: &ProjectRegistryStore,
    include_ghq: bool,
) -> Result<ProjectCatalog> {
    let registered = store.list()?;
    let mut projects = registered
        .iter()
        .map(|project| ProjectListEntry::Registry {
            id: project.id.clone(),
            name: project.name.clone(),
            root_path: project.root_path.clone(),
            created_at: project.created_at.clone(),
        })
        .collect::<Vec<_>>();
    let mut warnings = Vec::new();
    if include_ghq {
        match discover_ghq() {
            Ok(Some(paths)) => {
                let mut known = registered
                    .iter()
                    .map(|project| project.root_path.clone())
                    .collect::<std::collections::BTreeSet<_>>();
                for path in paths {
                    let Ok(root) = resolve_project_root(Path::new(&path)) else {
                        continue;
                    };
                    let root = root.to_string_lossy().to_string();
                    if !known.insert(root.clone()) {
                        continue;
                    }
                    let name = Path::new(&root)
                        .file_name()
                        .map(|name| name.to_string_lossy().to_string())
                        .unwrap_or_default();
                    projects.push(ProjectListEntry::Ghq {
                        name,
                        root_path: root,
                    });
                }
            }
            Ok(None) => {}
            Err(error) => warnings.push(error.to_string()),
        }
    }
    projects.sort_by(|left, right| {
        entry_name(left)
            .cmp(entry_name(right))
            .then(entry_path(left).cmp(entry_path(right)))
    });
    Ok(ProjectCatalog {
        version: LIST_VERSION,
        projects,
        warnings,
    })
}

fn entry_name(entry: &ProjectListEntry) -> &str {
    match entry {
        ProjectListEntry::Registry { name, .. } | ProjectListEntry::Ghq { name, .. } => name,
    }
}

fn entry_path(entry: &ProjectListEntry) -> &str {
    match entry {
        ProjectListEntry::Registry { root_path, .. } | ProjectListEntry::Ghq { root_path, .. } => {
            root_path
        }
    }
}

pub fn resolve_project_root(input: &Path) -> Result<PathBuf> {
    let resolved = fs::canonicalize(input).map_err(|error| Error::Projects(error.to_string()))?;
    let git_root = git::git_root(&resolved)?;
    fs::canonicalize(git_root).map_err(|error| Error::Projects(error.to_string()))
}

fn discover_ghq() -> Result<Option<Vec<String>>> {
    match process::run_with_timeout(
        "ghq",
        &["list", "--full-path"],
        Duration::from_millis(5_000),
    ) {
        Ok(captured) if captured.code == 0 => Ok(Some(parse_ghq_paths(&captured.stdout))),
        Ok(captured) => {
            let detail = captured.stderr.trim();
            Err(Error::Projects(if detail.is_empty() {
                "Failed to discover ghq repositories".to_string()
            } else {
                format!("Failed to discover ghq repositories: {detail}")
            }))
        }
        Err(Error::Spawn { details, .. }) if details.contains("ENOENT") => Ok(None),
        Err(error) => Err(error),
    }
}

fn parse_ghq_paths(stdout: &str) -> Vec<String> {
    let mut paths = stdout
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(|line| {
            fs::canonicalize(line)
                .unwrap_or_else(|_| PathBuf::from(line))
                .to_string_lossy()
                .to_string()
        })
        .collect::<Vec<_>>();
    paths.sort();
    paths.dedup();
    paths
}

pub fn default_data_dir() -> Result<PathBuf> {
    let home = std::env::var("HOME").map_err(|_| Error::Projects("HOME is not set".to_string()))?;
    let base = match std::env::var("XDG_STATE_HOME") {
        Ok(state) if Path::new(&state).is_absolute() => PathBuf::from(state),
        _ => PathBuf::from(home).join(".local").join("state"),
    };
    Ok(base.join("phantom"))
}

fn empty_registry() -> RegistryState {
    RegistryState {
        version: REGISTRY_VERSION,
        projects: Vec::new(),
    }
}

fn normalize_root(path: &Path) -> Result<String> {
    if !path.is_absolute() {
        return Err(Error::Projects(
            "Project root path must be absolute".to_string(),
        ));
    }
    let normalized = fs::canonicalize(path).unwrap_or_else(|_| paths_normalize(path));
    if normalized.file_name().is_none() {
        return Err(Error::Projects(
            "Project root path must have a name".to_string(),
        ));
    }
    Ok(normalized.to_string_lossy().to_string())
}

fn paths_normalize(path: &Path) -> PathBuf {
    crate::paths::normalize(path)
}

fn validate_state(state: &RegistryState) -> Result<()> {
    if state.version != REGISTRY_VERSION {
        return Err(Error::Projects(format!(
            "Unsupported projects registry version: {}",
            state.version
        )));
    }
    let mut ids = std::collections::BTreeSet::new();
    let mut roots = std::collections::BTreeSet::new();
    for project in &state.projects {
        if !is_project_id(&project.id) {
            return Err(Error::Projects(format!(
                "Projects registry has an invalid shape at id: {}",
                project.id
            )));
        }
        if project.name.is_empty()
            || Path::new(&project.root_path)
                .file_name()
                .and_then(|name| name.to_str())
                != Some(project.name.as_str())
        {
            return Err(Error::Projects(
                "Projects registry has an invalid shape at name: Expected name to match the root path basename".to_string(),
            ));
        }
        if !Path::new(&project.root_path).is_absolute() {
            return Err(Error::Projects(
                "Projects registry has an invalid shape at rootPath: Expected an absolute path"
                    .to_string(),
            ));
        }
        if !is_iso(&project.created_at) {
            return Err(Error::Projects("Projects registry has an invalid shape at createdAt: Expected a valid ISO timestamp".to_string()));
        }
        if !ids.insert(project.id.clone()) {
            return Err(Error::Projects(
                "Projects registry has an invalid shape at id: Duplicate project id".to_string(),
            ));
        }
        if !roots.insert(project.root_path.clone()) {
            return Err(Error::Projects(
                "Projects registry has an invalid shape at rootPath: Duplicate project root path"
                    .to_string(),
            ));
        }
    }
    Ok(())
}

fn is_project_id(id: &str) -> bool {
    let Some(rest) = id.strip_prefix("proj_") else {
        return false;
    };
    let parts = rest.split('-').collect::<Vec<_>>();
    parts.len() == 5
        && parts[0].len() == 8
        && parts[1].len() == 4
        && parts[2].len() == 4
        && parts[3].len() == 4
        && parts[4].len() == 12
        && parts
            .iter()
            .all(|part| part.chars().all(|char| char.is_ascii_hexdigit()))
        && matches!(parts[2].chars().next(), Some('1'..='8'))
        && matches!(
            parts[3].chars().next(),
            Some('8' | '9' | 'a' | 'b' | 'A' | 'B')
        )
}

fn is_iso(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 24
        && &bytes[4..5] == b"-"
        && &bytes[7..8] == b"-"
        && &bytes[10..11] == b"T"
        && &bytes[13..14] == b":"
        && &bytes[16..17] == b":"
        && &bytes[19..20] == b"."
        && bytes[23] == b'Z'
}

fn iso_now() -> String {
    let now = chrono::Utc::now();
    format!("{}Z", now.format("%Y-%m-%dT%H:%M:%S%.3f"))
}

fn create_owner() -> Result<LockOwner> {
    Ok(LockOwner {
        token: uuid::Uuid::new_v4().to_string(),
        pid: std::process::id(),
        created_at: iso_now(),
        process_identity: process_identity(std::process::id()),
    })
}

fn write_owner(path: &Path, owner: &LockOwner) -> Result<()> {
    let body = format!(
        "{}\n",
        serde_json::to_string(owner).map_err(|error| Error::Projects(error.to_string()))?
    );
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
        .map_err(|error| Error::Projects(error.to_string()))?;
    file.write_all(body.as_bytes())
        .map_err(|error| Error::Projects(error.to_string()))?;
    Ok(())
}

fn read_owner(lock_path: &Path) -> Result<Option<LockOwner>> {
    let path = if lock_path.ends_with(OWNER_FILE) {
        lock_path.to_path_buf()
    } else {
        lock_path.join(OWNER_FILE)
    };
    let content = match fs::read_to_string(path) {
        Ok(content) => content,
        Err(_) => return Ok(None),
    };
    Ok(serde_json::from_str(&content).ok())
}

fn directory_owned_by(directory: &Path, token: &str) -> Result<bool> {
    Ok(read_owner(directory)?.is_some_and(|owner| owner.token == token))
}

fn release_owned_dir(directory: &Path, token: &str) -> Result<()> {
    if directory_owned_by(directory, token)? {
        let _ = fs::remove_dir_all(directory);
    }
    Ok(())
}

fn read_observation(lock_path: &Path) -> Result<Option<LockObservation>> {
    if !lock_path.exists() {
        return Ok(None);
    }
    let owner = read_owner(lock_path)?;
    Ok(Some(LockObservation {
        token: owner.map(|owner| owner.token),
    }))
}

fn same_holder(left: Option<&LockObservation>, right: Option<&LockObservation>) -> bool {
    match (left, right) {
        (None, None) => true,
        (Some(left), Some(right)) => left.token == right.token,
        _ => false,
    }
}

fn is_stale(metadata: &std::fs::Metadata) -> Result<bool> {
    let modified = metadata
        .modified()
        .map_err(|error| Error::Projects(error.to_string()))?;
    Ok(modified.elapsed().unwrap_or(Duration::ZERO) > STALE_LOCK)
}

fn owner_alive(owner: &LockOwner) -> bool {
    if !process_alive(owner.pid) {
        return false;
    }
    match &owner.process_identity {
        None => true,
        Some(expected) => match process_identity(owner.pid) {
            None => true,
            Some(actual) => actual == *expected,
        },
    }
}

fn process_alive(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    match process::raw("kill", &["-0", &pid.to_string()], None) {
        Ok(captured) if captured.code == 0 => true,
        Ok(captured) => {
            let stderr = captured.stderr.to_ascii_lowercase();
            stderr.contains("operation not permitted") || stderr.contains("not permitted")
        }
        Err(_) => false,
    }
}

fn process_identity(pid: u32) -> Option<String> {
    if pid == 0 {
        return None;
    }
    if let Ok(stat) = fs::read_to_string(format!("/proc/{pid}/stat")) {
        if let Some(command_end) = stat.rfind(')') {
            let fields = stat[command_end + 1..]
                .split_whitespace()
                .collect::<Vec<_>>();
            if let Some(start) = fields.get(19) {
                return Some(format!("linux:{start}"));
            }
        }
    }
    let output =
        process::capture("ps", &["-o", "lstart=", "-p", &pid.to_string()], None, true).ok()?;
    let start = output.stdout.trim();
    if start.is_empty() {
        None
    } else {
        Some(format!("linux:{start}"))
    }
}

fn mkdir_exclusive(path: &Path) -> std::io::Result<()> {
    fs::DirBuilder::new().mode(0o700).create(path)
}

fn sync_dir(path: &Path) -> Result<()> {
    let file = File::open(path).map_err(|error| Error::Projects(error.to_string()))?;
    match file.sync_all() {
        Ok(()) => Ok(()),
        Err(error) if matches!(error.raw_os_error(), Some(22) | Some(95)) => Ok(()),
        Err(error) => Err(Error::Projects(error.to_string())),
    }
}

use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_add_is_idempotent_under_the_lock() {
        let dir = std::env::temp_dir().join(format!("phantom-registry-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).expect("temp");
        let root = dir.join("repo");
        fs::create_dir_all(&root).expect("repo");
        let store = ProjectRegistryStore::new(dir.join("state"));
        let (first, added) = store.add(&root).expect("add");
        assert!(added);
        let (second, added_again) = store.add(&root).expect("add again");
        assert!(!added_again);
        assert_eq!(first, second);
        let removed = store.remove(&first.id).expect("remove");
        assert_eq!(
            removed.as_ref().map(|project| project.id.as_str()),
            Some(first.id.as_str())
        );
        assert!(store.list().expect("list").is_empty());
        let _ = fs::remove_dir_all(&dir);
    }
}
