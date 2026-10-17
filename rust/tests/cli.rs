use std::fs;
use std::path::PathBuf;
use std::process::Command;

struct Repo {
    root: PathBuf,
    repo: PathBuf,
    home: PathBuf,
}

impl Repo {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("phantom-rust-{}", uuid()));
        let repo = root.join("repo");
        let home = root.join("home");
        fs::create_dir_all(home.join(".config/git")).expect("home");
        fs::create_dir_all(&repo).expect("repo");
        fs::write(home.join(".gitconfig"), "").expect("gitconfig");
        let repo_ctx = Repo { root, repo, home };
        repo_ctx.git(&["init", "-b", "main"]);
        repo_ctx.git(&["config", "user.name", "Phantom Rust"]);
        repo_ctx.git(&["config", "user.email", "phantom-rust@example.com"]);
        fs::write(repo_ctx.repo.join("README.md"), "# phantom\n").expect("readme");
        repo_ctx.git(&["add", "README.md"]);
        repo_ctx.git(&["commit", "-m", "initial commit"]);
        repo_ctx
    }

    fn git(&self, args: &[&str]) {
        let output = self.command("git", args).output().expect("git");
        assert!(
            output.status.success(),
            "git {} failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn phantom(&self, args: &[&str]) -> std::process::Output {
        self.command(env!("CARGO_BIN_EXE_phantom"), args)
            .output()
            .expect("phantom")
    }

    fn command(&self, program: &str, args: &[&str]) -> Command {
        let mut command = Command::new(program);
        command
            .args(args)
            .current_dir(&self.repo)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("HOME", &self.home)
            .env("XDG_CONFIG_HOME", self.home.join(".config"))
            .env("XDG_STATE_HOME", self.root.join("state"));
        command
    }
}

impl Drop for Repo {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn uuid() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    format!("{nanos}-{}", std::process::id())
}

fn text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).trim_end().to_string()
}

#[test]
fn version_help_and_unknown_command() {
    let repo = Repo::new();
    let version = repo.phantom(&["--version"]);
    assert!(version.status.success());
    assert_eq!(text(&version.stdout), "Phantom v6.3.2");

    let help = repo.phantom(&["--help"]);
    assert!(help.status.success());
    assert!(text(&help.stdout).contains("Phantom - Git Worktree Manager"));

    let unknown = repo.phantom(&["nope"]);
    assert_eq!(unknown.status.code(), Some(1));
    assert!(text(&unknown.stderr).contains("Unknown command 'nope'"));
}

#[test]
fn create_list_where_delete_and_attach() {
    let repo = Repo::new();
    let created = repo.phantom(&["create", "feature/add-tests"]);
    assert!(created.status.success(), "{}", text(&created.stderr));
    assert!(text(&created.stdout).contains("Created worktree 'feature/add-tests' at "));
    let worktree = repo.repo.join(".git/phantom/worktrees/feature/add-tests");
    assert!(worktree.join("README.md").is_file());

    let duplicate = repo.phantom(&["create", "feature/add-tests"]);
    assert_eq!(duplicate.status.code(), Some(3));
    assert!(text(&duplicate.stderr).contains("already exists"));

    let names = repo.phantom(&["list", "--names", "--no-default"]);
    assert!(names.status.success(), "{}", text(&names.stderr));
    assert_eq!(text(&names.stdout), "feature/add-tests");

    let empty = repo.phantom(&["list", "--no-default"]);
    let _ = empty;
    let where_path = repo.phantom(&["where", "feature/add-tests"]);
    assert_eq!(where_path.status.code(), Some(0));
    assert_eq!(text(&where_path.stdout), worktree.to_string_lossy());

    let missing = repo.phantom(&["where", "missing-worktree"]);
    assert_eq!(missing.status.code(), Some(2));
    assert!(text(&missing.stderr).contains("not found"));

    repo.git(&["branch", "existing-feature"]);
    let attached = repo.phantom(&["attach", "existing-feature"]);
    assert!(attached.status.success(), "{}", text(&attached.stderr));
    assert!(text(&attached.stdout).contains("Attached phantom: existing-feature"));
    let missing_branch = repo.phantom(&["attach", "missing-branch"]);
    assert_eq!(missing_branch.status.code(), Some(2));

    let kept = repo.phantom(&["delete", "existing-feature", "--keep-branch"]);
    assert!(kept.status.success(), "{}", text(&kept.stderr));
    assert!(text(&kept.stdout).contains("kept its branch 'existing-feature'"));
    let branch = repo
        .command("git", &["branch", "--list", "existing-feature"])
        .output()
        .expect("branch");
    assert!(text(&branch.stdout).contains("existing-feature"));

    let deleted = repo.phantom(&["delete", "feature/add-tests"]);
    assert!(deleted.status.success(), "{}", text(&deleted.stderr));
    assert!(text(&deleted.stdout).contains("and its branch 'feature/add-tests'"));
    assert!(!worktree.exists());
    let missing_delete = repo.phantom(&["delete", "missing-worktree"]);
    assert_eq!(missing_delete.status.code(), Some(3));
}

