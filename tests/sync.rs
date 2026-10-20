use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

struct Repo {
    root: PathBuf,
    main: PathBuf,
    upstream: PathBuf,
}
impl Repo {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("mabo-sync-{}", uuid::Uuid::new_v4()));
        let main = root.join("main");
        let upstream = root.join("upstream");
        fs::create_dir_all(&main).unwrap();
        let repo = Self {
            root,
            main,
            upstream,
        };
        repo.git(&repo.main, &["init", "-b", "main"]);
        repo.git(&repo.main, &["config", "user.name", "Sync Test"]);
        repo.git(&repo.main, &["config", "user.email", "sync@example.com"]);
        repo.write_commit(&repo.main, "file", "initial\n");
        repo.git(
            &repo.main,
            &[
                "clone",
                "--bare",
                repo.main.to_str().unwrap(),
                repo.root.join("remote.git").to_str().unwrap(),
            ],
        );
        repo.git(
            &repo.main,
            &[
                "remote",
                "add",
                "origin",
                repo.root.join("remote.git").to_str().unwrap(),
            ],
        );
        repo.git(&repo.main, &["fetch", "origin"]);
        repo.git(&repo.main, &["remote", "set-head", "origin", "main"]);
        repo.git(
            &repo.main,
            &[
                "clone",
                repo.root.join("remote.git").to_str().unwrap(),
                repo.upstream.to_str().unwrap(),
            ],
        );
        repo.git(&repo.upstream, &["config", "user.name", "Sync Test"]);
        repo.git(
            &repo.upstream,
            &["config", "user.email", "sync@example.com"],
        );
        repo
    }
    fn command(&self, program: &str, path: &Path, args: &[&str]) -> Command {
        let mut cmd = Command::new(program);
        cmd.args(args)
            .current_dir(path)
            .env("HOME", self.root.join("home"))
            .env("XDG_CONFIG_HOME", self.root.join("config"))
            .env("XDG_DATA_HOME", self.root.join("data"))
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_TEMPLATE_DIR", self.root.join("template"))
            .env_remove("MABO_AGENT_ID")
            .env_remove("GIT_CONFIG_COUNT")
            .env_remove("GIT_CONFIG_PARAMETERS");
        fs::create_dir_all(self.root.join("template")).unwrap();
        cmd
    }
    fn git(&self, path: &Path, args: &[&str]) -> String {
        let out = self.command("git", path, args).output().unwrap();
        assert!(
            out.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8(out.stdout).unwrap().trim().to_string()
    }
    fn mabo(&self, path: &Path, args: &[&str]) -> Output {
        self.command(env!("CARGO_BIN_EXE_mabo"), path, args)
            .output()
            .unwrap()
    }
    fn sync(&self, path: &Path, args: &[&str], code: i32) -> Value {
        let mut all = vec!["sync", "--json"];
        all.extend_from_slice(args);
        let out = self.mabo(path, &all);
        assert_eq!(
            out.status.code(),
            Some(code),
            "{} {}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        );
        serde_json::from_slice(&out.stdout).unwrap()
    }
    fn create(&self, name: &str) -> PathBuf {
        let out = self.mabo(&self.main, &["create", name, "--json"]);
        assert!(
            out.status.success(),
            "{} {}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        );
        let doc: Value = serde_json::from_slice(&out.stdout).unwrap();
        assert_eq!(doc["worktree"]["base"], "HEAD");
        PathBuf::from(doc["worktree"]["path"].as_str().unwrap())
    }
    fn write_commit(&self, path: &Path, file: &str, text: &str) {
        fs::write(path.join(file), text).unwrap();
        self.git(path, &["add", file]);
        self.git(path, &["commit", "-m", file]);
    }
    fn advance(&self) {
        self.write_commit(&self.upstream, "remote-file", "remote\n");
        self.git(&self.upstream, &["push", "origin", "main"]);
    }
    fn snapshot(&self, path: &Path) -> Value {
        json!({"head": self.git(path, &["rev-parse", "HEAD"]), "status": self.git(path, &["status", "--porcelain=v2"]), "index": self.git(path, &["write-tree"]), "files": file_contents(path)})
    }
}
impl Drop for Repo {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[test]
fn default_only_and_linked_implicit_including_subdirectory_and_detached() {
    let r = Repo::new();
    let tree = r.create("topic");
    r.write_commit(&tree, "local-file", "local\n");
    let before = r.git(&tree, &["rev-parse", "HEAD"]);
    r.advance();
    let doc = r.sync(&r.main, &[], 0);
    assert_eq!(doc["default"]["status"], "updated");
    assert_eq!(doc["worktrees"], json!([]));
    assert_eq!(r.git(&tree, &["rev-parse", "HEAD"]), before);
    fs::create_dir(tree.join("sub")).unwrap();
    let doc = r.sync(&tree.join("sub"), &[], 0);
    assert_eq!(doc["worktrees"][0]["status"], "updated");
    assert_eq!(doc["worktrees"][0]["strategy"], "rebase");
    assert_eq!(
        r.sync(&tree, &[], 0)["worktrees"][0]["status"],
        "up-to-date"
    );
    r.git(&tree, &["checkout", "--detach"]);
    assert_eq!(r.sync(&tree, &[], 0)["worktrees"][0]["status"], "detached");
}

#[test]
fn default_ref_update_linked_checkout_diverged_and_dirty() {
    let r = Repo::new();
    r.git(&r.main, &["checkout", "-b", "other"]);
    r.advance();
    let before = r.git(&r.main, &["rev-parse", "HEAD"]);
    assert_eq!(r.sync(&r.main, &[], 0)["default"]["status"], "updated");
    assert_eq!(r.git(&r.main, &["rev-parse", "HEAD"]), before);
    let linked = r.root.join("default-tree");
    r.git(
        &r.main,
        &["worktree", "add", linked.to_str().unwrap(), "main"],
    );
    r.write_commit(&r.upstream, "remote-two", "two\n");
    r.git(&r.upstream, &["push", "origin", "main"]);
    assert_eq!(r.sync(&r.main, &[], 0)["default"]["status"], "updated");
    assert!(linked.join("remote-two").exists());
    r.write_commit(&linked, "own-main", "local\n");
    let before = r.snapshot(&linked);
    assert_eq!(r.sync(&r.main, &[], 1)["default"]["status"], "diverged");
    assert_eq!(r.snapshot(&linked), before);
    let tree = r.create("topic");
    r.write_commit(&tree, "topic-file", "topic\n");
    assert_eq!(
        r.sync(&r.main, &["topic"], 0)["default"]["status"],
        "diverged"
    );
    let dirty = Repo::new();
    dirty.write_commit(&dirty.upstream, "file", "remote edit\n");
    dirty.git(&dirty.upstream, &["push", "origin", "main"]);
    fs::write(dirty.main.join("file"), "dirty edit\n").unwrap();
    let before = dirty.snapshot(&dirty.main);
    assert_eq!(
        dirty.sync(&dirty.main, &[], 1)["default"]["status"],
        "dirty"
    );
    assert_eq!(dirty.snapshot(&dirty.main), before);
}

#[test]
fn pushed_auto_merge_and_rebase_refusal_force_preserve_upstream() {
    let r = Repo::new();
    let tree = r.create("topic");
    r.write_commit(&tree, "own", "own\n");
    let before = r.git(&tree, &["rev-parse", "HEAD"]);
    r.git(&tree, &["push", "-u", "origin", "topic"]);
    r.advance();
    let refused = r.sync(&r.main, &["topic", "--rebase"], 3);
    assert_eq!(refused["worktrees"][0]["code"], "pushed");
    assert_eq!(r.git(&tree, &["rev-parse", "HEAD"]), before);
    let forced = r.sync(&r.main, &["topic", "--rebase", "--force"], 0);
    assert_eq!(forced["worktrees"][0]["strategy"], "rebase");
    assert_ne!(r.git(&tree, &["rev-parse", "HEAD"]), before);
    assert_eq!(
        r.git(&tree, &["rev-parse", "--abbrev-ref", "@{upstream}"]),
        "origin/topic"
    );
    let s = Repo::new();
    let tree = s.create("pushed");
    s.write_commit(&tree, "own", "own\n");
    s.git(&tree, &["push", "origin", "pushed"]);
    s.advance();
    let doc = s.sync(&s.main, &["pushed"], 0);
    assert_eq!(doc["worktrees"][0]["strategy"], "merge");
    assert_eq!(
        s.git(&tree, &["rev-list", "--parents", "-n", "1", "HEAD"])
            .split_whitespace()
            .count(),
        3
    );
}

#[test]
fn conflicts_restore_everything_and_keep_conflicts_is_single_target_only() {
    for strategy in ["--rebase", "--merge"] {
        let r = Repo::new();
        let tree = r.create("topic");
        r.write_commit(&tree, "file", "local edit\n");
        r.write_commit(&r.upstream, "file", "remote edit\n");
        r.git(&r.upstream, &["push", "origin", "main"]);
        fs::write(tree.join("ignored"), "ignored contents\n").unwrap();
        r.git(
            &tree,
            &[
                "config",
                "core.excludesFile",
                r.root.join("ignore").to_str().unwrap(),
            ],
        );
        fs::write(r.root.join("ignore"), "ignored\n").unwrap();
        let before = r.snapshot(&tree);
        let doc = r.sync(&tree, &[strategy], 1);
        assert_eq!(doc["worktrees"][0]["status"], "conflict");
        assert_eq!(doc["worktrees"][0]["conflicts"], json!(["file"]));
        assert_eq!(r.snapshot(&tree), before);
        assert_eq!(
            fs::read(tree.join("ignored")).unwrap(),
            b"ignored contents\n"
        );
        let doc = r.sync(&tree, &[strategy, "--keep-conflicts"], 1);
        assert_eq!(doc["worktrees"][0]["status"], "conflict");
        assert!(r.git(&tree, &["status", "--porcelain=v2"]).contains("u "));
        r.git(
            &tree,
            &[
                if strategy == "--merge" {
                    "merge"
                } else {
                    "rebase"
                },
                "--abort",
            ],
        );
        r.create("second");
        r.sync(&r.main, &["topic", "second", "--keep-conflicts"], 2);
    }
}

#[test]
fn dirty_merged_squash_base_gone_legacy_and_metadata_base() {
    let r = Repo::new();
    let tree = r.create("topic");
    r.write_commit(&tree, "topic-file", "topic\n");
    fs::write(tree.join("untracked"), "untracked\n").unwrap();
    assert_eq!(r.sync(&tree, &[], 0)["worktrees"][0]["status"], "dirty");
    fs::remove_file(tree.join("untracked")).unwrap();
    r.git(&r.main, &["merge", "--squash", "topic"]);
    r.git(&r.main, &["commit", "-m", "squash"]);
    r.git(&r.main, &["push", "origin", "main"]);
    assert_eq!(r.sync(&tree, &[], 0)["worktrees"][0]["status"], "merged");
    r.git(&r.main, &["branch", "stack"]);
    let out = r.mabo(
        &r.main,
        &["meta", "set", "topic", "--base", "stack", "--json"],
    );
    assert!(out.status.success());
    let doc: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(doc["worktree"]["base"], "refs/heads/stack");
    let invalid = r.mabo(&r.main, &["meta", "set", "topic", "--base", "nonexistent"]);
    assert!(!invalid.status.success());
    r.git(&r.main, &["branch", "-D", "stack"]);
    assert_eq!(r.sync(&tree, &[], 0)["worktrees"][0]["status"], "base-gone");
    let file = r.main.join(".git/maboroshi/worktrees.json");
    let mut stored: Value = serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
    stored["worktrees"][0]
        .as_object_mut()
        .unwrap()
        .remove("base");
    fs::write(&file, serde_json::to_vec(&stored).unwrap()).unwrap();
    assert_eq!(
        r.sync(&tree, &[], 0)["worktrees"][0]["base"],
        "refs/remotes/origin/main"
    );
}

#[test]
fn all_mine_ownership_no_default_explicit_and_forced_merge() {
    let r = Repo::new();
    for (name, owner) in [("mine", "agent"), ("other", "someone")] {
        let tree = r.create(name);
        r.write_commit(&tree, name, "work\n");
        assert!(r
            .mabo(&r.main, &["meta", "set", name, "--owner", owner])
            .status
            .success());
    }
    r.advance();
    let run = |args: &[&str]| {
        let out = r
            .command(env!("CARGO_BIN_EXE_mabo"), &r.main, args)
            .env("MABO_AGENT_ID", "agent")
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stdout)
        );
        serde_json::from_slice::<Value>(&out.stdout).unwrap()
    };
    let doc = run(&["sync", "--all", "--no-default", "--json"]);
    assert!(doc["default"].is_null());
    assert_eq!(
        doc["worktrees"]
            .as_array()
            .unwrap()
            .iter()
            .find(|v| v["name"] == "other")
            .unwrap()["status"],
        "owned"
    );
    let doc = run(&["sync", "--mine", "--json"]);
    assert_eq!(doc["worktrees"].as_array().unwrap().len(), 1);
    assert_eq!(doc["worktrees"][0]["name"], "mine");
    assert_eq!(
        run(&["sync", "other", "--merge", "--json"])["worktrees"][0]["strategy"],
        "merge"
    );
    let doc = r.sync(&r.main, &["--all"], 0);
    assert_eq!(doc["worktrees"].as_array().unwrap().len(), 2);
    r.sync(&r.main, &["--mine"], 2);
}

#[test]
fn json_schema_snapshot_and_project_selection() {
    let r = Repo::new();
    let mut doc = r.sync(&r.main, &["--project", r.main.to_str().unwrap()], 0);
    doc["default"]["path"] = json!("<path>");
    doc["default"]["before"] = json!("<sha>");
    doc["default"]["after"] = json!("<sha>");
    assert_eq!(
        doc,
        json!({"schema":1,"default":{"name":"main","path":"<path>","branch":"refs/heads/main","base":"refs/remotes/origin/main","status":"up-to-date","strategy":"ff-only","before":"<sha>","after":"<sha>","conflicts":[],"detail":null,"code":null},"worktrees":[]})
    );
    let tree = r.create("topic");
    r.write_commit(&tree, "own", "own\n");
    assert_eq!(
        r.sync(&r.main, &["topic", "-p", r.main.to_str().unwrap()], 0)["worktrees"][0]["name"],
        "topic"
    );
}

#[test]
fn sync_and_delete_serialize_during_fetch() {
    use std::os::unix::fs::PermissionsExt;
    use std::sync::mpsc;
    use std::time::{Duration, Instant};
    let r = Repo::new();
    let tree = r.create("topic");
    r.write_commit(&tree, "local", "local\n");
    r.advance();
    let gate = r.root.join("gate");
    assert!(Command::new("mkfifo")
        .arg(&gate)
        .status()
        .unwrap()
        .success());
    let entered = r.root.join("entered");
    let script = r.root.join("upload-pack");
    fs::write(
        &script,
        format!(
            "#!/bin/sh\nprintf ready > '{}'\nread release < '{}'\nexec git-upload-pack \"$@\"\n",
            entered.display(),
            gate.display()
        ),
    )
    .unwrap();
    fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();
    r.git(
        &r.main,
        &[
            "config",
            "remote.origin.uploadpack",
            script.to_str().unwrap(),
        ],
    );
    let mut sync = r
        .command(
            env!("CARGO_BIN_EXE_mabo"),
            &r.main,
            &["sync", "topic", "--json"],
        )
        .stdout(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    while !entered.exists() {
        assert!(
            sync.try_wait().unwrap().is_none(),
            "sync exited before fetch"
        );
        assert!(Instant::now() < deadline, "fetch did not start");
        std::thread::sleep(Duration::from_millis(5));
    }
    let mut delete = r.command(
        env!("CARGO_BIN_EXE_mabo"),
        &r.main,
        &["delete", "topic", "--force", "--no-hooks", "--json"],
    );
    let (tx, rx) = mpsc::channel();
    let child = delete.stdout(std::process::Stdio::piped()).spawn().unwrap();
    let waiter = std::thread::spawn(move || {
        tx.send(child.wait_with_output().unwrap()).unwrap();
    });
    assert!(
        rx.recv_timeout(Duration::from_millis(150)).is_err(),
        "delete passed the lock during sync fetch"
    );
    assert!(tree.exists());
    fs::write(&gate, "release\n").unwrap();
    let synced = sync.wait_with_output().unwrap();
    assert!(
        synced.status.success(),
        "{}",
        String::from_utf8_lossy(&synced.stdout)
    );
    let deleted = rx.recv_timeout(Duration::from_secs(5)).unwrap();
    assert!(deleted.status.success());
    waiter.join().unwrap();
    assert!(!tree.exists());
}

#[test]
fn fetch_only_involved_remotes_once_and_failed_fetch_cannot_update_stale_base() {
    let r = Repo::new();
    let tree = r.create("topic");
    r.write_commit(&tree, "own", "own\n");
    r.advance();
    r.git(&r.main, &["remote", "add", "unrelated", "/does/not/exist"]);
    let trace = r.root.join("trace");
    let out = r
        .command(
            env!("CARGO_BIN_EXE_mabo"),
            &r.main,
            &["sync", "topic", "--json"],
        )
        .env("GIT_TRACE", &trace)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stdout)
    );
    let trace = fs::read_to_string(&trace).unwrap();
    assert_eq!(
        trace
            .matches("built-in: git fetch --prune -- origin")
            .count(),
        1
    );
    assert!(!trace.contains("fetch --prune -- unrelated"));
    r.git(&r.main, &["remote", "set-url", "origin", "/does/not/exist"]);
    let before = r.snapshot(&tree);
    let doc = r.sync(&tree, &[], 1);
    assert_eq!(doc["worktrees"][0]["status"], "failed");
    assert_eq!(r.snapshot(&tree), before);
}

