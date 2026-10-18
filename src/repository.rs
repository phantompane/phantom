use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::error::{Error, Result, JSON_VERSION};
use crate::preferences;
use crate::process;
use crate::projects::ProjectRegistryStore;

/// Clone target parsed from a URL or `host/owner/repo` shorthand.
#[derive(Debug, Clone, PartialEq, Eq)]
struct RepoSpec {
    host: String,
    owner: String,
    repo: String,
    /// Passed to `git clone`, including any userinfo.
    clone_url: String,
    /// Shown in JSON and errors. `user:password` userinfo is removed.
    remote_url: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloneResult {
    pub version: u32,
    pub path: String,
    pub host: String,
    pub owner: String,
    pub repo: String,
    pub remote_url: String,
    pub cloned: bool,
    pub updated: bool,
}

pub struct CloneRequest<'a> {
    pub source: &'a str,
    pub branch: Option<&'a str>,
    pub depth: Option<&'a str>,
    pub update: bool,
}

pub fn clone_repository(request: &CloneRequest<'_>) -> Result<CloneResult> {
    let spec = parse_clone_source(request.source)?;
    let branch = normalize_branch(request.branch)?;
    let depth = parse_depth(request.depth)?;
    let root = resolve_repository_root()?;
    let destination = root.join(&spec.host).join(&spec.owner).join(&spec.repo);
    let (cloned, updated) = place_clone(&destination, &spec, branch, depth, request.update)?;

    let registered = register_repository(&destination)?;
    Ok(CloneResult {
        version: JSON_VERSION,
        path: registered,
        host: spec.host,
        owner: spec.owner,
        repo: spec.repo,
        remote_url: spec.remote_url,
        cloned,
        updated,
    })
}

pub fn human_clone_message(result: &CloneResult) -> String {
    if result.cloned {
        format!("Cloned into {}", result.path)
    } else if result.updated {
        format!("Updated {}", result.path)
    } else {
        format!("Already cloned at {}", result.path)
    }
}

/// Root used for `<root>/<host>/<owner>/<repo>`.
///
/// Order: `root` in the user config, the first `git config ghq.root` value,
/// `$GHQ_ROOT`, then `~/ghq`. `project list` scans this same directory.
pub fn resolve_repository_root() -> Result<PathBuf> {
    let home = home_dir()?;
    let config_root = preferences::load_preferences()?.root;
    let ghq_root = std::env::var("GHQ_ROOT").ok();
    let mut warnings = Vec::new();
    let root = resolve_repository_root_from(
        config_root.as_deref(),
        read_git_ghq_roots,
        ghq_root.as_deref(),
        &home,
        &mut warnings,
    )?;
    for warning in warnings {
        eprintln!("Warning: {warning}");
    }
    Ok(root)
}

/// Git checkouts located at `<root>/<host>/<owner>/<repo>`.
pub fn scan_repository_root(root: &Path) -> Vec<String> {
    let mut found = Vec::new();
    let Ok(hosts) = fs::read_dir(root) else {
        return found;
    };
    for host in hosts.flatten() {
        let host_path = host.path();
        if !is_directory(&host_path) {
            continue;
        }
        let Ok(owners) = fs::read_dir(&host_path) else {
            continue;
        };
        for owner in owners.flatten() {
            let owner_path = owner.path();
            if !is_directory(&owner_path) {
                continue;
            }
            let Ok(repos) = fs::read_dir(&owner_path) else {
                continue;
            };
            for repo in repos.flatten() {
                let repo_path = repo.path();
                if !is_directory(&repo_path) || !repo_path.join(".git").exists() {
                    continue;
                }
                let canonical = fs::canonicalize(&repo_path).unwrap_or(repo_path);
                found.push(canonical.to_string_lossy().to_string());
            }
        }
    }
    found.sort();
    found.dedup();
    found
}

fn resolve_repository_root_from(
    config_root: Option<&str>,
    git_roots: impl FnOnce() -> Result<Vec<String>>,
    ghq_root: Option<&str>,
    home: &Path,
    warnings: &mut Vec<String>,
) -> Result<PathBuf> {
    if let Some(value) = nonempty(config_root) {
        return expand_absolute_path(value, home, "root");
    }
    match git_roots() {
        Ok(roots) => {
            if let Some(value) = roots
                .iter()
                .find_map(|value| nonempty(Some(value.as_str())))
            {
                return expand_absolute_path(value, home, "git config ghq.root");
            }
        }
        Err(error) => warnings.push(format!("{error} Continuing with $GHQ_ROOT or ~/ghq.")),
    }
    if let Some(value) = nonempty(ghq_root) {
        return expand_absolute_path(value, home, "GHQ_ROOT");
    }
    Ok(crate::paths::normalize(&home.join("ghq")))
}

fn read_git_ghq_roots() -> Result<Vec<String>> {
    match process::raw("git", &["config", "--get-all", "ghq.root"], None) {
        Ok(captured) if captured.code == 0 => Ok(nonempty_lines(&captured.stdout)),
        Ok(captured) if captured.stderr.trim().is_empty() => Ok(Vec::new()),
        Ok(captured) => Err(Error::msg(format!(
            "Failed to read git config ghq.root: {}",
            captured.stderr.trim()
        ))),
        Err(Error::Spawn { .. }) => Ok(Vec::new()),
        Err(error) => Err(error),
    }
}

