use std::fs;
use std::path::{Component, Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};
use crate::git;
use crate::process;

const REGISTRY_FILE: &str = "projects.json";
const REGISTRY_VERSION: u32 = 1;
const LIST_VERSION: u32 = 2;

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
        self.ensure_records()?;
        if let Some(existing) = self
            .list()?
            .into_iter()
            .find(|project| project.root_path == normalized)
        {
            return Ok((existing, false));
        }
        let project = ProjectRecord {
            id: format!("proj_{}", uuid::Uuid::new_v4()),
            name: Path::new(&normalized)
                .file_name()
                .map(|name| name.to_string_lossy().to_string())
                .unwrap_or_default(),
            root_path: normalized,
            created_at: iso_now(),
        };
        save_project(&self.data_dir.join("repos"), &project)?;
        Ok((project, true))
    }

    pub fn remove(&self, id: &str) -> Result<Option<ProjectRecord>> {
        self.ensure_records()?;
        let records = self.read_individual()?;
        let Some(project) = records.iter().find(|project| project.id == id).cloned() else {
            return Ok(None);
        };
        // Remove concurrent duplicate registrations too, so a removed root does
        // not reappear through the next oldest record.
        for record in records
            .iter()
            .filter(|record| record.root_path == project.root_path)
        {
            match fs::remove_file(
                self.data_dir
                    .join("repos")
                    .join(format!("{}.json", record.id)),
            ) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(Error::Projects(error.to_string())),
            }
        }
        Ok(Some(project))
    }

    fn ensure_records(&self) -> Result<()> {
        self.ensure_records_with(|| {})
    }

    fn ensure_records_with(&self, before_publish: impl FnOnce()) -> Result<()> {
        let dir = self.data_dir.join("repos");
        let legacy = self.data_dir.join(REGISTRY_FILE);
        if legacy.exists() {
            crate::atomic::import_directory(&dir, &legacy, |staging| {
                for project in self.load_legacy()?.unwrap_or_else(empty_registry).projects {
                    save_project(staging, &project)?;
                }
                before_publish();
                Ok(())
            })
        } else {
            fs::create_dir_all(dir).map_err(|error| Error::Projects(error.to_string()))
        }
    }

    fn read_individual(&self) -> Result<Vec<ProjectRecord>> {
        let mut records = Vec::new();
        for entry in fs::read_dir(self.data_dir.join("repos"))
            .map_err(|error| Error::Projects(error.to_string()))?
        {
            let path = entry
                .map_err(|error| Error::Projects(error.to_string()))?
                .path();
            if path.extension().is_none_or(|ext| ext != "json") {
                continue;
            }
            let record: ProjectRecord = serde_json::from_slice(
                &fs::read(&path).map_err(|error| Error::Projects(error.to_string()))?,
            )
            .map_err(|error| {
                Error::Projects(format!("Projects registry contains invalid JSON: {error}"))
            })?;
            validate_state(&RegistryState {
                version: REGISTRY_VERSION,
                projects: vec![record.clone()],
            })?;
            if path.file_stem().and_then(|stem| stem.to_str()) != Some(&record.id) {
                return Err(Error::Projects(
                    "Project id does not match its filename".into(),
                ));
            }
            records.push(record);
        }
        Ok(records)
    }

    fn load(&self) -> Result<RegistryState> {
        self.load_with(|| {})
    }

    fn load_with(&self, before_legacy: impl FnOnce()) -> Result<RegistryState> {
        if !crate::atomic::import_complete(&self.data_dir.join("repos")) {
            before_legacy();
            if let Some(state) = self.load_legacy()? {
                return Ok(state);
            }
            // A concurrent importer publishes repos before archiving the
            // legacy file. Recheck it before treating NotFound as empty.
            if !self.data_dir.join("repos").exists() {
                return Ok(empty_registry());
            }
        }
        let mut records = self.read_individual()?;
        records.sort_by(|a, b| (&a.created_at, &a.id).cmp(&(&b.created_at, &b.id)));
        let mut roots = std::collections::HashSet::new();
        records.retain(|record| roots.insert(record.root_path.clone()));
        Ok(RegistryState {
            version: REGISTRY_VERSION,
            projects: records,
        })
    }

    fn load_legacy(&self) -> Result<Option<RegistryState>> {
        let path = self.data_dir.join(REGISTRY_FILE);
        let content = match fs::read_to_string(&path) {
            Ok(content) => content,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(None);
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
        Ok(Some(state))
    }
}