#[test]
fn sync_runs_no_git_hooks_and_does_not_update_other_refs() {
    use std::os::unix::fs::PermissionsExt;
    let r = Repo::new();
    let tree = r.create("topic");
    r.write_commit(&tree, "own", "own\n");
    r.git(&tree, &["branch", "other-ref"]);
    let old = r.git(&tree, &["rev-parse", "other-ref"]);
    let hooks = r.root.join("hooks");
    fs::create_dir_all(&hooks).unwrap();
    let marker = r.root.join("hook-ran");
    for name in [
        "reference-transaction",
        "post-merge",
        "pre-rebase",
        "post-rewrite",
        "post-checkout",
    ] {
        let file = hooks.join(name);
        fs::write(&file, format!("#!/bin/sh\ntouch '{}'\n", marker.display())).unwrap();
        fs::set_permissions(file, fs::Permissions::from_mode(0o755)).unwrap();
    }
    r.git(
        &r.main,
        &["config", "core.hooksPath", hooks.to_str().unwrap()],
    );
    r.git(&r.main, &["config", "rebase.updateRefs", "true"]);
    r.advance();
    assert_eq!(r.sync(&tree, &[], 0)["worktrees"][0]["status"], "updated");
    assert!(!marker.exists());
    assert_eq!(r.git(&tree, &["rev-parse", "other-ref"]), old);
    r.git(&r.main, &["checkout", "-b", "non-default"]);
    fs::remove_file(&marker).unwrap();
    r.write_commit(&r.upstream, "remote-more", "more\n");
    r.git(&r.upstream, &["push", "origin", "main"]);
    r.sync(&r.main, &[], 0);
    assert!(!marker.exists());
}