fn place_clone(
    destination: &Path,
    spec: &RepoSpec,
    branch: Option<&str>,
    depth: Option<u32>,
    update: bool,
) -> Result<(bool, bool)> {
    if destination_exists(destination)? {
        return adopt_existing(destination, spec, update);
    }
    let created_parents = create_missing_parents(destination)?;
    let Some(parent) = destination.parent() else {
        remove_created_parents(&created_parents);
        return Err(Error::validation(format!(
            "Cannot create clone destination {}",
            destination.display()
        )));
    };
    // The staging directory is the checkout. Renaming it onto the destination
    // stays on one filesystem. POSIX rename fails when the destination is a
    // non-empty directory, which is the racing clone we must not delete.
    let staging = parent.join(format!(
        ".ptm-clone-{}-{}",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    if let Err(error) = fs::create_dir(&staging) {
        remove_created_parents(&created_parents);
        return Err(Error::msg(format!(
            "Failed to create {}: {error}",
            staging.display()
        )));
    }
    if let Err(error) = clone_with_git(&spec.clone_url, &staging, branch, depth) {
        remove_staging(&staging);
        remove_created_parents(&created_parents);
        return Err(error);
    }
    match publish_clone(&staging, destination, spec, update) {
        Ok(result) => Ok(result),
        Err(error) => {
            remove_created_parents(&created_parents);
            Err(error)
        }
    }
}

fn publish_clone(
    staging: &Path,
    destination: &Path,
    spec: &RepoSpec,
    update: bool,
) -> Result<(bool, bool)> {
    match fs::rename(staging, destination) {
        Ok(()) => Ok((true, false)),
        Err(error) if destination_appeared(&error) => {
            remove_staging(staging);
            adopt_existing(destination, spec, update)
        }
        Err(error) => {
            remove_staging(staging);
            Err(Error::msg(format!(
                "Failed to move clone into {}: {error}",
                destination.display()
            )))
        }
    }
}

/// Directories between the clone root and the destination that did not exist.
/// Listed deepest first so cleanup removes the leaf first.
fn create_missing_parents(destination: &Path) -> Result<Vec<PathBuf>> {
    let mut missing = Vec::new();
    let mut cursor = destination.parent().map(Path::to_path_buf);
    while let Some(dir) = cursor {
        if destination_exists(&dir)? {
            break;
        }
        cursor = dir.parent().map(Path::to_path_buf);
        missing.push(dir);
    }
    let mut created = Vec::new();
    for dir in missing.iter().rev() {
        match fs::create_dir(dir) {
            Ok(()) => created.push(dir.clone()),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => {
                remove_created_parents(&created);
                return Err(Error::msg(format!(
                    "Failed to create {}: {error}",
                    dir.display()
                )));
            }
        }
    }
    created.reverse();
    Ok(created)
}

fn remove_created_parents(created_deepest_first: &[PathBuf]) {
    for dir in created_deepest_first {
        if fs::remove_dir(dir).is_err() {
            break;
        }
    }
}

fn adopt_existing(destination: &Path, spec: &RepoSpec, update: bool) -> Result<(bool, bool)> {
    ensure_matching_repository(destination, spec)?;
    if update {
        fetch_origin(destination)?;
        Ok((false, true))
    } else {
        Ok((false, false))
    }
}

fn remove_staging(staging: &Path) {
    let _ = fs::remove_dir_all(staging);
}

fn register_repository(destination: &Path) -> Result<String> {
    let root = crate::projects::resolve_project_root(destination)?;
    let store = ProjectRegistryStore::default_store()?;
    let (project, _) = store.add(&root)?;
    Ok(project.root_path)
}

fn ensure_matching_repository(path: &Path, spec: &RepoSpec) -> Result<()> {
    if !is_directory(path) {
        return Err(not_a_repository(path));
    }
    let Some(toplevel) = repository_toplevel(path)? else {
        return Err(not_a_repository(path));
    };
    let canonical = fs::canonicalize(path)
        .map_err(|error| Error::msg(format!("Failed to resolve {}: {error}", path.display())))?;
    if toplevel != canonical {
        return Err(Error::validation(format!(
            "{} is inside the Git repository at {}, not a repository root.",
            path.display(),
            toplevel.display()
        )));
    }
    let Some(actual) = origin_url(path)? else {
        return Err(Error::validation(format!(
            "{} is a Git repository without an origin remote. Expected '{}'.",
            path.display(),
            spec.remote_url
        )));
    };
    if !same_repository(spec, &actual) {
        return Err(Error::validation(format!(
            "{} is a Git repository with origin '{}', which does not match '{}' ({}/{}/{}).",
            path.display(),
            redact_userinfo(&actual),
            spec.remote_url,
            spec.host,
            spec.owner,
            spec.repo
        )));
    }
    Ok(())
}

fn not_a_repository(path: &Path) -> Error {
    Error::validation(format!(
        "{} exists but is not a Git repository.",
        path.display()
    ))
}

fn clone_with_git(
    url: &str,
    destination: &Path,
    branch: Option<&str>,
    depth: Option<u32>,
) -> Result<()> {
    let destination = path_arg(destination)?;
    let mut args = vec!["clone".to_string()];
    if let Some(branch) = branch {
        args.push("--branch".to_string());
        args.push(branch.to_string());
    }
    if let Some(depth) = depth {
        args.push("--depth".to_string());
        args.push(depth.to_string());
    }
    args.push("--".to_string());
    args.push(url.to_string());
    args.push(destination);
    run_git_visible(&args, "git clone")
}

fn fetch_origin(destination: &Path) -> Result<()> {
    let destination = path_arg(destination)?;
    let args = [
        "-C".to_string(),
        destination,
        "fetch".to_string(),
        "origin".to_string(),
    ];
    run_git_visible(&args, "git fetch")
}

fn run_git_visible(args: &[String], command: &str) -> Result<()> {
    let refs = args.iter().map(String::as_str).collect::<Vec<_>>();
    let code = process::inherit("git", &refs, None, &[], true)?;
    if code == 0 {
        Ok(())
    } else {
        Err(Error::CommandFailed {
            command: command.to_string(),
            code,
        })
    }
}

fn repository_toplevel(path: &Path) -> Result<Option<PathBuf>> {
    let arg = path_arg(path)?;
    match process::raw("git", &["-C", &arg, "rev-parse", "--show-toplevel"], None) {
        Ok(captured) if captured.code == 0 => {
            let toplevel = PathBuf::from(captured.stdout.trim());
            Ok(Some(fs::canonicalize(&toplevel).unwrap_or(toplevel)))
        }
        Ok(_) => Ok(None),
        Err(error) => Err(error),
    }
}

fn origin_url(path: &Path) -> Result<Option<String>> {
    let path = path_arg(path)?;
    // `remote get-url` expands insteadOf. Compare the URL Git stored.
    match process::raw(
        "git",
        &["-C", &path, "config", "--get", "remote.origin.url"],
        None,
    ) {
        Ok(captured) if captured.code == 0 => {
            let url = captured.stdout.trim();
            if url.is_empty() {
                Ok(None)
            } else {
                Ok(Some(url.to_string()))
            }
        }
        Ok(_) => Ok(None),
        Err(error) => Err(error),
    }
}

fn destination_exists(path: &Path) -> Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(Error::msg(format!(
            "Failed to inspect {}: {error}",
            path.display()
        ))),
    }
}