fn save_project(dir: &Path, project: &ProjectRecord) -> Result<()> {
    let body =
        serde_json::to_vec_pretty(project).map_err(|error| Error::Projects(error.to_string()))?;
    crate::atomic::write(&dir.join(format!("{}.json", project.id)), &body)
        .map_err(|error| Error::Projects(error.to_string()))
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
        /// Every name `--repo` may match. The first is `canonical_name`.
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
                    crate::output::warning("repo_discovery", format!("Warning: {warning}"));
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
    let resolved = fs::canonicalize(input).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            Error::PathNotFound(input.to_string_lossy().into_owned())
        } else {
            Error::Projects(error.to_string())
        }
    })?;
    let git_root = git::git_root(&resolved)?;
    fs::canonicalize(git_root).map_err(|error| Error::Projects(error.to_string()))
}

/// Repository selected by `--repo <ref>`.
///
/// A ref that starts with `/`, `.`, or `~` is a directory anywhere inside a
/// repository, including a linked worktree, and resolves to the main checkout.
/// A linked worktree's `.git` file resolves the same way as that worktree.
/// Any other ref matches the canonical `host/owner/repo` name of a registered
/// or discovered project, that project's directory name, or an unambiguous
/// path-segment suffix (`owner/repo`, `repo`).
pub fn resolve_project_ref(reference: &str) -> Result<PathBuf> {
    let reference = reference.trim();
    if reference.is_empty() {
        return Err(Error::validation(
            "Option '--repo <value>' requires a repo name or path".to_string(),
        ));
    }
    if reference.starts_with('-') {
        return Err(Error::validation(format!(
            "Option '--repo <value>' received '{reference}', which looks like an option"
        )));
    }
    if is_path_reference(reference) {
        let cwd = std::env::current_dir().map_err(|error| Error::msg(error.to_string()))?;
        let home = home_dir()?;
        return resolve_directory_reference(reference, &cwd, &home);
    }
    let include_ghq = preferences_include_discovery()?;
    let catalog = list_catalog(include_ghq)?;
    for warning in &catalog.warnings {
        crate::output::warning("repo_discovery", format!("Warning: {warning}"));
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
            return Err(Error::PathNotFound(reference.to_string()));
        }
        Err(error) => return Err(Error::msg(error.to_string())),
    };
    if !metadata.is_dir() {
        if let Some(checkout) = linked_worktree_checkout(&path, &metadata) {
            return resolve_checkout_path(&checkout, reference, false);
        }
        return Err(Error::validation(format!(
            "Repository path '{reference}' is not a directory"
        )));
    }
    resolve_checkout_path(&path, reference, true)
}

fn linked_worktree_checkout(path: &Path, metadata: &fs::Metadata) -> Option<PathBuf> {
    if !(metadata.is_file() && path.file_name().is_some_and(|name| name == ".git")) {
        return None;
    }
    let contents = fs::read_to_string(path).ok()?;
    if !contents.starts_with("gitdir:") {
        return None;
    }
    path.parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .map(Path::to_path_buf)
}

fn resolve_checkout_path(path: &Path, reference: &str, walk_git_dir: bool) -> Result<PathBuf> {
    match git::git_root(path) {
        Ok(root) => Ok(fs::canonicalize(&root).unwrap_or(root)),
        Err(error) if walk_git_dir => match checkout_above_git_dir(path) {
            Some(checkout) => match git::git_root(&checkout) {
                Ok(root) => Ok(fs::canonicalize(&root).unwrap_or(root)),
                Err(_) => Err(Error::validation(format!(
                    "Repository path '{reference}' is inside a Git directory, not a checkout"
                ))),
            },
            None => Err(error),
        },
        Err(error) => Err(error),
    }
}

