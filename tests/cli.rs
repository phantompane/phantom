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
        self.command(env!("CARGO_BIN_EXE_ptm"), args)
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
        // Parallel `git init` hardlinks the shared template and can fail with
        // "File exists" on the hook samples. Give each repo an empty template.
        if program.ends_with("git") && args.first() == Some(&"init") {
            let template = self.root.join("git-template");
            fs::create_dir_all(&template).expect("git template");
            command.env("GIT_TEMPLATE_DIR", &template);
        }
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

fn phantom_color(
    repo: &Repo,
    args: &[&str],
    no_color: Option<&str>,
    force_color: Option<&str>,
) -> std::process::Output {
    let mut command = repo.command(env!("CARGO_BIN_EXE_ptm"), args);
    command.env_remove("NO_COLOR").env_remove("FORCE_COLOR");
    if let Some(value) = no_color {
        command.env("NO_COLOR", value);
    }
    if let Some(value) = force_color {
        command.env("FORCE_COLOR", value);
    }
    command.output().expect("phantom")
}

#[test]
fn help_is_plain_when_stdout_is_not_a_tty() {
    let repo = Repo::new();
    let help = phantom_color(&repo, &["--help"], None, None);
    assert!(help.status.success());
    assert!(
        !text(&help.stdout).contains('\u{1b}'),
        "piped help should not include ANSI color: {}",
        text(&help.stdout)
    );
    let list = phantom_color(&repo, &["list", "--help"], None, None);
    assert!(list.status.success());
    assert!(!text(&list.stdout).contains('\u{1b}'));

    let forced = phantom_color(&repo, &["--help"], None, Some("1"));
    assert!(
        text(&forced.stdout).contains('\u{1b}'),
        "FORCE_COLOR=1 should color piped help"
    );

    let no_color = phantom_color(&repo, &["--help"], Some("1"), Some("1"));
    assert!(
        !text(&no_color.stdout).contains('\u{1b}'),
        "NO_COLOR disables color even when FORCE_COLOR is set"
    );

    let disabled = phantom_color(&repo, &["github", "checkout", "--help"], None, Some("0"));
    assert!(!text(&disabled.stdout).contains('\u{1b}'));
}

#[test]
fn outside_a_git_repository_is_a_phantom_error() {
    let repo = Repo::new();
    let outside = repo.root.join("outside");
    fs::create_dir_all(&outside).expect("outside");
    for args in [
        &["list"][..],
        &["create", "name"],
        &["where", "name"],
        &["delete", "name"],
        &["exec", "name", "--", "true"],
    ] {
        let output = repo
            .command(env!("CARGO_BIN_EXE_ptm"), args)
            .current_dir(&outside)
            .output()
            .expect("phantom");
        let stderr = text(&output.stderr);
        assert!(
            !stderr.to_ascii_lowercase().contains("fatal:"),
            "{args:?} leaked git output: {stderr}"
        );
        assert!(
            stderr.contains("Not a git repository. Run ptm from inside a Git repository."),
            "{args:?} stderr: {stderr}"
        );
        assert_eq!(output.status.code(), Some(4), "{args:?} stderr: {stderr}");
    }
    let help = repo
        .command(env!("CARGO_BIN_EXE_ptm"), &["--help"])
        .current_dir(&outside)
        .output()
        .expect("help");
    assert!(help.status.success());
}

#[test]
fn version_help_and_unknown_command() {
    let repo = Repo::new();
    let version = repo.phantom(&["--version"]);
    assert!(version.status.success());
    let version_line = text(&version.stdout);
    assert!(
        version_line.starts_with("Phantom v7.0.0-alpha.1+rust"),
        "{version_line}"
    );
    assert_ne!(version_line, "Phantom v7.0.0-alpha.1");
    let subcommand = repo.phantom(&["version"]);
    assert_eq!(text(&subcommand.stdout), version_line);

    let help = repo.phantom(&["--help"]);
    assert!(help.status.success());
    let help_text = text(&help.stdout);
    assert!(help_text.contains("Phantom - Git Worktree Manager"));
    assert!(help_text.contains("ptm <command> [options]"));
    assert!(help_text.contains("Run 'ptm <command> --help'"));
    assert!(!help_text.contains("phantom <command>"));

    let where_help = repo.phantom(&["where", "--help"]);
    assert!(where_help.status.success());
    let where_text = text(&where_help.stdout);
    assert!(where_text.contains("ptm where"));
    assert!(where_text.contains("ptm where <worktree-name>"));
    assert!(!where_text.contains("phantom where"));

    let missing_where = repo.phantom(&["where"]);
    assert_eq!(missing_where.status.code(), Some(3));
    assert!(text(&missing_where.stderr).contains("Usage: ptm where <worktree-name>"));

    let unknown = repo.phantom(&["nope"]);
    assert_eq!(unknown.status.code(), Some(1));
    assert!(text(&unknown.stderr).contains("Unknown command 'nope'"));
}

#[test]
fn removed_tmux_options_are_unknown() {
    let repo = Repo::new();
    let cases = [
        vec!["create", "name", "--tmux"],
        vec!["create", "name", "-t"],
        vec!["attach", "main", "--tmux-vertical"],
        vec!["exec", "--tmux-h", "name", "true"],
        vec!["github", "checkout", "1", "--tmux"],
        vec!["gh", "checkout", "1", "-t"],
    ];
    for args in cases {
        let output = repo.phantom(&args);
        assert_eq!(
            output.status.code(),
            Some(3),
            "{args:?} {}",
            text(&output.stderr)
        );
        let stderr = text(&output.stderr);
        assert!(
            stderr.contains("Unknown option"),
            "{args:?} produced {stderr}"
        );
    }
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
    assert!(text(&attached.stdout).contains("Attached worktree: existing-feature"));
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
    assert_eq!(missing_delete.status.code(), Some(2));
}

#[test]
fn invalid_config_names_the_file_and_the_problem() {
    let repo = Repo::new();
    fs::write(repo.repo.join(".ptm.toml"), "[\n").expect("config");
    let created = repo.phantom(&["create", "feature/bad-toml"]);
    let stderr = text(&created.stderr);
    assert!(
        !created.status.success(),
        "invalid TOML should fail, stdout: {}",
        text(&created.stdout)
    );
    assert!(
        stderr.contains(".ptm.toml"),
        "stderr should name the file: {stderr}"
    );
    assert!(
        stderr.contains("parse") || stderr.contains("expected") || stderr.contains("invalid"),
        "stderr should describe the TOML problem: {stderr}"
    );
    assert!(!repo
        .repo
        .join(".git/phantom/worktrees/feature/bad-toml")
        .exists());

    fs::write(
        repo.repo.join(".ptm.toml"),
        "[hooks]\npost-create = \"pnpm install\"\n",
    )
    .expect("schema");
    let created = repo.phantom(&["where", "feature/bad-toml"]);
    let stderr = text(&created.stderr);
    assert!(!created.status.success(), "{}", text(&created.stdout));
    assert!(stderr.contains(".ptm.toml"), "{stderr}");
    assert!(
        stderr.contains("post-create") || stderr.contains("invalid type"),
        "{stderr}"
    );

    fs::write(
        repo.repo.join(".ptm.toml"),
        "worktreesDirectory = \".phantom\"\n",
    )
    .expect("unknown");
    let created = repo.phantom(&["where", "feature/bad-toml"]);
    let stderr = text(&created.stderr);
    assert!(!created.status.success(), "{}", text(&created.stdout));
    assert!(stderr.contains(".ptm.toml"), "{stderr}");
    assert!(stderr.contains("worktreesDirectory"), "{stderr}");
}

#[test]
fn github_checkout_logs_the_post_create_hook() {
    let repo = Repo::new();
    fs::write(
        repo.repo.join(".ptm.toml"),
        "[hooks]\npost-create = [\"true\"]\n",
    )
    .expect("config");
    let bin = repo.root.join("bin");
    fs::create_dir_all(&bin).expect("bin");
    let gh = bin.join("gh");
    fs::write(
        &gh,
        "#!/bin/sh\nif [ \"$1\" = \"repo\" ]; then\n  printf '%s\\n' '{\"owner\":{\"login\":\"acme\"},\"name\":\"demo\"}'\n  exit 0\nfi\nif [ \"$1\" = \"api\" ]; then\n  printf '%s\\n' '{\"number\":7}'\n  exit 0\nfi\nprintf '%s\\n' \"unexpected gh: $*\" >&2\nexit 1\n",
    )
    .expect("gh");
    use std::os::unix::fs::PermissionsExt;
    let mut perms = fs::metadata(&gh).expect("meta").permissions();
    perms.set_mode(0o755);
    fs::set_permissions(&gh, perms).expect("chmod");
    let path = format!(
        "{}:{}",
        bin.display(),
        std::env::var("PATH").unwrap_or_default()
    );

    let cli = repo
        .command(env!("CARGO_BIN_EXE_ptm"), &["github", "checkout", "7"])
        .env("PATH", &path)
        .output()
        .expect("cli");
    assert!(
        cli.status.success(),
        "{}\n{}",
        text(&cli.stdout),
        text(&cli.stderr)
    );
    assert!(
        text(&cli.stdout).contains("Executing: true"),
        "CLI checkout should log the hook:\n{}",
        text(&cli.stdout)
    );
}

#[test]
fn post_create_failure_reports_the_created_worktree() {
    let repo = Repo::new();
    fs::write(
        repo.repo.join(".ptm.toml"),
        "[hooks]\npost-create = [\"phantom-missing-post-create-bin\"]\n",
    )
    .expect("config");
    let created = repo.phantom(&["create", "feature/hooks"]);
    let worktree = repo.repo.join(".git/phantom/worktrees/feature/hooks");
    assert!(
        worktree.join("README.md").is_file(),
        "worktree should exist after a post-create failure"
    );
    let stdout = text(&created.stdout);
    let stderr = text(&created.stderr);
    assert!(
        stdout.contains("Created worktree 'feature/hooks' at "),
        "stdout: {stdout}"
    );
    assert!(
        stdout.contains(&worktree.to_string_lossy().to_string()),
        "stdout: {stdout}"
    );
    assert!(
        stdout.contains("Executing: phantom-missing-post-create-bin"),
        "stdout: {stdout}"
    );
    assert!(
        stderr.contains("Warning:"),
        "stderr should warn, not look like creation failed: {stderr}"
    );
    assert!(
        stderr.contains("phantom-missing-post-create-bin"),
        "{stderr}"
    );
    assert!(stderr.contains("127"), "{stderr}");
    assert_eq!(created.status.code(), Some(127), "{stderr}");

    repo.git(&["branch", "existing-hook"]);
    let attached = repo.phantom(&["attach", "existing-hook"]);
    let attached_path = repo.repo.join(".git/phantom/worktrees/existing-hook");
    assert!(attached_path.join("README.md").is_file());
    assert!(
        text(&attached.stdout).contains("Attached worktree: existing-hook"),
        "{}",
        text(&attached.stdout)
    );
    assert!(
        text(&attached.stderr).contains("Warning:"),
        "{}",
        text(&attached.stderr)
    );
    assert_eq!(attached.status.code(), Some(127));
}