fn parse_clone_source(input: &str) -> Result<RepoSpec> {
    let input = input.trim();
    if input.is_empty() || input.chars().any(char::is_whitespace) {
        return Err(invalid_source(input));
    }
    if let Some((scheme, rest)) = input.split_once("://") {
        return parse_scheme_url(input, scheme, rest);
    }
    if let Some((left, path)) = input.split_once(':') {
        return parse_scp(input, left, path);
    }
    parse_shorthand(input)
}

fn parse_scheme_url(input: &str, scheme: &str, rest: &str) -> Result<RepoSpec> {
    if !matches!(scheme, "https" | "http" | "ssh") {
        return Err(Error::validation(format!(
            "Unsupported URL scheme '{scheme}' in '{}'. Expected https, http, or ssh.",
            redact_userinfo(input)
        )));
    }
    if rest.contains('?') || rest.contains('#') {
        return Err(invalid_source(input));
    }
    let Some((authority, path)) = rest.split_once('/') else {
        return Err(invalid_path(input));
    };
    if authority.is_empty() {
        return Err(invalid_source(input));
    }
    let host = host_from_authority(input, authority)?;
    let (owner, repo) = owner_repo_from_path(input, path)?;
    Ok(spec_from_urls(
        host,
        owner,
        repo,
        input.trim_end_matches('/'),
    ))
}

fn parse_scp(input: &str, left: &str, path: &str) -> Result<RepoSpec> {
    if path.starts_with('/') {
        return Err(Error::validation(format!(
            "Invalid repository '{}'. An scp-style path must be owner/repo, not an absolute path.",
            redact_userinfo(input)
        )));
    }
    if left.is_empty() || path.is_empty() || left.contains('/') {
        return Err(invalid_source(input));
    }
    let host = match left.rsplit_once('@') {
        Some((_, host)) if !host.is_empty() => host,
        Some(_) => return Err(invalid_source(input)),
        None => left,
    };
    let host = host.to_ascii_lowercase();
    validate_host(input, &host)?;
    let (owner, repo) = owner_repo_from_path(input, path)?;
    Ok(spec_from_urls(
        host,
        owner,
        repo,
        input.trim_end_matches('/'),
    ))
}

fn parse_shorthand(input: &str) -> Result<RepoSpec> {
    let (host, owner, repo) = match path_segments(input) {
        Some(segments) if segments.len() == 2 => ("github.com", segments[0], segments[1]),
        Some(segments) if segments.len() == 3 => (segments[0], segments[1], segments[2]),
        _ => return Err(invalid_path(input)),
    };
    let host = host.to_ascii_lowercase();
    validate_host(input, &host)?;
    let owner = validate_component(input, owner, "owner")?;
    let repo = validate_repo_name(input, repo)?;
    let remote_url = format!("https://{host}/{owner}/{repo}.git");
    Ok(RepoSpec {
        clone_url: remote_url.clone(),
        remote_url,
        host,
        owner,
        repo,
    })
}

