#[path = "common/records.rs"]
mod records;
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
            .env_remove("MABO_OUTPUT")
            .env_remove("MABO_NO_INPUT")
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
        assert_eq!(doc["data"]["workspace"]["base"], "HEAD");
        PathBuf::from(doc["data"]["workspace"]["path"].as_str().unwrap())
    }
    fn write_commit(&self, path: &Path, file: &str, text: &str) {
        fs::write(path.join(file), text).unwrap();
        self.git(path, &["add", file]);
        self.git(path, &["commit", "-m", file]);
    }
    fn install_fsmonitor(&self) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let marker = self.root.join("fsmonitor-ran");
        let hook = self.root.join("fsmonitor-hook");
        fs::write(
            &hook,
            format!("#!/bin/sh\ntouch '{}'\nprintf '/\\000'\n", marker.display()),
        )
        .unwrap();
        fs::set_permissions(&hook, fs::Permissions::from_mode(0o755)).unwrap();
        self.git(
            &self.main,
            &["config", "core.fsmonitor", hook.to_str().unwrap()],
        );
        self.git(&self.main, &["status", "--porcelain"]);
        assert!(marker.exists());
        fs::remove_file(&marker).unwrap();
        marker
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
fn default_upstream_precedes_other_remote_heads_without_origin_head() {
    for existing_trunk in [false, true] {
        let r = Repo::new();
        r.git(&r.main, &["remote", "set-head", "origin", "--delete"]);
        r.git(
            &r.main,
            &["branch", "--set-upstream-to=origin/main", "main"],
        );
        let second = r.root.join("second.git");
        r.git(
            &r.main,
            &[
                "clone",
                "--bare",
                r.root.join("remote.git").to_str().unwrap(),
                second.to_str().unwrap(),
            ],
        );
        r.git(&second, &["branch", "trunk", "main"]);
        r.git(&second, &["symbolic-ref", "HEAD", "refs/heads/trunk"]);
        r.git(
            &r.main,
            &["remote", "add", "upstream", second.to_str().unwrap()],
        );
        r.git(&r.main, &["fetch", "upstream"]);
        r.git(&r.main, &["remote", "set-head", "upstream", "trunk"]);
        let second_before = r.git(&r.main, &["for-each-ref", "refs/remotes/upstream"]);
        if existing_trunk {
            r.git(&r.main, &["branch", "trunk", "main"]);
        }
        let trunk_before = r.git(&r.main, &["for-each-ref", "refs/heads/trunk"]);
        // Make the second remote stale too: sync must fetch only origin.
        r.write_commit(&r.upstream, "second-only", "second remote\n");
        r.git(
            &r.upstream,
            &["push", second.to_str().unwrap(), "main:trunk"],
        );
        r.git(&r.upstream, &["reset", "--hard", "origin/main"]);
        r.advance();
        let expected = r.git(&r.upstream, &["rev-parse", "HEAD"]);
        let doc = r.sync(&r.main, &[], 0);
        assert_eq!(doc["data"]["default"]["status"], "updated", "{doc}");
        assert_eq!(doc["data"]["default"]["branch"], "refs/heads/main");
        assert_eq!(doc["data"]["default"]["base"], "refs/remotes/origin/main");
        assert_eq!(r.git(&r.main, &["rev-parse", "main"]), expected);
        assert_eq!(r.git(&r.main, &["rev-parse", "origin/main"]), expected);
        assert_eq!(
            r.git(&r.main, &["for-each-ref", "refs/heads/trunk"]),
            trunk_before
        );
        assert_eq!(
            r.git(&r.main, &["for-each-ref", "refs/remotes/upstream"]),
            second_before
        );
        assert_eq!(r.git(&r.main, &["rev-parse", "main@{upstream}"]), expected);
        assert_eq!(
            r.sync(&r.main, &[], 0)["data"]["default"]["status"],
            "up-to-date"
        );
    }
}

#[test]
fn other_remote_head_remains_a_fallback_for_unresolved_default_upstream() {
    let r = Repo::new();
    let before = r.git(&r.main, &["rev-parse", "main"]);
    r.git(&r.main, &["remote", "set-head", "origin", "--delete"]);
    r.git(&r.main, &["config", "branch.main.remote", "origin"]);
    r.git(
        &r.main,
        &["config", "branch.main.merge", "refs/heads/missing"],
    );
    r.git(&r.upstream, &["push", "origin", "main:trunk"]);
    r.git(
        &r.main,
        &[
            "remote",
            "add",
            "upstream",
            r.root.join("remote.git").to_str().unwrap(),
        ],
    );
    r.git(&r.main, &["fetch", "upstream"]);
    r.git(&r.main, &["remote", "set-head", "upstream", "trunk"]);
    r.advance();
    r.git(&r.upstream, &["push", "origin", "main:trunk"]);
    let expected = r.git(&r.upstream, &["rev-parse", "HEAD"]);
    let doc = r.sync(&r.main, &[], 0);
    assert_eq!(doc["data"]["default"]["status"], "updated", "{doc}");
    assert_eq!(
        doc["data"]["default"]["base"],
        "refs/remotes/upstream/trunk"
    );
    assert_eq!(r.git(&r.main, &["rev-parse", "trunk"]), expected);
    assert_eq!(r.git(&r.main, &["rev-parse", "main"]), before);
    assert_eq!(
        r.git(&r.main, &["config", "branch.main.merge"]),
        "refs/heads/missing"
    );
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
        assert_eq!(doc["data"]["default"]["status"], "up-to-date");
        assert_eq!(
            doc["data"]["default"]["base"],
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
            assert_eq!(doc["data"]["workspaces"][0]["base"], tracking);
            if !checked_out {
                r.git(&r.main, &["checkout", "-b", "other"]);
            }
            r.write_commit(&r.upstream, "remote-trunk", "advanced\n");
            r.git(&r.upstream, &["push", "origin", "main:trunk"]);
            let expected = r.git(&r.upstream, &["rev-parse", "HEAD"]);
            assert_ne!(r.git(&r.main, &["rev-parse", tracking]), expected);
            let doc = r.sync(&r.main, &[], 0);
            assert_eq!(doc["data"]["default"]["status"], "updated");
            assert_eq!(doc["data"]["default"]["branch"], "refs/heads/main");
            assert_eq!(doc["data"]["default"]["base"], tracking);
            assert_eq!(r.git(&r.main, &["rev-parse", "main"]), expected);
            assert_eq!(r.git(&r.main, &["rev-parse", tracking]), expected);
            assert_eq!(r.git(&r.main, &["for-each-ref", "refs/heads/trunk"]), "");
            assert_eq!(
                r.sync(&r.main, &[], 0)["data"]["default"]["status"],
                "up-to-date"
            );
        }
    }
}

#[test]
fn implicit_sync_does_not_revalidate_the_resolved_branch_name() {
    for subdirectory in [false, true] {
        let r = Repo::new();
        let tree = r.root.join("plain-checkout");
        r.git(
            &r.main,
            &[
                "worktree",
                "add",
                "-b",
                "topic+fix",
                tree.to_str().unwrap(),
                "main",
            ],
        );
        let other = r.create("other");
        let other_before = r.snapshot(&other);
        let store = r.main.join(".git/maboroshi/workspaces");
        let records_before = records::read(&store).unwrap();
        r.advance();
        let cwd = if subdirectory {
            let sub = tree.join("sub");
            fs::create_dir(&sub).unwrap();
            sub
        } else {
            tree.clone()
        };
        let doc = r.sync(&cwd, &[], 0);
        assert_eq!(doc["schema"], 2);
        assert_eq!(doc["data"]["default"]["status"], "updated");
        assert_eq!(doc["data"]["workspaces"].as_array().unwrap().len(), 1);
        assert_eq!(doc["data"]["workspaces"][0]["name"], "topic+fix");
        assert_eq!(doc["data"]["workspaces"][0]["status"], "updated");
        assert_eq!(
            r.git(&tree, &["rev-parse", "HEAD"]),
            r.git(&r.upstream, &["rev-parse", "HEAD"])
        );
        assert_eq!(r.snapshot(&other), other_before);
        assert_eq!(records::read(&store).unwrap(), records_before);
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
    assert_eq!(doc["data"]["default"]["status"], "updated");
    assert_eq!(doc["data"]["workspaces"], json!([]));
    assert_eq!(r.git(&tree, &["rev-parse", "HEAD"]), before);
    fs::create_dir(tree.join("sub")).unwrap();
    let doc = r.sync(&tree.join("sub"), &[], 0);
    assert_eq!(doc["data"]["workspaces"][0]["status"], "updated");
    assert_eq!(doc["data"]["workspaces"][0]["strategy"], "rebase");
    assert_eq!(
        r.sync(&tree, &[], 0)["data"]["workspaces"][0]["status"],
        "up-to-date"
    );
    r.git(&tree, &["checkout", "--detach"]);
    assert_eq!(
        r.sync(&tree, &[], 0)["data"]["workspaces"][0]["status"],
        "detached"
    );
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
            &["set", "main", "--purpose", "tester", "--base", "other"],
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
            assert!(doc["data"]["default"].is_null());
            assert_eq!(doc["data"]["workspaces"], json!([]));
            assert_eq!(r.snapshot(&tree), before);
        }
        let mut cmd = r.command(
            env!("CARGO_BIN_EXE_mabo"),
            &tree,
            &["sync", "--all", "--no-default", "--json"],
        );
        let out = cmd.env("MABO_AGENT_ID", "tester").output().unwrap();
        assert!(out.status.success());
        let doc: Value = serde_json::from_slice(&out.stdout).unwrap();
        assert_eq!(doc["data"]["workspaces"], json!([]));
        assert_eq!(r.snapshot(&tree), before);
        let status = if diverged { "diverged" } else { "updated" };
        let doc = r.sync(&tree, &["main", "--no-default", "--rebase", "--force"], 0);
        assert!(doc["data"]["default"].is_null());
        assert_eq!(doc["data"]["workspaces"].as_array().unwrap().len(), 1);
        assert_eq!(doc["data"]["workspaces"][0]["status"], status);
        assert_eq!(doc["data"]["workspaces"][0]["strategy"], "ff-only");
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
            assert_eq!(doc["data"]["workspaces"], json!([]));
            assert_eq!(
                doc["data"]["default"]["status"],
                if diverged {
                    "diverged"
                } else if i == 0 {
                    "updated"
                } else {
                    "up-to-date"
                }
            );
            assert_eq!(doc["data"]["default"]["path"], tree.to_str().unwrap());
            if diverged {
                assert_eq!(r.snapshot(&tree), before);
            }
        }
        let out = r
            .command(
                env!("CARGO_BIN_EXE_mabo"),
                &tree,
                &["sync", "--all", "--json"],
            )
            .env("MABO_AGENT_ID", "tester")
            .output()
            .unwrap();
        assert_eq!(out.status.code(), Some(if diverged { 1 } else { 0 }));
        let doc: Value = serde_json::from_slice(&out.stdout).unwrap();
        assert_eq!(doc["data"]["workspaces"], json!([]));
        assert_eq!(r.git(&r.main, &["rev-parse", "HEAD"]), other);
    }
}