#[test]
fn copies_worktreeinclude_files_and_runs_post_create() {
    let repo = Repo::new();
    fs::write(repo.repo.join(".gitignore"), ".env.local\n").expect("gitignore");
    fs::write(repo.repo.join(".env.local"), "API_KEY=test-value\n").expect("env");
    fs::write(repo.repo.join(".worktreeinclude"), ".env.local\n").expect("include");
    fs::write(
        repo.repo.join(".ptm.toml"),
        "[hooks]\npost-create = [\"touch post-create.txt\"]\n",
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
fn hooks_run_in_order_stop_on_failure_and_export_root_path() {
    let repo = Repo::new();
    fs::write(
        repo.repo.join(".ptm.toml"),
        r#"[hooks]
post-create = [
  "printf '%s' \"$PTM_ROOT_PATH\" > root-path.txt",
  "printf '%s' \"$PTM\" > ptm-flag.txt",
  "printf '%s' \"$PTM_NAME\" > ptm-name.txt",
  "printf '%s' \"$PTM_PATH\" > ptm-path.txt",
  "printf '%s' \"$PHANTOM\" > phantom-flag.txt",
  "printf '%s' \"$PHANTOM_NAME\" > phantom-name.txt",
  "printf '%s' \"$PHANTOM_PATH\" > phantom-path.txt",
  "pwd > hook-cwd.txt",
  "touch first.txt",
  "false",
  "touch skipped.txt",
]
pre-delete = [
  "touch pre-first.txt",
  "exit 9",
  "touch pre-skipped.txt",
]
"#,
    )
    .expect("toml");

    let created = repo.phantom(&["create", "feature/hooks-order"]);
    let worktree = repo.repo.join(".git/phantom/worktrees/feature/hooks-order");
    assert_eq!(created.status.code(), Some(1), "{}", text(&created.stderr));
    assert_eq!(
        fs::read_to_string(worktree.join("root-path.txt")).expect("root path"),
        repo.repo.display().to_string()
    );
    assert_eq!(
        fs::read_to_string(worktree.join("ptm-flag.txt")).expect("flag"),
        "1"
    );
    assert_eq!(
        fs::read_to_string(worktree.join("ptm-name.txt")).expect("name"),
        "feature/hooks-order"
    );
    assert_eq!(
        fs::read_to_string(worktree.join("ptm-path.txt")).expect("path"),
        worktree.display().to_string()
    );
    assert_eq!(
        fs::read_to_string(worktree.join("phantom-flag.txt")).expect("old flag"),
        ""
    );
    assert_eq!(
        fs::read_to_string(worktree.join("phantom-name.txt")).expect("old name"),
        ""
    );
    assert_eq!(
        fs::read_to_string(worktree.join("phantom-path.txt")).expect("old path"),
        ""
    );
    assert_eq!(
        text(&fs::read(worktree.join("hook-cwd.txt")).expect("cwd")),
        worktree.display().to_string()
    );
    assert!(worktree.join("first.txt").is_file());
    assert!(!worktree.join("skipped.txt").exists());

    let deleted = repo.phantom(&["delete", "--force", "feature/hooks-order"]);
    let stderr = text(&deleted.stderr);
    assert!(!deleted.status.success(), "{}", text(&deleted.stdout));
    assert!(stderr.contains("exit code 9"), "{stderr}");
    assert!(
        worktree.exists(),
        "pre-delete failure should keep the worktree"
    );
    assert!(worktree.join("pre-first.txt").is_file());
    assert!(!worktree.join("pre-skipped.txt").exists());
}

#[test]
fn hooks_follow_the_source_checkout_when_run_from_a_worktree() {
    let repo = Repo::new();
    let source_created = repo.phantom(&["create", "feature/source"]);
    assert!(
        source_created.status.success(),
        "{}\n{}",
        text(&source_created.stdout),
        text(&source_created.stderr)
    );
    let source = repo.repo.join(".git/phantom/worktrees/feature/source");
    fs::write(
        repo.repo.join(".ptm.toml"),
        "[hooks]\npost-create = [\"touch from-main.txt\"]\npre-delete = [\"touch pre-from-main.txt\"]\n",
    )
    .expect("main hooks");
    fs::write(
        source.join(".ptm.toml"),
        r#"[hooks]
post-create = ["printf '%s' \"$PTM_ROOT_PATH\" > root-path.txt"]
pre-delete = ["printf '%s' \"$PTM_ROOT_PATH\" > \"$PTM_ROOT_PATH/pre-root.txt\""]
"#,
    )
    .expect("source hooks");
    let toplevel = repo
        .command("git", &["rev-parse", "--show-toplevel"])
        .current_dir(&source)
        .output()
        .expect("toplevel");
    assert!(toplevel.status.success(), "{}", text(&toplevel.stderr));
    let source_path = text(&toplevel.stdout);
    assert_ne!(source_path, repo.repo.display().to_string());

    let created = repo
        .command(env!("CARGO_BIN_EXE_ptm"), &["create", "feature/child"])
        .current_dir(&source)
        .output()
        .expect("create");
    assert!(
        created.status.success(),
        "{}\n{}",
        text(&created.stdout),
        text(&created.stderr)
    );
    let child = repo.repo.join(".git/phantom/worktrees/feature/child");
    assert_eq!(
        fs::read_to_string(child.join("root-path.txt")).expect("root path"),
        source_path
    );
    assert!(!child.join("from-main.txt").exists());

    let deleted = repo
        .command(
            env!("CARGO_BIN_EXE_ptm"),
            &["delete", "--force", "feature/child"],
        )
        .current_dir(&source)
        .output()
        .expect("delete");
    assert!(
        deleted.status.success(),
        "{}\n{}",
        text(&deleted.stdout),
        text(&deleted.stderr)
    );
    assert_eq!(
        fs::read_to_string(PathBuf::from(&source_path).join("pre-root.txt")).expect("pre-delete"),
        source_path
    );
    assert!(!child.join("pre-from-main.txt").exists());
}

#[test]
fn phantom_config_json_is_not_read() {
    let repo = Repo::new();
    fs::write(repo.repo.join("phantom.config.json"), "{").expect("json");
    let created = repo.phantom(&["create", "feature/no-json"]);
    assert!(
        created.status.success(),
        "{}\n{}",
        text(&created.stdout),
        text(&created.stderr)
    );
    assert!(repo
        .repo
        .join(".git/phantom/worktrees/feature/no-json/README.md")
        .is_file());
}

#[test]
fn preferences_and_project_registry() {
    let repo = Repo::new();
    let set = repo.phantom(&["preferences", "set", "keep-branch", "true"]);
    assert!(set.status.success(), "{}", text(&set.stderr));
    let set_stdout = text(&set.stdout);
    assert!(set_stdout.contains("keep-branch"), "{set_stdout}");
    assert!(set_stdout.contains("true"), "{set_stdout}");
    assert!(
        set_stdout.contains(
            repo.home
                .join(".config/ptm/config.toml")
                .to_str()
                .expect("path")
        ),
        "{set_stdout}"
    );
    let get = repo.phantom(&["preferences", "get", "keep-branch"]);
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

    repo.phantom(&["preferences", "set", "ghq-discovery", "false"]);
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
fn project_registry_is_stored_under_xdg_state_home_ptm() {
    let repo = Repo::new();
    let legacy = repo.root.join("state/phantom");
    write_legacy_registry(&legacy);
    let legacy_body = fs::read_to_string(legacy.join("projects.json")).expect("legacy");

    let added = repo.phantom(&["project", "add", "--json"]);
    assert!(added.status.success(), "{}", text(&added.stderr));
    let registry = fs::read_to_string(repo.root.join("state/ptm/projects.json")).expect("registry");
    assert!(registry.contains("\"name\": \"repo\""));
    assert!(!registry.contains("proj_550e8400-e29b-41d4-a716-446655440000"));
    assert_eq!(
        fs::read_to_string(legacy.join("projects.json")).expect("legacy unchanged"),
        legacy_body
    );

    let disabled = repo.phantom(&["preferences", "set", "ghq-discovery", "false"]);
    assert!(disabled.status.success(), "{}", text(&disabled.stderr));
    let listed = repo.phantom(&["project", "list", "--json"]);
    assert!(listed.status.success(), "{}", text(&listed.stderr));
    let catalog: serde_json::Value = serde_json::from_str(&text(&listed.stdout)).expect("catalog");
    assert_eq!(catalog["projects"].as_array().map(Vec::len), Some(1));
    assert_eq!(catalog["projects"][0]["name"], "repo");
    assert_eq!(catalog["projects"][0]["source"], "registry");

    let help = repo.phantom(&["project", "--help"]);
    assert!(help.status.success(), "{}", text(&help.stderr));
    let help_text = text(&help.stdout);
    assert!(help_text.contains("$XDG_STATE_HOME/ptm"));
    assert!(help_text.contains("~/.local/state/ptm"));
    assert!(!help_text.contains("XDG_STATE_HOME/phantom"));
    assert!(!help_text.contains(".local/state/phantom"));
}

#[test]
fn project_registry_defaults_to_home_local_state_ptm() {
    let repo = Repo::new();
    let legacy = repo.home.join(".local/state/phantom");
    write_legacy_registry(&legacy);
    let legacy_body = fs::read_to_string(legacy.join("projects.json")).expect("legacy");
    let disabled = repo.phantom(&["preferences", "set", "ghq-discovery", "false"]);
    assert!(disabled.status.success(), "{}", text(&disabled.stderr));

    let added = repo
        .command(env!("CARGO_BIN_EXE_ptm"), &["project", "add", "--json"])
        .env_remove("XDG_STATE_HOME")
        .output()
        .expect("add");
    assert!(added.status.success(), "{}", text(&added.stderr));
    let registry =
        fs::read_to_string(repo.home.join(".local/state/ptm/projects.json")).expect("registry");
    assert!(registry.contains("\"name\": \"repo\""));
    assert!(!registry.contains("proj_550e8400-e29b-41d4-a716-446655440000"));
    assert_eq!(
        fs::read_to_string(legacy.join("projects.json")).expect("legacy unchanged"),
        legacy_body
    );

    let listed = repo
        .command(env!("CARGO_BIN_EXE_ptm"), &["project", "list", "--names"])
        .env("XDG_STATE_HOME", "relative/state")
        .output()
        .expect("list");
    assert!(listed.status.success(), "{}", text(&listed.stderr));
    assert_eq!(text(&listed.stdout), "repo");
    assert!(!repo.repo.join("relative").exists());
}

fn write_legacy_registry(dir: &std::path::Path) {
    fs::create_dir_all(dir).expect("legacy dir");
    fs::write(
        dir.join("projects.json"),
        r#"{
  "version": 1,
  "projects": [
    {
      "id": "proj_550e8400-e29b-41d4-a716-446655440000",
      "name": "legacy",
      "rootPath": "/tmp/legacy",
      "createdAt": "2026-01-01T00:00:00.000Z"
    }
  ]
}
"#,
    )
    .expect("legacy registry");
}

#[test]
fn preferences_file_uses_xdg_config_home() {
    let repo = Repo::new();
    let path = repo.home.join(".config/ptm/config.toml");
    let gitconfig = fs::read_to_string(repo.home.join(".gitconfig")).expect("gitconfig");

    let missing = repo.phantom(&["preferences", "get", "keep-branch"]);
    assert!(missing.status.success(), "{}", text(&missing.stderr));
    let missing_stdout = text(&missing.stdout);
    assert!(missing_stdout.contains("is not set"), "{missing_stdout}");
    assert!(
        missing_stdout.contains(path.to_str().expect("path")),
        "{missing_stdout}"
    );
    assert!(!path.exists());

    let invalid_bool = repo.phantom(&["preferences", "set", "keep-branch", "yes"]);
    assert_eq!(invalid_bool.status.code(), Some(3));
    assert!(
        text(&invalid_bool.stderr).contains("true"),
        "{}",
        text(&invalid_bool.stderr)
    );
    assert!(!path.exists());

    let set = repo.phantom(&["preferences", "set", "directory-name-separator", "-"]);
    assert!(set.status.success(), "{}", text(&set.stderr));
    let written = fs::read_to_string(&path).expect("config");
    assert!(
        written.contains("directory-name-separator = \"-\""),
        "{written}"
    );
    assert_eq!(
        fs::read_to_string(repo.home.join(".gitconfig")).expect("gitconfig"),
        gitconfig
    );

    fs::write(
        &path,
        "# header\nkeep-branch = false # inline\n\n# separator\ndirectory-name-separator = \"-\"\n",
    )
    .expect("seed");
    let updated = repo.phantom(&["preferences", "set", "keep-branch", "true"]);
    assert!(updated.status.success(), "{}", text(&updated.stderr));
    let written = fs::read_to_string(&path).expect("updated");
    assert!(written.contains("# header"), "{written}");
    assert!(written.contains("# inline"), "{written}");
    assert!(written.contains("# separator"), "{written}");
    assert!(written.contains("keep-branch = true"), "{written}");
    assert!(
        written.contains("directory-name-separator = \"-\""),
        "{written}"
    );

    let removed = repo.phantom(&["preferences", "remove", "keep-branch"]);
    assert!(removed.status.success(), "{}", text(&removed.stderr));
    let written = fs::read_to_string(&path).expect("removed");
    assert!(!written.contains("keep-branch"), "{written}");
    assert!(written.contains("# separator"), "{written}");

    fs::write(&path, "{\n").expect("invalid");
    let invalid = repo.phantom(&["preferences", "get", "keep-branch"]);
    assert_eq!(invalid.status.code(), Some(1));
    let stderr = text(&invalid.stderr);
    assert!(stderr.contains(path.to_str().expect("path")), "{stderr}");

    fs::write(&path, "editor = \"code\"\n").expect("unknown");
    let unknown = repo.phantom(&["preferences", "get", "ghq-discovery"]);
    assert_eq!(unknown.status.code(), Some(1));
    let stderr = text(&unknown.stderr);
    assert!(stderr.contains("editor"), "{stderr}");
    assert!(stderr.contains(path.to_str().expect("path")), "{stderr}");

    fs::remove_file(&path).expect("cleanup");
    repo.git(&["config", "--global", "phantom.keepBranch", "true"]);
    let ignored = repo.phantom(&["preferences", "get", "keep-branch"]);
    assert!(ignored.status.success(), "{}", text(&ignored.stderr));
    assert!(
        text(&ignored.stdout).contains("is not set"),
        "{}",
        text(&ignored.stdout)
    );
    assert!(!path.exists());
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
    repo.phantom(&["preferences", "set", "keep-branch", "true"]);
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
fn removed_ai_command_and_preference_are_unknown() {
    let repo = Repo::new();
    let command = repo.phantom(&["ai", "feature"]);
    assert_eq!(command.status.code(), Some(1));
    assert!(text(&command.stderr).contains("Unknown command 'ai feature'"));

    let preference = repo.phantom(&["preferences", "set", "ai", "claude"]);
    assert_eq!(preference.status.code(), Some(3));
    let stderr = text(&preference.stderr);
    assert!(stderr.contains("Unknown preference 'ai'"), "{stderr}");
    assert!(stderr.contains("worktrees-directory"), "{stderr}");
}

#[test]
fn removed_edit_command_and_editor_preference_are_unknown() {
    let repo = Repo::new();
    let command = repo.phantom(&["edit", "feature"]);
    assert_eq!(command.status.code(), Some(1));
    assert!(text(&command.stderr).contains("Unknown command 'edit feature'"));

    let preference = repo.phantom(&["preferences", "get", "editor"]);
    assert_eq!(preference.status.code(), Some(3));
    let stderr = text(&preference.stderr);
    assert!(stderr.contains("Unknown preference 'editor'"), "{stderr}");
    assert!(stderr.contains("worktrees-directory"), "{stderr}");
}

#[test]
fn removed_shell_command_and_flag_are_unknown() {
    let repo = Repo::new();
    let command = repo.phantom(&["shell", "feature"]);
    assert_eq!(command.status.code(), Some(1));
    assert!(text(&command.stderr).contains("Unknown command 'shell feature'"));

    for args in [
        vec!["create", "name", "--shell"],
        vec!["attach", "main", "-s"],
    ] {
        let output = repo.phantom(&args);
        assert_eq!(
            output.status.code(),
            Some(3),
            "{args:?} {}",
            text(&output.stderr)
        );
        assert!(
            text(&output.stderr).contains("Unknown option"),
            "{args:?} {}",
            text(&output.stderr)
        );
    }
}

#[test]
fn removed_fzf_option_is_unknown() {
    let repo = Repo::new();
    let cases = [
        vec!["list", "--fzf"],
        vec!["where", "--fzf"],
        vec!["delete", "--fzf"],
        vec!["exec", "--fzf", "true"],
    ];
    for args in cases {
        let output = repo.phantom(&args);
        assert_eq!(
            output.status.code(),
            Some(3),
            "{args:?} {}",
            text(&output.stderr)
        );
        let stderr = text(&output.stderr);
        assert!(
            stderr.contains("Unknown option"),
            "{args:?} produced {stderr}"
        );
    }
}

#[test]
fn reports_when_only_the_default_worktree_exists() {
    let repo = Repo::new();
    let result = repo.phantom(&["list", "--no-default"]);
    assert_eq!(result.status.code(), Some(0), "{}", text(&result.stderr));
    assert!(text(&result.stdout).contains("No sub worktrees found"));
}

#[test]
fn project_add_from_a_linked_worktree_is_idempotent() {
    let repo = Repo::new();
    let added = repo.phantom(&["project", "add", "--json"]);
    assert!(added.status.success(), "{}", text(&added.stderr));
    let value: serde_json::Value = serde_json::from_str(&text(&added.stdout)).expect("json");
    let linked = repo.root.join("linked-worktree");
    repo.git(&[
        "worktree",
        "add",
        "-b",
        "project-linked",
        linked.to_str().expect("path"),
    ]);
    let again = repo
        .command(
            env!("CARGO_BIN_EXE_ptm"),
            &["project", "add", linked.to_str().expect("path"), "--json"],
        )
        .current_dir(&linked)
        .output()
        .expect("add");
    assert!(again.status.success(), "{}", text(&again.stderr));
    let again_value: serde_json::Value = serde_json::from_str(&text(&again.stdout)).expect("json");
    assert_eq!(again_value["status"], "existing");
    assert_eq!(again_value["project"], value["project"]);
}

#[test]
fn project_list_discovers_ghq_and_warns_when_discovery_fails() {
    let repo = Repo::new();
    let bin = repo.root.join("bin");
    fs::create_dir_all(&bin).expect("bin");
    let ghq = bin.join("ghq");
    fs::write(
        &ghq,
        "#!/bin/sh\nif [ \"$1\" != \"list\" ] || [ \"$2\" != \"--full-path\" ]; then\n  exit 2\nfi\nprintf \"%s\\n\" \"$PTM_TEST_GHQ_PROJECT\"\n",
    )
    .expect("ghq");
    use std::os::unix::fs::PermissionsExt;
    let mut perms = fs::metadata(&ghq).expect("meta").permissions();
    perms.set_mode(0o755);
    fs::set_permissions(&ghq, perms.clone()).expect("chmod");
    let path = format!(
        "{}:{}",
        bin.display(),
        std::env::var("PATH").unwrap_or_default()
    );
    let discovered = repo
        .command(env!("CARGO_BIN_EXE_ptm"), &["project", "list", "--json"])
        .env("PATH", &path)
        .env("PTM_TEST_GHQ_PROJECT", &repo.repo)
        .output()
        .expect("list");
    assert!(discovered.status.success(), "{}", text(&discovered.stderr));
    let catalog: serde_json::Value = serde_json::from_str(&text(&discovered.stdout)).expect("json");
    assert_eq!(catalog["version"], 2);
    assert_eq!(catalog["projects"][0]["source"], "ghq");
    assert_eq!(
        catalog["projects"][0]["rootPath"],
        repo.repo.to_string_lossy().as_ref()
    );

    fs::write(
        &ghq,
        "#!/bin/sh\nprintf '%s\\n' 'simulated ghq failure' >&2\nexit 17\n",
    )
    .expect("fail");
    fs::set_permissions(&ghq, perms).expect("chmod");
    let added = repo
        .command(env!("CARGO_BIN_EXE_ptm"), &["project", "add", "--json"])
        .env("PATH", &path)
        .output()
        .expect("add");
    assert!(added.status.success(), "{}", text(&added.stderr));
    let warned = repo
        .command(env!("CARGO_BIN_EXE_ptm"), &["project", "list", "--json"])
        .env("PATH", &path)
        .output()
        .expect("warn");
    assert!(warned.status.success(), "{}", text(&warned.stderr));
    assert!(text(&warned.stdout).contains("\"source\": \"registry\""));
    assert!(!text(&warned.stdout).contains("Warning:"));
    assert!(text(&warned.stderr).contains("Warning: Failed to discover ghq repositories:"));
    assert!(text(&warned.stderr).contains("simulated ghq failure"));
}

#[test]
fn worktreeinclude_copies_only_matching_gitignored_files() {
    let repo = Repo::new();
    fs::write(repo.repo.join("tracked.env"), "committed\n").expect("tracked");
    repo.git(&["add", "tracked.env"]);
    repo.git(&["commit", "-m", "track env"]);
    fs::write(
        repo.repo.join(".gitignore"),
        "*.env\n*.log\nfrom-config.local\n",
    )
    .expect("gitignore");
    fs::write(
        repo.repo.join(".worktreeinclude"),
        "*.env\nnested/**\n!nested/skip.env\n",
    )
    .expect("include");
    fs::write(
        repo.repo.join("phantom.config.json"),
        r#"{"postCreate":{"copyFiles":["from-config.local"]}}"#,
    )
    .expect("legacy config");
    fs::create_dir_all(repo.repo.join("nested/deep")).expect("nested");
    fs::write(repo.repo.join("secret.env"), "secret\n").expect("secret");
    fs::write(repo.repo.join("nested/deep/inner.env"), "inner\n").expect("inner");
    fs::write(repo.repo.join("nested/skip.env"), "skip\n").expect("skip");
    fs::write(repo.repo.join("nested/deep/note.txt"), "note\n").expect("note");
    fs::write(repo.repo.join("notes.log"), "log\n").expect("log");
    fs::write(repo.repo.join("other.log"), "other\n").expect("other");
    fs::write(repo.repo.join("from-config.local"), "config\n").expect("legacy");
    fs::write(repo.repo.join("tracked.env"), "dirty\n").expect("dirty");

    let created = repo
        .command(
            env!("CARGO_BIN_EXE_ptm"),
            &["create", "copied", "--copy-file", "notes.log"],
        )
        .current_dir(repo.repo.join("nested"))
        .output()
        .expect("phantom");
    assert!(
        created.status.success(),
        "{}\n{}",
        text(&created.stdout),
        text(&created.stderr)
    );
    let worktree = repo.repo.join(".git/phantom/worktrees/copied");
    assert_eq!(read_copy(&worktree.join("secret.env")), "secret\n");
    assert_eq!(
        read_copy(&worktree.join("nested/deep/inner.env")),
        "inner\n"
    );
    assert_eq!(read_copy(&worktree.join("notes.log")), "log\n");
    assert_eq!(read_copy(&worktree.join("tracked.env")), "committed\n");
    assert!(!worktree.join("nested/skip.env").exists());
    assert!(!worktree.join("nested/deep/note.txt").exists());
    assert!(!worktree.join("other.log").exists());
    assert!(!worktree.join("from-config.local").exists());

    repo.git(&["branch", "attached"]);
    let attached = repo.phantom(&["attach", "attached"]);
    assert!(attached.status.success(), "{}", text(&attached.stderr));
    let attached_path = repo.repo.join(".git/phantom/worktrees/attached");
    assert_eq!(read_copy(&attached_path.join("secret.env")), "secret\n");
    assert!(!attached_path.join("nested/skip.env").exists());
    assert!(!attached_path.join("other.log").exists());
}

#[test]
fn copies_gitignored_files_from_the_checkout_the_command_runs_in() {
    let repo = Repo::new();
    fs::write(repo.repo.join(".gitignore"), "*.env\n").expect("gitignore");
    fs::write(repo.repo.join(".worktreeinclude"), "*.env\n").expect("include");
    fs::write(repo.repo.join("secret.env"), "from-main\n").expect("main env");
    repo.git(&["add", ".gitignore", ".worktreeinclude"]);
    repo.git(&["commit", "-m", "include"]);
    repo.git(&[
        "worktree",
        "add",
        "-b",
        "source",
        ".git/phantom/worktrees/source",
    ]);
    let source = repo.repo.join(".git/phantom/worktrees/source");
    fs::write(source.join("secret.env"), "from-source\n").expect("source env");

    let created = repo
        .command(env!("CARGO_BIN_EXE_ptm"), &["create", "copied"])
        .current_dir(&source)
        .output()
        .expect("phantom");
    assert!(
        created.status.success(),
        "{}\n{}",
        text(&created.stdout),
        text(&created.stderr)
    );
    assert_eq!(
        read_copy(&repo.repo.join(".git/phantom/worktrees/copied/secret.env")),
        "from-source\n"
    );
}

fn read_copy(path: &std::path::Path) -> String {
    fs::read_to_string(path).unwrap_or_else(|error| panic!("read {}: {error}", path.display()))
}

#[test]
fn copy_file_globs_ignore_brackets_in_the_repository_path() {
    let root = std::env::temp_dir().join(format!(
        "phantom-bracket-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock")
            .as_nanos()
    ));
    let repo_dir = root.join("repo[tmp]");
    let home = root.join("home");
    fs::create_dir_all(home.join(".config/git")).expect("home");
    fs::create_dir_all(&repo_dir).expect("repo");
    fs::write(home.join(".gitconfig"), "").expect("gitconfig");
    let git = |args: &[&str]| {
        let output = Command::new("git")
            .args(args)
            .current_dir(&repo_dir)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("HOME", &home)
            .output()
            .expect("git");
        assert!(output.status.success(), "{}", text(&output.stderr));
    };
    git(&["init", "-b", "main"]);
    git(&["config", "user.name", "Phantom Rust"]);
    git(&["config", "user.email", "phantom-rust@example.com"]);
    fs::write(repo_dir.join("README.md"), "#\n").expect("readme");
    git(&["add", "README.md"]);
    git(&["commit", "-m", "initial"]);
    fs::write(repo_dir.join(".gitignore"), "*.env\n").expect("gitignore");
    fs::write(repo_dir.join("kept.env"), "kept\n").expect("kept");
    let output = Command::new(env!("CARGO_BIN_EXE_ptm"))
        .args(["create", "copied", "--copy-file", "*.env"])
        .current_dir(&repo_dir)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("HOME", &home)
        .env("XDG_CONFIG_HOME", home.join(".config"))
        .env("XDG_STATE_HOME", root.join("state"))
        .output()
        .expect("phantom");
    assert!(output.status.success(), "{}", text(&output.stderr));
    assert_eq!(
        fs::read_to_string(repo_dir.join(".git/phantom/worktrees/copied/kept.env"))
            .expect("copied"),
        "kept\n"
    );
    let _ = fs::remove_dir_all(root);
}

#[test]
fn concurrent_project_add_processes_keep_every_record() {
    let repo = Repo::new();
    repo.phantom(&["preferences", "set", "ghq-discovery", "false"]);
    let mut children = Vec::new();
    for index in 0..6 {
        let path = repo.root.join(format!("project-{index}"));
        fs::create_dir_all(&path).expect("project");
        let init = repo
            .command("git", &["init", "-b", "main"])
            .current_dir(&path)
            .output()
            .expect("init");
        assert!(init.status.success(), "{}", text(&init.stderr));
        let child = repo
            .command(
                env!("CARGO_BIN_EXE_ptm"),
                &["project", "add", path.to_str().expect("path"), "--json"],
            )
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .expect("spawn");
        children.push(child);
    }
    for child in children {
        let output = child.wait_with_output().expect("wait");
        assert!(output.status.success(), "{}", text(&output.stderr));
    }
    let listed = repo.phantom(&["project", "list", "--names"]);
    assert!(listed.status.success(), "{}", text(&listed.stderr));
    let names = text(&listed.stdout);
    for index in 0..6 {
        assert!(names.contains(&format!("project-{index}")), "{names}");
    }
}

#[test]
fn create_and_attach_exec_export_ptm_env() {
    let repo = Repo::new();
    let script = "printf '%s\\n' \"$PTM\" \"$PTM_NAME\" \"$PTM_PATH\" \"$PHANTOM\" \"$PHANTOM_NAME\" \"$PHANTOM_PATH\" > ptm-env.txt";
    let created = repo.phantom(&["create", "feature/env", "--exec", script]);
    assert!(
        created.status.success(),
        "{}\n{}",
        text(&created.stdout),
        text(&created.stderr)
    );
    let worktree = repo.repo.join(".git/phantom/worktrees/feature/env");
    assert_ptm_env(&worktree, "feature/env");

    repo.git(&["branch", "attached-env"]);
    let attached = repo.phantom(&["attach", "attached-env", "--exec", script]);
    assert!(
        attached.status.success(),
        "{}\n{}",
        text(&attached.stdout),
        text(&attached.stderr)
    );
    assert_ptm_env(
        &repo.repo.join(".git/phantom/worktrees/attached-env"),
        "attached-env",
    );

    let execed = repo.phantom(&["exec", "feature/env", "--", "sh", "-c", script]);
    assert!(execed.status.success(), "{}", text(&execed.stderr));
    assert_ptm_env(&worktree, "feature/env");
}

fn assert_ptm_env(worktree: &std::path::Path, name: &str) {
    let recorded = fs::read_to_string(worktree.join("ptm-env.txt")).expect("ptm env");
    let mut lines = recorded.lines();
    assert_eq!(lines.next(), Some("1"), "{recorded}");
    assert_eq!(lines.next(), Some(name), "{recorded}");
    assert_eq!(
        lines.next(),
        Some(worktree.to_string_lossy().as_ref()),
        "{recorded}"
    );
    assert_eq!(lines.next(), Some(""), "{recorded}");
    assert_eq!(lines.next(), Some(""), "{recorded}");
    assert_eq!(lines.next(), Some(""), "{recorded}");
}

#[test]
fn parent_cleanup_failure_still_deletes_the_branch() {
    let repo = Repo::new();
    let created = repo.phantom(&["create", "cursor/foo"]);
    assert!(created.status.success(), "{}", text(&created.stderr));
    let root = repo.repo.join(".git/phantom/worktrees");
    use std::os::unix::fs::PermissionsExt;
    let _reset = ModeReset(&root);
    let mut perms = fs::metadata(&root).expect("meta").permissions();
    perms.set_mode(0o555);
    fs::set_permissions(&root, perms).expect("chmod");

    let deleted = repo.phantom(&["delete", "cursor/foo"]);
    assert!(
        deleted.status.success(),
        "cleanup must not fail the delete\n{}\n{}",
        text(&deleted.stdout),
        text(&deleted.stderr)
    );
    let combined = format!("{}\n{}", text(&deleted.stdout), text(&deleted.stderr));
    assert!(
        combined.contains("Warning:"),
        "cleanup error should be a warning: {combined}"
    );
    let branch = repo
        .command("git", &["branch", "--list", "cursor/foo"])
        .output()
        .expect("branch");
    assert!(
        text(&branch.stdout).is_empty(),
        "branch should still be deleted: {}",
        text(&branch.stdout)
    );
}

struct ModeReset<'a>(&'a std::path::Path);

impl Drop for ModeReset<'_> {
    fn drop(&mut self) {
        let Ok(metadata) = fs::metadata(self.0) else {
            return;
        };
        let mut perms = metadata.permissions();
        use std::os::unix::fs::PermissionsExt;
        perms.set_mode(0o755);
        let _ = fs::set_permissions(self.0, perms);
    }
}