#[test]
fn ignored_files_are_preserved_when_base_would_overwrite_them() {
    let r = Repo::new();
    let tree = r.create("topic");
    r.write_commit(&tree, "own", "own\n");
    let ignore = r.root.join("ignore");
    fs::write(&ignore, "valuable\n").unwrap();
    r.git(
        &tree,
        &["config", "core.excludesFile", ignore.to_str().unwrap()],
    );
    fs::write(tree.join("valuable"), "precious ignored data\n").unwrap();
    r.write_commit(&r.upstream, "valuable", "remote tracked data\n");
    r.git(&r.upstream, &["push", "origin", "main"]);
    let before = r.snapshot(&tree);
    assert_eq!(r.sync(&tree, &[], 0)["worktrees"][0]["status"], "dirty");
    assert_eq!(r.snapshot(&tree), before);
    assert_eq!(
        fs::read(tree.join("valuable")).unwrap(),
        b"precious ignored data\n"
    );
}

fn file_contents(root: &Path) -> std::collections::BTreeMap<String, Vec<u8>> {
    fn collect(root: &Path, dir: &Path, files: &mut std::collections::BTreeMap<String, Vec<u8>>) {
        for entry in fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path == root.join(".git") {
                continue;
            }
            if path.is_dir() {
                collect(root, &path, files);
            } else {
                files.insert(
                    path.strip_prefix(root)
                        .unwrap()
                        .to_string_lossy()
                        .into_owned(),
                    fs::read(path).unwrap(),
                );
            }
        }
    }
    let mut files = std::collections::BTreeMap::new();
    collect(root, root, &mut files);
    files
}

