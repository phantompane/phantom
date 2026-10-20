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
fn default_upstream_ignores_child_branch_without_remote_head() {
    for has_upstream in [false, true] {
        let r = Repo::new();
        r.git(&r.main, &["remote", "set-head", "origin", "--delete"]);
        let before = r.git(&r.main, &["rev-parse", "main"]);
        r.git(&r.upstream, &["push", "origin", "main:trunk"]);
        r.advance();
        r.git(&r.upstream, &["push", "origin", "main:child"]);
        r.git(&r.main, &["fetch", "origin"]);
        let child_tip = r.git(&r.main, &["rev-parse", "origin/main"]);
        r.git(
            &r.main,
            &["update-ref", "refs/remotes/origin/child", &child_tip],
        );
        r.git(
            &r.main,
            &["update-ref", "refs/remotes/origin/main", &before],
        );
        // A packed-ref fixture represents the prefix collision that Git's normal
        // branch creation rejects. Both refs remain readable by ref enumeration.
        r.git(&r.main, &["pack-refs", "--all"]);
        let packed = r.main.join(".git/packed-refs");
        let mut refs = fs::read_to_string(&packed).unwrap();
        refs.push_str(&format!("{child_tip} refs/heads/main/foo\n"));
        let mut lines: Vec<_> = refs.lines().collect();
        lines.sort_by_key(|line| line.split_once(' ').map(|(_, name)| name).unwrap_or(line));
        fs::write(packed, lines.join("\n") + "\n").unwrap();
        r.git(&r.main, &["config", "branch.main/foo.remote", "origin"]);
        r.git(
            &r.main,
            &["config", "branch.main/foo.merge", "refs/heads/child"],
        );
        if has_upstream {
            r.git(
                &r.main,
                &["update-ref", "refs/remotes/origin/trunk", &before],
            );
            r.git(&r.main, &["config", "branch.main.remote", "origin"]);
            r.git(
                &r.main,
                &["config", "branch.main.merge", "refs/heads/trunk"],
            );
        }
        // Keep the deliberately distinct tracking tips unchanged during sync.
        r.git(
            &r.main,
            &["config", "--add", "remote.origin.fetch", "^refs/heads/main"],
        );
        assert_eq!(
            r.git(&r.main, &["rev-parse", "refs/heads/main/foo"]),
            child_tip
        );
        let doc = r.sync(&r.main, &[], 0);
        assert_eq!(doc["default"]["status"], "up-to-date");
        assert_eq!(
            doc["default"]["base"],
            if has_upstream {
                "refs/remotes/origin/trunk"
            } else {
                "refs/remotes/origin/main"
            }
        );
        assert_eq!(r.git(&r.main, &["rev-parse", "main"]), before);
    }
}