#[test]
fn removed_mcp_command_is_unknown() {
    let repo = Repo::new();
    for args in [vec!["mcp"], vec!["mcp", "serve"], vec!["mcp", "--help"]] {
        let output = repo.phantom(&args);
        assert_eq!(
            output.status.code(),
            Some(1),
            "{args:?}\n{}\n{}",
            text(&output.stdout),
            text(&output.stderr)
        );
        let stderr = text(&output.stderr);
        assert!(
            stderr.contains("Unknown command"),
            "{args:?} produced {stderr}"
        );
    }

    let help = repo.phantom(&["--help"]);
    assert!(help.status.success(), "{}", text(&help.stderr));
    assert!(
        !text(&help.stdout).to_ascii_lowercase().contains("mcp"),
        "top-level help should not mention MCP:\n{}",
        text(&help.stdout)
    );

    let preferences = repo.phantom(&["preferences", "--help"]);
    assert!(
        preferences.status.success(),
        "{}",
        text(&preferences.stderr)
    );
    assert!(
        !text(&preferences.stdout)
            .to_ascii_lowercase()
            .contains("mcp"),
        "preferences help should not mention MCP:\n{}",
        text(&preferences.stdout)
    );
}

#[test]
fn delete_removes_empty_parent_directories() {
    let repo = Repo::new();
    let created = repo.phantom(&["create", "cursor/foo"]);
    assert!(created.status.success(), "{}", text(&created.stderr));
    let root = repo.repo.join(".git/phantom/worktrees");
    let parent = root.join("cursor");
    assert!(parent.join("foo").is_dir());
    let deleted = repo.phantom(&["delete", "cursor/foo"]);
    assert!(deleted.status.success(), "{}", text(&deleted.stderr));
    assert!(!parent.join("foo").exists());
    assert!(!parent.exists(), "empty parent directory should be removed");
    assert!(root.is_dir(), "worktrees root should stay");

    assert!(repo.phantom(&["create", "cursor/foo"]).status.success());
    assert!(repo.phantom(&["create", "cursor/bar"]).status.success());
    assert!(repo.phantom(&["delete", "cursor/foo"]).status.success());
    assert!(parent.join("bar").is_dir());
    assert!(parent.is_dir(), "parent still holds another worktree");
    assert!(repo.phantom(&["delete", "cursor/bar"]).status.success());
    assert!(!parent.exists());

    assert!(repo.phantom(&["create", "a/b/c"]).status.success());
    assert!(repo.phantom(&["delete", "a/b/c"]).status.success());
    assert!(!root.join("a").exists());
    assert!(root.is_dir());
}