#[test]
fn default_ref_update_linked_checkout_diverged_and_dirty() {
    let r = Repo::new();
    r.git(&r.main, &["checkout", "-b", "other"]);
    r.advance();
    let before = r.git(&r.main, &["rev-parse", "HEAD"]);
    assert_eq!(
        r.sync(&r.main, &[], 0)["data"]["default"]["status"],
        "updated"
    );
    assert_eq!(r.git(&r.main, &["rev-parse", "HEAD"]), before);
    let linked = r.root.join("default-tree");
    r.git(
        &r.main,
        &["worktree", "add", linked.to_str().unwrap(), "main"],
    );
    r.write_commit(&r.upstream, "remote-two", "two\n");
    r.git(&r.upstream, &["push", "origin", "main"]);
    assert_eq!(
        r.sync(&r.main, &[], 0)["data"]["default"]["status"],
        "updated"
    );
    assert!(linked.join("remote-two").exists());
    r.write_commit(&linked, "own-main", "local\n");
    let before = r.snapshot(&linked);
    assert_eq!(
        r.sync(&r.main, &[], 1)["data"]["default"]["status"],
        "diverged"
    );
    assert_eq!(r.snapshot(&linked), before);
    let tree = r.create("topic");
    r.write_commit(&tree, "topic-file", "topic\n");
    assert_eq!(
        r.sync(&r.main, &["topic"], 0)["data"]["default"]["status"],
        "diverged"
    );
    let dirty = Repo::new();
    dirty.write_commit(&dirty.upstream, "file", "remote edit\n");
    dirty.git(&dirty.upstream, &["push", "origin", "main"]);
    fs::write(dirty.main.join("file"), "dirty edit\n").unwrap();
    let before = dirty.snapshot(&dirty.main);
    assert_eq!(
        dirty.sync(&dirty.main, &[], 1)["data"]["default"]["status"],
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
        let item = &doc["data"]["workspaces"][0];
        assert_eq!(item["status"], "up-to-date");
        assert_eq!(item["strategy"], strategy);
        assert_eq!(item["before"], head);
        assert_eq!(item["after"], head);
        assert_eq!(item["code"], Value::Null);
        assert_eq!(r.snapshot(&tree), before);
    }
}

#[test]
fn corrupt_custom_base_metadata_refuses_sync_before_fetch_or_updates() {
    let r = Repo::new();
    let tree = r.create("topic");
    r.create("healthy");
    r.git(&r.main, &["branch", "stack"]);
    r.write_commit(&tree, "own", "own commit\n");
    assert!(r
        .mabo(&r.main, &["set", "topic", "--base", "stack"])
        .status
        .success());
    let dir = r.main.join(".git/maboroshi/workspaces");
    let record = fs::read_dir(&dir)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .find(|file| {
            let record: Value = serde_json::from_slice(&fs::read(file).unwrap()).unwrap();
            record["path"] == tree.to_str().unwrap()
        })
        .unwrap();
    let mut body: Value = serde_json::from_slice(&fs::read(&record).unwrap()).unwrap();
    assert_eq!(body["base"], "refs/heads/stack");
    body["purpose"] = json!({"invalid": "shape"});
    let corrupt = serde_json::to_vec(&body).unwrap();
    fs::write(&record, &corrupt).unwrap();
    r.advance();
    let refs = r.git(&r.main, &["for-each-ref"]);
    let before = r.snapshot(&tree);
    let main_before = r.snapshot(&r.main);
    let doc = r.sync(&r.main, &["topic", "healthy"], 1);
    assert_eq!(doc["error"]["code"], "failed");
    assert!(doc["error"]["message"]
        .as_str()
        .unwrap()
        .contains("invalid JSON or shape"));
    assert!(doc["data"].is_null());
    assert_eq!(r.git(&r.main, &["for-each-ref"]), refs);
    assert_eq!(r.snapshot(&tree), before);
    assert_eq!(r.snapshot(&r.main), main_before);
    assert_eq!(fs::read(&record).unwrap(), corrupt);
    let listed = r.mabo(&r.main, &["list", "--json"]);
    assert!(listed.status.success());
    let doc: Value = serde_json::from_slice(&listed.stdout).unwrap();
    assert!(!doc["warnings"].as_array().unwrap().is_empty());
    assert!(doc["data"]["workspaces"]
        .as_array()
        .unwrap()
        .iter()
        .any(|item| item["name"] == "healthy" && item["id"].is_string()));
}

#[test]
fn updates_with_failures_conflicts_or_published_refusals_exit_partial() {
    for update_default in [true, false] {
        for outcome in ["conflict", "kept-conflict", "published", "failure"] {
            let r = Repo::new();
            let tree = r.create("topic");
            r.write_commit(&tree, "file", "topic edit\n");
            if outcome == "published" {
                r.git(&tree, &["push", "origin", "topic"]);
            }
            if outcome == "failure" {
                r.git(
                    &r.main,
                    &[
                        "remote",
                        "add",
                        "broken",
                        r.root.join("remote.git").to_str().unwrap(),
                    ],
                );
                r.git(&r.main, &["fetch", "broken"]);
                assert!(r
                    .mabo(&r.main, &["set", "topic", "--base", "broken/main"])
                    .status
                    .success());
                r.git(
                    &r.main,
                    &[
                        "remote",
                        "set-url",
                        "broken",
                        r.root.join("absent.git").to_str().unwrap(),
                    ],
                );
            }
            let good = r.create("good");
            r.write_commit(&good, "own", "independent edit\n");
            r.write_commit(&r.upstream, "file", "remote edit\n");
            r.git(&r.upstream, &["push", "origin", "main"]);
            let before = r.snapshot(&tree);
            let mut args = vec!["topic", "--rebase"];
            if !update_default {
                // Deliberately update the other item before visiting topic.
                args = vec!["good", "topic", "--rebase", "--no-default"];
            }
            if outcome == "kept-conflict" {
                args.push("--keep-conflicts");
                // keep-conflicts requires exactly one worktree target.
                if !update_default {
                    continue;
                }
            }
            let doc = r.sync(&r.main, &args, 6);
            assert_eq!(doc["error"]["code"], "partial");
            let topic = doc["data"]["workspaces"]
                .as_array()
                .unwrap()
                .iter()
                .find(|item| item["name"] == "topic")
                .unwrap();
            if outcome == "published" {
                assert_eq!(topic["code"], "published");
            } else if outcome == "failure" {
                assert_eq!(topic["status"], "failed");
            } else {
                assert_eq!(topic["status"], "conflict");
            }
            if outcome != "kept-conflict" {
                assert_eq!(r.snapshot(&tree), before);
            } else {
                assert!(r.git(&tree, &["status", "--porcelain=v2"]).contains("u "));
            }
            let updated = if update_default {
                &doc["data"]["default"]
            } else {
                &doc["data"]["workspaces"][0]
            };
            assert_eq!(updated["status"], "updated");
            assert_ne!(updated["before"], updated["after"]);
        }
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
    let refused = r.sync(&r.main, &["topic", "--rebase", "--no-default"], 4);
    assert_eq!(refused["error"]["code"], "published");
    assert_eq!(refused["data"]["workspaces"][0]["code"], "published");
    assert_eq!(r.git(&tree, &["rev-parse", "HEAD"]), before);
    let forced = r.sync(&r.main, &["topic", "--rebase", "--force"], 0);
    assert_eq!(forced["data"]["workspaces"][0]["strategy"], "rebase");
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
    assert_eq!(doc["data"]["workspaces"][0]["strategy"], "merge");
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
        let doc = r.sync(&tree, &[strategy, "--no-default"], 5);
        assert_eq!(doc["data"]["workspaces"][0]["status"], "conflict");
        assert_eq!(doc["data"]["workspaces"][0]["conflicts"], json!(["file"]));
        assert_eq!(r.snapshot(&tree), before);
        assert_eq!(
            fs::read(tree.join("ignored")).unwrap(),
            b"ignored contents\n"
        );
        let doc = r.sync(&tree, &[strategy, "--keep-conflicts", "--no-default"], 5);
        assert_eq!(doc["data"]["workspaces"][0]["status"], "conflict");
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
    assert_eq!(
        r.sync(&tree, &[], 0)["data"]["workspaces"][0]["status"],
        "dirty"
    );
    fs::remove_file(tree.join("untracked")).unwrap();
    r.git(&r.main, &["merge", "--squash", "topic"]);
    r.git(&r.main, &["commit", "-m", "squash"]);
    r.git(&r.main, &["push", "origin", "main"]);
    assert_eq!(
        r.sync(&tree, &[], 0)["data"]["workspaces"][0]["status"],
        "merged"
    );
    r.git(&r.main, &["branch", "stack"]);
    let out = r.mabo(&r.main, &["set", "topic", "--base", "stack", "--json"]);
    assert!(out.status.success());
    let doc: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(doc["data"]["workspace"]["base"], "refs/heads/stack");
    let invalid = r.mabo(&r.main, &["set", "topic", "--base", "nonexistent"]);
    assert!(!invalid.status.success());
    r.git(&r.main, &["branch", "-D", "stack"]);
    assert_eq!(
        r.sync(&tree, &[], 0)["data"]["workspaces"][0]["status"],
        "base-gone"
    );
    let file = r.main.join(".git/maboroshi/workspaces");
    let mut stored: Value = serde_json::from_slice(&records::read(&file).unwrap()).unwrap();
    stored["worktrees"][0]
        .as_object_mut()
        .unwrap()
        .remove("base");
    records::write(&file, serde_json::to_vec(&stored).unwrap()).unwrap();
    assert_eq!(
        r.sync(&tree, &[], 0)["data"]["workspaces"][0]["base"],
        "refs/remotes/origin/main"
    );
}

#[test]
fn all_syncs_legacy_owners_and_unrecorded_workspaces() {
    let r = Repo::new();
    for (name, owner) in [("first", "agent"), ("other", "someone")] {
        let tree = r.create(name);
        r.write_commit(&tree, name, "work\n");
        let store = r.main.join(".git/maboroshi/workspaces");
        let mut body: Value = serde_json::from_slice(&records::read(&store).unwrap()).unwrap();
        let row = body["worktrees"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|row| row["path"] == tree.to_str().unwrap())
            .unwrap();
        row["owner"] = json!(owner);
        row["lastUsedAt"] = json!("2000-01-01T00:00:00.000Z");
        records::write(&store, serde_json::to_vec(&body).unwrap()).unwrap();
    }
    let unrecorded = r.root.join("unrecorded");
    r.git(
        &r.main,
        &[
            "worktree",
            "add",
            "-b",
            "unrecorded",
            unrecorded.to_str().unwrap(),
        ],
    );
    r.write_commit(&unrecorded, "unrecorded", "work\n");
    r.advance();
    let out = r
        .command(
            env!("CARGO_BIN_EXE_mabo"),
            &r.main,
            &["sync", "--all", "--no-default", "--json"],
        )
        .env("MABO_AGENT_ID", "agent")
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stdout)
    );
    let doc: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert!(doc["data"]["default"].is_null());
    let trees = doc["data"]["workspaces"].as_array().unwrap();
    assert_eq!(trees.len(), 3);
    for name in ["first", "other", "unrecorded"] {
        let tree = trees.iter().find(|tree| tree["name"] == name).unwrap();
        assert_eq!(tree["status"], "updated", "{tree}");
        assert!(tree.get("owner").is_none());
        assert!(tree.get("lastUsedAt").is_none());
    }
    r.write_commit(&r.upstream, "second-remote-file", "second remote change\n");
    r.git(&r.upstream, &["push", "origin", "main"]);
    let doc = r.sync(&r.main, &["other", "--merge"], 0);
    assert_eq!(doc["data"]["workspaces"][0]["strategy"], "merge");
    assert_eq!(
        r.sync(&r.main, &["--all"], 0)["data"]["workspaces"]
            .as_array()
            .unwrap()
            .len(),
        3
    );
}