#[test]
fn default_without_remote_head_uses_differently_named_upstream() {
    for tracking in [
        "refs/remotes/origin/trunk",
        "refs/remotes/origin/mapped/trunk",
    ] {
        for checked_out in [true, false] {
            let r = Repo::new();
            r.git(&r.main, &["remote", "set-head", "origin", "--delete"]);
            r.git(&r.upstream, &["push", "origin", "main:trunk"]);
            if tracking.contains("/mapped/") {
                r.git(
                    &r.main,
                    &[
                        "config",
                        "remote.origin.fetch",
                        "+refs/heads/*:refs/remotes/origin/mapped/*",
                    ],
                );
            }
            r.git(&r.main, &["fetch", "origin"]);
            r.git(&r.main, &["config", "branch.main.remote", "origin"]);
            r.git(
                &r.main,
                &["config", "branch.main.merge", "refs/heads/trunk"],
            );
            if !checked_out {
                r.git(&r.main, &["update-ref", "-d", "refs/remotes/origin/main"]);
            }
            // Neither a missing nor a stale origin/main may override the upstream.
            let tree = r.create("topic");
            let doc = r.sync(&tree, &["--no-default"], 0);
            assert_eq!(doc["worktrees"][0]["base"], tracking);
            if !checked_out {
                r.git(&r.main, &["checkout", "-b", "other"]);
            }
            r.write_commit(&r.upstream, "remote-trunk", "advanced\n");
            r.git(&r.upstream, &["push", "origin", "main:trunk"]);
            let expected = r.git(&r.upstream, &["rev-parse", "HEAD"]);
            assert_ne!(r.git(&r.main, &["rev-parse", tracking]), expected);
            let doc = r.sync(&r.main, &[], 0);
            assert_eq!(doc["default"]["status"], "updated");
            assert_eq!(doc["default"]["branch"], "refs/heads/main");
            assert_eq!(doc["default"]["base"], tracking);
            assert_eq!(r.git(&r.main, &["rev-parse", "main"]), expected);
            assert_eq!(r.git(&r.main, &["rev-parse", tracking]), expected);
            assert_eq!(r.git(&r.main, &["for-each-ref", "refs/heads/trunk"]), "");
            assert_eq!(r.sync(&r.main, &[], 0)["default"]["status"], "up-to-date");
        }
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
fn linked_default_is_only_integrated_fast_forward_once() {
    for diverged in [false, true] {
        let r = Repo::new();
        r.git(&r.main, &["checkout", "-b", "other"]);
        let tree = r.root.join("default-tree");
        r.git(
            &r.main,
            &["worktree", "add", tree.to_str().unwrap(), "main"],
        );
        let out = r.mabo(
            &r.main,
            &[
                "meta", "set", "main", "--owner", "tester", "--base", "other",
            ],
        );
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        if diverged {
            r.write_commit(&tree, "own-main", "local\n");
        }
        r.advance();
        let before = r.snapshot(&tree);
        let other = r.git(&r.main, &["rev-parse", "HEAD"]);
        for args in [vec!["--no-default"], vec!["--no-default", "--all"]] {
            let doc = r.sync(&tree, &args, 0);
            assert!(doc["default"].is_null());
            assert_eq!(doc["worktrees"], json!([]));
            assert_eq!(r.snapshot(&tree), before);
        }
        let mut cmd = r.command(
            env!("CARGO_BIN_EXE_mabo"),
            &tree,
            &["sync", "--mine", "--no-default", "--json"],
        );
        let out = cmd.env("MABO_AGENT_ID", "tester").output().unwrap();
        assert!(out.status.success());
        let doc: Value = serde_json::from_slice(&out.stdout).unwrap();
        assert_eq!(doc["worktrees"], json!([]));
        assert_eq!(r.snapshot(&tree), before);
        let status = if diverged { "diverged" } else { "updated" };
        let doc = r.sync(&tree, &["main", "--no-default", "--rebase", "--force"], 0);
        assert!(doc["default"].is_null());
        assert_eq!(doc["worktrees"].as_array().unwrap().len(), 1);
        assert_eq!(doc["worktrees"][0]["status"], status);
        assert_eq!(doc["worktrees"][0]["strategy"], "ff-only");
        if diverged {
            assert_eq!(r.snapshot(&tree), before);
        } else {
            r.write_commit(&r.upstream, "remote-two", "two\n");
            r.git(&r.upstream, &["push", "origin", "main"]);
        }
        for (i, args) in [vec![], vec!["--all"], vec!["main", "--merge"]]
            .iter()
            .enumerate()
        {
            let doc = r.sync(&tree, args, if diverged { 1 } else { 0 });
            assert_eq!(doc["worktrees"], json!([]));
            assert_eq!(
                doc["default"]["status"],
                if diverged {
                    "diverged"
                } else if i == 0 {
                    "updated"
                } else {
                    "up-to-date"
                }
            );
            assert_eq!(doc["default"]["path"], tree.to_str().unwrap());
            if diverged {
                assert_eq!(r.snapshot(&tree), before);
            }
        }
        let out = r
            .command(
                env!("CARGO_BIN_EXE_mabo"),
                &tree,
                &["sync", "--mine", "--json"],
            )
            .env("MABO_AGENT_ID", "tester")
            .output()
            .unwrap();
        assert_eq!(out.status.code(), Some(if diverged { 1 } else { 0 }));
        let doc: Value = serde_json::from_slice(&out.stdout).unwrap();
        assert_eq!(doc["worktrees"], json!([]));
        assert_eq!(r.git(&r.main, &["rev-parse", "HEAD"]), other);
    }
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
fn pushed_branch_containing_base_is_up_to_date_without_force() {
    let r = Repo::new();
    let tree = r.create("topic");
    r.write_commit(&tree, "own", "own\n");
    r.git(&tree, &["push", "origin", "topic"]);
    let before = r.snapshot(&tree);
    let head = r.git(&tree, &["rev-parse", "HEAD"]);
    for (args, strategy) in [
        (vec!["topic", "--rebase"], "rebase"),
        (vec!["topic"], "merge"),
        (vec!["topic", "--merge"], "merge"),
    ] {
        let doc = r.sync(&r.main, &args, 0);
        let item = &doc["worktrees"][0];
        assert_eq!(item["status"], "up-to-date");
        assert_eq!(item["strategy"], strategy);
        assert_eq!(item["before"], head);
        assert_eq!(item["after"], head);
        assert_eq!(item["code"], Value::Null);
        assert_eq!(r.snapshot(&tree), before);
    }
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
        s.git(&tree, &["log", "-1", "--format=%s"]),
        "Merge origin/main into pushed"
    );
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
    let mut child = delete
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let stderr = child.stderr.take().unwrap();
    let (waiting_tx, waiting_rx) = mpsc::channel();
    let diagnostic = std::thread::spawn(move || {
        use std::io::BufRead;
        let mut lines = std::io::BufReader::new(stderr).lines();
        waiting_tx.send(lines.next().unwrap().unwrap()).unwrap();
        assert!(
            lines.next().is_none(),
            "only one lock waiting line is allowed"
        );
    });
    let waiter = std::thread::spawn(move || {
        tx.send(child.wait_with_output().unwrap()).unwrap();
    });
    let waiting = waiting_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    assert!(waiting.starts_with("Waiting for another mabo operation to finish ("));
    assert!(
        rx.try_recv().is_err(),
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
    diagnostic.join().unwrap();
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
fn ignored_collisions_follow_core_ignorecase() {
    for ignorecase in [true, false] {
        for strategy in ["--rebase", "--merge"] {
            for (ignored, incoming) in [
                ("Secret.txt", "secret.txt"),
                ("Build/x", "build"),
                ("Build", "build/x"),
                ("Build/x", "build/y"),
            ] {
                let r = Repo::new();
                let tree = r.create("topic");
                r.write_commit(&tree, "own", "own\n");
                r.git(
                    &tree,
                    &[
                        "config",
                        "core.ignorecase",
                        if ignorecase { "true" } else { "false" },
                    ],
                );
                let ignore = r.root.join("ignore");
                fs::write(&ignore, format!("{}\n", ignored.split('/').next().unwrap())).unwrap();
                r.git(
                    &tree,
                    &["config", "core.excludesFile", ignore.to_str().unwrap()],
                );
                let valuable = tree.join(ignored);
                fs::create_dir_all(valuable.parent().unwrap()).unwrap();
                fs::write(&valuable, "precious ignored data\n").unwrap();
                fs::create_dir_all(r.upstream.join(incoming).parent().unwrap()).unwrap();
                r.write_commit(&r.upstream, incoming, "remote tracked data\n");
                r.git(&r.upstream, &["push", "origin", "main"]);
                let before = r.snapshot(&tree);
                let doc = r.sync(&tree, &[strategy, "--no-default"], 0);
                let collision = ignorecase;
                assert_eq!(
                    doc["worktrees"][0]["status"],
                    if collision { "dirty" } else { "updated" },
                    "ignorecase={ignorecase}, {strategy}, {ignored}, {incoming}"
                );
                if collision {
                    assert_eq!(r.snapshot(&tree), before);
                }
                assert_eq!(fs::read(&valuable).unwrap(), b"precious ignored data\n");
            }
        }
    }
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

#[test]
fn fresh_branches_update_but_fast_forward_landed_branches_are_merged() {
    let r = Repo::new();
    let tree = r.create("fresh");
    assert_eq!(
        r.sync(&tree, &[], 0)["worktrees"][0]["status"],
        "up-to-date"
    );
    r.advance();
    assert_eq!(r.sync(&tree, &[], 0)["worktrees"][0]["status"], "updated");
    assert_eq!(
        r.git(&tree, &["rev-parse", "HEAD"]),
        r.git(&r.main, &["rev-parse", "origin/main"])
    );
    assert_eq!(
        r.sync(&tree, &[], 0)["worktrees"][0]["status"],
        "up-to-date"
    );
    let gc = r.mabo(&r.main, &["gc", "--json"]);
    assert!(gc.status.success());
    let doc: Value = serde_json::from_slice(&gc.stdout).unwrap();
    assert!(!doc.to_string().contains("fresh"), "{doc}");
    let landed = r.create("landed");
    r.write_commit(&landed, "work", "work\n");
    r.git(&r.main, &["merge", "--ff-only", "landed"]);
    r.git(&r.main, &["push", "origin", "main"]);
    assert_eq!(r.sync(&landed, &[], 0)["worktrees"][0]["status"], "merged");
    // Legacy metadata uses the very same reflog fallback as gc.
    let legacy = r.create("legacy");
    let file = r.main.join(".git/maboroshi/worktrees.json");
    let mut stored: Value = serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
    for record in stored["worktrees"].as_array_mut().unwrap() {
        record.as_object_mut().unwrap().remove("createdFrom");
    }
    fs::write(file, serde_json::to_vec(&stored).unwrap()).unwrap();
    r.write_commit(&r.upstream, "more", "more\n");
    r.git(&r.upstream, &["pull", "--no-rebase", "origin", "main"]);
    r.git(&r.upstream, &["push", "origin", "main"]);
    assert_eq!(r.sync(&legacy, &[], 0)["worktrees"][0]["status"], "updated");
}

#[test]
fn unrecorded_fresh_syncs_keep_null_metadata_and_gc_keeps_them() {
    for no_reflog in [false, true] {
        let r = Repo::new();
        // Use the managed directory so gc's directory boundary cannot hide a failure.
        let template = r.create("template");
        let tree = template.parent().unwrap().join("topic");
        if no_reflog {
            r.git(&r.main, &["config", "core.logAllRefUpdates", "false"]);
        }
        r.git(
            &r.main,
            &[
                "worktree",
                "add",
                "-b",
                "topic",
                tree.to_str().unwrap(),
                "origin/main",
            ],
        );
        let store = r.main.join(".git/maboroshi/worktrees.json");
        let before = fs::read(&store).unwrap();
        r.advance();
        assert_eq!(
            r.sync(&r.main, &["topic"], 0)["worktrees"][0]["status"],
            "updated"
        );
        r.write_commit(&r.upstream, "second", "second\n");
        r.git(&r.upstream, &["push", "origin", "main"]);
        assert_eq!(
            r.sync(&r.main, &["topic"], 0)["worktrees"][0]["status"],
            "updated"
        );
        assert_eq!(
            r.sync(&r.main, &["topic"], 0)["worktrees"][0]["status"],
            "up-to-date"
        );
        let gc = r.mabo(&r.main, &["gc", "--json"]);
        assert!(gc.status.success());
        let doc: Value = serde_json::from_slice(&gc.stdout).unwrap();
        assert!(!doc.to_string().contains("topic"), "{doc}");
        assert_eq!(fs::read(store).unwrap(), before);
        if !no_reflog {
            r.write_commit(&r.upstream, "third", "third\n");
            r.git(&r.upstream, &["push", "origin", "main"]);
            r.git(&r.main, &["fetch", "origin"]);
            r.git(&tree, &["reset", "--hard", "origin/main"]);
            assert_eq!(
                r.sync(&r.main, &["topic"], 0)["worktrees"][0]["status"],
                "merged"
            );
            let gc = r.mabo(&r.main, &["gc", "--json"]);
            assert!(String::from_utf8_lossy(&gc.stdout).contains("topic"));
        }
    }
}

#[test]
fn ignored_directories_collapse_and_only_incoming_paths_block_sync() {
    for collision in [false, true] {
        let r = Repo::new();
        let tree = r.create("topic");
        let ignore = r.root.join("ignore");
        fs::write(&ignore, "cache/\n").unwrap();
        r.git(
            &tree,
            &["config", "core.excludesFile", ignore.to_str().unwrap()],
        );
        fs::create_dir(tree.join("cache")).unwrap();
        for i in 0..2000 {
            fs::write(tree.join(format!("cache/{i}")), "ignored data").unwrap();
        }
        if collision {
            // A tracked file replacing an ignored directory must be protected.
            r.write_commit(&r.upstream, "cache", "incoming file\n");
        } else {
            r.advance();
        }
        r.git(&r.upstream, &["push", "origin", "main"]);
        let doc = r.sync(&tree, &[], 0);
        assert_eq!(
            doc["worktrees"][0]["status"],
            if collision { "dirty" } else { "updated" }
        );
        assert_eq!(
            fs::read_to_string(tree.join("cache/1999")).unwrap(),
            "ignored data"
        );
    }
}

#[test]
fn conflict_output_is_short_in_human_and_json_formats() {
    for strategy in ["rebase", "merge"] {
        let r = Repo::new();
        let tree = r.create("topic");
        r.write_commit(&tree, "file", "local\n");
        r.write_commit(&r.upstream, "file", "remote\n");
        r.git(&r.upstream, &["push", "origin", "main"]);
        let flag = format!("--{strategy}");
        let doc = r.sync(&tree, &[&flag], 1);
        assert_eq!(
            doc["worktrees"][0]["detail"],
            format!("{strategy} aborted; worktree unchanged")
        );
        let out = r.mabo(&tree, &["sync", &flag, "--no-default"]);
        assert_eq!(out.status.code(), Some(1));
        assert_eq!(String::from_utf8(out.stdout).unwrap(), format!("topic  conflict  file ({strategy} aborted; worktree unchanged)\nSync complete: 1 conflict\n"));
        let out = r.mabo(&tree, &["sync", &flag, "--no-default", "--keep-conflicts"]);
        assert_eq!(out.status.code(), Some(1));
        assert_eq!(
            String::from_utf8(out.stdout).unwrap(),
            format!(
                "topic  conflict  file ({strategy} left in progress)\nSync complete: 1 conflict\n"
            )
        );
    }
}

fn finish_child(mut child: std::process::Child) -> Output {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    loop {
        if child.try_wait().unwrap().is_some() {
            return child.wait_with_output().unwrap();
        }
        if std::time::Instant::now() >= deadline {
            child.kill().unwrap();
            let out = child.wait_with_output().unwrap();
            panic!(
                "command did not finish: {} {}",
                String::from_utf8_lossy(&out.stdout),
                String::from_utf8_lossy(&out.stderr)
            );
        }
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
}

#[test]
fn git_hooks_can_reenter_the_operation_lock() {
    use std::os::unix::fs::PermissionsExt;
    for hook_name in ["post-checkout", "reference-transaction"] {
        let r = Repo::new();
        r.git(&r.main, &["branch", "existing"]);
        let hook = r.main.join(".git/hooks").join(hook_name);
        fs::create_dir_all(hook.parent().unwrap()).unwrap();
        let status = r.root.join("nested-status");
        let output = r.root.join("nested-output");
        fs::write(
            &hook,
            format!(
                r#"#!/bin/sh
# Bound the nested command so a regression cannot leave orphaned lock waiters.
'{bin}' gc --json > '{output}' 2>&1 &
nested=$!
(sleep 3; kill "$nested" 2>/dev/null) >/dev/null 2>&1 &
watcher=$!
wait "$nested"
result=$?
kill "$watcher" 2>/dev/null
wait "$watcher" 2>/dev/null
echo "$result" >> '{status}'
exit "$result"
"#,
                bin = env!("CARGO_BIN_EXE_mabo"),
                output = output.display(),
                status = status.display()
            ),
        )
        .unwrap();
        fs::set_permissions(&hook, fs::Permissions::from_mode(0o755)).unwrap();
        for args in [
            vec!["create", "topic", "--json"],
            vec!["attach", "existing", "--json"],
            vec!["delete", "topic", "--force", "--json"],
        ] {
            let out = r.mabo(&r.main, &args);
            assert!(
                out.status.success(),
                "{args:?}: {} {}",
                String::from_utf8_lossy(&out.stdout),
                String::from_utf8_lossy(&out.stderr)
            );
        }
        let statuses = fs::read_to_string(&status).unwrap();
        assert!(!statuses.is_empty());
        assert!(
            statuses.lines().all(|line| line == "0"),
            "{hook_name}: {statuses}; {}",
            fs::read_to_string(output).unwrap()
        );
    }
}

#[test]
fn operation_lock_token_is_not_exported_to_project_hooks_or_exec() {
    let r = Repo::new();
    fs::write(
        r.main.join(".mabo.toml"),
        "[hooks]\npost-create = ['test -z \"${MABO_OPERATION_LOCK+x}\"']\npre-delete = ['test -z \"${MABO_OPERATION_LOCK+x}\"']\n",
    ).unwrap();
    for args in [
        vec![
            "create",
            "topic",
            "--json",
            "--exec",
            "test -z \"${MABO_OPERATION_LOCK+x}\"",
        ],
        vec!["delete", "topic", "--force", "--json"],
    ] {
        let out = r
            .command(env!("CARGO_BIN_EXE_mabo"), &r.main, &args)
            .env("MABO_TRUST_ALL", "1")
            .env("MABO_OPERATION_LOCK", "stale-inherited-token")
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "{} {}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        );
    }
}

#[test]
fn post_create_hook_can_list_and_create_and_pre_delete_hook_can_create() {
    let r = Repo::new();
    let bin = env!("CARGO_BIN_EXE_mabo");
    fs::write(r.main.join(".mabo.toml"), format!("[hooks]\npost-create = [\"'{bin}' list --json\", \"'{bin}' create nested --no-hooks\"]\n")).unwrap();
    let child = r
        .command(bin, &r.main, &["create", "outer"])
        .env("MABO_TRUST_ALL", "1")
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let out = finish_child(child);
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    fs::write(
        r.main.join(".mabo.toml"),
        format!("[hooks]\npre-delete = [\"'{bin}' create from-delete --no-hooks\"]\n"),
    )
    .unwrap();
    let child = r
        .command(bin, &r.main, &["delete", "outer", "--force"])
        .env("MABO_TRUST_ALL", "1")
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let out = finish_child(child);
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(r.mabo(&r.main, &["where", "from-delete"]).status.success());
}

#[test]
fn create_exec_releases_lock_while_command_is_running() {
    let r = Repo::new();
    let other = r.create("other");
    let gate = r.root.join("exec-gate");
    assert!(Command::new("mkfifo")
        .arg(&gate)
        .status()
        .unwrap()
        .success());
    let marker = r.root.join("exec-entered");
    let command = format!(
        "touch '{}'; read release < '{}'",
        marker.display(),
        gate.display()
    );
    let mut create = r
        .command(
            env!("CARGO_BIN_EXE_mabo"),
            &r.main,
            &["create", "agent", "--exec", &command],
        )
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    while !marker.exists() {
        assert!(
            create.try_wait().unwrap().is_none(),
            "create exited before exec"
        );
        assert!(std::time::Instant::now() < deadline, "exec did not start");
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    let delete = r
        .command(
            env!("CARGO_BIN_EXE_mabo"),
            &r.main,
            &["delete", "other", "--force", "--no-hooks", "--json"],
        )
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let deleted = finish_child(delete);
    assert!(
        deleted.status.success(),
        "{}",
        String::from_utf8_lossy(&deleted.stderr)
    );
    assert!(!other.exists());
    assert!(
        create.try_wait().unwrap().is_none(),
        "exec must still be waiting at gate"
    );
    fs::write(gate, "release\n").unwrap();
    assert!(finish_child(create).status.success());
}

#[test]
fn attach_and_gc_hooks_can_run_mabo_and_delete_rechecks_after_hooks() {
    let r = Repo::new();
    let bin = env!("CARGO_BIN_EXE_mabo");
    r.git(&r.main, &["branch", "existing"]);
    fs::write(
        r.main.join(".mabo.toml"),
        format!("[hooks]\npost-create = [\"'{bin}' create from-attach --no-hooks\"]\n"),
    )
    .unwrap();
    let child = r
        .command(bin, &r.main, &["attach", "existing"])
        .env("MABO_TRUST_ALL", "1")
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let out = finish_child(child);
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    fs::write(r.main.join(".mabo.toml"), "").unwrap();
    let tree = r.create("landed");
    r.write_commit(&tree, "work", "work\n");
    r.git(&r.main, &["merge", "--ff-only", "landed"]);
    r.git(&r.main, &["push", "origin", "main"]);
    fs::write(
        r.main.join(".mabo.toml"),
        format!("[hooks]\npre-delete = [\"'{bin}' create from-gc --no-hooks\"]\n"),
    )
    .unwrap();
    let child = r
        .command(bin, &r.main, &["gc", "--merged", "--apply", "--json"])
        .env("MABO_TRUST_ALL", "1")
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let out = finish_child(child);
    assert!(
        out.status.success(),
        "{} {}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(!tree.exists());
    assert!(r.mabo(&r.main, &["where", "from-gc"]).status.success());
    // A hook can change the target while unlocked; the old preflight is stale.
    fs::write(
        r.main.join(".mabo.toml"),
        "[hooks]\npre-delete = [\"git commit --allow-empty -m changed-by-hook\"]\n",
    )
    .unwrap();
    let child = r
        .command(bin, &r.main, &["delete", "from-attach", "--force"])
        .env("MABO_TRUST_ALL", "1")
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let out = finish_child(child);
    assert!(!out.status.success());
    assert!(String::from_utf8_lossy(&out.stderr).contains("Worktree changed"));
    assert!(r.mabo(&r.main, &["where", "from-attach"]).status.success());
}

#[test]
fn rebase_checkout_preserves_ignored_paths_deleted_by_local_commits() {
    let r = Repo::new();
    let tree = r.create("topic");
    r.git(&tree, &["rm", "file"]);
    r.git(&tree, &["commit", "-m", "delete file"]);
    let ignore = r.root.join("ignore");
    fs::write(&ignore, "file\n").unwrap();
    r.git(
        &tree,
        &["config", "core.excludesFile", ignore.to_str().unwrap()],
    );
    fs::write(tree.join("file"), "precious\n").unwrap();
    r.advance();
    assert_eq!(r.sync(&tree, &[], 0)["worktrees"][0]["status"], "dirty");
    assert_eq!(fs::read_to_string(tree.join("file")).unwrap(), "precious\n");
}

#[test]
fn ignored_paths_touched_by_intermediate_commits_are_preserved() {
    for side in ["local", "base"] {
        for shape in ["delete", "rename", "copy", "directory", "file"] {
            for strategy in ["rebase", "merge"] {
                if side == "local" && strategy == "merge" {
                    continue;
                }
                let r = Repo::new();
                let tree = r.create("topic");
                let history = if side == "local" { &tree } else { &r.upstream };
                let touched = if shape == "directory" {
                    "cache/child"
                } else {
                    "cache"
                };
                if shape == "directory" {
                    fs::create_dir(history.join("cache")).unwrap();
                }
                r.write_commit(history, touched, "temporary\n");
                if shape == "rename" {
                    r.git(history, &["mv", touched, "renamed"]);
                } else if shape == "copy" {
                    fs::copy(history.join(touched), history.join("copied")).unwrap();
                    r.git(history, &["add", "copied"]);
                    r.git(history, &["rm", touched]);
                } else {
                    r.git(history, &["rm", touched]);
                }
                r.git(history, &["commit", "-m", "remove temporary path"]);
                // Keep a real own diff so landed detection does not skip integration.
                r.write_commit(&tree, "own", "own\n");
                r.advance();
                let ignore = r.root.join("ignore");
                fs::write(&ignore, "cache\n").unwrap();
                r.git(
                    &tree,
                    &["config", "core.excludesFile", ignore.to_str().unwrap()],
                );
                let protected = if shape == "file" {
                    fs::create_dir(tree.join("cache")).unwrap();
                    "cache/private"
                } else {
                    "cache"
                };
                fs::write(tree.join(protected), "user data").unwrap();
                let before = r.git(&tree, &["rev-parse", "HEAD"]);
                let flag = format!("--{strategy}");
                assert_eq!(
                    r.sync(&tree, &[&flag], 0)["worktrees"][0]["status"],
                    "dirty",
                    "{side} {shape} {strategy}"
                );
                assert_eq!(
                    fs::read_to_string(tree.join(protected)).unwrap(),
                    "user data"
                );
                assert_eq!(r.git(&tree, &["rev-parse", "HEAD"]), before);
            }
        }
    }
}

#[test]
fn merge_ignores_user_options_and_signing_configuration() {
    for options in [
        "--no-commit",
        "--squash",
        "--ff-only",
        "--verify-signatures --gpg-sign",
    ] {
        let r = Repo::new();
        let tree = r.create("topic");
        r.write_commit(&tree, "own", "own\n");
        let before = r.git(&tree, &["rev-parse", "HEAD"]);
        r.git(&tree, &["push", "origin", "topic"]);
        r.advance();
        r.git(&tree, &["config", "branch.topic.mergeOptions", options]);
        r.git(&tree, &["config", "merge.ff", "only"]);
        r.git(&tree, &["config", "merge.verifySignatures", "true"]);
        r.git(&tree, &["config", "merge.autoStash", "true"]);
        r.git(&tree, &["config", "commit.gpgSign", "true"]);
        r.git(&tree, &["config", "gpg.program", "/does/not/exist"]);
        let doc = r.sync(&tree, &["--no-default"], 0);
        assert_eq!(doc["worktrees"][0]["status"], "updated", "{options}");
        assert_eq!(doc["worktrees"][0]["strategy"], "merge");
        assert_eq!(r.git(&tree, &["rev-parse", "HEAD^1"]), before);
        assert_eq!(
            r.git(&tree, &["rev-parse", "HEAD^2"]),
            r.git(&tree, &["rev-parse", "origin/main"])
        );
        assert_eq!(r.git(&tree, &["status", "--porcelain=v2"]), "");
        assert!(!tree
            .join(r.git(&tree, &["rev-parse", "--git-path", "MERGE_HEAD"]))
            .exists());
        assert_eq!(r.git(&tree, &["stash", "list"]), "");
    }
}

#[test]
fn rebase_preserves_fixup_commits_and_disables_user_rebase_configuration() {
    let r = Repo::new();
    let tree = r.create("topic");
    r.write_commit(&tree, "own", "own\n");
    fs::write(tree.join("own"), "fixed\n").unwrap();
    r.git(&tree, &["add", "own"]);
    r.git(&tree, &["commit", "--fixup", "HEAD"]);
    let subjects = r.git(&tree, &["log", "--format=%s", "origin/main..HEAD"]);
    r.git(&tree, &["branch", "other-ref"]);
    let other = r.git(&tree, &["rev-parse", "other-ref"]);
    for key in [
        "rebase.autoSquash",
        "rebase.rebaseMerges",
        "rebase.updateRefs",
        "rebase.autoStash",
        "commit.gpgSign",
    ] {
        r.git(&tree, &["config", key, "true"]);
    }
    r.git(&tree, &["config", "gpg.program", "/does/not/exist"]);
    r.advance();
    let doc = r.sync(&tree, &["--no-default"], 0);
    assert_eq!(doc["worktrees"][0]["status"], "updated");
    assert_eq!(
        r.git(&tree, &["log", "--format=%s", "origin/main..HEAD"]),
        subjects
    );
    assert_eq!(r.git(&tree, &["rev-parse", "other-ref"]), other);
    assert_eq!(r.git(&tree, &["status", "--porcelain=v2"]), "");
    assert_eq!(r.git(&tree, &["stash", "list"]), "");
}

#[test]
fn successful_but_incomplete_integration_is_failed_and_restored() {
    use std::os::unix::fs::PermissionsExt;
    let real_git = std::env::split_paths(&std::env::var_os("PATH").unwrap())
        .map(|dir| dir.join("git"))
        .find(|file| file.is_file())
        .unwrap();
    for mode in ["merge", "squash", "rebase"] {
        let r = Repo::new();
        let tree = r.create("topic");
        r.write_commit(&tree, "own", "own\n");
        fs::write(tree.join(".gitignore"), "ignored\n").unwrap();
        r.git(&tree, &["add", ".gitignore"]);
        r.git(&tree, &["commit", "-m", "ignore"]);
        fs::write(tree.join("ignored"), b"precious\0bytes").unwrap();
        r.advance();
        let before = r.snapshot(&tree);
        let bin = r.root.join("bin");
        fs::create_dir(&bin).unwrap();
        let wrapper = bin.join("git");
        // Simulate a Git process returning success after leaving real operation
        // state or a squash index behind, despite our explicit command options.
        fs::write(
            &wrapper,
            format!(
                r#"#!/bin/sh
for arg do
    if [ "$arg" = --abort ]; then exec "$REAL_GIT" "$@"; fi
done
for arg do
    case "$arg" in
        merge|rebase)
            case '{mode}' in
                merge) "$REAL_GIT" -c core.hooksPath=/dev/null merge --no-commit origin/main ;;
                squash) "$REAL_GIT" -c core.hooksPath=/dev/null merge --squash origin/main ;;
                rebase) "$REAL_GIT" -c core.hooksPath=/dev/null rebase --exec false origin/main ;;
            esac
            exit 0 ;;
    esac
done
exec "$REAL_GIT" "$@"
"#
            ),
        )
        .unwrap();
        fs::set_permissions(&wrapper, fs::Permissions::from_mode(0o755)).unwrap();
        let mut paths = vec![bin];
        paths.extend(std::env::split_paths(&std::env::var_os("PATH").unwrap()));
        let out = r
            .command(
                env!("CARGO_BIN_EXE_mabo"),
                &tree,
                &[
                    "sync",
                    "--json",
                    "--no-default",
                    "--keep-conflicts",
                    if mode == "rebase" {
                        "--rebase"
                    } else {
                        "--merge"
                    },
                ],
            )
            .env("PATH", std::env::join_paths(paths).unwrap())
            .env("REAL_GIT", &real_git)
            .output()
            .unwrap();
        assert_eq!(
            out.status.code(),
            Some(1),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        let doc: Value = serde_json::from_slice(&out.stdout).unwrap();
        assert_eq!(doc["worktrees"][0]["status"], "failed");
        assert_eq!(r.snapshot(&tree), before, "{mode}");
        for state in ["MERGE_HEAD", "rebase-merge", "rebase-apply"] {
            assert!(!tree
                .join(r.git(&tree, &["rev-parse", "--git-path", state]))
                .exists());
        }
    }
}

#[test]
fn rebase_does_not_preserve_merges_from_user_config() {
    let r = Repo::new();
    let tree = r.create("topic");
    r.write_commit(&tree, "own", "own\n");
    r.git(&tree, &["checkout", "-b", "side"]);
    r.write_commit(&tree, "side", "side\n");
    r.git(&tree, &["checkout", "topic"]);
    r.write_commit(&tree, "other", "other\n");
    r.git(&tree, &["merge", "--no-ff", "--no-edit", "side"]);
    r.git(&tree, &["config", "rebase.rebaseMerges", "true"]);
    r.advance();
    assert_eq!(
        r.sync(&tree, &["--no-default"], 0)["worktrees"][0]["status"],
        "updated"
    );
    assert_eq!(
        r.git(&tree, &["rev-list", "--merges", "origin/main..HEAD"]),
        ""
    );
    assert_eq!(
        r.git(&tree, &["rev-list", "--count", "origin/main..HEAD"]),
        "3"
    );
}

#[test]
fn slash_remote_default_and_explicit_bases_fetch_and_integrate_main() {
    for overlapping in [false, true] {
        let r = Repo::new();
        r.git(&r.main, &["remote", "rename", "origin", "team/origin"]);
        if overlapping {
            // Fetching the shorter prefix would fail, and must never be attempted.
            r.git(&r.main, &["remote", "add", "team", "/does/not/exist"]);
        }
        for base in [
            None,
            Some("team/origin/main"),
            Some("refs/remotes/team/origin/main"),
        ] {
            let name = format!("topic-{}", base.map_or(0, str::len));
            let mut args = vec!["create", &name, "--json"];
            if let Some(base) = base {
                args.extend(["--base", base]);
            }
            let out = r.mabo(&r.main, &args);
            assert!(
                out.status.success(),
                "{}",
                String::from_utf8_lossy(&out.stderr)
            );
            let doc: Value = serde_json::from_slice(&out.stdout).unwrap();
            let tree = PathBuf::from(doc["worktree"]["path"].as_str().unwrap());
            let out = r.mabo(
                &r.main,
                &["meta", "set", &name, "--base", "team/origin/main"],
            );
            assert!(
                out.status.success(),
                "{}",
                String::from_utf8_lossy(&out.stderr)
            );
            r.write_commit(&r.upstream, &name, "incoming\n");
            r.git(&r.upstream, &["push", "origin", "main"]);
            let expected = r.git(&r.upstream, &["rev-parse", "HEAD"]);
            let doc = r.sync(&r.main, &[], 0);
            assert_eq!(doc["default"]["name"], "main");
            assert_eq!(doc["default"]["status"], "updated");
            assert_eq!(r.git(&r.main, &["rev-parse", "main"]), expected);
            assert_eq!(r.git(&r.main, &["branch", "--list", "origin/main"]), "");
            r.write_commit(&r.upstream, &format!("{name}-next"), "next\n");
            r.git(&r.upstream, &["push", "origin", "main"]);
            let expected = r.git(&r.upstream, &["rev-parse", "HEAD"]);
            let doc = r.sync(&tree, &["--no-default"], 0);
            assert_eq!(doc["worktrees"][0]["base"], "refs/remotes/team/origin/main");
            assert_eq!(doc["worktrees"][0]["status"], "updated");
            assert_eq!(r.git(&tree, &["rev-parse", "HEAD"]), expected);
        }
    }
}

#[test]
fn unmatched_default_remote_fails_without_creating_a_branch() {
    let r = Repo::new();
    r.git(&r.main, &["update-ref", "refs/remotes/stale/main", "HEAD"]);
    r.git(
        &r.main,
        &[
            "symbolic-ref",
            "refs/remotes/origin/HEAD",
            "refs/remotes/stale/main",
        ],
    );
    let before = r.git(&r.main, &["for-each-ref", "refs/heads"]);
    let doc = r.sync(&r.main, &[], 1);
    assert_eq!(doc["default"]["status"], "failed");
    assert!(doc["default"]["detail"]
        .as_str()
        .unwrap()
        .contains("No configured remote matches"));
    assert_eq!(r.git(&r.main, &["for-each-ref", "refs/heads"]), before);
}

fn pause_root_rebase(r: &Repo, path: &Path, update_refs: bool) {
    let editor = r.root.join("sequence-editor");
    fs::write(&editor, "#!/bin/sh\nsed -i '1s/^pick /edit /' \"$1\"\n").unwrap();
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(&editor, fs::Permissions::from_mode(0o755)).unwrap();
    let mut cmd = r.command("git", path, &["rebase", "-i", "--root"]);
    cmd.env("GIT_SEQUENCE_EDITOR", &editor);
    if update_refs {
        cmd.arg("--update-refs");
    }
    let out = cmd.output().unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
}

#[test]
fn default_reserved_by_rebase_in_main_or_linked_checkout() {
    for linked in [false, true] {
        let r = Repo::new();
        let path = if linked {
            r.git(&r.main, &["switch", "-c", "other"]);
            let path = r.root.join("default-tree");
            r.git(
                &r.main,
                &["worktree", "add", path.to_str().unwrap(), "main"],
            );
            path
        } else {
            r.main.clone()
        };
        let before = r.git(&r.main, &["rev-parse", "main"]);
        pause_root_rebase(&r, &path, false);
        r.advance();
        let doc = r.sync(&r.main, &[], 1);
        assert_eq!(doc["default"]["status"], "dirty");
        assert!(doc["default"]["detail"]
            .as_str()
            .unwrap()
            .contains("being rebased"));
        assert_eq!(r.git(&r.main, &["rev-parse", "main"]), before);
        let topic = r.create("topic");
        let doc = r.sync(&r.main, &["topic"], 0);
        assert_eq!(doc["default"]["status"], "dirty");
        assert_eq!(doc["worktrees"][0]["status"], "updated");
        assert!(topic.exists());
        r.git(&path, &["rebase", "--continue"]);
        assert_eq!(r.git(&r.main, &["rev-parse", "main"]), before);
    }
}

#[test]
fn default_reserved_by_update_refs_and_bisect() {
    for operation in ["update-refs", "bisect"] {
        let r = Repo::new();
        r.git(&r.main, &["switch", "-c", "other"]);
        if operation == "update-refs" {
            // main points at an intermediate commit, so --update-refs reserves it.
            r.write_commit(&r.main, "other-file", "other\n");
            pause_root_rebase(&r, &r.main, true);
        } else {
            r.write_commit(&r.main, "other-file", "other\n");
            r.git(&r.main, &["switch", "main"]);
            r.git(&r.main, &["bisect", "start", "other", "main"]);
        }
        let before = r.git(&r.main, &["rev-parse", "main"]);
        r.advance();
        let doc = r.sync(&r.main, &[], 1);
        assert_eq!(doc["default"]["status"], "dirty", "{doc}");
        assert_eq!(r.git(&r.main, &["rev-parse", "main"]), before);
        if operation == "update-refs" {
            r.git(&r.main, &["rebase", "--continue"]);
        } else {
            r.git(&r.main, &["bisect", "reset"]);
        }
    }
}

#[test]
fn target_operations_are_never_integrated() {
    for operation in ["rebase", "merge", "cherry-pick", "revert", "bisect"] {
        let r = Repo::new();
        let tree = r.create("topic");
        if operation == "rebase" {
            pause_root_rebase(&r, &tree, false);
        } else {
            // Resolved operations can have a clean index while their state remains.
            let state = match operation {
                "merge" => "MERGE_HEAD",
                "cherry-pick" => "CHERRY_PICK_HEAD",
                "revert" => "REVERT_HEAD",
                _ => "BISECT_START",
            };
            let file = r.git(&tree, &["rev-parse", "--git-path", state]);
            fs::write(tree.join(file), r.git(&tree, &["rev-parse", "HEAD"])).unwrap();
        }
        r.advance();
        let before = r.snapshot(&tree);
        let doc = r.sync(&r.main, &["topic", "--no-default"], 0);
        assert_eq!(
            doc["worktrees"][0]["status"],
            if operation == "rebase" {
                "detached"
            } else {
                "dirty"
            }
        );
        assert!(doc["worktrees"][0]["detail"]
            .as_str()
            .unwrap()
            .contains(&format!("{operation} in progress")));
        assert_eq!(r.snapshot(&tree), before);
    }
}

#[test]
fn target_reserved_by_another_worktrees_update_refs_is_dirty() {
    let r = Repo::new();
    let tree = r.create("topic");
    r.git(&tree, &["switch", "--detach"]);
    r.git(&r.main, &["switch", "-c", "other"]);
    r.write_commit(&r.main, "other-file", "other\n");
    pause_root_rebase(&r, &r.main, true);
    // Reattaching after the reservation makes the target eligible by HEAD alone.
    r.git(&tree, &["switch", "topic"]);
    r.advance();
    let before = r.snapshot(&tree);
    let doc = r.sync(&r.main, &["topic", "--no-default"], 0);
    assert_eq!(doc["worktrees"][0]["status"], "dirty");
    assert_eq!(r.snapshot(&tree), before);
    r.git(&r.main, &["rebase", "--continue"]);
}

#[test]
fn prunable_worktree_is_skipped_without_blocking_live_sync() {
    let r = Repo::new();
    let gone = r.create("gone");
    let before = r.git(&gone, &["rev-parse", "HEAD"]);
    let admin = PathBuf::from(r.git(&gone, &["rev-parse", "--absolute-git-dir"]));
    let registration = file_contents(&admin);
    fs::remove_dir_all(&gone).unwrap();
    let live = r.create("live");
    r.advance();
    let doc = r.sync(&r.main, &["--all"], 0);
    assert_eq!(doc["default"]["status"], "updated");
    let items = doc["worktrees"].as_array().unwrap();
    assert_eq!(
        items.iter().find(|v| v["name"] == "gone").unwrap()["status"],
        "dirty"
    );
    assert_eq!(
        items.iter().find(|v| v["name"] == "live").unwrap()["status"],
        "updated"
    );
    assert_eq!(
        r.git(&live, &["rev-parse", "HEAD"]),
        r.git(&r.upstream, &["rev-parse", "HEAD"])
    );
    assert_eq!(r.git(&r.main, &["rev-parse", "gone"]), before);
    assert_eq!(file_contents(&admin), registration);
    assert!(!gone.exists());
}

#[test]
fn missing_linked_checkout_still_reserves_default_during_rebase() {
    let r = Repo::new();
    r.git(&r.main, &["switch", "-c", "other"]);
    let gone = r.root.join("reserved-main");
    r.git(
        &r.main,
        &["worktree", "add", gone.to_str().unwrap(), "main"],
    );
    pause_root_rebase(&r, &gone, false);
    let admin = PathBuf::from(r.git(&gone, &["rev-parse", "--absolute-git-dir"]));
    let state = file_contents(&admin);
    let before = r.git(&r.main, &["rev-parse", "main"]);
    fs::remove_dir_all(&gone).unwrap();
    let live = r.create("live");
    r.advance();
    let doc = r.sync(&r.main, &["live"], 0);
    assert_eq!(doc["default"]["status"], "dirty");
    assert!(doc["default"]["detail"]
        .as_str()
        .unwrap()
        .contains("being rebased"));
    assert_eq!(doc["worktrees"][0]["status"], "updated");
    assert!(live.is_dir());
    assert_eq!(r.git(&r.main, &["rev-parse", "main"]), before);
    assert_eq!(file_contents(&admin), state);
}

#[test]
fn missing_default_checkout_and_broken_target_do_not_block_live_target() {
    let r = Repo::new();
    let bad = r.create("bad");
    let live = r.create("live");
    // Keep a directory but break its Git registration: only this item fails.
    fs::write(bad.join(".git"), "gitdir: /nonexistent/mabo-test\n").unwrap();
    r.git(&r.main, &["switch", "-c", "other"]);
    let missing = r.root.join("missing-main");
    r.git(
        &r.main,
        &["worktree", "add", missing.to_str().unwrap(), "main"],
    );
    fs::remove_dir_all(&missing).unwrap();
    let before = r.git(&r.main, &["rev-parse", "main"]);
    r.advance();
    let doc = r.sync(&r.main, &["--all"], 1);
    assert_eq!(doc["default"]["status"], "dirty");
    let items = doc["worktrees"].as_array().unwrap();
    assert_eq!(
        items.iter().find(|v| v["name"] == "bad").unwrap()["status"],
        "failed"
    );
    assert_eq!(
        items.iter().find(|v| v["name"] == "live").unwrap()["status"],
        "updated"
    );
    assert_eq!(r.git(&r.main, &["rev-parse", "main"]), before);
    assert_eq!(
        r.git(&live, &["rev-parse", "HEAD"]),
        r.git(&r.upstream, &["rev-parse", "HEAD"])
    );
}

#[test]
fn context_errors_use_shared_exit_codes() {
    let r = Repo::new();
    for args in [
        vec!["sync", "--project", "missing-project", "--json"],
        vec!["list", "--project", "missing-project", "--json"],
    ] {
        assert_eq!(r.mabo(&r.main, &args).status.code(), Some(2));
    }
    assert_eq!(r.mabo(&r.root, &["sync", "--json"]).status.code(), Some(4));
}

#[test]
fn metadata_failure_after_fast_forward_restores_worktree() {
    use std::os::unix::fs::PermissionsExt;
    let real_git = std::env::split_paths(&std::env::var_os("PATH").unwrap())
        .map(|dir| dir.join("git"))
        .find(|file| file.is_file())
        .unwrap();
    for fail_rollback in [false, true] {
        let r = Repo::new();
        let tree = r.create("topic");
        let store = r.main.join(".git/maboroshi/worktrees.json");
        let original_store = fs::read(&store).unwrap();
        r.advance();
        let before = r.snapshot(&tree);
        let bin = r.root.join("bin");
        fs::create_dir(&bin).unwrap();
        let wrapper = bin.join("git");
        fs::write(
            &wrapper,
            r#"#!/bin/sh
for arg do
    if [ "$arg" = --keep ] && [ "$FAIL_ROLLBACK" = 1 ]; then
        echo "injected rollback failure" >&2
        exit 1
    fi
done
for arg do
    if [ "$arg" = merge ]; then
        "$REAL_GIT" "$@" || exit $?
        printf 'invalid json' > "$STORE"
        exit 0
    fi
done
exec "$REAL_GIT" "$@"
"#,
        )
        .unwrap();
        fs::set_permissions(&wrapper, fs::Permissions::from_mode(0o755)).unwrap();
        let mut paths = vec![bin];
        paths.extend(std::env::split_paths(&std::env::var_os("PATH").unwrap()));
        let out = r
            .command(
                env!("CARGO_BIN_EXE_mabo"),
                &tree,
                &["sync", "--no-default", "--json"],
            )
            .env("PATH", std::env::join_paths(paths).unwrap())
            .env("REAL_GIT", &real_git)
            .env("STORE", &store)
            .env("FAIL_ROLLBACK", if fail_rollback { "1" } else { "0" })
            .output()
            .unwrap();
        assert_eq!(out.status.code(), Some(1), "{out:?}");
        let doc: Value = serde_json::from_slice(&out.stdout).unwrap();
        let item = &doc["worktrees"][0];
        assert_eq!(item["status"], "failed");
        let detail = item["detail"].as_str().unwrap();
        assert!(detail.contains("metadata update failed"), "{detail}");
        if fail_rollback {
            assert!(detail.contains("rollback failed"), "{detail}");
        } else {
            assert!(detail.contains("worktree restored"), "{detail}");
            assert_eq!(item["before"], item["after"]);
            assert_eq!(r.snapshot(&tree), before);
            fs::write(&store, &original_store).unwrap();
            assert_eq!(
                r.sync(&tree, &["--no-default"], 0)["worktrees"][0]["status"],
                "updated"
            );
            assert_eq!(
                r.sync(&tree, &["--no-default"], 0)["worktrees"][0]["status"],
                "up-to-date"
            );
            let out = r.mabo(&r.main, &["gc", "--json"]);
            assert!(!String::from_utf8_lossy(&out.stdout).contains("topic"));
        }
    }
}