#[test]
fn multiple_bases_fetch_each_involved_remote_and_respect_no_default() {
    let r = Repo::new();
    let tree = r.create("topic");
    r.write_commit(&tree, "own", "own\n");
    let remote = r.root.join("stack.git");
    r.git(
        &r.main,
        &[
            "clone",
            "--bare",
            r.main.to_str().unwrap(),
            remote.to_str().unwrap(),
        ],
    );
    r.git(
        &r.main,
        &["remote", "add", "stack", remote.to_str().unwrap()],
    );
    r.git(&r.main, &["fetch", "stack"]);
    assert!(r
        .mabo(&r.main, &["meta", "set", "topic", "--base", "stack/main"])
        .status
        .success());
    r.git(&r.main, &["remote", "set-url", "origin", "/does/not/exist"]);
    let doc = r.sync(&tree, &["--no-default"], 0);
    assert_eq!(doc["worktrees"][0]["base"], "refs/remotes/stack/main");
    r.git(
        &r.main,
        &[
            "remote",
            "set-url",
            "origin",
            r.root.join("remote.git").to_str().unwrap(),
        ],
    );
    let trace = r.root.join("trace");
    let out = r
        .command(
            env!("CARGO_BIN_EXE_mabo"),
            &r.main,
            &["sync", "topic", "--json"],
        )
        .env("GIT_TRACE", &trace)
        .output()
        .unwrap();
    assert!(out.status.success());
    let trace = fs::read_to_string(trace).unwrap();
    assert_eq!(
        trace
            .matches("built-in: git fetch --prune -- origin")
            .count(),
        1
    );
    assert_eq!(
        trace
            .matches("built-in: git fetch --prune -- stack")
            .count(),
        1
    );
}