#[test]
fn json_schema_snapshot_and_project_selection() {
    let r = Repo::new();
    let mut doc = r.sync(&r.main, &["--repo", r.main.to_str().unwrap()], 0);
    doc["data"]["default"]["path"] = json!("<path>");
    doc["data"]["default"]["before"] = json!("<sha>");
    doc["data"]["default"]["after"] = json!("<sha>");
    assert_eq!(
        doc,
        json!({"schema":2,"command":"sync","ok":true,"warnings":[],"error":null,"data":{"default":{"name":"main","path":"<path>","branch":"refs/heads/main","base":"refs/remotes/origin/main","status":"up-to-date","strategy":"ff-only","before":"<sha>","after":"<sha>","conflicts":[],"detail":null,"code":null},"workspaces":[]}})
    );
    let tree = r.create("topic");
    r.write_commit(&tree, "own", "own\n");
    assert_eq!(
        r.sync(&r.main, &["topic", "-R", r.main.to_str().unwrap()], 0)["data"]["workspaces"][0]
            ["name"],
        "topic"
    );
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
    assert_eq!(doc["data"]["workspaces"][0]["status"], "failed");
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
    assert_eq!(
        r.sync(&tree, &[], 0)["data"]["workspaces"][0]["status"],
        "updated"
    );
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
                    doc["data"]["workspaces"][0]["status"],
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
    assert_eq!(
        r.sync(&tree, &[], 0)["data"]["workspaces"][0]["status"],
        "dirty"
    );
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
        .mabo(&r.main, &["set", "topic", "--base", "stack/main"])
        .status
        .success());
    r.git(&r.main, &["remote", "set-url", "origin", "/does/not/exist"]);
    let doc = r.sync(&tree, &["--no-default"], 0);
    assert_eq!(
        doc["data"]["workspaces"][0]["base"],
        "refs/remotes/stack/main"
    );
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
        assert_eq!(
            r.sync(&tree, &[], 0)["data"]["workspaces"][0]["status"],
            "dirty"
        );
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
    assert_eq!(
        r.sync(&tree, &[], 0)["data"]["workspaces"][0]["status"],
        "merged"
    );
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
    assert_eq!(
        s.sync(&s.main, &[], 0)["data"]["default"]["status"],
        "updated"
    );
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
        r.sync(&tree, &[], 0)["data"]["workspaces"][0]["status"],
        "up-to-date"
    );
    r.advance();
    assert_eq!(
        r.sync(&tree, &[], 0)["data"]["workspaces"][0]["status"],
        "updated"
    );
    assert_eq!(
        r.git(&tree, &["rev-parse", "HEAD"]),
        r.git(&r.main, &["rev-parse", "origin/main"])
    );
    assert_eq!(
        r.sync(&tree, &[], 0)["data"]["workspaces"][0]["status"],
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
    assert_eq!(
        r.sync(&landed, &[], 0)["data"]["workspaces"][0]["status"],
        "merged"
    );
    // Legacy metadata uses the very same reflog fallback as gc.
    let legacy = r.create("legacy");
    let file = r.main.join(".git/maboroshi/workspaces");
    let mut stored: Value = serde_json::from_slice(&records::read(&file).unwrap()).unwrap();
    for record in stored["worktrees"].as_array_mut().unwrap() {
        record.as_object_mut().unwrap().remove("createdFrom");
    }
    records::write(file, serde_json::to_vec(&stored).unwrap()).unwrap();
    r.write_commit(&r.upstream, "more", "more\n");
    r.git(&r.upstream, &["pull", "--no-rebase", "origin", "main"]);
    r.git(&r.upstream, &["push", "origin", "main"]);
    assert_eq!(
        r.sync(&legacy, &[], 0)["data"]["workspaces"][0]["status"],
        "updated"
    );
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
        let store = r.main.join(".git/maboroshi/workspaces");
        let before = records::read(&store).unwrap();
        r.advance();
        assert_eq!(
            r.sync(&r.main, &["topic"], 0)["data"]["workspaces"][0]["status"],
            "updated"
        );
        r.write_commit(&r.upstream, "second", "second\n");
        r.git(&r.upstream, &["push", "origin", "main"]);
        assert_eq!(
            r.sync(&r.main, &["topic"], 0)["data"]["workspaces"][0]["status"],
            "updated"
        );
        assert_eq!(
            r.sync(&r.main, &["topic"], 0)["data"]["workspaces"][0]["status"],
            "up-to-date"
        );
        let gc = r.mabo(&r.main, &["gc", "--json"]);
        assert!(gc.status.success());
        let doc: Value = serde_json::from_slice(&gc.stdout).unwrap();
        assert!(!doc.to_string().contains("topic"), "{doc}");
        assert_eq!(records::read(store).unwrap(), before);
        if !no_reflog {
            r.write_commit(&r.upstream, "third", "third\n");
            r.git(&r.upstream, &["push", "origin", "main"]);
            r.git(&r.main, &["fetch", "origin"]);
            r.git(&tree, &["reset", "--hard", "origin/main"]);
            assert_eq!(
                r.sync(&r.main, &["topic"], 0)["data"]["workspaces"][0]["status"],
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
            doc["data"]["workspaces"][0]["status"],
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
        let doc = r.sync(&tree, &[&flag, "--no-default"], 5);
        assert_eq!(
            doc["data"]["workspaces"][0]["detail"],
            format!("{strategy} aborted; workspace unchanged")
        );
        let out = r.mabo(&tree, &["sync", &flag, "--no-default"]);
        assert_eq!(out.status.code(), Some(5));
        assert_eq!(String::from_utf8(out.stdout).unwrap(), format!("topic  conflict  file ({strategy} aborted; workspace unchanged)\nSync complete: 1 conflict\n"));
        let out = r.mabo(&tree, &["sync", &flag, "--no-default", "--keep-conflicts"]);
        assert_eq!(out.status.code(), Some(5));
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
fn git_hooks_can_run_mabo() {
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
# Bound the nested command so a regression cannot leave orphaned child processes.
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
fn git_hook_can_run_mabo_exec_and_create_with_project_hooks_and_exec() {
    use std::os::unix::fs::PermissionsExt;
    let r = Repo::new();
    r.create("victim");
    let bin = env!("CARGO_BIN_EXE_mabo");
    let gate = r.root.join("hook-entered");
    let status = r.root.join("hook-status");
    let standalone = r.root.join("standalone-exec");
    let post_create = r.root.join("post-create");
    let create_exec = r.root.join("create-exec");
    fs::write(
        r.main.join(".mabo.toml"),
        format!(
            "[hooks]\npost-create = [\"touch '{}'\"]\n",
            post_create.display()
        ),
    )
    .unwrap();
    let hook = r.main.join(".git/hooks/post-checkout");
    fs::create_dir_all(hook.parent().unwrap()).unwrap();
    fs::write(
        &hook,
        format!(
            r#"#!/bin/sh
[ -e '{gate}' ] && exit 0
touch '{gate}'
cd '{main}'
'{bin}' exec victim -- sh -c "touch '{standalone}'" &&
'{bin}' create nested --exec "touch '{create_exec}'"
echo $? > '{status}'
"#,
            gate = gate.display(),
            main = r.main.display(),
            standalone = standalone.display(),
            create_exec = create_exec.display(),
            status = status.display()
        ),
    )
    .unwrap();
    fs::set_permissions(&hook, fs::Permissions::from_mode(0o755)).unwrap();
    let child = r
        .command(bin, &r.main, &["create", "outer", "--no-hooks"])
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
    assert_eq!(
        fs::read_to_string(status).unwrap().trim(),
        "0",
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    for marker in [standalone, post_create, create_exec] {
        assert!(marker.is_file(), "{}", marker.display());
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
    assert!(r.mabo(&r.main, &["path", "from-delete"]).status.success());
}

#[test]
fn other_commands_can_run_while_create_exec_is_running() {
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
    assert!(r.mabo(&r.main, &["path", "from-gc"]).status.success());
    // A hook can change the target; the old preflight is stale.
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
    assert!(String::from_utf8_lossy(&out.stderr).contains("Workspace changed"));
    assert!(r.mabo(&r.main, &["path", "from-attach"]).status.success());
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
    assert_eq!(
        r.sync(&tree, &[], 0)["data"]["workspaces"][0]["status"],
        "dirty"
    );
    assert_eq!(fs::read_to_string(tree.join("file")).unwrap(), "precious\n");
}

#[test]
fn unrelated_default_history_fails_without_changing_the_checkout() {
    let r = Repo::new();
    r.git(&r.main, &["checkout", "--orphan", "replacement"]);
    r.git(&r.main, &["rm", "-rf", "."]);
    r.write_commit(&r.main, "unrelated", "local main\n");
    r.git(&r.main, &["branch", "-M", "main"]);
    let before = r.snapshot(&r.main);
    let refs = r.git(&r.main, &["show-ref"]);
    let doc = r.sync(&r.main, &[], 1);
    assert_eq!(doc["data"]["default"]["status"], "failed");
    assert!(doc["data"]["default"]["detail"]
        .as_str()
        .unwrap()
        .contains("no common history with refs/remotes/origin/main"));
    assert_eq!(r.snapshot(&r.main), before);
    assert_eq!(r.git(&r.main, &["show-ref"]), refs);
}

#[test]
fn silent_git_failures_are_checked_before_sync_mutations() {
    use std::os::unix::fs::PermissionsExt;
    let real_git = std::env::split_paths(&std::env::var_os("PATH").unwrap())
        .map(|dir| dir.join("git"))
        .find(|file| file.is_file())
        .unwrap();
    for command in [
        "status",
        "ls-files",
        "log",
        "rev-list",
        "for-each-ref",
        "update-ref",
    ] {
        let r = Repo::new();
        let tree = r.create("topic");
        r.write_commit(&tree, "own", "local work\n");
        r.write_commit(&tree, ".gitignore", "valuable\n");
        fs::write(tree.join("valuable"), "precious\n").unwrap();
        let default_only = command == "update-ref";
        if default_only {
            r.git(&r.main, &["checkout", "-b", "other"]);
        }
        r.advance();
        // Keep the fetch outside the snapshot so only sync's integration is tested.
        r.git(&r.main, &["fetch", "origin"]);
        let before = r.snapshot(&tree);
        let main_before = r.snapshot(&r.main);
        let refs = r.git(&r.main, &["show-ref"]);
        let bin = r.root.join("bin");
        fs::create_dir(&bin).unwrap();
        let wrapper = bin.join("git");
        fs::write(
            &wrapper,
            "#!/bin/sh\nfor arg do\n    if [ \"$arg\" = \"$FAIL_COMMAND\" ]; then exit 2; fi\ndone\nexec \"$REAL_GIT\" \"$@\"\n",
        )
        .unwrap();
        fs::set_permissions(wrapper, fs::Permissions::from_mode(0o755)).unwrap();
        let mut paths = vec![bin];
        paths.extend(std::env::split_paths(&std::env::var_os("PATH").unwrap()));
        let args = if default_only {
            vec!["sync", "--json"]
        } else {
            vec!["sync", "--no-default", "--json"]
        };
        let out = r
            .command(
                env!("CARGO_BIN_EXE_mabo"),
                if default_only { &r.main } else { &tree },
                &args,
            )
            .env("PATH", std::env::join_paths(paths).unwrap())
            .env("REAL_GIT", &real_git)
            .env("FAIL_COMMAND", command)
            .output()
            .unwrap();
        assert_eq!(out.status.code(), Some(1), "{command}: {out:?}");
        let doc: Value = serde_json::from_slice(&out.stdout).unwrap();
        let item = if default_only {
            &doc["data"]["default"]
        } else {
            &doc["data"]["workspaces"][0]
        };
        assert_eq!(item["status"], "failed", "{command}: {doc}");
        assert!(item["detail"].as_str().unwrap().contains("exit 2"), "{doc}");
        assert_eq!(r.snapshot(&tree), before, "{command}");
        assert_eq!(r.snapshot(&r.main), main_before, "{command}");
        assert_eq!(r.git(&r.main, &["show-ref"]), refs, "{command}");
    }
}

#[test]
fn unrelated_histories_fail_without_touching_worktree_or_ignored_files() {
    for strategy in [None, Some("--rebase"), Some("--merge")] {
        for has_ignored_file in [true, false] {
            let r = Repo::new();
            let tree = r.create("topic");
            r.git(&tree, &["checkout", "--orphan", "orphan"]);
            r.git(&tree, &["rm", "-rf", "."]);
            r.write_commit(&tree, ".gitignore", "valuable\n");
            fs::write(tree.join("valuable"), "temporary history contents\n").unwrap();
            r.git(&tree, &["add", "-f", "valuable"]);
            r.git(&tree, &["commit", "-m", "temporary path"]);
            r.git(&tree, &["rm", "valuable"]);
            r.git(&tree, &["commit", "-m", "remove temporary path"]);
            r.write_commit(&tree, "own", "unrelated work\n");
            if has_ignored_file {
                fs::write(tree.join("valuable"), b"precious\0ignored data\n").unwrap();
            }
            let merge_base = r
                .command("git", &tree, &["merge-base", "HEAD", "origin/main"])
                .output()
                .unwrap();
            assert_eq!(merge_base.status.code(), Some(1));
            assert!(merge_base.stdout.is_empty());
            assert!(merge_base.stderr.is_empty());
            let before = r.snapshot(&tree);
            let refs = r.git(&tree, &["show-ref"]);
            let mut args = vec!["--no-default"];
            args.extend(strategy);
            let doc = r.sync(&tree, &args, 1);
            let item = &doc["data"]["workspaces"][0];
            assert_eq!(item["status"], "failed", "{doc}");
            assert!(
                item["detail"]
                    .as_str()
                    .unwrap()
                    .contains("no common history with refs/remotes/origin/main"),
                "{doc}"
            );
            assert_eq!(r.snapshot(&tree), before);
            assert_eq!(r.git(&tree, &["show-ref"]), refs);
            assert_eq!(item["before"], item["after"]);
            if has_ignored_file {
                assert_eq!(
                    fs::read(tree.join("valuable")).unwrap(),
                    b"precious\0ignored data\n"
                );
            }
        }
    }
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
                    r.sync(&tree, &[&flag], 0)["data"]["workspaces"][0]["status"],
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
        assert_eq!(
            doc["data"]["workspaces"][0]["status"], "updated",
            "{options}"
        );
        assert_eq!(doc["data"]["workspaces"][0]["strategy"], "merge");
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
    assert_eq!(doc["data"]["workspaces"][0]["status"], "updated");
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
        let fsmonitor = r.install_fsmonitor();
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
                merge) "$REAL_GIT" -c core.hooksPath=/dev/null -c core.fsmonitor=false merge --no-commit origin/main ;;
                squash) "$REAL_GIT" -c core.hooksPath=/dev/null -c core.fsmonitor=false merge --squash origin/main ;;
                rebase) "$REAL_GIT" -c core.hooksPath=/dev/null -c core.fsmonitor=false rebase --exec false origin/main ;;
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
        assert_eq!(doc["data"]["workspaces"][0]["status"], "failed");
        assert!(
            !fsmonitor.exists(),
            "fsmonitor ran during incomplete integration rollback"
        );
        r.git(&r.main, &["config", "core.fsmonitor", "false"]);
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
        r.sync(&tree, &["--no-default"], 0)["data"]["workspaces"][0]["status"],
        "updated"
    );
    for file in ["own", "side", "other"] {
        assert_eq!(
            fs::read_to_string(tree.join(file)).unwrap(),
            format!("{file}\n")
        );
    }
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
            let tree = PathBuf::from(doc["data"]["workspace"]["path"].as_str().unwrap());
            let out = r.mabo(&r.main, &["set", &name, "--base", "team/origin/main"]);
            assert!(
                out.status.success(),
                "{}",
                String::from_utf8_lossy(&out.stderr)
            );
            r.write_commit(&r.upstream, &name, "incoming\n");
            r.git(&r.upstream, &["push", "origin", "main"]);
            let expected = r.git(&r.upstream, &["rev-parse", "HEAD"]);
            let doc = r.sync(&r.main, &[], 0);
            assert_eq!(doc["data"]["default"]["name"], "main");
            assert_eq!(doc["data"]["default"]["status"], "updated");
            assert_eq!(r.git(&r.main, &["rev-parse", "main"]), expected);
            assert_eq!(r.git(&r.main, &["branch", "--list", "origin/main"]), "");
            r.write_commit(&r.upstream, &format!("{name}-next"), "next\n");
            r.git(&r.upstream, &["push", "origin", "main"]);
            let expected = r.git(&r.upstream, &["rev-parse", "HEAD"]);
            let doc = r.sync(&tree, &["--no-default"], 0);
            assert_eq!(
                doc["data"]["workspaces"][0]["base"],
                "refs/remotes/team/origin/main"
            );
            assert_eq!(doc["data"]["workspaces"][0]["status"], "updated");
            assert_eq!(r.git(&tree, &["rev-parse", "HEAD"]), expected);
        }
    }
}

