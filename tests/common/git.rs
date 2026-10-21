// Each test binary uses only the helpers its fixtures need.
#![allow(dead_code)]

use std::{ffi::OsStr, fs, path::Path, process::Command};

// Background maintenance can prune entries in .git/worktrees while a test is
// asserting on them. Disable both modern maintenance and older automatic GC.
const CONFIG: &str = "[maintenance]\n\tauto = false\n[gc]\n\tauto = 0\n";

pub fn write_config(home: &Path) {
    fs::write(home.join(".gitconfig"), CONFIG).expect("gitconfig");
}

pub fn command(program: impl AsRef<OsStr>) -> Command {
    let mut command = Command::new(program);
    // Also reaches Git children (including those started by mabo) when the
    // fixture does not use an isolated HOME. Local push receivers clear these
    // variables, so configure their repositories with configure_repo first.
    command
        .env("GIT_CONFIG_COUNT", "2")
        .env("GIT_CONFIG_KEY_0", "maintenance.auto")
        .env("GIT_CONFIG_VALUE_0", "false")
        .env("GIT_CONFIG_KEY_1", "gc.auto")
        .env("GIT_CONFIG_VALUE_1", "0");
    command
}

pub fn configure_repo(repo: &Path) {
    // Persist the settings for production Git calls and local push receivers.
    for (key, value) in [("maintenance.auto", "false"), ("gc.auto", "0")] {
        let output = command("git")
            .args(["config", "--local", key, value])
            .current_dir(repo)
            .output()
            .expect("git config");
        assert!(
            output.status.success(),
            "git config {key}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
}