#[test]
fn copies_config_files_and_runs_post_create() {
    let repo = Repo::new();
    fs::write(repo.repo.join(".env.local"), "API_KEY=test-value\n").expect("env");
    fs::write(
        repo.repo.join("phantom.config.json"),
        r#"{"postCreate":{"copyFiles":[".env.local"],"commands":["touch post-create.txt"]}}"#,
    )
    .expect("config");
    let created = repo.phantom(&["create", "feature/config"]);
    assert!(
        created.status.success(),
        "{}\n{}",
        text(&created.stdout),
        text(&created.stderr)
    );
    let worktree = repo.repo.join(".git/phantom/worktrees/feature/config");
    assert_eq!(
        fs::read_to_string(worktree.join(".env.local")).expect("copied"),
        "API_KEY=test-value\n"
    );
    assert!(text(&created.stdout).contains("Running post-create commands"));
    assert!(text(&created.stdout).contains("Executing: touch post-create.txt"));
    assert!(worktree.join("post-create.txt").is_file());
}

#[test]
fn preferences_and_project_registry() {
    let repo = Repo::new();
    let set = repo.phantom(&["preferences", "set", "keepBranch", "true"]);
    assert!(set.status.success(), "{}", text(&set.stderr));
    assert!(text(&set.stdout).contains("Set phantom.keepBranch (global) to 'true'"));
    let get = repo.phantom(&["preferences", "get", "keepBranch"]);
    assert_eq!(text(&get.stdout), "true");

    let added = repo.phantom(&["project", "add", "--json"]);
    assert!(added.status.success(), "{}", text(&added.stderr));
    let value: serde_json::Value = serde_json::from_str(&text(&added.stdout)).expect("json");
    assert_eq!(value["status"], "added");
    assert_eq!(value["project"]["name"], "repo");
    assert_eq!(
        value["project"]["rootPath"],
        repo.repo.to_string_lossy().as_ref()
    );

    repo.phantom(&["preferences", "set", "ghqDiscovery", "false"]);
    let listed = repo.phantom(&["project", "list", "--json"]);
    assert!(listed.status.success(), "{}", text(&listed.stderr));
    let catalog: serde_json::Value = serde_json::from_str(&text(&listed.stdout)).expect("catalog");
    assert_eq!(catalog["version"], 2);
    assert_eq!(catalog["projects"][0]["source"], "registry");
    assert_eq!(catalog["projects"][0]["id"], value["project"]["id"]);

    let removed = repo.phantom(&[
        "project",
        "remove",
        value["project"]["id"].as_str().expect("id"),
        "--json",
    ]);
    assert!(removed.status.success(), "{}", text(&removed.stderr));
    let empty = repo.phantom(&["project", "list", "--json"]);
    let empty_catalog: serde_json::Value =
        serde_json::from_str(&text(&empty.stdout)).expect("empty");
    assert_eq!(empty_catalog["projects"].as_array().map(Vec::len), Some(0));
}

#[test]
fn keep_branch_preference_applies_to_delete() {
    let repo = Repo::new();
    repo.git(&[
        "worktree",
        "add",
        "-b",
        "removable",
        ".git/phantom/worktrees/removable",
        "HEAD",
    ]);
    repo.phantom(&["preferences", "set", "keepBranch", "true"]);
    let deleted = repo.phantom(&["delete", "removable"]);
    assert!(deleted.status.success(), "{}", text(&deleted.stderr));
    assert!(text(&deleted.stdout).contains("kept its branch 'removable'"));
    let branch = repo
        .command("git", &["branch", "--list", "removable"])
        .output()
        .expect("branch");
    assert!(text(&branch.stdout).contains("removable"));
}

#[test]
fn completion_scripts_are_emitted() {
    let repo = Repo::new();
    for shell in ["bash", "zsh", "fish"] {
        let output = repo.phantom(&["completion", shell]);
        assert!(output.status.success(), "{}", text(&output.stderr));
        assert!(!text(&output.stdout).is_empty());
    }
    let unsupported = repo.phantom(&["completion", "nu"]);
    assert_eq!(unsupported.status.code(), Some(1));
    assert!(text(&unsupported.stderr).contains("Unsupported shell: nu"));
}

#[test]
fn exec_preserves_the_child_exit_code() {
    let repo = Repo::new();
    let created = repo.phantom(&["create", "feature/exec"]);
    assert!(created.status.success(), "{}", text(&created.stderr));
    let output = repo.phantom(&["exec", "feature/exec", "--", "sh", "-c", "exit 4"]);
    assert_eq!(output.status.code(), Some(4));
    assert!(text(&output.stderr).contains("failed with exit code 4"));
}