#[test]
fn unmatched_default_remote_fails_without_creating_a_branch() {
    let r = Repo::new();
    let tree = r.create("topic");
    r.write_commit(&tree, "own", "own\n");
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
    assert_eq!(doc["data"]["default"]["status"], "failed");
    assert!(doc["data"]["default"]["detail"]
        .as_str()
        .unwrap()
        .contains("No configured remote matches"));
    assert_eq!(r.git(&r.main, &["for-each-ref", "refs/heads"]), before);
    r.advance();
    let doc = r.sync(&r.main, &["topic"], 6);
    assert_eq!(doc["data"]["default"]["status"], "failed");
    assert_eq!(doc["data"]["workspaces"][0]["status"], "updated", "{doc}");
    assert!(tree.join("remote-file").exists());
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
        assert_eq!(doc["data"]["default"]["status"], "dirty");
        assert!(doc["data"]["default"]["detail"]
            .as_str()
            .unwrap()
            .contains("being rebased"));
        assert_eq!(r.git(&r.main, &["rev-parse", "main"]), before);
        let topic = r.create("topic");
        let doc = r.sync(&r.main, &["topic"], 0);
        assert_eq!(doc["data"]["default"]["status"], "dirty");
        assert_eq!(doc["data"]["workspaces"][0]["status"], "updated");
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
        assert_eq!(doc["data"]["default"]["status"], "dirty", "{doc}");
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
            doc["data"]["workspaces"][0]["status"],
            if operation == "rebase" {
                "detached"
            } else {
                "dirty"
            }
        );
        assert!(doc["data"]["workspaces"][0]["detail"]
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
    assert_eq!(doc["data"]["workspaces"][0]["status"], "dirty");
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
    assert_eq!(doc["data"]["default"]["status"], "updated");
    let items = doc["data"]["workspaces"].as_array().unwrap();
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
    assert_eq!(doc["data"]["default"]["status"], "dirty");
    assert!(doc["data"]["default"]["detail"]
        .as_str()
        .unwrap()
        .contains("being rebased"));
    assert_eq!(doc["data"]["workspaces"][0]["status"], "updated");
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
    let doc = r.sync(&r.main, &["--all"], 6);
    assert_eq!(doc["data"]["default"]["status"], "dirty");
    let items = doc["data"]["workspaces"].as_array().unwrap();
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
        vec!["sync", "--repo", "missing-project", "--json"],
        vec!["list", "--repo", "missing-project", "--json"],
    ] {
        assert_eq!(r.mabo(&r.main, &args).status.code(), Some(3));
    }
    assert_eq!(r.mabo(&r.root, &["sync", "--json"]).status.code(), Some(3));
}