#[test]
fn detached_worktree_keeps_its_directory_name() {
    let repo = Repo::new();
    let worktree = repo.repo.join(".git/phantom/worktrees/next");
    repo.git(&[
        "worktree",
        "add",
        "--detach",
        worktree.to_str().expect("path"),
        "HEAD",
    ]);
    let head = repo
        .command("git", &["rev-parse", "--short=7", "HEAD"])
        .output()
        .expect("rev-parse");
    let sha = text(&head.stdout);
    let names = repo.phantom(&["list", "--names", "--no-default"]);
    assert!(names.status.success(), "{}", text(&names.stderr));
    assert_eq!(text(&names.stdout), "next");
    let listed = repo.phantom(&["list", "--no-default"]);
    assert!(
        text(&listed.stdout).starts_with("next ("),
        "{}",
        text(&listed.stdout)
    );
    assert!(
        !text(&listed.stdout).starts_with(&sha),
        "{}",
        text(&listed.stdout)
    );

    let found = repo.phantom(&["where", "next"]);
    assert_eq!(found.status.code(), Some(0), "{}", text(&found.stderr));
    assert_eq!(text(&found.stdout), worktree.to_string_lossy());

    let moved = repo
        .command(
            "git",
            &["commit", "--allow-empty", "-m", "move detached head"],
        )
        .current_dir(&worktree)
        .output()
        .expect("commit");
    assert!(moved.status.success(), "{}", text(&moved.stderr));
    let names_after = repo.phantom(&["list", "--names", "--no-default"]);
    assert_eq!(text(&names_after.stdout), "next");

    repo.git(&[
        "worktree",
        "add",
        "-b",
        "topic",
        repo.repo
            .join(".git/phantom/worktrees/alias")
            .to_str()
            .expect("path"),
        "HEAD",
    ]);
    let by_directory = repo.phantom(&["where", "alias"]);
    let by_branch = repo.phantom(&["where", "topic"]);
    let alias = repo.repo.join(".git/phantom/worktrees/alias");
    assert_eq!(text(&by_directory.stdout), alias.to_string_lossy());
    assert_eq!(text(&by_branch.stdout), alias.to_string_lossy());
    let both = repo.phantom(&["list", "--names", "--no-default"]);
    let listed_names = text(&both.stdout);
    assert!(listed_names.contains("next"), "{listed_names}");
    assert!(listed_names.contains("alias"), "{listed_names}");
    assert!(!listed_names.lines().any(|line| line == "topic"));
}

#[test]
fn directory_name_is_preferred_over_another_worktrees_branch() {
    let repo = Repo::new();
    let branch_topic = repo.repo.join(".git/phantom/worktrees/a");
    let directory_topic = repo.repo.join(".git/phantom/worktrees/topic");
    repo.git(&[
        "worktree",
        "add",
        "-b",
        "topic",
        branch_topic.to_str().expect("path"),
        "HEAD",
    ]);
    repo.git(&[
        "worktree",
        "add",
        "-b",
        "other",
        directory_topic.to_str().expect("path"),
        "HEAD",
    ]);

    let found = repo.phantom(&["where", "topic"]);
    assert_eq!(found.status.code(), Some(0), "{}", text(&found.stderr));
    assert_eq!(
        text(&found.stdout),
        directory_topic.to_string_lossy(),
        "directory name should win over branch topic checked out at a"
    );

    let deleted = repo.phantom(&["delete", "topic", "--keep-branch"]);
    assert!(
        deleted.status.success(),
        "{}\n{}",
        text(&deleted.stdout),
        text(&deleted.stderr)
    );
    assert!(!directory_topic.exists());
    assert!(
        branch_topic.exists(),
        "delete topic must not remove the worktree whose branch is topic"
    );
    let kept = repo
        .command("git", &["branch", "--list", "other"])
        .output()
        .expect("branch");
    assert!(
        text(&kept.stdout).contains("other"),
        "kept the branch of the directory named topic"
    );
}

