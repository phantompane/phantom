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

    let mut cloned = false;
    let mut updated = false;
    if destination_exists(&destination)? {
        ensure_matching_repository(&destination, &spec)?;
        if request.update {
            fetch_origin(&destination)?;
            updated = true;
        }
    } else {
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent).map_err(|error| {
                Error::msg(format!("Failed to create {}: {error}", parent.display()))
            })?;
        }
        if let Err(error) = clone_with_git(&spec.remote_url, &destination, branch, depth) {
            remove_partial_clone(&destination);
            return Err(error);
        }
        cloned = true;
    }

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
    let git_roots = read_git_ghq_roots()?;
    let ghq_root = std::env::var("GHQ_ROOT").ok();
    resolve_repository_root_from(
        config_root.as_deref(),
        &git_roots,
        ghq_root.as_deref(),
        &home,
    )
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
    git_roots: &[String],
    ghq_root: Option<&str>,
    home: &Path,
) -> Result<PathBuf> {
    if let Some(value) = nonempty(config_root) {
        return expand_absolute_path(value, home, "root");
    }
    if let Some(value) = git_roots
        .iter()
        .find_map(|value| nonempty(Some(value.as_str())))
    {
        return expand_absolute_path(value, home, "git config ghq.root");
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

fn register_repository(destination: &Path) -> Result<String> {
    let root = crate::projects::resolve_project_root(destination)?;
    let store = ProjectRegistryStore::default_store()?;
    let (project, _) = store.add(&root)?;
    Ok(project.root_path)
}

fn ensure_matching_repository(path: &Path, spec: &RepoSpec) -> Result<()> {
    if !is_directory(path) || !is_git_repository(path)? {
        return Err(Error::validation(format!(
            "{} exists but is not a Git repository.",
            path.display()
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
            "{} is a Git repository with origin '{actual}', which does not match '{}' ({}/{}/{}).",
            path.display(),
            spec.remote_url,
            spec.host,
            spec.owner,
            spec.repo
        )));
    }
    Ok(())
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

fn is_git_repository(path: &Path) -> Result<bool> {
    let path = path_arg(path)?;
    match process::raw("git", &["-C", &path, "rev-parse", "--git-dir"], None) {
        Ok(captured) => Ok(captured.code == 0),
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
            "Unsupported URL scheme '{scheme}' in '{input}'. Expected https, http, or ssh."
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
    Ok(RepoSpec {
        host,
        owner,
        repo,
        remote_url: input.trim_end_matches('/').to_string(),
    })
}

fn parse_scp(input: &str, left: &str, path: &str) -> Result<RepoSpec> {
    if left.is_empty() || path.is_empty() || left.contains('/') {
        return Err(invalid_source(input));
    }
    let host = match left.rsplit_once('@') {
        Some((_, host)) if !host.is_empty() => host,
        Some(_) => return Err(invalid_source(input)),
        None => left,
    };
    validate_host(input, host)?;
    let (owner, repo) = owner_repo_from_path(input, path)?;
    Ok(RepoSpec {
        host: host.to_string(),
        owner,
        repo,
        remote_url: input.trim_end_matches('/').to_string(),
    })
}

fn parse_shorthand(input: &str) -> Result<RepoSpec> {
    let (host, owner, repo) = match path_segments(input) {
        Some(segments) if segments.len() == 2 => ("github.com", segments[0], segments[1]),
        Some(segments) if segments.len() == 3 => (segments[0], segments[1], segments[2]),
        _ => return Err(invalid_path(input)),
    };
    validate_host(input, host)?;
    let owner = validate_component(input, owner, "owner")?;
    let repo = validate_repo_name(input, repo)?;
    Ok(RepoSpec {
        remote_url: format!("https://{host}/{owner}/{repo}.git"),
        host: host.to_string(),
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
    let host = if let Some(rest) = hostport.strip_prefix('[') {
        let Some(end) = rest.find(']') else {
            return Err(invalid_source(input));
        };
        if end == 0 {
            return Err(invalid_source(input));
        }
        let after = &rest[end + 1..];
        if !(after.is_empty() || is_numeric_port(after)) {
            return Err(invalid_source(input));
        }
        &rest[..end]
    } else if let Some((host, port)) = hostport.rsplit_once(':') {
        if host.is_empty() || !is_port_number(port) {
            return Err(invalid_source(input));
        }
        host
    } else {
        hostport
    };
    validate_host(input, host)?;
    Ok(host.to_string())
}

fn is_numeric_port(value: &str) -> bool {
    value.strip_prefix(':').is_some_and(is_port_number)
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
            "Invalid {label} '{value}' in repository '{input}'."
        )));
    }
    Ok(value.to_string())
}

fn same_repository(expected: &RepoSpec, actual_url: &str) -> bool {
    match parse_clone_source(actual_url) {
        Ok(actual) => {
            actual.host.eq_ignore_ascii_case(&expected.host)
                && actual.owner == expected.owner
                && actual.repo == expected.repo
        }
        Err(_) => false,
    }
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

fn remove_partial_clone(path: &Path) {
    if fs::symlink_metadata(path).is_err() {
        return;
    }
    if fs::remove_dir_all(path).is_err() {
        let _ = fs::remove_file(path);
    }
}

fn invalid_source(input: &str) -> Error {
    Error::validation(format!(
        "Invalid repository '{input}'. Expected an http(s) URL, an ssh:// URL, an scp-style git@host:owner/repo path, host/owner/repo, or owner/repo."
    ))
}

fn invalid_path(input: &str) -> Error {
    Error::validation(format!(
        "Invalid repository '{input}'. Expected a path of <owner>/<repo> or <host>/<owner>/<repo>."
    ))
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
                "https://user:token@github.com/aku11i/phantom.git",
            ),
            (
                "http://gitlab.example.com:8443/group/repo.git",
                "gitlab.example.com",
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
                "github.com",
                "aku11i",
                "phantom",
                "ssh://git@github.com:22/aku11i/phantom.git",
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
        let mixed = spec("https://GitHub.com/Aku11i/Phantom.git");
        assert!(same_repository(&mixed, "git@github.com:Aku11i/Phantom.git"));
        assert!(!same_repository(
            &mixed,
            "git@github.com:aku11i/phantom.git"
        ));
    }

    #[test]
    fn root_resolution_follows_config_then_git_then_env_then_home() {
        let home = Path::new("/home/phantom");
        let config = resolve_repository_root_from(
            Some("~/from-config"),
            &["/from-git".to_string(), "/second".to_string()],
            Some("/from-env"),
            home,
        )
        .expect("config");
        assert_eq!(config, PathBuf::from("/home/phantom/from-config"));

        let git = resolve_repository_root_from(
            Some("  "),
            &["~/from-git".to_string(), "/second".to_string()],
            Some("/from-env"),
            home,
        )
        .expect("git");
        assert_eq!(git, PathBuf::from("/home/phantom/from-git"));

        let env = resolve_repository_root_from(None, &[], Some("~/from-env"), home).expect("env");
        assert_eq!(env, PathBuf::from("/home/phantom/from-env"));

        let default = resolve_repository_root_from(None, &[], Some("   "), home).expect("default");
        assert_eq!(default, PathBuf::from("/home/phantom/ghq"));

        let relative = resolve_repository_root_from(Some("relative/root"), &[], None, home)
            .expect_err("relative");
        assert!(relative.to_string().contains("absolute"), "{relative}");
        let user = resolve_repository_root_from(None, &["~other/src".to_string()], None, home)
            .expect_err("user");
        assert!(user.to_string().contains("~/"), "{user}");
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
}