#[test]
fn dirty_staged_and_unstaged_worktrees_are_untouched() {
    let r = Repo::new();
    let tree = r.create("topic");
    r.write_commit(&tree, "own", "own\n");
    r.advance();
    fs::write(tree.join("file"), "local edit\n").unwrap();
    for staged in [false, true] {
        if staged {
            r.git(&tree, &["add", "file"]);
        }
        let before = r.snapshot(&tree);
        assert_eq!(r.sync(&tree, &[], 0)["worktrees"][0]["status"], "dirty");
        assert_eq!(r.snapshot(&tree), before);
    }
}

#[test]
fn separate_git_directory_default_checkout_and_published_squash_are_supported() {
    let r = Repo::new();
    let tree = r.create("topic");
    r.write_commit(&tree, "own", "own\n");
    r.git(&tree, &["push", "origin", "topic"]);
    r.git(&r.upstream, &["fetch", "origin"]);
    r.git(&r.upstream, &["merge", "--squash", "origin/topic"]);
    r.git(&r.upstream, &["commit", "-m", "squash"]);
    r.git(&r.upstream, &["push", "origin", "main"]);
    assert_eq!(r.sync(&tree, &[], 0)["worktrees"][0]["status"], "merged");
    // Use a fresh repository: Git does not relocate linked-worktree gitfiles on re-init.
    let s = Repo::new();
    s.git(
        &s.main,
        &[
            "init",
            "--separate-git-dir",
            s.root.join("git-dir").to_str().unwrap(),
        ],
    );
    s.advance();
    assert_eq!(s.sync(&s.main, &[], 0)["default"]["status"], "updated");
}

#[test]
fn human_output_and_usage_errors() {
    let r = Repo::new();
    let out = r.mabo(&r.main, &["sync"]);
    assert!(out.status.success());
    let text = String::from_utf8(out.stdout).unwrap();
    let lines: Vec<&str> = text.lines().collect();
    assert_eq!(lines.len(), 2);
    assert!(lines[0].starts_with("main  up-to-date"));
    assert!(lines[1].starts_with("Sync complete:"));
    for args in [
        vec!["--all", "--mine"],
        vec!["--all", "topic"],
        vec!["--rebase", "--merge"],
        vec!["--keep-conflicts"],
        vec!["--bad-flag"],
    ] {
        r.sync(&r.main, &args, 2);
    }
}
