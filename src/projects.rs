use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Component, Path, PathBuf};
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

type NowFn = Arc<dyn Fn() -> u64 + Send + Sync>;
type DelayFn = Arc<dyn Fn(u64) + Send + Sync>;
type HookFn = Arc<dyn Fn() + Send + Sync>;

pub struct ProjectRegistryStore {
    data_dir: PathBuf,
    lock_timeout_ms: u64,
    lock_retry_ms: u64,
    now_ms: NowFn,
    delay: DelayFn,
    on_lock_acquired: Option<HookFn>,
}

impl ProjectRegistryStore {
    pub fn new(data_dir: PathBuf) -> Self {
        let started = Instant::now();
        Self {
            data_dir,
            lock_timeout_ms: u64::try_from(LOCK_TIMEOUT.as_millis()).unwrap_or(5_000),
            lock_retry_ms: u64::try_from(LOCK_RETRY.as_millis()).unwrap_or(20),
            now_ms: Arc::new(move || {
                u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX)
            }),
            delay: Arc::new(|milliseconds| thread::sleep(Duration::from_millis(milliseconds))),
            on_lock_acquired: None,
        }
    }

    #[cfg(test)]
    fn controlled(
        data_dir: PathBuf,
        lock_timeout_ms: u64,
        lock_retry_ms: u64,
        now_ms: NowFn,
        delay: DelayFn,
        on_lock_acquired: Option<HookFn>,
    ) -> Self {
        Self {
            data_dir,
            lock_timeout_ms,
            lock_retry_ms,
            now_ms,
            delay,
            on_lock_acquired,
        }
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
        let mut deadline = (self.now_ms)().saturating_add(self.lock_timeout_ms);
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
            if let Some(hook) = &self.on_lock_acquired {
                hook();
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
        mut deadline: u64,
        lock_path: &Path,
        recovery_path: &Path,
        initialized: &mut bool,
        snapshot: &mut Option<LockObservation>,
    ) -> Result<u64> {
        let current = read_observation(lock_path)?;
        let now = (self.now_ms)();
        if !*initialized {
            *snapshot = current.clone();
            *initialized = true;
        } else if !same_holder(snapshot.as_ref(), current.as_ref()) {
            *snapshot = current;
            deadline = now.saturating_add(self.lock_timeout_ms);
        }
        if now >= deadline {
            return Err(Error::Projects(format!(
                "Timed out waiting for projects registry lock at {}. Inspect {} for abandoned recovery markers.",
                lock_path.display(),
                recovery_path.display()
            )));
        }
        (self.delay)(self.lock_retry_ms);
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
        /// `host/owner/repo` when the checkout or its `origin` URL identifies one.
        #[serde(rename = "canonicalName")]
        canonical_name: String,
        /// Every name `--project` may match. The first is `canonical_name`.
        #[serde(skip)]
        match_names: Vec<String>,
        #[serde(rename = "rootPath")]
        root_path: String,
        #[serde(rename = "createdAt")]
        created_at: String,
    },
    #[serde(rename = "ghq")]
    Ghq {
        name: String,
        #[serde(rename = "canonicalName")]
        canonical_name: String,
        #[serde(skip)]
        match_names: Vec<String>,
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
    let mut warnings = Vec::new();
    let clone_root = clone_root_for_names(include_ghq, &mut warnings);
    let mut projects = registered
        .iter()
        .map(|project| registry_entry(project, clone_root.as_deref()))
        .collect::<Vec<_>>();
    if include_ghq {
        let mut known = registered
            .iter()
            .map(|project| project.root_path.clone())
            .collect::<std::collections::BTreeSet<_>>();
        for path in discover_repository_paths(clone_root.as_deref(), &mut warnings) {
            let Ok(root) = resolve_project_root(Path::new(&path)) else {
                continue;
            };
            let root = root.to_string_lossy().to_string();
            if !known.insert(root.clone()) {
                continue;
            }
            projects.push(ghq_entry(&root, clone_root.as_deref()));
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

fn clone_root_for_names(include_ghq: bool, warnings: &mut Vec<String>) -> Option<PathBuf> {
    match crate::repository::resolve_repository_root_quiet() {
        Ok((root, root_warnings)) => {
            if include_ghq {
                for warning in root_warnings {
                    eprintln!("Warning: {warning}");
                }
            }
            Some(root)
        }
        Err(error) => {
            if include_ghq {
                warnings.push(format!(
                    "Failed to discover repositories under the clone root: {error}"
                ));
            }
            None
        }
    }
}

fn registry_entry(project: &ProjectRecord, clone_root: Option<&Path>) -> ProjectListEntry {
    let names = names_for_root(Path::new(&project.root_path), clone_root);
    let canonical_name = names.first().cloned().unwrap_or_default();
    ProjectListEntry::Registry {
        id: project.id.clone(),
        name: project.name.clone(),
        canonical_name,
        match_names: names,
        root_path: project.root_path.clone(),
        created_at: project.created_at.clone(),
    }
}

fn ghq_entry(root: &str, clone_root: Option<&Path>) -> ProjectListEntry {
    let names = names_for_root(Path::new(root), clone_root);
    let canonical_name = names.first().cloned().unwrap_or_default();
    let name = Path::new(root)
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_default();
    ProjectListEntry::Ghq {
        name,
        canonical_name,
        match_names: names,
        root_path: root.to_string(),
    }
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

/// Repository selected by `--project <ref>`.
///
/// A ref that starts with `/`, `.`, or `~` is a directory anywhere inside a
/// repository, including a linked worktree, and resolves to the main checkout.
/// Any other ref matches the canonical `host/owner/repo` name of a registered
/// or discovered project, or an unambiguous path-segment suffix (`owner/repo`,
/// `repo`).
pub fn resolve_project_ref(reference: &str) -> Result<PathBuf> {
    let reference = reference.trim();
    if reference.is_empty() {
        return Err(Error::validation(
            "Option '--project <value>' requires a project name or path".to_string(),
        ));
    }
    if is_path_reference(reference) {
        let cwd = std::env::current_dir().map_err(|error| Error::msg(error.to_string()))?;
        let home = home_dir()?;
        return resolve_directory_reference(reference, &cwd, &home);
    }
    let include_ghq = preferences_include_discovery()?;
    let catalog = list_catalog(include_ghq)?;
    for warning in &catalog.warnings {
        eprintln!("Warning: {warning}");
    }
    select_named_project(reference, &candidates(&catalog))
}

fn preferences_include_discovery() -> Result<bool> {
    Ok(crate::preferences::load_preferences()?.ghq_discovery != Some(false))
}

fn home_dir() -> Result<PathBuf> {
    match std::env::var_os("HOME") {
        Some(value) if !value.is_empty() => Ok(PathBuf::from(value)),
        _ => Err(Error::msg("HOME is not set".to_string())),
    }
}

fn is_path_reference(reference: &str) -> bool {
    reference.starts_with('/') || reference.starts_with('.') || reference.starts_with('~')
}

fn resolve_directory_reference(reference: &str, cwd: &Path, home: &Path) -> Result<PathBuf> {
    let expanded = expand_tilde(reference, home)?;
    let path = if expanded.is_absolute() {
        expanded
    } else {
        cwd.join(expanded)
    };
    let metadata = match fs::metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err(Error::ProjectNotFound(reference.to_string()));
        }
        Err(error) => return Err(Error::msg(error.to_string())),
    };
    if !metadata.is_dir() {
        return Err(Error::validation(format!(
            "Project path '{reference}' is not a directory"
        )));
    }
    let root = git::git_root(&path)?;
    Ok(fs::canonicalize(&root).unwrap_or(root))
}

fn expand_tilde(reference: &str, home: &Path) -> Result<PathBuf> {
    if reference == "~" {
        return Ok(home.to_path_buf());
    }
    if let Some(rest) = reference.strip_prefix("~/") {
        return Ok(home.join(rest));
    }
    if reference.starts_with('~') {
        return Err(Error::validation(format!(
            "Project path '{reference}' must be an absolute path, a relative path starting with ., or start with ~/."
        )));
    }
    Ok(PathBuf::from(reference))
}

struct ProjectCandidate {
    root: PathBuf,
    canonical_name: String,
    names: Vec<String>,
}

fn candidates(catalog: &ProjectCatalog) -> Vec<ProjectCandidate> {
    let mut seen = std::collections::BTreeSet::new();
    let mut projects = Vec::new();
    for entry in &catalog.projects {
        let stored = PathBuf::from(entry_path(entry));
        let root = fs::canonicalize(&stored).unwrap_or(stored);
        let key = root.to_string_lossy().to_string();
        if !seen.insert(key) {
            continue;
        }
        let names = entry_match_names(entry);
        projects.push(ProjectCandidate {
            root,
            canonical_name: entry_canonical_name(entry).to_string(),
            names,
        });
    }
    projects
}

fn select_named_project(reference: &str, projects: &[ProjectCandidate]) -> Result<PathBuf> {
    let mut matches = projects
        .iter()
        .filter(|project| {
            project
                .names
                .iter()
                .any(|name| name_matches(reference, name))
        })
        .collect::<Vec<_>>();
    matches.sort_by(|left, right| {
        left.canonical_name
            .cmp(&right.canonical_name)
            .then(left.root.cmp(&right.root))
    });
    match matches.as_slice() {
        [] => Err(Error::ProjectNotFound(reference.to_string())),
        [project] => Ok(project.root.clone()),
        many => Err(Error::validation(ambiguous_project_message(
            reference, many,
        ))),
    }
}

fn ambiguous_project_message(reference: &str, matches: &[&ProjectCandidate]) -> String {
    let mut lines = vec![format!("Project '{reference}' matches multiple projects:")];
    for project in matches {
        lines.push(format!(
            "  {} ({})",
            project.canonical_name,
            project.root.display()
        ));
    }
    lines.join("\n")
}

fn name_matches(query: &str, canonical: &str) -> bool {
    let Some(query_segments) = name_segments(query) else {
        return false;
    };
    let Some(canonical_segments) = name_segments(canonical) else {
        return false;
    };
    if query_segments.len() > canonical_segments.len() {
        return false;
    }
    canonical_segments[canonical_segments.len() - query_segments.len()..] == query_segments[..]
}

fn name_segments(value: &str) -> Option<Vec<&str>> {
    if value.is_empty() {
        return None;
    }
    let segments = value.split('/').collect::<Vec<_>>();
    if segments.iter().any(|segment| segment.is_empty()) {
        return None;
    }
    Some(segments)
}

fn entry_canonical_name(entry: &ProjectListEntry) -> &str {
    match entry {
        ProjectListEntry::Registry { canonical_name, .. }
        | ProjectListEntry::Ghq { canonical_name, .. } => canonical_name,
    }
}

fn entry_match_names(entry: &ProjectListEntry) -> Vec<String> {
    match entry {
        ProjectListEntry::Registry { match_names, .. }
        | ProjectListEntry::Ghq { match_names, .. } => match_names.clone(),
    }
}

/// Names `--project` matches for this checkout.
///
/// The first name is canonical: the `origin` URL when it parses as
/// `host/owner/repo`, otherwise the `<root>/<host>/<owner>/<repo>` location,
/// otherwise the directory name. A location that differs from the remote is
/// kept as an additional name.
fn names_for_root(root: &Path, clone_root: Option<&Path>) -> Vec<String> {
    let mut names = Vec::new();
    if let Some(remote) = crate::repository::canonical_name_from_origin(root) {
        names.push(remote);
    }
    if let Some(located) = name_from_location(root, clone_root) {
        if !names.iter().any(|name| name == &located) {
            names.push(located);
        }
    }
    if names.is_empty() {
        if let Some(name) = root
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .filter(|name| !name.is_empty())
        {
            names.push(name);
        }
    }
    names
}

fn name_from_location(root: &Path, clone_root: Option<&Path>) -> Option<String> {
    let clone_root = clone_root?;
    let root = fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
    let clone_root = fs::canonicalize(clone_root).unwrap_or_else(|_| clone_root.to_path_buf());
    let relative = root.strip_prefix(&clone_root).ok()?;
    let segments = relative
        .components()
        .map(|component| match component {
            Component::Normal(part) => Some(part.to_string_lossy().to_string()),
            _ => None,
        })
        .collect::<Option<Vec<_>>>()?;
    if segments.len() != 3 {
        return None;
    }
    let host = segments[0].to_ascii_lowercase();
    Some(format!("{host}/{}/{}", segments[1], segments[2]))
}

fn discover_repository_paths(clone_root: Option<&Path>, warnings: &mut Vec<String>) -> Vec<String> {
    let mut paths = Vec::new();
    if let Some(root) = clone_root {
        paths.extend(crate::repository::scan_repository_root(root));
    }
    match discover_ghq() {
        Ok(Some(listed)) => paths.extend(listed),
        Ok(None) => {}
        Err(error) => warnings.push(error.to_string()),
    }
    paths
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
    Ok(resolve_data_dir(
        &home,
        std::env::var("XDG_STATE_HOME").ok().as_deref(),
    ))
}

fn resolve_data_dir(home: &str, xdg_state_home: Option<&str>) -> PathBuf {
    let base = match xdg_state_home {
        Some(state) if Path::new(state).is_absolute() => PathBuf::from(state),
        _ => PathBuf::from(home).join(".local").join("state"),
    };
    base.join("ptm")
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
    fn default_data_dir_uses_xdg_state_home_ptm() {
        assert_eq!(
            resolve_data_dir("/home/user", Some("/var/state")),
            PathBuf::from("/var/state/ptm")
        );
    }

    #[test]
    fn default_data_dir_falls_back_to_home_local_state_ptm() {
        let fallback = PathBuf::from("/home/user/.local/state/ptm");
        assert_eq!(resolve_data_dir("/home/user", None), fallback);
        assert_eq!(resolve_data_dir("/home/user", Some("")), fallback);
        assert_eq!(
            resolve_data_dir("/home/user", Some("relative/state")),
            fallback
        );
        assert_eq!(
            resolve_data_dir("/home/user", Some("relative/phantom")),
            fallback
        );
    }

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

    #[test]
    fn does_not_time_out_while_queued_behind_live_holders() {
        let dir = std::env::temp_dir().join(format!("phantom-queue-{}", uuid::Uuid::new_v4()));
        let state = dir.join("state");
        fs::create_dir_all(&state).expect("state");
        let clock = Arc::new(std::sync::Mutex::new(0_u64));
        let stores = (0..8)
            .map(|_| {
                let now_clock = Arc::clone(&clock);
                let hook_clock = Arc::clone(&clock);
                ProjectRegistryStore::controlled(
                    state.clone(),
                    500,
                    1,
                    Arc::new(move || {
                        *now_clock
                            .lock()
                            .unwrap_or_else(std::sync::PoisonError::into_inner)
                    }),
                    Arc::new(|_| thread::yield_now()),
                    Some(Arc::new(move || {
                        *hook_clock
                            .lock()
                            .unwrap_or_else(std::sync::PoisonError::into_inner) += 100;
                        thread::yield_now();
                    })),
                )
            })
            .collect::<Vec<_>>();
        let handles = stores
            .into_iter()
            .enumerate()
            .map(|(index, store)| {
                thread::spawn(move || {
                    store
                        .add(Path::new(&format!("/work/project-{index}")))
                        .expect("add");
                })
            })
            .collect::<Vec<_>>();
        for handle in handles {
            handle.join().expect("join");
        }
        let listed = ProjectRegistryStore::new(state).list().expect("list");
        assert_eq!(listed.len(), 8);
        let elapsed = *clock
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        assert!(elapsed >= 800, "clock advanced {elapsed}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn resets_the_deadline_when_the_lock_holder_changes() {
        let dir = std::env::temp_dir().join(format!("phantom-holder-{}", uuid::Uuid::new_v4()));
        let state = dir.join("state");
        let lock_path = state.join("projects.lock");
        fs::create_dir_all(&lock_path).expect("lock");
        let owner_path = lock_path.join("owner.json");
        let time = Arc::new(std::sync::Mutex::new(0_u64));
        let stage = Arc::new(std::sync::Mutex::new(0_u8));
        let timeout = 100_u64;
        let now_time = Arc::clone(&time);
        let delay_time = Arc::clone(&time);
        let delay_stage = Arc::clone(&stage);
        let delay_owner = owner_path.clone();
        let delay_lock = lock_path.clone();
        let store = ProjectRegistryStore::controlled(
            state.clone(),
            timeout,
            10,
            Arc::new(move || {
                *now_time
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
            }),
            Arc::new(move |milliseconds| {
                let mut stage = delay_stage
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                let mut time = delay_time
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                if *stage == 0 {
                    *time += milliseconds;
                    let owner = serde_json::json!({
                        "token": "other-holder",
                        "pid": std::process::id(),
                        "createdAt": "2026-01-01T00:00:00.000Z",
                        "processIdentity": null,
                    });
                    fs::write(&delay_owner, format!("{owner}\n")).expect("owner");
                    *stage = 1;
                } else if *stage == 1 {
                    *time = timeout + 50;
                    let _ = fs::remove_file(&delay_owner);
                    *stage = 2;
                } else if *stage == 2 {
                    *time += milliseconds;
                    let _ = fs::remove_dir_all(&delay_lock);
                    *stage = 3;
                } else {
                    *time += milliseconds;
                }
            }),
            None,
        );
        let (_project, added) = store.add(Path::new("/work/project")).expect("add");
        assert!(added);
        assert_eq!(store.list().expect("list").len(), 1);
        let elapsed = *time
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        assert!(elapsed > timeout, "elapsed {elapsed}");
        let _ = fs::remove_dir_all(&dir);
    }

    fn candidate(root: &str, canonical: &str, names: &[&str]) -> ProjectCandidate {
        ProjectCandidate {
            root: PathBuf::from(root),
            canonical_name: canonical.to_string(),
            names: names.iter().copied().map(str::to_string).collect(),
        }
    }

    #[test]
    fn name_suffixes_match_one_project_and_reject_partial_segments() {
        let projects = [candidate(
            "/src/github.com/acme/widget",
            "github.com/acme/widget",
            &["github.com/acme/widget"],
        )];
        assert_eq!(
            select_named_project("github.com/acme/widget", &projects)
                .expect("full")
                .as_os_str(),
            "/src/github.com/acme/widget"
        );
        assert_eq!(
            select_named_project("acme/widget", &projects)
                .expect("owner/repo")
                .as_os_str(),
            "/src/github.com/acme/widget"
        );
        assert_eq!(
            select_named_project("widget", &projects)
                .expect("repo")
                .as_os_str(),
            "/src/github.com/acme/widget"
        );
        assert!(matches!(
            select_named_project("acme", &projects),
            Err(Error::ProjectNotFound(_))
        ));
        assert!(matches!(
            select_named_project("idget", &projects),
            Err(Error::ProjectNotFound(_))
        ));
        assert!(matches!(
            select_named_project("github.com/acme", &projects),
            Err(Error::ProjectNotFound(_))
        ));
        assert!(matches!(
            select_named_project("com/acme/widget", &projects),
            Err(Error::ProjectNotFound(_))
        ));
    }

    #[test]
    fn ambiguous_names_list_every_candidate() {
        let projects = [
            candidate(
                "/src/github.com/other/widget",
                "github.com/other/widget",
                &["github.com/other/widget"],
            ),
            candidate(
                "/src/github.com/acme/widget",
                "github.com/acme/widget",
                &["github.com/acme/widget"],
            ),
        ];
        let error = select_named_project("widget", &projects).expect_err("ambiguous");
        assert!(matches!(error, Error::Validation(_)));
        assert_eq!(error.exit_code(), crate::error::VALIDATION);
        let message = error.to_string();
        assert!(message.starts_with("Project 'widget' matches multiple projects:\n"));
        let acme = message.find("github.com/acme/widget").expect("acme");
        let other = message.find("github.com/other/widget").expect("other");
        assert!(acme < other, "{message}");
        assert!(message.contains("/src/github.com/acme/widget"), "{message}");
        assert!(
            message.contains("/src/github.com/other/widget"),
            "{message}"
        );
        assert_eq!(
            select_named_project("acme/widget", &projects)
                .expect("unique suffix")
                .as_os_str(),
            "/src/github.com/acme/widget"
        );
    }

    #[test]
    fn remote_and_location_names_both_match_the_same_checkout() {
        let dir = std::env::temp_dir().join(format!("phantom-names-{}", uuid::Uuid::new_v4()));
        let clone_root = dir.join("clones");
        let repo = clone_root.join("github.com/acme/placed");
        fs::create_dir_all(&repo).expect("repo");
        git_ok(&repo, &["init", "-b", "main"]);
        git_ok(
            &repo,
            &[
                "remote",
                "add",
                "origin",
                "https://gitlab.com/other/renamed.git",
            ],
        );
        let names = names_for_root(&repo, Some(&clone_root));
        assert_eq!(names[0], "gitlab.com/other/renamed");
        assert!(names.iter().any(|name| name == "github.com/acme/placed"));
        let canonical = fs::canonicalize(&repo).expect("canonical");
        let projects = [ProjectCandidate {
            root: canonical.clone(),
            canonical_name: names[0].clone(),
            names: names.clone(),
        }];
        assert_eq!(
            select_named_project("other/renamed", &projects).expect("remote"),
            canonical
        );
        assert_eq!(
            select_named_project("acme/placed", &projects).expect("location"),
            canonical
        );
        assert_eq!(
            select_named_project("placed", &projects).expect("location suffix"),
            canonical
        );
        let bare = dir.join("loose");
        fs::create_dir_all(&bare).expect("loose");
        assert_eq!(
            names_for_root(&bare, Some(&clone_root)),
            vec!["loose".to_string()]
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn directory_references_resolve_to_the_main_checkout() {
        let dir = std::env::temp_dir().join(format!("phantom-path-ref-{}", uuid::Uuid::new_v4()));
        let home = dir.join("home");
        let repo = home.join("repo");
        fs::create_dir_all(&repo).expect("repo");
        git_ok(&repo, &["init", "-b", "main"]);
        git_ok(&repo, &["config", "user.email", "phantom-rust@example.com"]);
        git_ok(&repo, &["config", "user.name", "Phantom Rust"]);
        fs::write(repo.join("README.md"), "hi\n").expect("readme");
        git_ok(&repo, &["add", "README.md"]);
        git_ok(&repo, &["commit", "-m", "initial"]);
        let worktree = repo.join(".git/phantom/worktrees/feature");
        git_ok(
            &repo,
            &[
                "worktree",
                "add",
                "-b",
                "feature",
                worktree.to_str().expect("worktree"),
                "HEAD",
            ],
        );
        let nested = worktree.join("nested");
        fs::create_dir_all(&nested).expect("nested");
        let main = fs::canonicalize(&repo).expect("main");
        assert_eq!(
            resolve_directory_reference(repo.to_str().expect("abs"), &dir, &home).expect("abs"),
            main
        );
        assert_eq!(
            resolve_directory_reference("./repo", &home, &home).expect("relative"),
            main
        );
        assert_eq!(
            resolve_directory_reference("~/repo", &dir, &home).expect("tilde"),
            main
        );
        assert_eq!(
            resolve_directory_reference(nested.to_str().expect("nested"), &dir, &home)
                .expect("inside worktree"),
            main
        );
        let missing = resolve_directory_reference("/no/such/ptm-project", &dir, &home);
        assert!(matches!(missing, Err(Error::ProjectNotFound(_))));
        let file = resolve_directory_reference(
            repo.join("README.md").to_str().expect("file"),
            &dir,
            &home,
        );
        assert!(matches!(file, Err(Error::Validation(_))));
        assert!(file
            .expect_err("file")
            .to_string()
            .contains("not a directory"));
        let outside = resolve_directory_reference(home.to_str().expect("home"), &dir, &home);
        assert!(matches!(outside, Err(Error::NotARepository)));
        let other = expand_tilde("~other/repo", &home);
        assert!(matches!(other, Err(Error::Validation(_))));
        let _ = fs::remove_dir_all(&dir);
    }

    fn git_ok(cwd: &Path, args: &[&str]) {
        let output = std::process::Command::new("git")
            .args(args)
            .current_dir(cwd)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_SYSTEM", "/dev/null")
            .output()
            .expect("git");
        assert!(
            output.status.success(),
            "git {} failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&output.stderr)
        );
    }
}