/// Parent of a `.git` directory when `path` is that directory or inside it.
fn checkout_above_git_dir(path: &Path) -> Option<PathBuf> {
    let mut current = path.to_path_buf();
    loop {
        if current.file_name().is_some_and(|name| name == ".git") && current.is_dir() {
            return current
                .parent()
                .filter(|parent| !parent.as_os_str().is_empty())
                .map(Path::to_path_buf);
        }
        if !current.pop() {
            return None;
        }
    }
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
            "Repository path '{reference}' must be an absolute path, a relative path starting with ., or start with ~/."
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
        let mut names = entry_match_names(entry);
        if let ProjectListEntry::Registry { id, .. } = entry {
            names.push(id.clone());
        }
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
        many => Err(Error::Status {
            code: "ambiguous",
            message: ambiguous_project_message(reference, many),
        }),
    }
}

fn ambiguous_project_message(reference: &str, matches: &[&ProjectCandidate]) -> String {
    let mut lines = vec![format!(
        "Repository '{}' matches multiple repos:",
        crate::output::diagnostic_value(reference)
    )];
    for project in matches {
        lines.push(format!(
            "  {} ({})",
            crate::output::diagnostic_value(&project.canonical_name),
            crate::output::diagnostic_value(&project.root.to_string_lossy())
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

/// Names `--repo` matches for this checkout.
///
/// The first name is canonical: the `origin` URL when it parses as
/// `host/owner/repo`, otherwise the `<root>/<host>/<owner>/<repo>` location,
/// otherwise the directory name. A location that differs from the remote is
/// kept as an additional name, and so is the directory name shown by
/// `repo list`.
fn names_for_root(root: &Path, clone_root: Option<&Path>) -> Vec<String> {
    let mut names = Vec::new();
    if let Some(remote) = crate::repository::canonical_name_from_origin(root) {
        names.push(remote);
    }
    if let Some(located) = name_from_location(root, clone_root) {
        push_unique(&mut names, located);
    }
    if let Some(name) = root
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .filter(|name| !name.is_empty())
    {
        push_unique(&mut names, name);
    }
    names
}

fn push_unique(names: &mut Vec<String>, name: String) {
    if !names.iter().any(|existing| existing == &name) {
        names.push(name);
    }
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
    base.join("maboroshi")
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_data_dir_uses_xdg_state_home_mabo() {
        assert_eq!(
            resolve_data_dir("/home/user", Some("/var/state")),
            PathBuf::from("/var/state/maboroshi")
        );
    }

    #[test]
    fn default_data_dir_falls_back_to_home_local_state_mabo() {
        let fallback = PathBuf::from("/home/user/.local/state/maboroshi");
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
    fn registry_add_is_idempotent() {
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
    fn concurrent_additions_keep_all_eight_records() {
        use std::{
            sync::{Arc, Barrier},
            thread,
        };
        let dir = std::env::temp_dir().join(format!("phantom-queue-{}", uuid::Uuid::new_v4()));
        let state = dir.join("state");
        let barrier = Arc::new(Barrier::new(8));
        let stores = (0..8)
            .map(|_| ProjectRegistryStore::new(state.clone()))
            .collect::<Vec<_>>();
        let handles = stores
            .into_iter()
            .enumerate()
            .map(|(index, store)| {
                let barrier = Arc::clone(&barrier);
                thread::spawn(move || {
                    barrier.wait();
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
        assert_eq!(fs::read_dir(dir.join("state/repos")).unwrap().count(), 8);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn reader_rechecks_records_after_a_concurrent_legacy_import() {
        let dir =
            std::env::temp_dir().join(format!("mabo-project-read-import-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join(REGISTRY_FILE),
            include_str!("../tests/fixtures/alpha6/projects.json"),
        )
        .unwrap();
        let store = ProjectRegistryStore::new(dir.clone());
        let before = store.list().unwrap();
        let read = store
            .load_with(|| {
                assert!(!dir.join("repos").exists());
                std::thread::scope(|scope| {
                    scope
                        .spawn(|| store.ensure_records().unwrap())
                        .join()
                        .unwrap();
                });
                assert!(!dir.join(REGISTRY_FILE).exists());
                assert!(dir.join("projects.json.imported").is_file());
            })
            .unwrap();
        assert_eq!(read.projects, before);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn imports_legacy_into_existing_or_concurrently_created_directory() {
        for scenario in ["empty-before", "empty-during", "record-during"] {
            let concurrent = scenario != "empty-before";
            let addition = scenario == "record-during";
            let dir = std::env::temp_dir().join(format!(
                "mabo-project-import-existing-{}",
                uuid::Uuid::new_v4()
            ));
            fs::create_dir_all(&dir).unwrap();
            let legacy = dir.join(REGISTRY_FILE);
            fs::write(
                &legacy,
                include_str!("../tests/fixtures/alpha6/projects.json"),
            )
            .unwrap();
            let store = ProjectRegistryStore::new(dir.clone());
            let before = store.list().unwrap();
            let target = dir.join("repos");
            let mut added = before[0].clone();
            added.id = format!("proj_{}", uuid::Uuid::new_v4());
            added.root_path = "/alpha6/concurrent".into();
            added.name = "concurrent".into();
            if !concurrent {
                fs::create_dir_all(&target).unwrap();
                assert_eq!(store.list().unwrap(), before);
            }
            store
                .ensure_records_with(|| {
                    if concurrent {
                        std::thread::scope(|scope| {
                            scope
                                .spawn(|| {
                                    fs::create_dir_all(&target).unwrap();
                                    if addition {
                                        save_project(&target, &added).unwrap();
                                    }
                                })
                                .join()
                                .unwrap()
                        });
                    }
                })
                .unwrap();
            let after = store.list().unwrap();
            assert_eq!(after.len(), before.len() + usize::from(addition));
            assert!(before.iter().all(|project| after.contains(project)));
            if addition {
                assert!(after.contains(&added));
            }
            assert!(crate::atomic::import_complete(&target));
            assert!(!legacy.exists());
            assert!(legacy.with_extension("json.imported").is_file());
            fs::remove_dir_all(dir).unwrap();
        }
    }

    #[test]
    fn imports_alpha6_registry_on_first_write_with_existing_ids() {
        let dir =
            std::env::temp_dir().join(format!("mabo-project-import-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let fixture = include_str!("../tests/fixtures/alpha6/projects.json");
        fs::write(dir.join(REGISTRY_FILE), fixture).unwrap();
        let store = ProjectRegistryStore::new(dir.clone());
        let before = store.list().unwrap();
        assert_eq!(before.len(), 2);
        assert!(!dir.join("repos").exists());
        store.add(Path::new("/alpha6/new")).unwrap();
        let after = store.list().unwrap();
        assert_eq!(after.len(), 3);
        assert!(before.iter().all(|record| after.contains(record)));
        assert!(!dir.join(REGISTRY_FILE).exists());
        assert_eq!(
            fs::read_to_string(dir.join("projects.json.imported")).unwrap(),
            fixture
        );
        for record in before {
            assert!(dir
                .join("repos")
                .join(format!("{}.json", record.id))
                .is_file());
        }
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn duplicate_roots_keep_oldest_registration_and_remove_together() {
        let dir =
            std::env::temp_dir().join(format!("mabo-project-duplicate-{}", uuid::Uuid::new_v4()));
        let store = ProjectRegistryStore::new(dir.clone());
        let (first, _) = store.add(Path::new("/alpha6/duplicate")).unwrap();
        let mut older = first.clone();
        older.id = format!("proj_{}", uuid::Uuid::new_v4());
        older.created_at = "2000-01-01T00:00:00.000Z".into();
        save_project(&dir.join("repos"), &older).unwrap();
        assert_eq!(store.list().unwrap(), vec![older.clone()]);
        assert_eq!(
            store.add(Path::new("/alpha6/duplicate")).unwrap(),
            (older.clone(), false)
        );
        store.remove(&older.id).unwrap();
        assert!(store.list().unwrap().is_empty());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn simultaneous_registry_imports_keep_old_and_new_projects() {
        use std::{
            sync::{Arc, Barrier},
            thread,
        };
        let dir =
            std::env::temp_dir().join(format!("mabo-project-import-race-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join(REGISTRY_FILE),
            include_str!("../tests/fixtures/alpha6/projects.json"),
        )
        .unwrap();
        let gate = Arc::new(Barrier::new(8));
        let handles = (0..8)
            .map(|index| {
                let dir = dir.clone();
                let gate = Arc::clone(&gate);
                thread::spawn(move || {
                    gate.wait();
                    ProjectRegistryStore::new(dir)
                        .add(Path::new(&format!("/alpha6/new-{index}")))
                        .unwrap();
                })
            })
            .collect::<Vec<_>>();
        for handle in handles {
            handle.join().unwrap();
        }
        assert_eq!(
            ProjectRegistryStore::new(dir.clone()).list().unwrap().len(),
            10
        );
        fs::remove_dir_all(dir).unwrap();
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
        assert!(matches!(
            error,
            Error::Status {
                code: "ambiguous",
                ..
            }
        ));
        assert_eq!(error.exit_code(), crate::error::VALIDATION);
        let message = error.to_string();
        assert!(message.starts_with("Repository 'widget' matches multiple repos:\n"));
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
    fn directory_name_matches_alongside_canonical_names() {
        let projects = [
            candidate(
                "/work/localname",
                "github.com/acme/widget",
                &["github.com/acme/widget", "localname"],
            ),
            candidate(
                "/src/github.com/other/localname",
                "github.com/other/localname",
                &["github.com/other/localname"],
            ),
        ];
        assert_eq!(
            select_named_project("widget", &projects[..1])
                .expect("suffix")
                .as_os_str(),
            "/work/localname"
        );
        assert_eq!(
            select_named_project("localname", &projects[..1])
                .expect("directory name")
                .as_os_str(),
            "/work/localname"
        );
        let error = select_named_project("localname", &projects).expect_err("ambiguous");
        assert!(matches!(
            error,
            Error::Status {
                code: "ambiguous",
                ..
            }
        ));
        assert_eq!(error.exit_code(), crate::error::VALIDATION);
        let message = error.to_string();
        assert!(message.contains("github.com/acme/widget"), "{message}");
        assert!(message.contains("github.com/other/localname"), "{message}");
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
        assert!(names.iter().any(|name| name == "placed"));
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
        let worktree = repo.join(".git/maboroshi/worktrees/feature");
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
        assert_eq!(
            resolve_directory_reference(repo.join(".git").to_str().expect("git dir"), &dir, &home)
                .expect(".git"),
            main
        );
        let gitfile = worktree.join(".git");
        assert!(gitfile.is_file(), "a linked worktree .git is a file");
        assert_eq!(
            resolve_directory_reference(gitfile.to_str().expect("git file"), &dir, &home)
                .expect("worktree .git file"),
            main
        );
        let notes = worktree.join("notes");
        fs::create_dir_all(&notes).expect("notes");
        let stray = notes.join(".git");
        fs::write(&stray, "hello\n").expect("stray git file");
        let stray_ref = resolve_directory_reference(stray.to_str().expect("stray"), &dir, &home);
        let stray_ref = stray_ref.expect_err("stray .git file");
        assert!(matches!(stray_ref, Error::Validation(_)));
        assert_eq!(stray_ref.exit_code(), crate::error::VALIDATION);
        assert!(stray_ref.to_string().contains("not a directory"));
        assert_eq!(
            resolve_directory_reference(
                repo.join(".git/objects").to_str().expect("objects"),
                &dir,
                &home,
            )
            .expect("inside .git"),
            main
        );
        let missing = resolve_directory_reference("/no/such/maboroshi-project", &dir, &home);
        let missing = missing.expect_err("missing path");
        assert!(matches!(missing, Error::PathNotFound(_)));
        assert_eq!(missing.exit_code(), crate::error::NOT_FOUND);
        assert_eq!(
            missing.to_string(),
            "Path '/no/such/maboroshi-project' does not exist"
        );
        let option = resolve_project_ref("--json").expect_err("option");
        assert!(matches!(option, Error::Validation(_)));
        assert!(option.to_string().contains("--json"));
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