#[test]
fn metadata_failure_after_fast_forward_restores_worktree() {
    use std::os::unix::fs::PermissionsExt;
    let real_git = std::env::split_paths(&std::env::var_os("PATH").unwrap())
        .map(|dir| dir.join("git"))
        .find(|file| file.is_file())
        .unwrap();
    for fail_rollback in ["0", "1", "silent"] {
        let r = Repo::new();
        let tree = r.create("topic");
        let store = r.main.join(".git/maboroshi/workspaces");
        let original_store = records::read(&store).unwrap();
        r.advance();
        let before = r.snapshot(&tree);
        let fsmonitor = r.install_fsmonitor();
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
    if [ "$arg" = --keep ] && [ "$FAIL_ROLLBACK" = silent ]; then
        exit 1
    fi
done
for arg do
    if [ "$arg" = merge ]; then
        "$REAL_GIT" "$@" || exit $?
        for record in "$STORE"/*.json; do printf 'invalid json' > "$record"; done
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
            .env("FAIL_ROLLBACK", fail_rollback)
            .output()
            .unwrap();
        assert_eq!(
            out.status.code(),
            Some(if fail_rollback == "0" { 1 } else { 6 }),
            "{out:?}"
        );
        let doc: Value = serde_json::from_slice(&out.stdout).unwrap();
        let item = &doc["data"]["workspaces"][0];
        assert_eq!(item["status"], "failed");
        assert!(
            !fsmonitor.exists(),
            "fsmonitor ran during metadata rollback"
        );
        r.git(&r.main, &["config", "core.fsmonitor", "false"]);
        let detail = item["detail"].as_str().unwrap();
        assert!(detail.contains("metadata update failed"), "{detail}");
        if fail_rollback != "0" {
            assert!(detail.contains("rollback failed"), "{detail}");
        } else {
            assert!(detail.contains("workspace restored"), "{detail}");
            assert_eq!(item["before"], item["after"]);
            assert_eq!(r.snapshot(&tree), before);
            records::write(&store, &original_store).unwrap();
            assert_eq!(
                r.sync(&tree, &["--no-default"], 0)["data"]["workspaces"][0]["status"],
                "updated"
            );
            assert_eq!(
                r.sync(&tree, &["--no-default"], 0)["data"]["workspaces"][0]["status"],
                "up-to-date"
            );
            let out = r.mabo(&r.main, &["gc", "--json"]);
            assert!(!String::from_utf8_lossy(&out.stdout).contains("topic"));
        }
    }
}

#[test]
fn default_branch_merge_options_cannot_autostash_local_edits() {
    let r = Repo::new();
    r.git(
        &r.main,
        &["config", "branch.main.mergeOptions", "--autostash"],
    );
    r.write_commit(&r.upstream, "file", "incoming edit\n");
    r.git(&r.upstream, &["push", "origin", "main"]);
    fs::write(r.main.join("file"), "local edit\n").unwrap();
    let before = r.snapshot(&r.main);
    let stash = r.git(&r.main, &["stash", "list"]);
    let out = r.mabo(&r.main, &["sync", "--json"]);
    let doc: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(doc["data"]["default"]["status"], "dirty", "{doc}");
    assert_eq!(out.status.code(), Some(1));
    assert_eq!(r.snapshot(&r.main), before);
    assert_eq!(r.git(&r.main, &["stash", "list"]), stash);
    assert!(!r.main.join(".git/MERGE_AUTOSTASH").exists());
}

#[test]
fn failed_default_remote_does_not_block_a_healthy_base_remote() {
    let r = Repo::new();
    r.git(
        &r.main,
        &[
            "config",
            "remote.origin.fetch",
            "+refs/heads/*:refs/remotes/cache/*",
        ],
    );
    r.git(&r.main, &["fetch", "origin"]);
    r.git(
        &r.main,
        &[
            "symbolic-ref",
            "refs/remotes/origin/HEAD",
            "refs/remotes/cache/main",
        ],
    );
    let healthy = r.create("healthy");
    let stale = r.create("stale");
    r.write_commit(&healthy, "own", "own\n");
    r.write_commit(&stale, "local", "local\n");
    r.git(
        &r.main,
        &[
            "remote",
            "add",
            "healthy",
            r.root.join("remote.git").to_str().unwrap(),
        ],
    );
    r.git(&r.main, &["fetch", "healthy"]);
    assert!(r
        .mabo(&r.main, &["set", "healthy", "--base", "healthy/main"])
        .status
        .success());
    r.advance();
    r.git(&r.main, &["remote", "set-url", "origin", "/does/not/exist"]);
    let default_before = r.snapshot(&r.main);
    let stale_before = r.snapshot(&stale);
    let doc = r.sync(&r.main, &["healthy", "stale"], 6);
    assert_eq!(doc["data"]["default"]["status"], "failed");
    assert_eq!(doc["data"]["workspaces"][0]["status"], "updated", "{doc}");
    assert_eq!(doc["data"]["workspaces"][1]["status"], "failed");
    for item in [&doc["data"]["default"], &doc["data"]["workspaces"][1]] {
        assert!(item["detail"]
            .as_str()
            .unwrap()
            .contains("Fetch origin failed"));
    }
    assert!(healthy.join("remote-file").exists());
    assert_eq!(r.snapshot(&r.main), default_before);
    assert_eq!(r.snapshot(&stale), stale_before);
}

#[test]
fn fetch_failures_exit_one_even_with_a_published_rebase_refusal() {
    let r = Repo::new();
    let tree = r.create("published");
    let stale = r.create("stale");
    r.write_commit(&tree, "own", "own\n");
    r.git(
        &r.main,
        &[
            "remote",
            "add",
            "healthy",
            r.root.join("remote.git").to_str().unwrap(),
        ],
    );
    r.git(&tree, &["push", "healthy", "published"]);
    r.git(&r.main, &["fetch", "healthy"]);
    assert!(r
        .mabo(&r.main, &["set", "published", "--base", "healthy/main"])
        .status
        .success());
    r.advance();
    r.git(&r.main, &["remote", "set-url", "origin", "/does/not/exist"]);
    let before = r.snapshot(&tree);
    for args in [
        vec!["published", "--rebase"],
        vec!["--no-default", "published", "stale", "--rebase"],
        vec!["--no-default", "stale", "published", "--rebase"],
    ] {
        let doc = r.sync(&r.main, &args, 1);
        assert!(doc["data"]["workspaces"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["code"] == "published"));
        assert_eq!(r.snapshot(&tree), before);
        assert!(!stale.join("remote-file").exists());
    }
}

#[test]
fn git_hook_read_only_intermediary_can_run_nested_mabo() {
    use std::os::unix::{fs::PermissionsExt, process::CommandExt};
    let r = Repo::new();
    r.create("existing");
    let bin = env!("CARGO_BIN_EXE_mabo");
    let marker = r.root.join("monitor-entered");
    let nested_status = r.root.join("monitor-status");
    let monitor = r.root.join("monitor");
    fs::write(
        &monitor,
        format!(
            r#"#!/bin/sh
if [ ! -e '{marker}' ]; then
    touch '{marker}'
    '{bin}' gc --json > '{output}' 2>&1
    echo $? > '{status}'
fi
printf 'token\000/\000'
"#,
            marker = marker.display(),
            output = r.root.join("nested-output").display(),
            status = nested_status.display()
        ),
    )
    .unwrap();
    fs::set_permissions(&monitor, fs::Permissions::from_mode(0o755)).unwrap();
    let hook = r.main.join(".git/hooks/post-checkout");
    fs::create_dir_all(hook.parent().unwrap()).unwrap();
    fs::write(
        &hook,
        format!(
            "#!/bin/sh\ncd '{}'\ngit config core.fsmonitor '{}'\n'{bin}' list --json\n",
            r.main.display(),
            monitor.display()
        ),
    )
    .unwrap();
    fs::set_permissions(&hook, fs::Permissions::from_mode(0o755)).unwrap();
    let mut child = r
        .command(bin, &r.main, &["create", "outer", "--no-hooks"])
        .process_group(0)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    let timed_out = loop {
        if child.try_wait().unwrap().is_some() {
            break false;
        }
        if std::time::Instant::now() >= deadline {
            Command::new("kill")
                .args(["-KILL", "--", &format!("-{}", child.id())])
                .status()
                .unwrap();
            break true;
        }
        std::thread::sleep(std::time::Duration::from_millis(5));
    };
    let out = child.wait_with_output().unwrap();
    assert!(
        !timed_out,
        "read-only Git intermediary deadlocked: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert_eq!(fs::read_to_string(nested_status).unwrap().trim(), "0");
}

#[test]
fn gc_protects_linked_default_with_a_remapped_tracking_namespace() {
    for (refspec, destination) in [
        (
            "+refs/heads/*:refs/remotes/cache/*",
            "refs/remotes/cache/main",
        ),
        ("+refs/heads/*:refs/cache/*", "refs/cache/main"),
        ("+refs/heads/main:refs/cache/main", "refs/cache/main"),
        ("+refs/heads/m*in:refs/cache/m*in", "refs/cache/main"),
    ] {
        let r = Repo::new();
        r.git(&r.main, &["config", "remote.origin.fetch", refspec]);
        r.git(&r.main, &["fetch", "origin"]);
        r.git(
            &r.main,
            &["symbolic-ref", "refs/remotes/origin/HEAD", destination],
        );
        let landed = r.create("landed");
        r.write_commit(&landed, "landed", "landed change\n");
        r.git(&r.main, &["merge", "--ff-only", "landed"]);
        r.git(&r.main, &["push", "origin", "main"]);
        r.git(&r.upstream, &["pull", "--ff-only"]);
        r.git(&r.main, &["checkout", "-b", "other"]);
        assert!(r.mabo(&r.main, &["attach", "main"]).status.success());
        // main has moved since creation, so only the default-branch guard protects it.
        r.advance();
        let doc = r.sync(&r.main, &[], 0);
        let tree = PathBuf::from(doc["data"]["default"]["path"].as_str().unwrap());
        let before = r.snapshot(&tree);
        let out = r.mabo(&r.main, &["gc", "--merged", "--apply", "--json"]);
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        let doc: Value = serde_json::from_slice(&out.stdout).unwrap();
        assert!(tree.exists(), "primary checkout removed: {doc}");
        assert_eq!(r.snapshot(&tree), before);
        assert!(
            !doc["data"]["candidates"]
                .as_array()
                .unwrap()
                .iter()
                .any(|item| item["branch"] == "main" && item["action"] == "removed"),
            "{doc}"
        );
        assert!(
            doc["data"]["candidates"]
                .as_array()
                .unwrap()
                .iter()
                .any(|item| item["branch"] == "landed" && item["action"] == "removed"),
            "landed branch was not selected: {doc}"
        );
        assert!(!landed.exists());
    }
}

#[test]
fn gc_local_branch_named_like_a_remapped_default_is_not_the_default() {
    for ambiguous_refs in ["true", "false"] {
        let r = Repo::new();
        r.git(
            &r.main,
            &["config", "core.warnAmbiguousRefs", ambiguous_refs],
        );
        r.git(
            &r.main,
            &[
                "config",
                "remote.origin.fetch",
                "+refs/heads/*:refs/remotes/cache/*",
            ],
        );
        r.git(&r.main, &["fetch", "origin"]);
        r.git(
            &r.main,
            &[
                "symbolic-ref",
                "refs/remotes/origin/HEAD",
                "refs/remotes/cache/main",
            ],
        );
        let collision = r.create("cache/main");
        r.write_commit(&collision, "landed", "landed change\n");
        r.git(&r.main, &["merge", "--ff-only", "cache/main"]);
        r.git(&r.main, &["push", "origin", "main"]);
        r.git(&r.main, &["fetch", "origin"]);
        r.git(&r.main, &["checkout", "-b", "other"]);
        let out = r.mabo(&r.main, &["attach", "main", "--json"]);
        assert!(out.status.success());
        let doc: Value = serde_json::from_slice(&out.stdout).unwrap();
        let default_path = PathBuf::from(doc["data"]["workspace"]["path"].as_str().unwrap());
        let before = r.snapshot(&default_path);
        let out = r.mabo(&r.main, &["gc", "--merged", "--json"]);
        assert!(out.status.success());
        let doc: Value = serde_json::from_slice(&out.stdout).unwrap();
        assert!(
            doc["data"]["candidates"]
                .as_array()
                .unwrap()
                .iter()
                .any(|item| item["branch"] == "cache/main" && item["action"] == "wouldRemove"),
            "local cache/main was mistaken for the default: {doc}"
        );
        assert!(
            !doc["data"]["candidates"]
                .as_array()
                .unwrap()
                .iter()
                .any(|item| item["branch"] == "main" && item["action"] == "wouldRemove"),
            "default main was selected: {doc}"
        );
        assert_eq!(r.snapshot(&default_path), before);
        let out = r.mabo(&r.main, &["gc", "--merged", "--apply", "--json"]);
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stdout)
        );
        let doc: Value = serde_json::from_slice(&out.stdout).unwrap();
        assert!(
            doc["data"]["candidates"]
                .as_array()
                .unwrap()
                .iter()
                .any(|item| item["branch"] == "cache/main" && item["action"] == "removed"),
            "{doc}"
        );
        assert!(!collision.exists());
        assert!(default_path.exists(), "{doc}");
        assert_eq!(r.snapshot(&default_path), before);
    }
}

#[test]
fn fetch_refspec_namespace_determines_remote_and_default_local_name() {
    for (refspec, upstream, remote_head) in [
        ("+refs/heads/*:refs/remotes/cache/*", false, true),
        ("+refs/heads/*:refs/remotes/cache/*", true, false),
        ("+refs/heads/main:refs/remotes/cache/main", false, false),
        ("+refs/heads/m*in:refs/remotes/cache/m*in", true, true),
    ] {
        let r = Repo::new();
        r.git(&r.main, &["config", "remote.origin.fetch", refspec]);
        r.git(&r.main, &["fetch", "origin"]);
        r.git(
            &r.main,
            &[
                "symbolic-ref",
                "refs/remotes/origin/HEAD",
                "refs/remotes/cache/main",
            ],
        );
        if !remote_head {
            r.git(&r.main, &["remote", "set-head", "origin", "--delete"]);
        }
        if upstream {
            r.git(&r.main, &["config", "branch.main.remote", "origin"]);
            r.git(&r.main, &["config", "branch.main.merge", "refs/heads/main"]);
        }
        let tree = r.create("topic");
        let out = r.mabo(
            &r.main,
            &["set", "topic", "--base", "refs/remotes/cache/main"],
        );
        assert!(out.status.success());
        r.write_commit(&tree, "local", "local\n");
        r.advance();
        let tip = r.git(&r.upstream, &["rev-parse", "HEAD"]);
        let doc = r.sync(&r.main, &["topic"], 0);
        assert_eq!(doc["data"]["default"]["status"], "updated", "{doc}");
        assert_eq!(doc["data"]["default"]["branch"], "refs/heads/main");
        assert_eq!(doc["data"]["workspaces"][0]["status"], "updated", "{doc}");
        assert_eq!(r.git(&r.main, &["rev-parse", "main"]), tip);
        assert_eq!(
            r.git(&r.main, &["rev-parse", "refs/remotes/cache/main"]),
            tip
        );
        assert!(tree.join("remote-file").exists());
        assert_eq!(r.git(&r.main, &["branch", "--list", "cache/main"]), "");
    }
}

#[test]
fn unresolved_default_does_not_block_recorded_bases() {
    let r = Repo::new();
    r.git(&r.upstream, &["branch", "-m", "develop"]);
    r.git(&r.upstream, &["push", "origin", "develop"]);
    let clone = r.root.join("single-branch");
    r.git(
        &r.main,
        &[
            "clone",
            "--single-branch",
            "--branch",
            "develop",
            r.root.join("remote.git").to_str().unwrap(),
            clone.to_str().unwrap(),
        ],
    );
    r.git(&clone, &["config", "user.name", "Sync Test"]);
    r.git(&clone, &["config", "user.email", "sync@example.com"]);
    r.git(&clone, &["remote", "set-head", "origin", "--delete"]);
    let out = r.mabo(
        &clone,
        &["create", "topic", "--base", "origin/develop", "--json"],
    );
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let created: Value = serde_json::from_slice(&out.stdout).unwrap();
    let tree = PathBuf::from(created["data"]["workspace"]["path"].as_str().unwrap());
    r.write_commit(&tree, "own", "own\n");
    // attach deliberately leaves the recorded base null, exercising fallback errors.
    r.git(&clone, &["branch", "legacy"]);
    assert!(r.mabo(&clone, &["attach", "legacy"]).status.success());
    r.write_commit(&r.upstream, "incoming-develop", "incoming\n");
    r.git(&r.upstream, &["push", "origin", "develop"]);
    let doc = r.sync(&clone, &["legacy", "topic"], 6);
    assert_eq!(doc["data"]["default"]["status"], "failed", "{doc}");
    assert_eq!(doc["data"]["workspaces"][0]["status"], "failed", "{doc}");
    for item in [&doc["data"]["default"], &doc["data"]["workspaces"][0]] {
        assert!(
            item["detail"]
                .as_str()
                .unwrap()
                .contains("Cannot determine the default branch"),
            "{doc}"
        );
    }
    assert_eq!(doc["data"]["workspaces"][1]["status"], "updated", "{doc}");
    assert!(tree.join("incoming-develop").exists());
    let doc = r.sync(&clone, &["topic", "--no-default"], 0);
    assert!(doc["data"]["default"].is_null());
    assert_eq!(doc["data"]["workspaces"][0]["status"], "up-to-date");
    let doc = r.sync(&clone, &["legacy", "topic", "--no-default"], 1);
    assert!(doc["data"]["default"].is_null());
    assert_eq!(doc["data"]["workspaces"][0]["status"], "failed");
    assert_eq!(doc["data"]["workspaces"][1]["status"], "up-to-date");
}

#[test]
fn ordinary_failures_take_precedence_over_pushed_refusals() {
    let r = Repo::new();
    let conflict = r.create("conflict");
    let published = r.create("published");
    r.write_commit(&conflict, "file", "conflicting local edit\n");
    r.write_commit(&published, "own", "published\n");
    r.git(&published, &["push", "origin", "published"]);
    r.write_commit(&r.upstream, "file", "conflicting remote edit\n");
    r.git(&r.upstream, &["push", "origin", "main"]);
    let before = r.snapshot(&conflict);
    for names in [["conflict", "published"], ["published", "conflict"]] {
        let doc = r.sync(
            &r.main,
            &[names[0], names[1], "--no-default", "--rebase"],
            5,
        );
        let items = doc["data"]["workspaces"].as_array().unwrap();
        assert!(
            items.iter().any(|item| item["status"] == "conflict"),
            "{doc}"
        );
        assert!(
            items.iter().any(|item| item["code"] == "published"),
            "{doc}"
        );
        assert_eq!(r.snapshot(&conflict), before);
    }
    let doc = r.sync(&r.main, &["published", "--no-default", "--rebase"], 4);
    assert_eq!(doc["data"]["workspaces"][0]["code"], "published");

    // A default failure is ordinary too, even alongside a sole refusal.
    r.git(&r.main, &["update-ref", "refs/remotes/stale/main", "HEAD"]);
    r.git(
        &r.main,
        &[
            "symbolic-ref",
            "refs/remotes/origin/HEAD",
            "refs/remotes/stale/main",
        ],
    );
    let doc = r.sync(&r.main, &["published", "--rebase"], 1);
    assert_eq!(doc["data"]["default"]["status"], "failed");
    assert_eq!(doc["data"]["workspaces"][0]["code"], "published");

    // A target inspection failure must also survive either ordering.
    fs::write(conflict.join(".git"), "gitdir: /does/not/exist\n").unwrap();
    for names in [["conflict", "published"], ["published", "conflict"]] {
        let doc = r.sync(
            &r.main,
            &[names[0], names[1], "--no-default", "--rebase"],
            1,
        );
        let items = doc["data"]["workspaces"].as_array().unwrap();
        assert!(
            items
                .iter()
                .any(|item| item["status"] == "failed" && item["code"].is_null()),
            "{doc}"
        );
        assert!(
            items.iter().any(|item| item["code"] == "published"),
            "{doc}"
        );
    }
}

#[test]
fn rebase_reapplies_upstream_cherry_pick_that_was_reverted() {
    for explicit in [false, true] {
        let r = Repo::new();
        let tree = r.create("topic");
        r.write_commit(&tree, "local-change", "must survive\n");
        let local = r.git(&tree, &["rev-parse", "HEAD"]);
        r.advance();
        r.git(&r.upstream, &["fetch", r.main.to_str().unwrap(), "topic"]);
        r.git(&r.upstream, &["cherry-pick", &local]);
        r.git(&r.upstream, &["revert", "--no-edit", "HEAD"]);
        r.git(&r.upstream, &["push", "origin", "main"]);
        let args = if explicit {
            vec!["--no-default", "--rebase"]
        } else {
            vec!["--no-default"]
        };
        let doc = r.sync(&tree, &args, 0);
        assert_eq!(doc["data"]["workspaces"][0]["strategy"], "rebase");
        assert_eq!(doc["data"]["workspaces"][0]["status"], "updated");
        assert_eq!(
            fs::read_to_string(tree.join("local-change")).unwrap(),
            "must survive\n"
        );
    }
}

#[test]
fn rebase_preserves_intentionally_empty_and_newly_empty_commits() {
    for explicit in [false, true] {
        let r = Repo::new();
        let tree = r.create("topic");
        r.git(
            &tree,
            &["commit", "--allow-empty", "-m", "intentional-empty"],
        );
        r.write_commit(&tree, "shared", "shared\n");
        r.write_commit(&tree, "own", "own\n");
        r.write_commit(&r.upstream, "shared", "shared\n");
        r.git(&r.upstream, &["push", "origin", "main"]);
        r.git(&tree, &["config", "rebase.backend", "apply"]);
        r.git(&tree, &["config", "rebase.missingCommitsCheck", "ignore"]);
        let args = if explicit {
            vec!["--no-default", "--rebase"]
        } else {
            vec!["--no-default"]
        };
        let doc = r.sync(&tree, &args, 0);
        assert_eq!(doc["data"]["workspaces"][0]["status"], "updated");
        assert_eq!(
            r.git(&tree, &["rev-list", "--count", "origin/main..HEAD"]),
            "3"
        );
        assert!(r
            .git(&tree, &["log", "--format=%s", "origin/main..HEAD"])
            .contains("intentional-empty"));
    }
}

#[test]
fn merge_own_changes_refuse_rebase_and_survive_explicit_merge() {
    for resolution in [false, true] {
        for strategy in ["auto", "--rebase", "--merge"] {
            let r = Repo::new();
            let tree = r.create("topic");
            r.write_commit(&tree, "own", "own\n");
            r.git(&tree, &["checkout", "-b", "side"]);
            r.write_commit(&tree, if resolution { "file" } else { "side" }, "side\n");
            r.git(&tree, &["checkout", "topic"]);
            r.write_commit(&tree, if resolution { "file" } else { "other" }, "other\n");
            let out = r
                .command("git", &tree, &["merge", "--no-commit", "--no-ff", "side"])
                .output()
                .unwrap();
            assert_eq!(out.status.success(), !resolution);
            r.write_commit(
                &tree,
                if resolution { "file" } else { "merge-only" },
                "merge owns this\n",
            );
            let merge = r.git(&tree, &["rev-parse", "--short", "HEAD"]);
            r.advance();
            let before = r.snapshot(&tree);
            let mut args = vec!["--no-default"];
            if strategy != "auto" {
                args.push(strategy);
            }
            let doc = r.sync(&tree, &args, if strategy == "--merge" { 0 } else { 1 });
            let item = &doc["data"]["workspaces"][0];
            if strategy == "--merge" {
                assert_eq!(item["status"], "updated");
                assert_eq!(item["strategy"], "merge");
                assert_eq!(
                    fs::read_to_string(tree.join(if resolution { "file" } else { "merge-only" }))
                        .unwrap(),
                    "merge owns this\n"
                );
            } else {
                assert_eq!(item["status"], "failed");
                assert_eq!(item["strategy"], "rebase");
                let detail = item["detail"].as_str().unwrap();
                assert!(
                    detail.contains(&merge)
                        && detail.contains("has changes of its own; use --merge"),
                    "{doc}"
                );
                assert_eq!(r.snapshot(&tree), before);
            }
        }
    }
}

#[test]
fn published_commits_in_fetch_destinations_outside_remotes_are_protected() {
    for refspec in [
        "+refs/heads/*:refs/cache/*",
        "+refs/heads/topic:refs/cache/topic",
        "+refs/heads/to*ic:refs/cache/to*ic",
    ] {
        for explicit in [false, true] {
            let r = Repo::new();
            let tree = r.create("topic");
            r.write_commit(&tree, "published", "published\n");
            r.git(&tree, &["push", "origin", "topic"]);
            // Keep standard main tracking for the recorded base, but store the
            // published topic only in the configured cache destination.
            r.git(
                &r.main,
                &[
                    "config",
                    "remote.origin.fetch",
                    "+refs/heads/main:refs/remotes/origin/main",
                ],
            );
            r.git(
                &r.main,
                &["config", "--add", "remote.origin.fetch", refspec],
            );
            r.git(&r.main, &["update-ref", "-d", "refs/remotes/origin/topic"]);
            r.git(&r.main, &["fetch", "origin"]);
            r.advance();
            let before = r.snapshot(&tree);
            let doc = r.sync(
                &tree,
                if explicit {
                    &["--no-default", "--rebase"]
                } else {
                    &["--no-default"]
                },
                if explicit { 4 } else { 0 },
            );
            let item = &doc["data"]["workspaces"][0];
            if explicit {
                assert_eq!(item["code"], "published");
                assert_eq!(r.snapshot(&tree), before);
            } else {
                assert_eq!(item["strategy"], "merge", "{doc}");
                assert_eq!(item["status"], "updated");
                let published = before["head"].as_str().unwrap();
                r.git(&tree, &["merge-base", "--is-ancestor", published, "HEAD"]);
            }
        }
    }
}

#[test]
fn gc_default_uses_local_branch_when_a_same_name_tag_exists() {
    for annotated in [false, true] {
        let r = Repo::new();
        let gone = r.create("gone");
        r.git(&r.main, &["remote", "set-head", "origin", "--delete"]);
        if annotated {
            r.git(&r.main, &["tag", "-a", "main", "-m", "same-name tag"]);
        } else {
            r.git(&r.main, &["tag", "main"]);
        }
        r.write_commit(&r.main, "local-default", "keep default\n");
        r.git(&r.main, &["checkout", "-b", "other"]);
        assert!(r.mabo(&r.main, &["attach", "main"]).status.success());
        let default_path = PathBuf::from(
            r.git(&r.main, &["worktree", "list", "--porcelain"])
                .lines()
                .filter_map(|line| line.strip_prefix("worktree "))
                .find(|path| {
                    Path::new(path).join("local-default").exists() && Path::new(path) != r.main
                })
                .unwrap(),
        );
        r.git(
            &r.main,
            &["worktree", "remove", "--force", gone.to_str().unwrap()],
        );
        let before = r.snapshot(&default_path);
        for args in [
            vec!["gc", "--orphaned", "--json"],
            vec!["gc", "--merged", "--apply", "--json"],
        ] {
            let out = r.mabo(&r.main, &args);
            assert!(
                out.status.success(),
                "{} {}",
                String::from_utf8_lossy(&out.stdout),
                String::from_utf8_lossy(&out.stderr)
            );
            let doc: Value = serde_json::from_slice(&out.stdout).unwrap();
            assert!(default_path.exists(), "{doc}");
            assert_eq!(r.snapshot(&default_path), before);
            if args.contains(&"--orphaned") {
                assert!(
                    doc["data"]["candidates"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .any(|item| item["name"] == "gone"),
                    "{doc}"
                );
            }
        }
    }
}

#[test]
fn gc_orphaned_survives_unresolvable_default_mapping() {
    let r = Repo::new();
    let gone = r.create("gone");
    r.git(
        &r.main,
        &["worktree", "remove", "--force", gone.to_str().unwrap()],
    );
    r.git(
        &r.main,
        &["update-ref", "refs/remotes/unmapped/main", "HEAD"],
    );
    r.git(
        &r.main,
        &[
            "symbolic-ref",
            "refs/remotes/origin/HEAD",
            "refs/remotes/unmapped/main",
        ],
    );
    let out = r.mabo(&r.main, &["gc", "--orphaned", "--apply", "--json"]);
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stdout)
    );
    let doc: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(doc["data"]["candidates"][0]["name"], "gone");
    assert_eq!(doc["data"]["candidates"][0]["action"], "removed");
}

#[test]
fn gc_unresolved_default_keeps_branch_worktrees_even_with_force() {
    for missing_base in [false, true] {
        let r = Repo::new();
        let tree = r.create("possibly-default");
        let gone = r.create("gone");
        r.git(
            &r.main,
            &["worktree", "remove", "--force", gone.to_str().unwrap()],
        );
        if missing_base {
            r.git(&r.main, &["branch", "-m", "develop"]);
            r.git(&r.main, &["remote", "remove", "origin"]);
        } else {
            r.git(
                &r.main,
                &["update-ref", "refs/remotes/unmapped/main", "HEAD"],
            );
            r.git(
                &r.main,
                &[
                    "symbolic-ref",
                    "refs/remotes/origin/HEAD",
                    "refs/remotes/unmapped/main",
                ],
            );
        }
        let store = r.main.join(".git/maboroshi/workspaces");
        let mut doc: Value = serde_json::from_slice(&records::read(&store).unwrap()).unwrap();
        for record in doc["worktrees"].as_array_mut().unwrap() {
            record["createdAt"] = json!("2000-01-01T00:00:00.000Z");
        }
        records::write(&store, serde_json::to_vec_pretty(&doc).unwrap()).unwrap();
        let before = r.snapshot(&tree);
        let out = r.mabo(
            &r.main,
            &[
                "gc",
                "--older-than",
                "1d",
                "--orphaned",
                "--force",
                "--json",
            ],
        );
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stdout)
        );
        assert!(
            String::from_utf8_lossy(&out.stderr)
                .contains("cannot resolve the default branch; keeping all branch workspaces"),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        let doc: Value = serde_json::from_slice(&out.stdout).unwrap();
        let candidates = doc["data"]["candidates"].as_array().unwrap();
        assert!(
            candidates
                .iter()
                .any(|item| item["name"] == "possibly-default" && item["action"] == "skipped"),
            "{doc}"
        );
        assert!(
            candidates
                .iter()
                .any(|item| item["name"] == "gone" && item["action"] == "removed"),
            "{doc}"
        );
        assert_eq!(r.snapshot(&tree), before);
    }
}

#[test]
fn sync_never_runs_fsmonitor_for_noop_update_or_conflict_abort() {
    for mode in [
        "noop",
        "rebase",
        "merge",
        "rebase-conflict",
        "merge-conflict",
    ] {
        let r = Repo::new();
        let tree = r.create("topic");
        let conflict = mode.ends_with("conflict");
        r.write_commit(&tree, if conflict { "file" } else { "own" }, "own\n");
        if mode != "noop" {
            if conflict {
                r.write_commit(&r.upstream, "file", "conflicting remote\n");
                r.git(&r.upstream, &["push", "origin", "main"]);
            } else {
                r.advance();
            }
        }
        let before = r.snapshot(&tree);
        let marker = r.install_fsmonitor();
        let mut args = vec!["topic"];
        if mode.starts_with("merge") {
            args.push("--merge");
        }
        let doc = r.sync(&r.main, &args, if conflict { 6 } else { 0 });
        assert_eq!(
            doc["data"]["workspaces"][0]["status"],
            if conflict {
                "conflict"
            } else if mode == "noop" {
                "up-to-date"
            } else {
                "updated"
            }
        );
        assert!(!marker.exists(), "fsmonitor ran for {mode}");
        r.sync(&r.main, &[], 0);
        assert!(!marker.exists(), "fsmonitor ran for default-only {mode}");
        r.git(&r.main, &["config", "core.fsmonitor", "false"]);
        if conflict {
            assert_eq!(r.snapshot(&tree), before);
        }
    }
}

#[test]
fn rebase_keeps_own_commits_after_upstream_rewind_with_forkpoint_config() {
    for explicit in [false, true] {
        let r = Repo::new();
        let initial = r.git(&r.upstream, &["rev-parse", "HEAD"]);
        r.write_commit(&r.upstream, "old-upstream", "must survive rewind\n");
        r.git(&r.upstream, &["push", "origin", "main"]);
        r.git(&r.main, &["fetch", "origin"]);
        r.git(&r.main, &["merge", "--ff-only", "origin/main"]);
        let tree = r.create("topic");
        r.write_commit(&tree, "own", "own\n");
        r.git(&r.upstream, &["reset", "--hard", &initial]);
        r.write_commit(&r.upstream, "new-upstream", "new upstream\n");
        r.git(&r.upstream, &["push", "--force", "origin", "main"]);
        r.git(&tree, &["config", "rebase.forkPoint", "true"]);
        let args = if explicit {
            vec!["--no-default", "--rebase"]
        } else {
            vec!["--no-default"]
        };
        let doc = r.sync(&tree, &args, 0);
        assert_eq!(doc["data"]["workspaces"][0]["status"], "updated");
        assert_eq!(
            fs::read_to_string(tree.join("old-upstream")).unwrap(),
            "must survive rewind\n"
        );
        assert_eq!(fs::read_to_string(tree.join("own")).unwrap(), "own\n");
    }
}

#[test]
fn explicitly_cleared_base_skips_sync_until_reset() {
    for selector in ["--all", "topic"] {
        let r = Repo::new();
        let tree = r.create("topic");
        let out = r.mabo(&r.main, &["set", "topic", "--unset", "base", "--json"]);
        assert!(out.status.success());
        // An unrelated edit must preserve the explicit clear across process boundaries.
        assert!(r
            .mabo(&r.main, &["set", "topic", "--purpose", "paused"])
            .status
            .success());
        r.advance();
        let before = r.snapshot(&tree);
        let store = r.main.join(".git/maboroshi/workspaces");
        let record_before = records::read(&store).unwrap();
        let doc = r.sync(&r.main, &[selector, "--no-default"], 0);
        let item = &doc["data"]["workspaces"][0];
        assert_eq!(item["status"], "base-unknown");
        assert!(item["base"].is_null());
        assert!(item["detail"]
            .as_str()
            .unwrap()
            .contains("explicitly cleared"));
        assert!(item["detail"]
            .as_str()
            .unwrap()
            .contains("mabo set topic --base REF"));
        assert_eq!(r.snapshot(&tree), before);
        assert_eq!(records::read(&store).unwrap(), record_before);
        let out = r.mabo(&r.main, &["set", "topic", "--base", "origin/main"]);
        assert!(out.status.success());
        let doc = r.sync(&r.main, &[selector, "--no-default"], 0);
        assert_eq!(doc["data"]["workspaces"][0]["status"], "updated");
        assert_eq!(
            r.git(&tree, &["rev-parse", "HEAD"]),
            r.git(&r.upstream, &["rev-parse", "HEAD"])
        );
    }
}

#[test]
fn cleared_base_on_default_checkout_is_skipped() {
    for selector in ["--all", "topic"] {
        let r = Repo::new();
        let tree = r.create("topic");
        r.git(&r.main, &["checkout", "-b", "primary"]);
        r.git(&tree, &["checkout", "main"]);
        assert!(r
            .mabo(&r.main, &["set", "topic", "--unset", "base"])
            .status
            .success());
        r.advance();
        let before = r.snapshot(&tree);
        let doc = r.sync(&r.main, &[selector, "--no-default"], 0);
        assert_eq!(doc["data"]["workspaces"][0]["status"], "base-unknown");
        assert_eq!(r.snapshot(&tree), before);
        let doc = r.sync(&r.main, &[selector], 0);
        assert_eq!(doc["data"]["default"]["status"], "base-unknown");
        assert_eq!(r.snapshot(&tree), before);
    }
}

#[test]
fn legacy_missing_base_falls_back_after_record_migration() {
    let r = Repo::new();
    let legacy = r.root.join("legacy");
    let cleared = r.root.join("cleared");
    for (name, path) in [("legacy", &legacy), ("cleared", &cleared)] {
        r.git(
            &r.main,
            &["worktree", "add", "-b", name, path.to_str().unwrap()],
        );
    }
    let file = r.main.join(".git/maboroshi/worktrees.json");
    fs::create_dir_all(file.parent().unwrap()).unwrap();
    fs::write(
        &file,
        serde_json::to_vec(&json!({"version": 1, "worktrees": [
            {"path": legacy, "purpose": "old"}, {"path": cleared}
        ]}))
        .unwrap(),
    )
    .unwrap();
    assert!(r
        .mabo(&r.main, &["set", "cleared", "--unset", "base"])
        .status
        .success());
    assert!(!file.exists());
    assert!(file.with_extension("json.imported").exists());
    r.advance();
    let before = r.snapshot(&cleared);
    let doc = r.sync(&r.main, &["--all", "--no-default"], 0);
    let items = doc["data"]["workspaces"].as_array().unwrap();
    let old = items.iter().find(|item| item["name"] == "legacy").unwrap();
    assert_eq!(old["base"], "refs/remotes/origin/main");
    assert_eq!(old["status"], "updated");
    let unknown = items.iter().find(|item| item["name"] == "cleared").unwrap();
    assert_eq!(unknown["status"], "base-unknown");
    assert_eq!(r.snapshot(&cleared), before);
}