fn host_from_authority(input: &str, authority: &str) -> Result<String> {
    let hostport = match authority.rsplit_once('@') {
        Some((_, hostport)) if !hostport.is_empty() => hostport,
        Some(_) => return Err(invalid_source(input)),
        None => authority,
    };
    let bracketed = hostport.starts_with('[');
    let (host, port) = if let Some(rest) = hostport.strip_prefix('[') {
        let Some(end) = rest.find(']') else {
            return Err(invalid_source(input));
        };
        if end == 0 {
            return Err(invalid_source(input));
        }
        let after = &rest[end + 1..];
        let port = if after.is_empty() {
            None
        } else if let Some(port) = after.strip_prefix(':').filter(|port| is_port_number(port)) {
            Some(port)
        } else {
            return Err(invalid_source(input));
        };
        (&rest[..end], port)
    } else if let Some((host, port)) = hostport.rsplit_once(':') {
        if host.is_empty() || !is_port_number(port) {
            return Err(invalid_source(input));
        }
        (host, Some(port))
    } else {
        (hostport, None)
    };
    validate_host(input, host)?;
    let host = host.to_ascii_lowercase();
    let rendered = if bracketed { format!("[{host}]") } else { host };
    Ok(match port {
        Some(port) => format!("{rendered}:{port}"),
        None => rendered,
    })
}

fn is_port_number(value: &str) -> bool {
    !value.is_empty() && value.chars().all(|char| char.is_ascii_digit())
}

fn owner_repo_from_path(input: &str, path: &str) -> Result<(String, String)> {
    let Some(segments) = path_segments(path) else {
        return Err(invalid_path(input));
    };
    if segments.len() != 2 {
        return Err(invalid_path(input));
    }
    let owner = validate_component(input, segments[0], "owner")?;
    let repo = validate_repo_name(input, segments[1])?;
    Ok((owner, repo))
}

fn path_segments(path: &str) -> Option<Vec<&str>> {
    let path = path.trim_matches('/');
    if path.is_empty() {
        return None;
    }
    let segments = path.split('/').collect::<Vec<_>>();
    if segments.iter().any(|segment| segment.is_empty()) {
        return None;
    }
    Some(segments)
}

fn validate_repo_name(input: &str, repo: &str) -> Result<String> {
    let repo = repo.strip_suffix(".git").unwrap_or(repo);
    validate_component(input, repo, "repository")
}

fn validate_host(input: &str, host: &str) -> Result<()> {
    if host.is_empty()
        || host == "."
        || host == ".."
        || host.contains('/')
        || host.contains('\\')
        || host.chars().any(char::is_control)
    {
        return Err(invalid_source(input));
    }
    Ok(())
}

fn validate_component(input: &str, value: &str, label: &str) -> Result<String> {
    if value.is_empty()
        || value == "."
        || value == ".."
        || value.chars().any(|char| {
            char.is_control() || matches!(char, '/' | '\\' | ':' | '@' | '?' | '#' | ' ')
        })
    {
        return Err(Error::validation(format!(
            "Invalid {label} '{value}' in repository '{}'.",
            redact_userinfo(input)
        )));
    }
    Ok(value.to_string())
}

fn same_repository(expected: &RepoSpec, actual_url: &str) -> bool {
    match parse_clone_source(actual_url) {
        Ok(actual) => {
            actual.host == expected.host
                && actual.owner == expected.owner
                && actual.repo == expected.repo
        }
        Err(_) => false,
    }
}

fn spec_from_urls(host: String, owner: String, repo: String, clone_url: &str) -> RepoSpec {
    RepoSpec {
        host,
        owner,
        repo,
        remote_url: redact_userinfo(clone_url),
        clone_url: clone_url.to_string(),
    }
}

/// Hide credentials in text we print.
///
/// `http` and `https` lose all userinfo, including a token used as the
/// username. `ssh` and scp-style URLs keep the login name and drop a password.
fn redact_userinfo(value: &str) -> String {
    if let Some((scheme, rest)) = value.split_once("://") {
        let (authority, path) = match rest.split_once('/') {
            Some((authority, path)) => (authority, format!("/{path}")),
            None => (rest, String::new()),
        };
        if matches!(scheme, "http" | "https") {
            if let Some((_, host)) = authority.rsplit_once('@') {
                return format!("{scheme}://{host}{path}");
            }
            return value.to_string();
        }
        if let Some((userinfo, host)) = authority.rsplit_once('@') {
            let username = userinfo
                .split_once(':')
                .map(|(user, _)| user)
                .unwrap_or(userinfo);
            if username.is_empty() {
                return format!("{scheme}://{host}{path}");
            }
            return format!("{scheme}://{username}@{host}{path}");
        }
        return value.to_string();
    }
    if let Some((userinfo, rest)) = value.rsplit_once('@') {
        if !rest.is_empty() {
            let username = userinfo
                .split_once(':')
                .map(|(user, _)| user)
                .unwrap_or(userinfo);
            if username.is_empty() {
                return rest.to_string();
            }
            return format!("{username}@{rest}");
        }
    }
    value.to_string()
}

fn normalize_branch(branch: Option<&str>) -> Result<Option<&str>> {
    let Some(value) = branch else {
        return Ok(None);
    };
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(Error::validation(
            "Option '--branch <value>' requires a branch name".to_string(),
        ));
    }
    if trimmed.starts_with('-') {
        return Err(Error::validation(
            "Branch name cannot start with '-'".to_string(),
        ));
    }
    Ok(Some(trimmed))
}