fn fake_gh_for_topic_pr(repo: &Repo) -> String {
    let bin = repo.root.join("bin");
    fs::create_dir_all(&bin).expect("bin");
    let gh = bin.join("gh");
    fs::write(
        &gh,
        r#"#!/bin/sh
if [ "$1" = "repo" ]; then
  printf '%s\n' '{"owner":{"login":"acme"},"name":"demo"}'
  exit 0
fi
case "$2" in
  *pulls*)
    printf '%s\n' '{"head":{"ref":"topic","repo":{"full_name":"acme/demo"}},"base":{"repo":{"full_name":"acme/demo"}}}'
    ;;
  *)
    printf '%s\n' '{"number":7,"pull_request":{}}'
    ;;
esac
"#,
    )
    .expect("gh");
    use std::os::unix::fs::PermissionsExt;
    let mut perms = fs::metadata(&gh).expect("meta").permissions();
    perms.set_mode(0o755);
    fs::set_permissions(&gh, perms).expect("chmod");
    format!(
        "{}:{}",
        bin.display(),
        std::env::var("PATH").unwrap_or_default()
    )
}

#[test]
fn pr_checkout_requires_the_branch_not_only_the_directory() {
    let repo = Repo::new();
    let path = fake_gh_for_topic_pr(&repo);
    let directory = repo.repo.join(".git/phantom/worktrees/topic");
    repo.git(&[
        "worktree",
        "add",
        "-b",
        "other",
        directory.to_str().expect("path"),
        "HEAD",
    ]);
    let output = repo
        .command(env!("CARGO_BIN_EXE_ptm"), &["github", "checkout", "7"])
        .env("PATH", &path)
        .output()
        .expect("checkout");
    let combined = format!("{}\n{}", text(&output.stdout), text(&output.stderr));
    assert!(
        !combined.contains("already checked out"),
        "directory topic on branch other is not PR branch topic:\n{combined}"
    );
    let current = repo
        .command("git", &["branch", "--show-current"])
        .current_dir(&directory)
        .output()
        .expect("branch");
    assert_eq!(text(&current.stdout), "other");

    let matching = Repo::new();
    let matching_path = fake_gh_for_topic_pr(&matching);
    let checked_out = matching.repo.join(".git/phantom/worktrees/topic");
    matching.git(&[
        "worktree",
        "add",
        "-b",
        "topic",
        checked_out.to_str().expect("path"),
        "HEAD",
    ]);
    let again = matching
        .command(env!("CARGO_BIN_EXE_ptm"), &["github", "checkout", "7"])
        .env("PATH", &matching_path)
        .output()
        .expect("again");
    assert!(
        again.status.success(),
        "{}\n{}",
        text(&again.stdout),
        text(&again.stderr)
    );
    assert!(
        text(&again.stdout).contains("already checked out"),
        "{}",
        text(&again.stdout)
    );
}

fn json_value(output: &std::process::Output) -> serde_json::Value {
    let stdout = String::from_utf8_lossy(&output.stdout);
    serde_json::from_str(stdout.trim()).unwrap_or_else(|error| {
        panic!(
            "stdout is not JSON ({error})\nstdout:\n{stdout}\nstderr:\n{}",
            String::from_utf8_lossy(&output.stderr)
        )
    })
}

fn paths_match(json_path: &str, expected: &std::path::Path) -> bool {
    let left = std::path::Path::new(json_path);
    left == expected || fs::canonicalize(left).ok() == fs::canonicalize(expected).ok()
}

fn full_head(repo: &Repo) -> String {
    let output = repo
        .command("git", &["rev-parse", "HEAD"])
        .output()
        .expect("head");
    assert!(output.status.success(), "{}", text(&output.stderr));
    text(&output.stdout)
}

fn assert_worktree_object(value: &serde_json::Value, name: &str, path: &std::path::Path) {
    assert_eq!(value["name"], name);
    assert!(
        paths_match(value["path"].as_str().unwrap_or(""), path),
        "path {} != {}",
        value["path"],
        path.display()
    );
    assert!(value["path"].as_str().unwrap_or("").starts_with('/'));
    assert_eq!(value["default"], false);
    assert!(value.get("rootPath").is_none());
    assert!(value.get("is_clean").is_none());
}

#[test]
fn worktree_json_covers_list_where_create_attach_and_delete() {
    let repo = Repo::new();
    let head = full_head(&repo);
    let empty = repo.phantom(&["list", "--json", "--no-default"]);
    assert!(empty.status.success(), "{}", text(&empty.stderr));
    let empty_json = json_value(&empty);
    assert_eq!(empty_json["version"], 1);
    assert_eq!(empty_json["worktrees"].as_array().map(Vec::len), Some(0));
    assert!(text(&empty.stderr).is_empty(), "{}", text(&empty.stderr));

    let created = repo.phantom(&["create", "feature/json", "--json", "--base", "HEAD"]);
    assert!(created.status.success(), "{}", text(&created.stderr));
    let created_json = json_value(&created);
    assert_eq!(created_json["version"], 1);
    assert_worktree_object(
        &created_json["worktree"],
        "feature/json",
        &repo.repo.join(".git/phantom/worktrees/feature/json"),
    );
    assert_eq!(created_json["worktree"]["branch"], "feature/json");
    assert_eq!(created_json["worktree"]["head"], head);
    assert_eq!(created_json["worktree"]["base"], "HEAD");
    assert_eq!(created_json["worktree"]["dirty"], false);
    assert_eq!(created_json["worktree"]["detached"], false);
    assert_eq!(created_json["copyFiles"]["ok"], true);
    assert!(created_json["copyFiles"]["error"].is_null());
    assert_eq!(created_json["postCreate"]["ran"], false);
    assert_eq!(created_json["postCreate"]["ok"], true);
    assert!(created_json["postCreate"]["command"].is_null());
    assert!(created_json["postCreate"]["exitCode"].is_null());
    assert!(created_json["exec"].is_null());
    assert!(!text(&created.stdout).contains("Created worktree"));

    let duplicate = repo.phantom(&["create", "feature/json", "--json"]);
    assert_eq!(duplicate.status.code(), Some(3));
    let duplicate_json = json_value(&duplicate);
    assert_eq!(duplicate_json["error"]["code"], "already_exists");
    assert_eq!(duplicate_json["error"]["exitCode"], 3);
    assert!(
        text(&duplicate.stderr).is_empty(),
        "{}",
        text(&duplicate.stderr)
    );

    let both = repo.phantom(&["list", "--json", "--names"]);
    assert_eq!(both.status.code(), Some(3));
    assert_eq!(json_value(&both)["error"]["code"], "validation");

    let listed = repo.phantom(&["list", "--json"]);
    assert!(listed.status.success(), "{}", text(&listed.stderr));
    let listed_json = json_value(&listed);
    let worktrees = listed_json["worktrees"].as_array().expect("worktrees");
    assert!(worktrees
        .iter()
        .any(|entry| entry["default"] == true && entry["branch"] == "main"));
    let feature = worktrees
        .iter()
        .find(|entry| entry["name"] == "feature/json")
        .expect("feature");
    assert_eq!(feature["head"], head);
    assert_eq!(feature["dirty"], false);
    assert!(feature["base"].is_null());

    let worktree = repo.repo.join(".git/phantom/worktrees/feature/json");
    fs::write(worktree.join("README.md"), "dirty\n").expect("dirty");
    let dirty = repo.phantom(&["list", "--json", "--no-default"]);
    let dirty_json = json_value(&dirty);
    assert_eq!(dirty_json["worktrees"][0]["dirty"], true);
    assert_eq!(dirty_json["worktrees"].as_array().map(Vec::len), Some(1));

    let located = repo.phantom(&["where", "feature/json", "--json"]);
    assert!(located.status.success(), "{}", text(&located.stderr));
    let located_json = json_value(&located);
    assert_eq!(located_json["version"], 1);
    assert_worktree_object(&located_json["worktree"], "feature/json", &worktree);
    assert!(!text(&located.stdout).contains("feature/json ("));

    let missing = repo.phantom(&["where", "missing-worktree", "--json"]);
    assert_eq!(missing.status.code(), Some(2));
    let missing_json = json_value(&missing);
    assert_eq!(missing_json["version"], 1);
    assert_eq!(missing_json["error"]["code"], "not_found");
    assert_eq!(missing_json["error"]["exitCode"], 2);
    assert!(missing_json["error"]["message"]
        .as_str()
        .unwrap_or("")
        .contains("missing-worktree"));
    assert!(
        text(&missing.stderr).is_empty(),
        "{}",
        text(&missing.stderr)
    );

    repo.git(&["branch", "existing-json"]);
    let attached = repo.phantom(&["attach", "existing-json", "--json"]);
    assert!(attached.status.success(), "{}", text(&attached.stderr));
    let attached_json = json_value(&attached);
    assert_worktree_object(
        &attached_json["worktree"],
        "existing-json",
        &repo.repo.join(".git/phantom/worktrees/existing-json"),
    );
    assert!(attached_json["worktree"]["base"].is_null());
    assert_eq!(attached_json["worktree"]["branch"], "existing-json");
    assert_eq!(attached_json["copyFiles"]["ok"], true);
    assert!(attached_json["exec"].is_null());

    let kept = repo.phantom(&["delete", "existing-json", "--keep-branch", "--json"]);
    assert!(kept.status.success(), "{}", text(&kept.stderr));
    let kept_json = json_value(&kept);
    assert!(kept_json["error"].is_null());
    assert_eq!(kept_json["deleted"][0]["branchDeleted"], false);
    assert!(kept_json["deleted"][0]["branchError"].is_null());
    assert!(kept_json["deleted"][0]["error"].is_null());
    assert_eq!(kept_json["deleted"][0]["worktree"]["name"], "existing-json");
    let branch = repo
        .command("git", &["branch", "--list", "existing-json"])
        .output()
        .expect("branch");
    assert!(text(&branch.stdout).contains("existing-json"));

    fs::write(worktree.join("README.md"), "# phantom\n").expect("restore");
    repo.git(&["branch", "second-json"]);
    assert!(repo.phantom(&["attach", "second-json"]).status.success());
    let partial = repo.phantom(&["delete", "feature/json", "missing-json", "--json"]);
    assert_eq!(partial.status.code(), Some(2), "{}", text(&partial.stderr));
    let partial_json = json_value(&partial);
    assert_eq!(
        partial_json["deleted"][0]["worktree"]["name"],
        "feature/json"
    );
    assert_eq!(partial_json["deleted"][0]["branchDeleted"], true);
    assert!(partial_json["deleted"][1]["worktree"].is_null());
    assert!(partial_json["deleted"][1]["error"]
        .as_str()
        .unwrap_or("")
        .contains("missing-json"));
    assert_eq!(partial_json["error"]["code"], "not_found");
    assert_eq!(partial_json["error"]["exitCode"], 2);
    assert!(!text(&partial.stdout).contains("Deleted worktree"));
    let gone = repo
        .command("git", &["branch", "--list", "feature/json"])
        .output()
        .expect("branch");
    assert!(text(&gone.stdout).is_empty(), "{}", text(&gone.stdout));

    let outside = repo.root.join("outside");
    fs::create_dir_all(&outside).expect("outside");
    let not_repo = repo
        .command(env!("CARGO_BIN_EXE_ptm"), &["list", "--json"])
        .current_dir(&outside)
        .output()
        .expect("list");
    assert_eq!(not_repo.status.code(), Some(4));
    let not_repo_json = json_value(&not_repo);
    assert_eq!(not_repo_json["error"]["code"], "not_repository");
    assert_eq!(not_repo_json["error"]["exitCode"], 4);
    assert!(
        text(&not_repo.stderr).is_empty(),
        "{}",
        text(&not_repo.stderr)
    );

    let project_modes = repo.phantom(&["project", "list", "--json", "--names"]);
    assert_eq!(project_modes.status.code(), Some(3));
    assert_eq!(json_value(&project_modes)["error"]["code"], "validation");
    assert_eq!(json_value(&project_modes)["version"], 1);
}

