use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;

struct TempTree {
    path: PathBuf,
}

impl TempTree {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "mabo-pull-head-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        fs::create_dir_all(&path).expect("temp");
        Self { path }
    }
}

impl Drop for TempTree {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

fn git(cwd: &Path, args: &[&str]) -> std::process::Output {
    let output = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_AUTHOR_NAME", "Mabo")
        .env("GIT_AUTHOR_EMAIL", "mabo@example.com")
        .env("GIT_COMMITTER_NAME", "Mabo")
        .env("GIT_COMMITTER_EMAIL", "mabo@example.com")
        .output()
        .expect("git");
    assert!(
        output.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    output
}

fn git_text(cwd: &Path, args: &[&str]) -> String {
    String::from_utf8(git(cwd, args).stdout)
        .expect("utf8")
        .trim()
        .to_string()
}

/// Remote has `refs/pull/843/head` and no `deleted-feature` branch.
fn deleted_pr_remote(root: &Path) -> (PathBuf, String) {
    let origin = root.join("origin.git");
    let seed = root.join("seed");
    let clone = root.join("clone");
    git(
        root,
        &[
            "init",
            "--bare",
            "-b",
            "main",
            origin.to_str().expect("origin"),
        ],
    );
    git(root, &["init", "-b", "main", seed.to_str().expect("seed")]);
    git(&seed, &["commit", "--allow-empty", "-m", "main"]);
    git(
        &seed,
        &[
            "remote",
            "add",
            "origin",
            origin.to_str().expect("origin url"),
        ],
    );
    git(&seed, &["push", "origin", "main"]);
    git(&seed, &["checkout", "-b", "deleted-feature"]);
    fs::write(seed.join("pr.txt"), "pull 843\n").expect("file");
    git(&seed, &["add", "pr.txt"]);
    git(&seed, &["commit", "-m", "pr head"]);
    let commit = git_text(&seed, &["rev-parse", "HEAD"]);
    git(&seed, &["push", "origin", "deleted-feature"]);
    git(&origin, &["update-ref", "refs/pull/843/head", &commit]);
    git(&seed, &["push", "origin", ":deleted-feature"]);
    git(
        root,
        &[
            "clone",
            origin.to_str().expect("origin url"),
            clone.to_str().expect("clone"),
        ],
    );
    let heads = git_text(
        &clone,
        &["ls-remote", "origin", "refs/heads/deleted-feature"],
    );
    assert!(
        heads.is_empty(),
        "the PR branch must stay deleted, got {heads}"
    );
    let pull = git_text(&clone, &["ls-remote", "origin", "refs/pull/843/head"]);
    assert!(
        pull.starts_with(&commit),
        "origin must advertise refs/pull/843/head, got {pull}"
    );
    (clone, commit)
}

fn fake_gh(bin: &Path) {
    fs::create_dir_all(bin).expect("bin");
    let script = bin.join("gh");
    fs::write(
        &script,
        r#"#!/bin/sh
set -eu
if [ "$1" = "repo" ]; then
  printf '%s\n' '{"url":"https://github.com/acme/tool","owner":{"login":"acme"},"name":"tool"}'
  exit 0
fi
if [ "$1" = "api" ]; then
  case "$2" in
    */issues/843)
      printf '%s\n' '{"number":843,"pull_request":{}}'
      exit 0
      ;;
    */pulls/843)
      printf '%s\n' '{"number":843,"head":{"ref":"deleted-feature","repo":{"full_name":"acme/tool"}},"base":{"repo":{"full_name":"acme/tool"}}}'
      exit 0
      ;;
  esac
fi
echo "unexpected gh invocation: $*" >&2
exit 1
"#,
    )
    .expect("gh script");
    let mut permissions = fs::metadata(&script).expect("meta").permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(&script, permissions).expect("chmod");
}

#[test]
fn gh_checkout_uses_pull_head_when_the_branch_is_deleted() {
    let tree = TempTree::new();
    let (clone, commit) = deleted_pr_remote(&tree.path);
    let bin = tree.path.join("bin");
    fake_gh(&bin);
    let data = tree.path.join("data");
    let config = tree.path.join("config");
    let home = tree.path.join("home");
    let path = format!("{}:{}", bin.display(), std::env::var("PATH").expect("PATH"));
    let output = Command::new(env!("CARGO_BIN_EXE_mabo"))
        .args(["gh", "checkout", "843", "--no-hooks", "--json"])
        .current_dir(&clone)
        .env("PATH", path)
        .env("HOME", &home)
        .env("XDG_DATA_HOME", &data)
        .env("XDG_CONFIG_HOME", &config)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .output()
        .expect("mabo");
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        output.status.success(),
        "mabo gh checkout 843 failed\nstdout:\n{stdout}\nstderr:\n{stderr}"
    );
    assert!(
        !stderr.contains("couldn't find remote ref"),
        "checkout still fetched the deleted branch\n{stderr}"
    );
    let document: serde_json::Value = serde_json::from_str(&stdout).expect("json");
    assert_eq!(document["github"]["kind"], "pullRequest");
    assert_eq!(document["github"]["number"], 843);
    assert_eq!(document["github"]["headRef"], "deleted-feature");
    assert_eq!(document["worktree"]["branch"], "deleted-feature");
    assert_eq!(document["worktree"]["detached"], false);
    assert_eq!(document["worktree"]["head"], commit);
    let worktree = document["worktree"]["path"].as_str().expect("path");
    let checked_out = git_text(Path::new(worktree), &["rev-parse", "HEAD"]);
    assert_eq!(checked_out, commit);
    let branch = git_text(Path::new(worktree), &["branch", "--show-current"]);
    assert_eq!(branch, "deleted-feature");
}