fn parse_depth(depth: Option<&str>) -> Result<Option<u32>> {
    let Some(value) = depth else {
        return Ok(None);
    };
    match value.parse::<u32>() {
        Ok(number) if number > 0 => Ok(Some(number)),
        _ => Err(Error::validation(format!(
            "Option '--depth <value>' requires a positive integer, got '{value}'"
        ))),
    }
}

fn expand_absolute_path(value: &str, home: &Path, label: &str) -> Result<PathBuf> {
    let value = value.trim();
    let path = if value == "~" {
        home.to_path_buf()
    } else if let Some(rest) = value.strip_prefix("~/") {
        home.join(rest)
    } else if value.starts_with('~') {
        return Err(Error::validation(format!(
            "{label} '{value}' must be an absolute path or start with ~/."
        )));
    } else {
        PathBuf::from(value)
    };
    if !path.is_absolute() {
        return Err(Error::validation(format!(
            "{label} '{value}' must be an absolute path"
        )));
    }
    Ok(crate::paths::normalize(&path))
}

fn home_dir() -> Result<PathBuf> {
    match std::env::var_os("HOME") {
        Some(value) if !value.is_empty() => Ok(PathBuf::from(value)),
        _ => Err(Error::msg("HOME is not set")),
    }
}

fn nonempty(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}

fn nonempty_lines(text: &str) -> Vec<String> {
    text.lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_string)
        .collect()
}

fn path_arg(path: &Path) -> Result<String> {
    path.to_str()
        .map(str::to_string)
        .ok_or_else(|| Error::msg(format!("Path is not valid Unicode: {}", path.display())))
}

fn is_directory(path: &Path) -> bool {
    fs::metadata(path)
        .map(|metadata| metadata.is_dir())
        .unwrap_or(false)
}

fn invalid_source(input: &str) -> Error {
    let input = redact_userinfo(input);
    Error::validation(format!(
        "Invalid repository '{input}'. Expected an http(s) URL, an ssh:// URL, an scp-style git@host:owner/repo path, host/owner/repo, or owner/repo."
    ))
}

fn invalid_path(input: &str) -> Error {
    let input = redact_userinfo(input);
    Error::validation(format!(
        "Invalid repository '{input}'. Expected a path of <owner>/<repo> or <host>/<owner>/<repo>."
    ))
}