#[test]
fn json_mode_keeps_hook_and_exec_output_off_stdout() {
    let repo = Repo::new();
    fs::write(
        repo.repo.join(".ptm.toml"),
        "[hooks]\npost-create = [\"echo HOOK_STDOUT_MARKER\"]\npre-delete = [\"echo PRE_DELETE_MARKER\"]\n",
    )
    .expect("hooks");
    let created = repo.phantom(&[
        "create",
        "feature/hooks-json",
        "--json",
        "--exec",
        "echo EXEC_MARKER",
    ]);
    assert!(
        created.status.success(),
        "{}\n{}",
        text(&created.stdout),
        text(&created.stderr)
    );
    let created_json = json_value(&created);
    assert!(!text(&created.stdout).contains("HOOK_STDOUT_MARKER"));
    assert!(text(&created.stderr)
        .lines()
        .any(|line| line == "HOOK_STDOUT_MARKER"));
    assert!(text(&created.stderr)
        .lines()
        .any(|line| line == "EXEC_MARKER"));
    assert_eq!(created_json["postCreate"]["ran"], true);
    assert_eq!(created_json["postCreate"]["ok"], true);
    assert_eq!(created_json["postCreate"]["exitCode"], 0);
    assert_eq!(created_json["exec"]["ok"], true);
    assert_eq!(created_json["exec"]["exitCode"], 0);
    assert_eq!(created_json["exec"]["command"], "echo EXEC_MARKER");

    let deleted = repo.phantom(&["delete", "--force", "feature/hooks-json", "--json"]);
    assert!(deleted.status.success(), "{}", text(&deleted.stderr));
    assert!(!text(&deleted.stdout).contains("PRE_DELETE_MARKER"));
    assert!(text(&deleted.stderr).contains("PRE_DELETE_MARKER"));
    assert_eq!(json_value(&deleted)["deleted"][0]["branchDeleted"], true);

    fs::write(
        repo.repo.join(".ptm.toml"),
        "[hooks]\npost-create = [\"echo HOOK_FAIL_MARKER\", \"exit 7\"]\n",
    )
    .expect("failing hook");
    let failed = repo.phantom(&["create", "feature/hook-fail", "--json"]);
    assert_eq!(failed.status.code(), Some(7), "{}", text(&failed.stderr));
    let failed_json = json_value(&failed);
    assert_eq!(failed_json["postCreate"]["ok"], false);
    assert_eq!(failed_json["postCreate"]["exitCode"], 7);
    assert_eq!(failed_json["postCreate"]["command"], "exit 7");
    assert_eq!(failed_json["worktree"]["name"], "feature/hook-fail");
    assert!(!text(&failed.stdout).contains("HOOK_FAIL_MARKER"));
    assert!(text(&failed.stderr).contains("HOOK_FAIL_MARKER"));
    assert!(repo
        .repo
        .join(".git/phantom/worktrees/feature/hook-fail/README.md")
        .is_file());

    fs::write(repo.repo.join(".ptm.toml"), "").expect("clear hooks");
    let exec_failed = repo.phantom(&[
        "create",
        "feature/exec-fail",
        "--json",
        "--exec",
        "echo EXEC_FAIL; exit 3",
    ]);
    assert_eq!(exec_failed.status.code(), Some(3));
    let exec_json = json_value(&exec_failed);
    assert_eq!(exec_json["exec"]["ok"], false);
    assert_eq!(exec_json["exec"]["exitCode"], 3);
    assert_eq!(exec_json["worktree"]["branch"], "feature/exec-fail");
    assert!(text(&exec_failed.stderr)
        .lines()
        .any(|line| line == "EXEC_FAIL"));
    assert!(!text(&exec_failed.stderr).contains("failed with exit code"));
}

#[test]
fn json_reports_detached_head_and_copy_errors() {
    let repo = Repo::new();
    let detached = repo.repo.join(".git/phantom/worktrees/next");
    repo.git(&[
        "worktree",
        "add",
        "--detach",
        detached.to_str().expect("path"),
        "HEAD",
    ]);
    let listed = repo.phantom(&["list", "--json", "--no-default"]);
    assert!(listed.status.success(), "{}", text(&listed.stderr));
    let entry = &json_value(&listed)["worktrees"][0];
    assert_eq!(entry["name"], "next");
    assert!(entry["branch"].is_null());
    assert_eq!(entry["detached"], true);
    assert_eq!(entry["head"], full_head(&repo));
    assert_eq!(entry["default"], false);

    std::os::unix::fs::symlink("elsewhere", repo.repo.join(".worktreeinclude")).expect("symlink");
    let created = repo.phantom(&["create", "feature/copy", "--json"]);
    assert!(created.status.success(), "{}", text(&created.stderr));
    let created_json = json_value(&created);
    assert_eq!(created_json["copyFiles"]["ok"], false);
    assert!(created_json["copyFiles"]["error"]
        .as_str()
        .unwrap_or("")
        .contains("symlink"));
    assert_eq!(created_json["worktree"]["name"], "feature/copy");
}

#[test]
fn project_parse_errors_keep_the_validation_exit_code() {
    let repo = Repo::new();
    let cases: &[&[&str]] = &[
        &["project", "add", "--unknown"],
        &["project", "list", "--unknown"],
        &["project", "remove", "--unknown"],
        &["project", "add", "--unknown", "--json"],
        &["project", "list", "--unknown", "--json"],
        &["project", "remove", "--unknown", "--json"],
    ];
    for args in cases {
        let output = repo.phantom(args);
        assert_eq!(
            output.status.code(),
            Some(3),
            "{args:?}\nstdout:\n{}\nstderr:\n{}",
            text(&output.stdout),
            text(&output.stderr)
        );
        if args.contains(&"--json") {
            let value = json_value(&output);
            assert_eq!(value["version"], 1, "{args:?} {value}");
            assert_eq!(value["error"]["code"], "validation", "{args:?} {value}");
            assert_eq!(value["error"]["exitCode"], 3, "{args:?} {value}");
            assert!(
                text(&output.stderr).is_empty(),
                "{args:?} stderr: {}",
                text(&output.stderr)
            );
        } else {
            assert!(
                text(&output.stderr).contains("Unknown option"),
                "{args:?} {}",
                text(&output.stderr)
            );
        }
    }
}

#[test]
fn json_unborn_head_is_null() {
    let repo = Repo::new();
    repo.git(&["update-ref", "-d", "HEAD"]);
    let listed = repo.phantom(&["list", "--json"]);
    assert!(listed.status.success(), "{}", text(&listed.stderr));
    let listed_json = json_value(&listed);
    let worktrees = listed_json["worktrees"].as_array().expect("worktrees");
    assert_eq!(worktrees.len(), 1, "{listed_json}");
    assert_eq!(worktrees[0]["name"], "main");
    assert_eq!(worktrees[0]["branch"], "main");
    assert_eq!(worktrees[0]["default"], true);
    assert!(
        worktrees[0]["head"].is_null(),
        "unborn HEAD should be null, got {}",
        worktrees[0]["head"]
    );

    let located = repo.phantom(&["where", "main", "--json"]);
    assert!(located.status.success(), "{}", text(&located.stderr));
    let located_json = json_value(&located);
    assert!(located_json["worktree"]["head"].is_null(), "{located_json}");
    assert_eq!(located_json["worktree"]["branch"], "main");
}

#[test]
fn argument_errors_are_validation_for_every_command() {
    let repo = Repo::new();
    let cases: &[&[&str]] = &[
        &["create", "topic", "--base"],
        &["create", "topic", "--json", "--base"],
        &["list", "--unknown"],
        &["list", "--json", "--unknown"],
        &["where", "--bogus"],
        &["where", "--json", "--bogus"],
        &["delete", "--bogus", "x"],
        &["delete", "--json", "--bogus", "x"],
        &["attach", "--zzz", "b"],
        &["attach", "--json", "--zzz", "b"],
        &["github", "checkout", "--bogus", "1"],
        &["gh", "checkout", "1", "--json", "--base"],
        &["exec", "--bogus", "name", "true"],
        &["preferences", "get", "--bogus"],
        &["version", "extra"],
    ];
    for args in cases {
        let output = repo.phantom(args);
        assert_eq!(
            output.status.code(),
            Some(3),
            "{args:?}\nstdout:\n{}\nstderr:\n{}",
            text(&output.stdout),
            text(&output.stderr)
        );
        let detail = format!("{}\n{}", text(&output.stdout), text(&output.stderr));
        assert!(
            detail.contains("Unknown option")
                || detail.contains("argument missing")
                || detail.contains("Unexpected argument"),
            "{args:?} {detail}"
        );
        if args.contains(&"--json") {
            let value = json_value(&output);
            assert_eq!(value["error"]["code"], "validation", "{args:?} {value}");
            assert_eq!(value["error"]["exitCode"], 3, "{args:?} {value}");
            assert!(
                text(&output.stderr).is_empty(),
                "{args:?} stderr: {}",
                text(&output.stderr)
            );
        }
    }
}

#[test]
fn invalid_names_are_validation_and_missing_worktrees_exit_not_found() {
    let repo = Repo::new();
    for args in [
        &["create", "a/../x"][..],
        &["create", "a/../x", "--json"],
        &["attach", "a/../x"],
        &["attach", "a/../x", "--json"],
    ] {
        let output = repo.phantom(args);
        assert_eq!(
            output.status.code(),
            Some(3),
            "{args:?}\n{}\n{}",
            text(&output.stdout),
            text(&output.stderr)
        );
        if args.contains(&"--json") {
            let value = json_value(&output);
            assert_eq!(value["error"]["code"], "validation", "{args:?} {value}");
            assert_eq!(value["error"]["exitCode"], 3, "{args:?} {value}");
            assert!(value.get("worktree").is_none(), "{args:?} {value}");
            assert!(text(&output.stderr).is_empty(), "{args:?}");
        } else {
            assert!(
                text(&output.stderr).contains("consecutive dots"),
                "{args:?} {}",
                text(&output.stderr)
            );
        }
    }
    assert!(!repo.repo.join(".git/phantom/worktrees/a/../x").exists());

    let missing_delete = repo.phantom(&["delete", "nope"]);
    assert_eq!(missing_delete.status.code(), Some(2));
    let missing_json = repo.phantom(&["delete", "nope", "--json"]);
    assert_eq!(missing_json.status.code(), Some(2));
    let missing_value = json_value(&missing_json);
    assert_eq!(missing_value["error"]["code"], "not_found");
    assert_eq!(missing_value["error"]["exitCode"], 2);
    assert_eq!(repo.phantom(&["where", "nope"]).status.code(), Some(2));
    assert_eq!(
        repo.phantom(&["exec", "nope", "true"]).status.code(),
        Some(2)
    );
}

