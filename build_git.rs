use std::path::{Path, PathBuf};
use std::process::Command;

pub fn head_watch_paths(cwd: &Path) -> Vec<PathBuf> {
    let Ok(head) = git_path(cwd, "HEAD") else {
        return Vec::new();
    };
    let mut paths = Vec::new();
    if head.is_file() {
        paths.push(head.clone());
    }
    if let Ok(text) = std::fs::read_to_string(&head) {
        if let Some(reference) = text.trim().strip_prefix("ref: ") {
            if let Ok(reference_path) = git_path(cwd, reference) {
                if reference_path.is_file() {
                    paths.push(reference_path);
                }
            }
        }
    }
    if let Ok(packed) = git_path(cwd, "packed-refs") {
        if packed.is_file() {
            paths.push(packed);
        }
    }
    paths
}

fn git_path(cwd: &Path, name: &str) -> std::io::Result<PathBuf> {
    let output = Command::new("git")
        .args(["rev-parse", "--git-path", name])
        .current_dir(cwd)
        .output()?;
    if !output.status.success() {
        return Err(std::io::Error::other("git rev-parse --git-path failed"));
    }
    let text = String::from_utf8(output.stdout)
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))?;
    let printed = text.trim();
    if printed.is_empty() {
        return Err(std::io::Error::other("git rev-parse --git-path was empty"));
    }
    let path = PathBuf::from(printed);
    if path.is_absolute() {
        Ok(path)
    } else {
        Ok(cwd.join(path))
    }
}
