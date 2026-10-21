use crate::error::{Error, Result};
use crate::git;
use crate::paths;
use crate::worktree::validate_worktree_name;
use std::collections::BTreeSet;
use std::path::Path;
#[cfg(debug_assertions)]
use std::sync::atomic::{AtomicUsize, Ordering};

const ADJECTIVES: &[&str] = &[
    "amber", "bold", "brave", "bright", "calm", "clever", "crimson", "eager", "fair", "gentle",
    "golden", "happy", "hidden", "jolly", "kind", "lively", "lucky", "misty", "nimble", "quiet",
    "rapid", "shiny", "silent", "swift", "tidy", "vivid", "warm", "wild", "witty", "young",
];

const NOUNS: &[&str] = &[
    "badger", "canyon", "comet", "falcon", "harbor", "heron", "island", "juniper", "lagoon",
    "lantern", "maple", "meadow", "otter", "pebble", "quartz", "raven", "river", "sparrow",
    "summit", "thicket", "tiger", "willow",
];

const MAX_RETRIES: usize = 10;

pub fn generate_unique_name(
    git_root: &Path,
    directory: &Path,
    separator: &str,
    remote_branches: &BTreeSet<String>,
) -> Result<String> {
    for _ in 0..MAX_RETRIES {
        let name = next_candidate();
        if validate_worktree_name(&name).is_err() {
            continue;
        }
        let path = paths::worktree_path(directory, &name, separator);
        if path.exists() {
            continue;
        }
        if git::branch_exists(git_root, &name)? {
            continue;
        }
        if remote_branches.contains(&name) {
            continue;
        }
        return Ok(name);
    }
    Err(Error::msg(
        "Failed to generate a unique workspace name after maximum retries",
    ))
}

/// `MABO_NAME_CANDIDATES` is a comma-separated list. Tests use it so the first
/// candidate can collide with a remote-tracking branch and the next one is free.
#[cfg(debug_assertions)]
static CANDIDATE_INDEX: AtomicUsize = AtomicUsize::new(0);

fn next_candidate() -> String {
    // Deterministic candidates support debug integration tests, never release builds.
    #[cfg(debug_assertions)]
    if let Ok(raw) = std::env::var("MABO_NAME_CANDIDATES") {
        let names: Vec<&str> = raw
            .split(',')
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .collect();
        let index = CANDIDATE_INDEX.fetch_add(1, Ordering::Relaxed);
        if let Some(name) = names.get(index) {
            return (*name).to_string();
        }
    }
    generate()
}

fn generate() -> String {
    let adjective = pick(ADJECTIVES);
    let noun = pick(NOUNS);
    format!("{adjective}-{noun}")
}

fn pick<'a>(words: &'a [&'a str]) -> &'a str {
    let mut bytes = [0_u8; 8];
    if let Ok(file) = std::fs::File::open("/dev/urandom") {
        use std::io::Read;
        let mut file = file;
        if file.read_exact(&mut bytes).is_ok() {
            let mut value = 0_u64;
            for byte in bytes {
                value = (value << 8) | u64::from(byte);
            }
            return words[(value as usize) % words.len()];
        }
    }
    words[0]
}