#[test]
fn json_exec_signal_and_spawn_failure_return_the_worktree() {
    let repo = Repo::new();
    let signaled = repo.phantom(&["create", "sig", "--json", "--exec", "kill -TERM $$"]);
    assert_eq!(
        signaled.status.code(),
        Some(143),
        "{}\n{}",
        text(&signaled.stdout),
        text(&signaled.stderr)
    );
    let signaled_json = json_value(&signaled);
    assert!(signaled_json.get("error").is_none(), "{signaled_json}");
    assert_eq!(signaled_json["worktree"]["name"], "sig");
    assert_eq!(signaled_json["exec"]["ok"], false);
    assert_eq!(signaled_json["exec"]["command"], "kill -TERM $$");
    assert_eq!(signaled_json["exec"]["exitCode"], 143);
    assert_eq!(signaled_json["exec"]["signal"], "SIGTERM");
    assert!(signaled_json["exec"]["error"].is_null());
    assert!(repo
        .repo
        .join(".git/phantom/worktrees/sig/README.md")
        .is_file());

    repo.git(&["branch", "attach-sig"]);
    let attached = repo.phantom(&["attach", "attach-sig", "--json", "--exec", "kill -TERM $$"]);
    assert_eq!(
        attached.status.code(),
        Some(143),
        "{}",
        text(&attached.stderr)
    );
    let attached_json = json_value(&attached);
    assert_eq!(attached_json["worktree"]["name"], "attach-sig");
    assert_eq!(attached_json["exec"]["ok"], false);
    assert_eq!(attached_json["exec"]["signal"], "SIGTERM");
    assert!(attached_json.get("error").is_none(), "{attached_json}");

    let human = repo.phantom(&["create", "sig-human", "--exec", "kill -TERM $$"]);
    assert_eq!(human.status.code(), Some(143));
    assert!(text(&human.stdout).contains("Created worktree 'sig-human'"));
    assert!(text(&human.stderr).contains("SIGTERM"));

    let spawned = repo
        .command(
            env!("CARGO_BIN_EXE_ptm"),
            &["create", "spawn", "--json", "--exec", "true"],
        )
        .env("SHELL", "/no/such/ptm-shell")
        .output()
        .expect("spawn");
    assert_eq!(
        spawned.status.code(),
        Some(1),
        "{}\n{}",
        text(&spawned.stdout),
        text(&spawned.stderr)
    );
    let spawned_json = json_value(&spawned);
    assert!(spawned_json.get("error").is_none(), "{spawned_json}");
    assert_eq!(spawned_json["worktree"]["name"], "spawn");
    assert_eq!(spawned_json["exec"]["ok"], false);
    assert_eq!(spawned_json["exec"]["exitCode"], 1);
    assert!(spawned_json["exec"]["signal"].is_null());
    let spawn_error = spawned_json["exec"]["error"].as_str().unwrap_or("");
    assert!(
        spawn_error.contains("ENOENT") && spawn_error.contains("/no/such/ptm-shell"),
        "{spawn_error}"
    );
    assert!(repo
        .repo
        .join(".git/phantom/worktrees/spawn/README.md")
        .is_file());

    repo.git(&["branch", "attach-spawn"]);
    let attach_spawn = repo
        .command(
            env!("CARGO_BIN_EXE_ptm"),
            &["attach", "attach-spawn", "--json", "--exec", "true"],
        )
        .env("SHELL", "/no/such/ptm-shell")
        .output()
        .expect("attach spawn");
    assert_eq!(attach_spawn.status.code(), Some(1));
    let attach_json = json_value(&attach_spawn);
    assert_eq!(attach_json["worktree"]["name"], "attach-spawn");
    assert_eq!(attach_json["exec"]["ok"], false);
    assert!(attach_json["exec"]["error"]
        .as_str()
        .unwrap_or("")
        .contains("ENOENT"));
    assert!(attach_json.get("error").is_none(), "{attach_json}");

    let interrupted = repo.phantom(&["create", "sigint", "--json", "--exec", "kill -INT $$"]);
    assert_eq!(
        interrupted.status.code(),
        Some(130),
        "{}\n{}",
        text(&interrupted.stdout),
        text(&interrupted.stderr)
    );
    let interrupted_json = json_value(&interrupted);
    assert_eq!(interrupted_json["exec"]["signal"], "SIGINT");
    assert_eq!(interrupted_json["exec"]["exitCode"], 130);
    assert!(
        interrupted_json.get("error").is_none(),
        "{interrupted_json}"
    );
}

#[test]
fn json_post_create_signal_and_spawn_return_the_worktree() {
    let repo = Repo::new();
    fs::write(
        repo.repo.join(".ptm.toml"),
        "[hooks]\npost-create = [\"kill -TERM $$\"]\n",
    )
    .expect("hooks");
    let created = repo.phantom(&["create", "h", "--json"]);
    assert_eq!(
        created.status.code(),
        Some(143),
        "{}\n{}",
        text(&created.stdout),
        text(&created.stderr)
    );
    let created_json = json_value(&created);
    assert!(created_json.get("error").is_none(), "{created_json}");
    assert_eq!(created_json["worktree"]["name"], "h");
    assert_eq!(created_json["postCreate"]["ok"], false);
    assert_eq!(created_json["postCreate"]["command"], "kill -TERM $$");
    assert_eq!(created_json["postCreate"]["exitCode"], 143);
    assert_eq!(created_json["postCreate"]["signal"], "SIGTERM");
    assert!(created_json["postCreate"]["error"].is_null());
    assert!(repo
        .repo
        .join(".git/phantom/worktrees/h/README.md")
        .is_file());

    repo.git(&["branch", "attach-hook"]);
    let attached = repo.phantom(&["attach", "attach-hook", "--json"]);
    assert_eq!(
        attached.status.code(),
        Some(143),
        "{}",
        text(&attached.stderr)
    );
    let attached_json = json_value(&attached);
    assert!(attached_json.get("error").is_none(), "{attached_json}");
    assert_eq!(attached_json["worktree"]["name"], "attach-hook");
    assert_eq!(attached_json["postCreate"]["ok"], false);
    assert_eq!(attached_json["postCreate"]["signal"], "SIGTERM");
    assert_eq!(attached_json["postCreate"]["exitCode"], 143);

    fs::write(
        repo.repo.join(".ptm.toml"),
        "[hooks]\npost-create = [\"true\"]\n",
    )
    .expect("spawn hook");
    let spawned = repo
        .command(
            env!("CARGO_BIN_EXE_ptm"),
            &["create", "hook-spawn", "--json"],
        )
        .env("SHELL", "/nonexistent")
        .output()
        .expect("hook spawn");
    assert_eq!(
        spawned.status.code(),
        Some(1),
        "{}\n{}",
        text(&spawned.stdout),
        text(&spawned.stderr)
    );
    let spawned_json = json_value(&spawned);
    assert!(spawned_json.get("error").is_none(), "{spawned_json}");
    assert_eq!(spawned_json["worktree"]["name"], "hook-spawn");
    assert_eq!(spawned_json["postCreate"]["ok"], false);
    assert_eq!(spawned_json["postCreate"]["exitCode"], 1);
    assert!(spawned_json["postCreate"]["signal"].is_null());
    let spawn_error = spawned_json["postCreate"]["error"].as_str().unwrap_or("");
    assert!(
        spawn_error.contains("ENOENT") && spawn_error.contains("/nonexistent"),
        "{spawn_error}"
    );
    assert!(repo
        .repo
        .join(".git/phantom/worktrees/hook-spawn/README.md")
        .is_file());

    repo.git(&["branch", "attach-hook-spawn"]);
    let attach_spawn = repo
        .command(
            env!("CARGO_BIN_EXE_ptm"),
            &["attach", "attach-hook-spawn", "--json"],
        )
        .env("SHELL", "/nonexistent")
        .output()
        .expect("attach hook spawn");
    assert_eq!(attach_spawn.status.code(), Some(1));
    let attach_json = json_value(&attach_spawn);
    assert_eq!(attach_json["postCreate"]["ok"], false);
    assert!(attach_json["postCreate"]["error"]
        .as_str()
        .unwrap_or("")
        .contains("ENOENT"));
    assert!(attach_json.get("error").is_none(), "{attach_json}");
    assert!(repo
        .repo
        .join(".git/phantom/worktrees/attach-hook-spawn/README.md")
        .is_file());

    fs::write(
        repo.repo.join(".ptm.toml"),
        "[hooks]\npre-delete = [\"kill -TERM $$\"]\n",
    )
    .expect("pre-delete signal");
    let deleted = repo.phantom(&["delete", "--force", "h", "--json"]);
    assert_eq!(
        deleted.status.code(),
        Some(143),
        "{}\n{}",
        text(&deleted.stdout),
        text(&deleted.stderr)
    );
    let deleted_json = json_value(&deleted);
    assert_eq!(deleted_json["error"]["code"], "signaled");
    assert_eq!(deleted_json["error"]["exitCode"], 143);
    assert_eq!(deleted_json["deleted"][0]["worktree"]["name"], "h");
    assert!(paths_match(
        deleted_json["deleted"][0]["worktree"]["path"]
            .as_str()
            .unwrap_or(""),
        &repo.repo.join(".git/phantom/worktrees/h")
    ));
    assert!(repo.repo.join(".git/phantom/worktrees/h").is_dir());

    fs::write(
        repo.repo.join(".ptm.toml"),
        "[hooks]\npre-delete = [\"true\"]\n",
    )
    .expect("pre-delete spawn");
    let pre_spawn = repo
        .command(
            env!("CARGO_BIN_EXE_ptm"),
            &["delete", "--force", "attach-hook", "--json"],
        )
        .env("SHELL", "/nonexistent")
        .output()
        .expect("pre-delete spawn");
    assert_eq!(pre_spawn.status.code(), Some(1));
    let pre_json = json_value(&pre_spawn);
    assert_eq!(pre_json["error"]["code"], "spawn");
    assert_eq!(pre_json["error"]["exitCode"], 1);
    assert_eq!(pre_json["deleted"][0]["worktree"]["name"], "attach-hook");
    assert!(paths_match(
        pre_json["deleted"][0]["worktree"]["path"]
            .as_str()
            .unwrap_or(""),
        &repo.repo.join(".git/phantom/worktrees/attach-hook")
    ));
    assert!(repo
        .repo
        .join(".git/phantom/worktrees/attach-hook")
        .is_dir());
}

#[test]
fn detached_exec_resolves_the_created_path_when_names_are_flattened() {
    let repo = Repo::new();
    let set = repo.phantom(&["preferences", "set", "directory-name-separator", "-"]);
    assert!(set.status.success(), "{}", text(&set.stderr));

    let created = repo.phantom(&[
        "create",
        "feature/topic",
        "--exec",
        "git checkout -q --detach",
    ]);
    assert!(
        created.status.success(),
        "{}\n{}",
        text(&created.stdout),
        text(&created.stderr)
    );
    assert!(!text(&created.stderr).contains("not found"));
    assert!(text(&created.stdout).contains("Created worktree 'feature/topic'"));
    let directory = repo.repo.join(".git/phantom/worktrees/feature-topic");
    assert!(directory.join("README.md").is_file());
    let abbrev = repo
        .command("git", &["rev-parse", "--abbrev-ref", "HEAD"])
        .current_dir(&directory)
        .output()
        .expect("abbrev");
    assert_eq!(text(&abbrev.stdout), "HEAD");

    let json_created = repo.phantom(&[
        "create",
        "feature/json-topic",
        "--json",
        "--exec",
        "git checkout -q --detach",
    ]);
    assert!(
        json_created.status.success(),
        "{}\n{}",
        text(&json_created.stdout),
        text(&json_created.stderr)
    );
    let json_value_created = json_value(&json_created);
    assert!(
        json_value_created.get("error").is_none(),
        "{json_value_created}"
    );
    assert_eq!(json_value_created["exec"]["ok"], true);
    assert_eq!(json_value_created["worktree"]["name"], "feature-json-topic");
    assert_eq!(json_value_created["worktree"]["detached"], true);
    assert!(json_value_created["worktree"]["branch"].is_null());
    assert!(paths_match(
        json_value_created["worktree"]["path"]
            .as_str()
            .unwrap_or(""),
        &repo.repo.join(".git/phantom/worktrees/feature-json-topic")
    ));

    repo.git(&["branch", "feature/attached"]);
    let attached = repo.phantom(&[
        "attach",
        "feature/attached",
        "--json",
        "--exec",
        "git checkout -q --detach",
    ]);
    assert!(
        attached.status.success(),
        "{}\n{}",
        text(&attached.stdout),
        text(&attached.stderr)
    );
    let attached_json = json_value(&attached);
    assert!(attached_json.get("error").is_none(), "{attached_json}");
    assert_eq!(attached_json["worktree"]["name"], "feature-attached");
    assert_eq!(attached_json["worktree"]["detached"], true);
    assert!(paths_match(
        attached_json["worktree"]["path"].as_str().unwrap_or(""),
        &repo.repo.join(".git/phantom/worktrees/feature-attached")
    ));

    fs::write(
        repo.repo.join(".ptm.toml"),
        "[hooks]\npost-create = [\"git checkout -q --detach\"]\n",
    )
    .expect("detach hook");
    let bin = repo.root.join("bin");
    fs::create_dir_all(&bin).expect("bin");
    let gh = bin.join("gh");
    fs::write(
        &gh,
        "#!/bin/sh\nif [ \"$1\" = \"repo\" ]; then\n  printf '%s\\n' '{\"owner\":{\"login\":\"acme\"},\"name\":\"demo\"}'\n  exit 0\nfi\nprintf '%s\\n' '{\"number\":7}'\nexit 0\n",
    )
    .expect("gh");
    use std::os::unix::fs::PermissionsExt;
    let mut perms = fs::metadata(&gh).expect("meta").permissions();
    perms.set_mode(0o755);
    fs::set_permissions(&gh, perms).expect("chmod");
    let path = format!(
        "{}:{}",
        bin.display(),
        std::env::var("PATH").unwrap_or_default()
    );
    let checkout = repo
        .command(
            env!("CARGO_BIN_EXE_ptm"),
            &["github", "checkout", "7", "--json"],
        )
        .env("PATH", &path)
        .output()
        .expect("checkout");
    assert!(
        checkout.status.success(),
        "{}\n{}",
        text(&checkout.stdout),
        text(&checkout.stderr)
    );
    let checkout_json = json_value(&checkout);
    assert!(checkout_json.get("error").is_none(), "{checkout_json}");
    assert_eq!(checkout_json["worktree"]["name"], "issues-7");
    assert_eq!(checkout_json["worktree"]["detached"], true);
    assert_eq!(checkout_json["postCreate"]["ok"], true);
    assert!(paths_match(
        checkout_json["worktree"]["path"].as_str().unwrap_or(""),
        &repo.repo.join(".git/phantom/worktrees/issues-7")
    ));
}

