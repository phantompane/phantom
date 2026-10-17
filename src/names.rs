use crate::error::{Error, Result};
use crate::git;
use crate::paths;
use crate::worktree::validate_worktree_name;
use std::path::Path;

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

pub fn generate_unique_name(git_root: &Path, directory: &Path, separator: &str) -> Result<String> {
    for _ in 0..MAX_RETRIES {
        let name = generate();
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
        return Ok(name);
    }
    Err(Error::msg(
        "Failed to generate a unique worktree name after maximum retries",
    ))
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