fn destination_appeared(error: &std::io::Error) -> bool {
    matches!(
        error.kind(),
        std::io::ErrorKind::AlreadyExists | std::io::ErrorKind::DirectoryNotEmpty
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(input: &str) -> RepoSpec {
        parse_clone_source(input).unwrap_or_else(|error| panic!("{input}: {error}"))
    }

    #[test]
    fn parses_url_forms() {
        let cases = [
            (
                "https://github.com/aku11i/phantom.git",
                "github.com",
                "aku11i",
                "phantom",
                "https://github.com/aku11i/phantom.git",
            ),
            (
                "https://github.com/aku11i/phantom",
                "github.com",
                "aku11i",
                "phantom",
                "https://github.com/aku11i/phantom",
            ),
            (
                "https://github.com/aku11i/phantom/",
                "github.com",
                "aku11i",
                "phantom",
                "https://github.com/aku11i/phantom",
            ),
            (
                "https://user:token@github.com/aku11i/phantom.git",
                "github.com",
                "aku11i",
                "phantom",
                "https://github.com/aku11i/phantom.git",
            ),
            (
                "http://gitlab.example.com:8443/group/repo.git",
                "gitlab.example.com:8443",
                "group",
                "repo",
                "http://gitlab.example.com:8443/group/repo.git",
            ),
            (
                "ssh://git@github.com/aku11i/phantom.git",
                "github.com",
                "aku11i",
                "phantom",
                "ssh://git@github.com/aku11i/phantom.git",
            ),
            (
                "ssh://git@github.com:22/aku11i/phantom.git",
                "github.com:22",
                "aku11i",
                "phantom",
                "ssh://git@github.com:22/aku11i/phantom.git",
            ),
            (
                "https://GitHub.com/aku11i/phantom.git",
                "github.com",
                "aku11i",
                "phantom",
                "https://GitHub.com/aku11i/phantom.git",
            ),
            (
                "git@github.com:aku11i/phantom.git",
                "github.com",
                "aku11i",
                "phantom",
                "git@github.com:aku11i/phantom.git",
            ),
            (
                "git@github.com:aku11i/phantom",
                "github.com",
                "aku11i",
                "phantom",
                "git@github.com:aku11i/phantom",
            ),
            (
                "github.com:aku11i/phantom.git",
                "github.com",
                "aku11i",
                "phantom",
                "github.com:aku11i/phantom.git",
            ),
            (
                "github.com/aku11i/phantom",
                "github.com",
                "aku11i",
                "phantom",
                "https://github.com/aku11i/phantom.git",
            ),
            (
                "github.com/aku11i/phantom.git",
                "github.com",
                "aku11i",
                "phantom",
                "https://github.com/aku11i/phantom.git",
            ),
            (
                "aku11i/phantom",
                "github.com",
                "aku11i",
                "phantom",
                "https://github.com/aku11i/phantom.git",
            ),
            (
                "aku11i/phantom.git",
                "github.com",
                "aku11i",
                "phantom",
                "https://github.com/aku11i/phantom.git",
            ),
        ];
        for (input, host, owner, repo, remote) in cases {
            let parsed = spec(input);
            assert_eq!(parsed.host, host, "{input}");
            assert_eq!(parsed.owner, owner, "{input}");
            assert_eq!(parsed.repo, repo, "{input}");
            assert_eq!(parsed.remote_url, remote, "{input}");
        }
    }

    #[test]
    fn rejects_invalid_repository_sources() {
        for input in [
            "",
            "aku11i",
            "https://github.com/aku11i",
            "https://github.com/a/b/c",
            "git@github.com:onlyrepo",
            "https://github.com/a/b?ref=1",
            "ftp://github.com/a/b",
            "file:///tmp/repo.git",
            "owner/../repo",
            "https://github.com/owner/../repo.git",
            "../etc/passwd",
            "not a repo",
        ] {
            let error = parse_clone_source(input).expect_err(input);
            assert!(matches!(error, Error::Validation(_)), "{input}: {error}");
            assert!(error.to_string().contains(input.trim()), "{error}");
        }
    }

    #[test]
    fn matches_equivalent_remote_urls() {
        let expected = spec("aku11i/phantom");
        assert!(same_repository(
            &expected,
            "https://github.com/aku11i/phantom.git"
        ));
        assert!(same_repository(&expected, "git@github.com:aku11i/phantom"));
        assert!(same_repository(
            &expected,
            "ssh://git@GitHub.com/aku11i/phantom.git"
        ));
        assert!(!same_repository(
            &expected,
            "https://gitlab.com/aku11i/phantom.git"
        ));
        assert!(!same_repository(
            &expected,
            "https://github.com/aku11i/other.git"
        ));
        assert!(!same_repository(&expected, "/tmp/local.git"));
        let port = spec("https://example.net:9443/acme/widget.git");
        assert_eq!(port.host, "example.net:9443");
        assert_eq!(
            Path::new("/ghq")
                .join(&port.host)
                .join(&port.owner)
                .join(&port.repo),
            PathBuf::from("/ghq/example.net:9443/acme/widget")
        );
        assert!(same_repository(
            &port,
            "https://Example.NET:9443/acme/widget"
        ));
        assert!(!same_repository(
            &port,
            "https://example.net:8443/acme/widget.git"
        ));
        assert!(!same_repository(
            &port,
            "https://example.net/acme/widget.git"
        ));
        let mixed = spec("https://GitHub.com/Aku11i/Phantom.git");
        assert!(same_repository(&mixed, "git@github.com:Aku11i/Phantom.git"));
        assert!(!same_repository(
            &mixed,
            "git@github.com:aku11i/phantom.git"
        ));
    }

    fn git_roots(values: &'static [&str]) -> impl FnOnce() -> Result<Vec<String>> {
        move || Ok(values.iter().map(|value| (*value).to_string()).collect())
    }

    #[test]
    fn root_resolution_follows_config_then_git_then_env_then_home() {
        let home = Path::new("/home/phantom");
        let mut warnings = Vec::new();
        let config = resolve_repository_root_from(
            Some("~/from-config"),
            git_roots(&["/from-git", "/second"]),
            Some("/from-env"),
            home,
            &mut warnings,
        )
        .expect("config");
        assert_eq!(config, PathBuf::from("/home/phantom/from-config"));
        assert!(warnings.is_empty());

        let git = resolve_repository_root_from(
            Some("  "),
            git_roots(&["~/from-git", "/second"]),
            Some("/from-env"),
            home,
            &mut warnings,
        )
        .expect("git");
        assert_eq!(git, PathBuf::from("/home/phantom/from-git"));

        let env = resolve_repository_root_from(
            None,
            git_roots(&[]),
            Some("~/from-env"),
            home,
            &mut warnings,
        )
        .expect("env");
        assert_eq!(env, PathBuf::from("/home/phantom/from-env"));

        let default =
            resolve_repository_root_from(None, git_roots(&[]), Some("   "), home, &mut warnings)
                .expect("default");
        assert_eq!(default, PathBuf::from("/home/phantom/ghq"));

        let relative = resolve_repository_root_from(
            Some("relative/root"),
            git_roots(&[]),
            None,
            home,
            &mut warnings,
        )
        .expect_err("relative");
        assert!(relative.to_string().contains("absolute"), "{relative}");
        let user = resolve_repository_root_from(
            None,
            git_roots(&["~other/src"]),
            None,
            home,
            &mut warnings,
        )
        .expect_err("user");
        assert!(user.to_string().contains("~/"), "{user}");
    }

    #[test]
    fn configured_root_skips_git_config_and_a_read_failure_falls_through() {
        let home = Path::new("/home/phantom");
        let mut warnings = Vec::new();
        let mut calls = 0;
        let configured = resolve_repository_root_from(
            Some("/from-config"),
            || {
                calls += 1;
                Err(Error::msg("broken gitconfig"))
            },
            Some("/from-env"),
            home,
            &mut warnings,
        )
        .expect("configured");
        assert_eq!(calls, 0);
        assert!(warnings.is_empty());
        assert_eq!(configured, PathBuf::from("/from-config"));

        let fallback = resolve_repository_root_from(
            None,
            || Err(Error::msg("Failed to read git config ghq.root: broken")),
            Some("~/from-env"),
            home,
            &mut warnings,
        )
        .expect("fallback");
        assert_eq!(fallback, PathBuf::from("/home/phantom/from-env"));
        assert_eq!(warnings.len(), 1, "{warnings:?}");
        assert!(warnings[0].contains("broken"), "{warnings:?}");
        assert!(warnings[0].contains("~/ghq") || warnings[0].contains("GHQ_ROOT"));
    }

    #[test]
    fn depth_and_branch_options_are_validated() {
        let error = parse_depth(Some("0")).expect_err("zero");
        assert!(error.to_string().contains("positive integer"), "{error}");
        assert!(parse_depth(Some("-1")).is_err());
        assert!(parse_depth(Some("nope")).is_err());
        assert_eq!(parse_depth(Some("2")).expect("depth"), Some(2));
        assert_eq!(parse_depth(None).expect("none"), None);
        assert!(normalize_branch(Some("  ")).is_err());
        assert!(normalize_branch(Some("--branch")).is_err());
        assert_eq!(
            normalize_branch(Some("main")).expect("branch"),
            Some("main")
        );
    }

    #[test]
    fn scan_finds_only_host_owner_repo_checkouts() {
        let root = std::env::temp_dir().join(format!(
            "ptm-scan-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        let repo = root.join("github.com").join("owner").join("repo");
        fs::create_dir_all(repo.join(".git")).expect("git dir");
        fs::create_dir_all(root.join("github.com").join("owner").join("not-a-repo"))
            .expect("plain");
        fs::write(root.join("github.com").join("file"), "nope").expect("file");
        let found = scan_repository_root(&root);
        assert_eq!(found.len(), 1, "{found:?}");
        assert!(found[0].ends_with("/github.com/owner/repo"), "{found:?}");
        assert!(scan_repository_root(&root.join("missing")).is_empty());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn remote_url_redacts_userinfo_and_clone_url_keeps_it() {
        let parsed = spec("https://user:secret@github.com/aku11i/phantom.git");
        assert_eq!(parsed.remote_url, "https://github.com/aku11i/phantom.git");
        assert_eq!(
            parsed.clone_url,
            "https://user:secret@github.com/aku11i/phantom.git"
        );
        assert!(!parsed.remote_url.contains("secret"));
        let token = spec("https://ghp_SECRET123@example.com/acme/widget");
        assert_eq!(token.remote_url, "https://example.com/acme/widget");
        assert_eq!(
            token.clone_url,
            "https://ghp_SECRET123@example.com/acme/widget"
        );
        assert!(!token.remote_url.contains("ghp_SECRET123"));
        let ssh = spec("git@github.com:aku11i/phantom.git");
        assert_eq!(ssh.remote_url, "git@github.com:aku11i/phantom.git");
        assert_eq!(ssh.clone_url, ssh.remote_url);
        let ssh_password = spec("ssh://git:secret@github.com/aku11i/phantom.git");
        assert_eq!(
            ssh_password.remote_url,
            "ssh://git@github.com/aku11i/phantom.git"
        );
        assert!(ssh_password.clone_url.contains("secret"));
        assert!(!ssh_password.remote_url.contains("secret"));

        let error = parse_clone_source("https://ghp_SECRET123@example.com/only").expect_err("path");
        let message = error.to_string();
        assert!(!message.contains("ghp_SECRET123"), "{message}");
        assert!(message.contains("example.com"), "{message}");
        let file_url = parse_clone_source("file:///tmp/repo.git").expect_err("file");
        assert!(file_url.to_string().contains("file"), "{file_url}");
        let absolute =
            parse_clone_source("git@example.com:/acme/widget.git").expect_err("absolute");
        let absolute_message = absolute.to_string();
        assert!(absolute_message.contains("absolute"), "{absolute_message}");
        assert!(!same_repository(
            &spec("git@example.com:acme/widget.git"),
            "git@example.com:/acme/widget.git"
        ));
    }

    #[test]
    fn rename_replaces_an_empty_directory_and_keeps_a_non_empty_one() {
        let root = temp_dir("rename");
        let source = root.join("source");
        fs::create_dir(&source).expect("source");
        fs::write(source.join("file.txt"), "moved").expect("file");
        let empty = root.join("empty");
        fs::create_dir(&empty).expect("empty");
        fs::rename(&source, &empty).expect("replace empty");
        assert!(!source.exists());
        assert_eq!(
            fs::read_to_string(empty.join("file.txt")).expect("moved"),
            "moved"
        );

        let again = root.join("again");
        fs::create_dir(&again).expect("again");
        fs::write(again.join("new.txt"), "temp").expect("new");
        let error = fs::rename(&again, &empty).expect_err("non-empty");
        assert!(destination_appeared(&error), "{error}");
        assert!(again.exists());
        assert_eq!(
            fs::read_to_string(empty.join("file.txt")).expect("kept"),
            "moved"
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn subdirectory_is_not_treated_as_the_repository() {
        let root = temp_dir("nested");
        let parent = root.join("github.com");
        fs::create_dir_all(&parent).expect("parent");
        git(
            &["init", "-b", "main", parent.to_str().expect("path")],
            None,
        );
        let nested = parent.join("example").join("widget");
        fs::create_dir_all(&nested).expect("nested");
        fs::write(nested.join("keep.txt"), "safe").expect("keep");
        let error =
            ensure_matching_repository(&nested, &spec("example/widget")).expect_err("nested");
        let message = error.to_string();
        assert!(message.contains("not a repository root"), "{message}");
        assert_eq!(
            fs::read_to_string(nested.join("keep.txt")).expect("kept"),
            "safe"
        );
        assert!(parent.join(".git").is_dir());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn lost_clone_race_keeps_the_existing_checkout() {
        let root = temp_dir("race");
        let destination = root.join("widget");
        fs::create_dir_all(&destination).expect("dest");
        git(
            &["init", "-b", "main", destination.to_str().expect("path")],
            None,
        );
        git(
            &[
                "-C",
                destination.to_str().expect("path"),
                "remote",
                "add",
                "origin",
                "https://user:secret@github.com/example/widget.git",
            ],
            None,
        );
        fs::write(destination.join("keep.txt"), "safe").expect("keep");
        let staging = root.join(".ptm-clone-test");
        fs::create_dir_all(&staging).expect("temp");
        fs::write(staging.join("new.txt"), "temp").expect("new");
        let spec = RepoSpec {
            host: "github.com".into(),
            owner: "example".into(),
            repo: "widget".into(),
            clone_url: "https://user:secret@github.com/example/widget.git".into(),
            remote_url: "https://github.com/example/widget.git".into(),
        };
        let (cloned, updated) =
            publish_clone(&staging, &destination, &spec, false).expect("publish");
        assert!(!cloned);
        assert!(!updated);
        assert_eq!(
            fs::read_to_string(destination.join("keep.txt")).expect("kept"),
            "safe"
        );
        assert!(!staging.exists());

        git(
            &[
                "-C",
                destination.to_str().expect("path"),
                "remote",
                "set-url",
                "origin",
                "https://user:secret@github.com/example/different.git",
            ],
            None,
        );
        let staging = root.join(".ptm-clone-mismatch");
        fs::create_dir_all(&staging).expect("temp");
        fs::write(staging.join("new.txt"), "temp").expect("new");
        let error = publish_clone(&staging, &destination, &spec, false).expect_err("mismatch");
        let message = error.to_string();
        assert!(message.contains("does not match"), "{message}");
        assert!(!message.contains("secret"), "{message}");
        assert_eq!(
            fs::read_to_string(destination.join("keep.txt")).expect("kept"),
            "safe"
        );
        assert!(!staging.exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn failed_clone_removes_only_its_staging_directory() {
        let root = temp_dir("fail-clone");
        let owner = root.join("github.com").join("example");
        let destination = owner.join("widget");
        let sibling = owner.join("keep");
        fs::create_dir_all(&sibling).expect("sibling");
        fs::write(sibling.join("keep.txt"), "safe").expect("keep");
        let spec = RepoSpec {
            host: "github.com".into(),
            owner: "example".into(),
            repo: "widget".into(),
            clone_url: root.join("missing.git").to_string_lossy().into_owned(),
            remote_url: "https://github.com/example/widget.git".into(),
        };
        let error = place_clone(&destination, &spec, None, None, false).expect_err("clone");
        assert!(error.to_string().contains("git clone"), "{error}");
        assert_eq!(
            fs::read_to_string(sibling.join("keep.txt")).expect("kept"),
            "safe"
        );
        assert!(!destination.exists());
        let leftovers = fs::read_dir(&owner)
            .expect("owner")
            .map(|entry| entry.expect("entry").file_name())
            .filter(|name| name.to_string_lossy().starts_with(".ptm-clone-"))
            .collect::<Vec<_>>();
        assert!(leftovers.is_empty(), "{leftovers:?}");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn failed_clone_removes_empty_parents_it_created() {
        let root = temp_dir("parents");
        let existing = root.join("github.com").join("other");
        fs::create_dir_all(&existing).expect("existing");
        fs::write(existing.join("keep.txt"), "safe").expect("keep");
        let destination = root.join("example.net:8443").join("acme").join("widget");
        let spec = RepoSpec {
            host: "example.net:8443".into(),
            owner: "acme".into(),
            repo: "widget".into(),
            clone_url: root.join("missing.git").to_string_lossy().into_owned(),
            remote_url: "https://example.net:8443/acme/widget.git".into(),
        };
        let error = place_clone(&destination, &spec, None, None, false).expect_err("clone");
        assert!(error.to_string().contains("git clone"), "{error}");
        assert!(!root.join("example.net:8443").exists());
        assert_eq!(
            fs::read_to_string(existing.join("keep.txt")).expect("kept"),
            "safe"
        );
        assert!(root.join("github.com").is_dir());
        let _ = fs::remove_dir_all(root);
    }

    fn temp_dir(label: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "ptm-{label}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        fs::create_dir_all(&path).expect("temp");
        path
    }

    fn git(args: &[&str], cwd: Option<&Path>) {
        let mut command = std::process::Command::new("git");
        command.args(args);
        if let Some(cwd) = cwd {
            command.current_dir(cwd);
        }
        let output = command
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_AUTHOR_NAME", "Phantom")
            .env("GIT_AUTHOR_EMAIL", "phantom@example.com")
            .env("GIT_COMMITTER_NAME", "Phantom")
            .env("GIT_COMMITTER_EMAIL", "phantom@example.com")
            .output()
            .expect("git");
        assert!(
            output.status.success(),
            "{args:?} {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
}