#[test]
fn github_checkout_json_reports_issue_and_existing_pull_request() {
    let repo = Repo::new();
    let bin = repo.root.join("bin");
    fs::create_dir_all(&bin).expect("bin");
    let gh = bin.join("gh");
    fs::write(
        &gh,
        "#!/bin/sh\nif [ \"$1\" = \"repo\" ]; then\n  printf '%s\\n' '{\"owner\":{\"login\":\"acme\"},\"name\":\"demo\"}'\n  exit 0\nfi\nprintf '%s\\n' '{\"number\":7}'\nexit 0\n",
    )
    .expect("gh");
    use std::os::unix::fs::PermissionsExt;
    let mut perms = fs::metadata(&gh).expect("meta").permissions();
    perms.set_mode(0o755);
    fs::set_permissions(&gh, perms).expect("chmod");
    let path = format!(
        "{}:{}",
        bin.display(),
        std::env::var("PATH").unwrap_or_default()
    );
    let checkout = repo
        .command(
            env!("CARGO_BIN_EXE_ptm"),
            &["github", "checkout", "7", "--json"],
        )
        .env("PATH", &path)
        .output()
        .expect("checkout");
    assert!(
        checkout.status.success(),
        "{}\n{}",
        text(&checkout.stdout),
        text(&checkout.stderr)
    );
    let checkout_json = json_value(&checkout);
    assert_eq!(checkout_json["version"], 1);
    assert_eq!(checkout_json["github"]["kind"], "issue");
    assert_eq!(checkout_json["github"]["number"], 7);
    assert!(checkout_json["github"]["headRef"].is_null());
    assert_eq!(checkout_json["github"]["alreadyExists"], false);
    assert_worktree_object(
        &checkout_json["worktree"],
        "issues/7",
        &repo.repo.join(".git/phantom/worktrees/issues/7"),
    );
    assert_eq!(checkout_json["worktree"]["branch"], "issues/7");
    assert_eq!(checkout_json["worktree"]["base"], "HEAD");
    assert!(!text(&checkout.stdout).contains("Created worktree"));

    let missing = repo
        .command(env!("CARGO_BIN_EXE_ptm"), &["github", "checkout", "--json"])
        .env("PATH", &path)
        .output()
        .expect("missing");
    assert_eq!(missing.status.code(), Some(3));
    assert_eq!(json_value(&missing)["error"]["code"], "validation");

    let matching = Repo::new();
    let matching_path = fake_gh_for_topic_pr(&matching);
    let checked_out = matching.repo.join(".git/phantom/worktrees/topic");
    matching.git(&[
        "worktree",
        "add",
        "-b",
        "topic",
        checked_out.to_str().expect("path"),
        "HEAD",
    ]);
    let again = matching
        .command(
            env!("CARGO_BIN_EXE_ptm"),
            &["gh", "checkout", "7", "--json"],
        )
        .env("PATH", &matching_path)
        .output()
        .expect("again");
    assert!(
        again.status.success(),
        "{}\n{}",
        text(&again.stdout),
        text(&again.stderr)
    );
    let again_json = json_value(&again);
    assert_eq!(again_json["github"]["kind"], "pullRequest");
    assert_eq!(again_json["github"]["number"], 7);
    assert_eq!(again_json["github"]["headRef"], "topic");
    assert_eq!(again_json["github"]["alreadyExists"], true);
    assert!(again_json["worktree"]["base"].is_null());
    assert_eq!(again_json["postCreate"]["ran"], false);
    assert_worktree_object(&again_json["worktree"], "topic", &checked_out);
    assert!(!text(&again.stdout).contains("already checked out"));
}

#[test]
fn exec_passes_command_options_through() {
    let repo = Repo::new();
    let created = repo.phantom(&["create", "feature/exec-flags"]);
    assert!(created.status.success(), "{}", text(&created.stderr));

    let direct = repo.phantom(&[
        "exec",
        "feature/exec-flags",
        "git",
        "branch",
        "--show-current",
    ]);
    assert!(
        direct.status.success(),
        "{}\n{}",
        text(&direct.stdout),
        text(&direct.stderr)
    );
    assert_eq!(text(&direct.stdout), "feature/exec-flags");

    let separated = repo.phantom(&[
        "exec",
        "feature/exec-flags",
        "--",
        "git",
        "branch",
        "--show-current",
    ]);
    assert!(separated.status.success(), "{}", text(&separated.stderr));
    assert_eq!(text(&separated.stdout), "feature/exec-flags");

    let nested = repo.phantom(&[
        "exec",
        "feature/exec-flags",
        "sh",
        "-c",
        "printf '%s\\n' \"$@\"",
        "sh",
        "--show-current",
        "-n",
        "--",
        "--keep",
        "--help",
    ]);
    assert!(
        nested.status.success(),
        "{}\n{}",
        text(&nested.stdout),
        text(&nested.stderr)
    );
    assert_eq!(
        text(&nested.stdout),
        "--show-current\n-n\n--\n--keep\n--help"
    );
    assert!(!text(&nested.stdout).contains("ptm exec <worktree-name>"));

    let help = repo.phantom(&["exec", "--help"]);
    assert!(help.status.success(), "{}", text(&help.stderr));
    assert!(text(&help.stdout).contains("ptm exec <worktree-name> <command> [args...]"));

    let early = repo.phantom(&["exec", "--show-current", "feature/exec-flags", "true"]);
    assert_eq!(early.status.code(), Some(3));
    assert!(text(&early.stderr).contains("Unknown option '--show-current'"));
}

#[test]
fn create_and_attach_exec_pass_command_options_through() {
    let repo = Repo::new();
    let created = repo.phantom(&[
        "create",
        "feature/exec-args",
        "--base",
        "main",
        "--exec",
        "git",
        "branch",
        "--show-current",
    ]);
    assert!(
        created.status.success(),
        "{}\n{}",
        text(&created.stdout),
        text(&created.stderr)
    );
    let created_text = text(&created.stdout);
    assert!(
        created_text.contains(
            "Executing command in worktree 'feature/exec-args': git branch --show-current"
        ),
        "{created_text}"
    );
    assert!(
        created_text.lines().any(|line| line == "feature/exec-args"),
        "{created_text}"
    );

    let env_exec = repo.phantom(&[
        "create",
        "feature/exec-env-args",
        "--exec",
        "sh",
        "-c",
        "printf '%s\\n' \"$PTM_NAME\"",
    ]);
    assert!(
        env_exec.status.success(),
        "{}\n{}",
        text(&env_exec.stdout),
        text(&env_exec.stderr)
    );
    assert!(
        text(&env_exec.stdout)
            .lines()
            .any(|line| line == "feature/exec-env-args"),
        "{}",
        text(&env_exec.stdout)
    );

    let short = repo.phantom(&[
        "create",
        "feature/exec-short",
        "-x",
        "git",
        "status",
        "--short",
    ]);
    assert!(
        short.status.success(),
        "{}\n{}",
        text(&short.stdout),
        text(&short.stderr)
    );
    assert!(text(&short.stdout).contains("git status --short"));

    let missing = repo.phantom(&["create", "feature/missing-exec", "--exec"]);
    assert_eq!(missing.status.code(), Some(3));
    assert!(text(&missing.stderr).contains("Option '--exec <value>' argument missing"));

    repo.git(&["branch", "attached-exec-flags"]);
    let attached = repo.phantom(&[
        "attach",
        "attached-exec-flags",
        "--exec",
        "git",
        "branch",
        "--show-current",
    ]);
    assert!(
        attached.status.success(),
        "{}\n{}",
        text(&attached.stdout),
        text(&attached.stderr)
    );
    assert!(
        text(&attached.stdout)
            .lines()
            .any(|line| line == "attached-exec-flags"),
        "{}",
        text(&attached.stdout)
    );

    let help_arg = repo.phantom(&[
        "create",
        "feature/exec-help",
        "--exec",
        "sh",
        "-c",
        "printf '%s\\n' --help",
    ]);
    assert!(
        help_arg.status.success(),
        "{}\n{}",
        text(&help_arg.stdout),
        text(&help_arg.stderr)
    );
    assert!(
        text(&help_arg.stdout).lines().any(|line| line == "--help"),
        "{}",
        text(&help_arg.stdout)
    );
    assert!(!text(&help_arg.stdout).contains("ptm create [name]"));

    let option_after = repo.phantom(&[
        "create",
        "feature/exec-base",
        "--exec",
        "git",
        "status",
        "--base",
    ]);
    assert!(!option_after.status.success());
    let combined = format!(
        "{}\n{}",
        text(&option_after.stdout),
        text(&option_after.stderr)
    );
    assert!(
        !combined.contains("Option '--base <value>' argument missing"),
        "{combined}"
    );
    assert!(
        combined.contains("failed with exit code") || combined.contains("unknown"),
        "{combined}"
    );
}

#[test]
fn repeated_exec_options_are_rejected() {
    let repo = Repo::new();
    let message = "The --exec option can only be specified once";

    let created = repo.phantom(&["create", "a", "--exec=echo", "--exec=true"]);
    assert_eq!(created.status.code(), Some(3), "{}", text(&created.stderr));
    assert!(
        text(&created.stderr).contains(message),
        "{}",
        text(&created.stderr)
    );
    assert_eq!(text(&created.stdout), "");
    assert!(!repo.repo.join(".git/phantom/worktrees/a").exists());

    let quoted = repo.phantom(&["create", "b", "--exec=echo one", "--exec=echo two"]);
    assert_eq!(quoted.status.code(), Some(3), "{}", text(&quoted.stderr));
    assert!(
        text(&quoted.stderr).contains(message),
        "{}",
        text(&quoted.stderr)
    );
    assert!(!repo.repo.join(".git/phantom/worktrees/b").exists());

    let mixed = repo.phantom(&["create", "c", "-xecho", "--exec=true"]);
    assert_eq!(mixed.status.code(), Some(3), "{}", text(&mixed.stderr));
    assert!(text(&mixed.stderr).contains(message));

    repo.git(&["branch", "attached-repeat"]);
    let attached = repo.phantom(&["attach", "attached-repeat", "--exec=echo", "--exec=true"]);
    assert_eq!(
        attached.status.code(),
        Some(3),
        "{}",
        text(&attached.stderr)
    );
    assert!(
        text(&attached.stderr).contains(message),
        "{}",
        text(&attached.stderr)
    );
    assert_eq!(text(&attached.stdout), "");
    assert!(!repo
        .repo
        .join(".git/phantom/worktrees/attached-repeat")
        .exists());

    let attached_short = repo.phantom(&["attach", "attached-repeat", "-xecho", "-xtrue"]);
    assert_eq!(
        attached_short.status.code(),
        Some(3),
        "{}",
        text(&attached_short.stderr)
    );
    assert!(text(&attached_short.stderr).contains(message));

    let trailing = repo.phantom(&["create", "kept", "--exec", "echo", "--exec"]);
    assert!(
        trailing.status.success(),
        "{}\n{}",
        text(&trailing.stdout),
        text(&trailing.stderr)
    );
    assert!(
        text(&trailing.stdout).lines().any(|line| line == "--exec"),
        "{}",
        text(&trailing.stdout)
    );

    let trailing_attach =
        repo.phantom(&["attach", "attached-repeat", "--exec", "echo", "--exec=true"]);
    assert!(
        trailing_attach.status.success(),
        "{}\n{}",
        text(&trailing_attach.stdout),
        text(&trailing_attach.stderr)
    );
    assert!(
        text(&trailing_attach.stdout)
            .lines()
            .any(|line| line == "--exec=true"),
        "{}",
        text(&trailing_attach.stdout)
    );
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
