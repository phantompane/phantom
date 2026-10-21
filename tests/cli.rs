#[path = "common/records.rs"]
mod records;
use std::fs;
use std::path::{Path, PathBuf};
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

    fn mabo(&self, args: &[&str]) -> std::process::Output {
        self.command(env!("CARGO_BIN_EXE_mabo"), args)
            .output()
            .expect("mabo")
    }

    fn command(&self, program: &str, args: &[&str]) -> Command {
        let mut command = Command::new(program);
        command
            .args(args)
            .current_dir(&self.repo)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("HOME", &self.home)
            .env("XDG_CONFIG_HOME", self.home.join(".config"))
            .env("XDG_STATE_HOME", self.root.join("state"))
            .env("XDG_DATA_HOME", self.root.join("xdg"))
            .env_remove("GHQ_ROOT")
            .env_remove("MABO_OUTPUT")
            .env_remove("MABO_NO_INPUT")
            .env_remove("MABO_AGENT_ID")
            .env_remove("MABO_NAME_CANDIDATES")
            .env_remove("PHANTOM_AGENT_ID")
            .env_remove("GIT_CONFIG_GLOBAL")
            .env_remove("GIT_CONFIG_SYSTEM")
            .env_remove("GIT_CONFIG_COUNT")
            .env_remove("GIT_CONFIG_PARAMETERS");
        if std::path::Path::new(program)
            .file_name()
            .and_then(|name| name.to_str())
            == Some("mabo")
        {
            command.env("MABO_TRUST_ALL", "1");
        }
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

fn managed_directory(git_root: &Path, xdg: &Path) -> PathBuf {
    let common = maboroshi::git::canonical_common_dir(git_root).expect("common dir");
    maboroshi::paths::default_worktrees_directory(git_root, &common, xdg).path
}

fn managed(repo: &Repo, relative: &str) -> PathBuf {
    managed_directory(&repo.repo, &repo.root.join("xdg")).join(relative)
}

fn managed_root(repo: &Repo) -> PathBuf {
    managed_directory(&repo.repo, &repo.root.join("xdg"))
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

fn mabo_color(
    repo: &Repo,
    args: &[&str],
    no_color: Option<&str>,
    force_color: Option<&str>,
) -> std::process::Output {
    let mut command = repo.command(env!("CARGO_BIN_EXE_mabo"), args);
    command.env_remove("NO_COLOR").env_remove("FORCE_COLOR");
    if let Some(value) = no_color {
        command.env("NO_COLOR", value);
    }
    if let Some(value) = force_color {
        command.env("FORCE_COLOR", value);
    }
    command.output().expect("mabo")
}

#[test]
fn help_is_plain_when_stdout_is_not_a_tty() {
    let repo = Repo::new();
    let help = mabo_color(&repo, &["--help"], None, None);
    assert!(help.status.success());
    assert!(
        !text(&help.stdout).contains('\u{1b}'),
        "piped help should not include ANSI color: {}",
        text(&help.stdout)
    );
    let list = mabo_color(&repo, &["list", "--help"], None, None);
    assert!(list.status.success());
    assert!(!text(&list.stdout).contains('\u{1b}'));

    let forced = mabo_color(&repo, &["--help"], None, Some("1"));
    assert!(
        text(&forced.stdout).contains('\u{1b}'),
        "FORCE_COLOR=1 should color piped help"
    );

    let no_color = mabo_color(&repo, &["--help"], Some("1"), Some("1"));
    assert!(
        !text(&no_color.stdout).contains('\u{1b}'),
        "NO_COLOR disables color even when FORCE_COLOR is set"
    );

    let disabled = mabo_color(&repo, &["github", "checkout", "--help"], None, Some("0"));
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
        &["gc"],
    ] {
        let output = repo
            .command(env!("CARGO_BIN_EXE_mabo"), args)
            .current_dir(&outside)
            .output()
            .expect("mabo");
        let stderr = text(&output.stderr);
        assert!(
            !stderr.to_ascii_lowercase().contains("fatal:"),
            "{args:?} leaked git output: {stderr}"
        );
        assert!(
            stderr.contains("Not a git repository. Run mabo from inside a Git repository."),
            "{args:?} stderr: {stderr}"
        );
        assert_eq!(output.status.code(), Some(3), "{args:?} stderr: {stderr}");
    }
    let help = repo
        .command(env!("CARGO_BIN_EXE_mabo"), &["--help"])
        .current_dir(&outside)
        .output()
        .expect("help");
    assert!(help.status.success());
}

#[test]
fn version_help_and_unknown_command() {
    let repo = Repo::new();
    let version = repo.mabo(&["--version"]);
    assert!(version.status.success());
    let version_line = text(&version.stdout);
    assert!(
        version_line.starts_with("mabo v7.0.0-alpha.6+rust"),
        "{version_line}"
    );
    assert!(!version_line.contains("ptm"), "{version_line}");
    assert_ne!(version_line, "mabo v7.0.0-alpha.6");
    let subcommand = repo.mabo(&["version"]);
    assert_eq!(text(&subcommand.stdout), version_line);

    let help = repo.mabo(&["--help"]);
    assert!(help.status.success());
    let help_text = text(&help.stdout);
    assert!(help_text.contains("mabo - Workspaces for parallel coding agents"));
    assert!(!help_text.contains("Phantom"), "{help_text}");
    assert!(help_text.contains("mabo <command> [options]"));
    assert!(help_text.contains("Run 'mabo <command> --help'"));
    assert!(!help_text.contains("phantom <command>"));

    for args in [["version", "--help"], ["project", "--help"]] {
        let command_help = repo.mabo(&args);
        assert!(command_help.status.success(), "{args:?}");
        let command_text = text(&command_help.stdout);
        assert!(
            !command_text.contains("Phantom"),
            "{args:?} still names Phantom:\n{command_text}"
        );
    }

    let where_help = repo.mabo(&["where", "--help"]);
    assert!(where_help.status.success());
    let where_text = text(&where_help.stdout);
    assert!(where_text.contains("mabo where"));
    assert!(where_text.contains("mabo where [--project <ref>] <worktree-name> [options]"));
    assert!(!where_text.contains("phantom where"));

    let missing_where = repo.mabo(&["where"]);
    assert_eq!(missing_where.status.code(), Some(2));
    assert!(text(&missing_where.stderr).contains("Usage: mabo where <worktree-name>"));

    let unknown = repo.mabo(&["nope"]);
    assert_eq!(unknown.status.code(), Some(2));
    assert!(text(&unknown.stderr).contains("Unknown command 'nope'"));
}

#[test]
fn linked_worktree_git_file_and_insteadof_canonical_name() {
    let repo = Repo::new();
    let worktree = repo.root.join("linked");
    repo.git(&[
        "worktree",
        "add",
        "-b",
        "feature",
        worktree.to_str().expect("worktree"),
        "HEAD",
    ]);
    let gitfile = worktree.join(".git");
    assert!(gitfile.is_file(), "{}", gitfile.display());
    let from_worktree = repo
        .command(
            env!("CARGO_BIN_EXE_mabo"),
            &["list", "-p", worktree.to_str().expect("worktree"), "--json"],
        )
        .output()
        .expect("list worktree");
    assert!(
        from_worktree.status.success(),
        "{}",
        text(&from_worktree.stderr)
    );
    let from_gitfile = repo
        .command(
            env!("CARGO_BIN_EXE_mabo"),
            &["list", "-p", gitfile.to_str().expect("git file"), "--json"],
        )
        .output()
        .expect("list git file");
    assert!(
        from_gitfile.status.success(),
        "stderr: {}",
        text(&from_gitfile.stderr)
    );
    assert_eq!(
        default_worktree_path(&json_value(&from_gitfile)),
        default_worktree_path(&json_value(&from_worktree))
    );
    assert!(same_dir(
        &default_worktree_path(&json_value(&from_gitfile)),
        &repo.repo
    ));

    let project = repo.root.join("aliased");
    fs::create_dir_all(&project).expect("project");
    git_at(&repo, &project, &["init", "-b", "main"]);
    git_at(
        &repo,
        &project,
        &["config", "user.email", "phantom-rust@example.com"],
    );
    git_at(&repo, &project, &["config", "user.name", "Phantom Rust"]);
    fs::write(project.join("README.md"), "hi\n").expect("readme");
    git_at(&repo, &project, &["add", "README.md"]);
    git_at(&repo, &project, &["commit", "-m", "initial"]);
    git_at(
        &repo,
        &project,
        &["remote", "add", "origin", "gh:zed/aliased"],
    );
    git_at(
        &repo,
        &project,
        &["config", "url.https://github.com/.insteadOf", "gh:"],
    );
    let added = repo
        .command(
            env!("CARGO_BIN_EXE_mabo"),
            &[
                "project",
                "add",
                project.to_str().expect("project"),
                "--json",
            ],
        )
        .output()
        .expect("project add");
    assert!(added.status.success(), "{}", text(&added.stderr));
    let catalog = repo.mabo(&["project", "list", "--json"]);
    assert!(catalog.status.success(), "{}", text(&catalog.stderr));
    let catalog = json_value(&catalog);
    let entry = catalog["data"]["projects"]
        .as_array()
        .expect("projects")
        .iter()
        .find(|project_entry| {
            project_entry["rootPath"]
                .as_str()
                .is_some_and(|path| same_dir(path, &project))
        })
        .expect("registered project");
    assert_eq!(entry["source"], "registry");
    assert_eq!(entry["canonicalName"], "github.com/zed/aliased");
}

fn default_worktree_path(value: &serde_json::Value) -> String {
    value["data"]["worktrees"]
        .as_array()
        .expect("worktrees")
        .iter()
        .find(|item| item["default"] == true)
        .expect("default worktree")["path"]
        .as_str()
        .expect("path")
        .to_string()
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
        let output = repo.mabo(&args);
        assert_eq!(
            output.status.code(),
            Some(2),
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
    let created = repo.mabo(&["create", "feature/add-tests"]);
    assert!(created.status.success(), "{}", text(&created.stderr));
    assert!(text(&created.stdout).contains("Created worktree 'feature/add-tests' at "));
    let worktree = managed(&repo, "feature/add-tests");
    assert!(worktree.join("README.md").is_file());
    assert!(!repo.repo.join(".git/phantom").exists());
    assert!(!repo.repo.join(".git/ptm").exists());
    assert!(repo.repo.join(".git/maboroshi/workspaces").is_dir());

    let duplicate = repo.mabo(&["create", "feature/add-tests"]);
    assert_eq!(duplicate.status.code(), Some(4));
    assert!(text(&duplicate.stderr).contains("already exists"));

    let names = repo.mabo(&["list", "--names", "--no-default"]);
    assert!(names.status.success(), "{}", text(&names.stderr));
    assert_eq!(text(&names.stdout), "feature/add-tests");

    let empty = repo.mabo(&["list", "--no-default"]);
    let _ = empty;
    let where_path = repo.mabo(&["where", "feature/add-tests"]);
    assert_eq!(where_path.status.code(), Some(0));
    assert_eq!(text(&where_path.stdout), worktree.to_string_lossy());

    let missing = repo.mabo(&["where", "missing-worktree"]);
    assert_eq!(missing.status.code(), Some(3));
    assert!(text(&missing.stderr).contains("not found"));

    repo.git(&["branch", "existing-feature"]);
    let attached = repo.mabo(&["attach", "existing-feature"]);
    assert!(attached.status.success(), "{}", text(&attached.stderr));
    assert!(text(&attached.stdout).contains("Attached worktree: existing-feature"));
    let missing_branch = repo.mabo(&["attach", "missing-branch"]);
    assert_eq!(missing_branch.status.code(), Some(3));

    let kept = repo.mabo(&["delete", "existing-feature", "--keep-branch"]);
    assert!(kept.status.success(), "{}", text(&kept.stderr));
    assert!(text(&kept.stdout).contains("kept its branch 'existing-feature'"));
    let branch = repo
        .command("git", &["branch", "--list", "existing-feature"])
        .output()
        .expect("branch");
    assert!(text(&branch.stdout).contains("existing-feature"));

    let deleted = repo.mabo(&["delete", "feature/add-tests"]);
    assert!(deleted.status.success(), "{}", text(&deleted.stderr));
    assert!(text(&deleted.stdout).contains("and its branch 'feature/add-tests'"));
    assert!(!worktree.exists());
    let missing_delete = repo.mabo(&["delete", "missing-worktree"]);
    assert_eq!(missing_delete.status.code(), Some(3));
}

#[test]
fn invalid_config_names_the_file_and_the_problem() {
    let repo = Repo::new();
    fs::write(repo.repo.join(".mabo.toml"), "[\n").expect("config");
    let created = repo.mabo(&["create", "feature/bad-toml"]);
    let stderr = text(&created.stderr);
    assert!(
        !created.status.success(),
        "invalid TOML should fail, stdout: {}",
        text(&created.stdout)
    );
    assert!(
        stderr.contains(".mabo.toml"),
        "stderr should name the file: {stderr}"
    );
    assert!(
        stderr.contains("parse") || stderr.contains("expected") || stderr.contains("invalid"),
        "stderr should describe the TOML problem: {stderr}"
    );
    assert!(!managed(&repo, "feature/bad-toml").exists());

    fs::write(
        repo.repo.join(".mabo.toml"),
        "[hooks]\npost-create = \"pnpm install\"\n",
    )
    .expect("schema");
    let created = repo.mabo(&["where", "feature/bad-toml"]);
    let stderr = text(&created.stderr);
    assert!(!created.status.success(), "{}", text(&created.stdout));
    assert!(stderr.contains(".mabo.toml"), "{stderr}");
    assert!(
        stderr.contains("post-create") || stderr.contains("invalid type"),
        "{stderr}"
    );

    fs::write(
        repo.repo.join(".mabo.toml"),
        "worktreesDirectory = \".phantom\"\n",
    )
    .expect("unknown");
    let created = repo.mabo(&["where", "feature/bad-toml"]);
    let stderr = text(&created.stderr);
    assert!(!created.status.success(), "{}", text(&created.stdout));
    assert!(stderr.contains(".mabo.toml"), "{stderr}");
    assert!(stderr.contains("worktreesDirectory"), "{stderr}");
}

#[test]
fn github_checkout_logs_the_post_create_hook() {
    let repo = Repo::new();
    fs::write(
        repo.repo.join(".mabo.toml"),
        "[hooks]\npost-create = [\"true\"]\n",
    )
    .expect("config");
    let bin = repo.root.join("bin");
    fs::create_dir_all(&bin).expect("bin");
    let gh = bin.join("gh");
    fs::write(
        &gh,
        "#!/bin/sh\nif [ \"$1\" = \"repo\" ]; then\n  printf '%s\\n' '{\"url\":\"https://github.com/acme/demo\",\"owner\":{\"login\":\"acme\"},\"name\":\"demo\"}'\n  exit 0\nfi\nif [ \"$1\" = \"api\" ]; then\n  printf '%s\\n' '{\"number\":7}'\n  exit 0\nfi\nprintf '%s\\n' \"unexpected gh: $*\" >&2\nexit 1\n",
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
        .command(env!("CARGO_BIN_EXE_mabo"), &["github", "checkout", "7"])
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
        repo.repo.join(".mabo.toml"),
        "[hooks]\npost-create = [\"phantom-missing-post-create-bin\"]\n",
    )
    .expect("config");
    let created = repo.mabo(&["create", "feature/hooks"]);
    let worktree = managed(&repo, "feature/hooks");
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
    assert_eq!(created.status.code(), Some(6), "{stderr}");

    repo.git(&["branch", "existing-hook"]);
    let attached = repo.mabo(&["attach", "existing-hook"]);
    let attached_path = managed(&repo, "existing-hook");
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
    assert_eq!(attached.status.code(), Some(6));
}

#[test]
fn copies_worktreeinclude_files_and_runs_post_create() {
    let repo = Repo::new();
    fs::write(repo.repo.join(".gitignore"), ".env.local\n").expect("gitignore");
    fs::write(repo.repo.join(".env.local"), "API_KEY=test-value\n").expect("env");
    fs::write(repo.repo.join(".worktreeinclude"), ".env.local\n").expect("include");
    fs::write(
        repo.repo.join(".mabo.toml"),
        "[hooks]\npost-create = [\"touch post-create.txt\"]\n",
    )
    .expect("config");
    let created = repo.mabo(&["create", "feature/config"]);
    assert!(
        created.status.success(),
        "{}\n{}",
        text(&created.stdout),
        text(&created.stderr)
    );
    let worktree = managed(&repo, "feature/config");
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
        repo.repo.join(".mabo.toml"),
        r#"[hooks]
post-create = [
  "printf '%s' \"$MABO_ROOT_PATH\" > root-path.txt",
  "printf '%s' \"$MABO\" > mabo-flag.txt",
  "printf '%s' \"$MABO_NAME\" > mabo-name.txt",
  "printf '%s' \"$MABO_PATH\" > mabo-path.txt",
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

    let created = repo.mabo(&["create", "feature/hooks-order"]);
    let worktree = managed(&repo, "feature/hooks-order");
    assert_eq!(created.status.code(), Some(6), "{}", text(&created.stderr));
    assert_eq!(
        fs::read_to_string(worktree.join("root-path.txt")).expect("root path"),
        repo.repo.display().to_string()
    );
    assert_eq!(
        fs::read_to_string(worktree.join("mabo-flag.txt")).expect("flag"),
        "1"
    );
    assert_eq!(
        fs::read_to_string(worktree.join("mabo-name.txt")).expect("name"),
        "feature/hooks-order"
    );
    assert_eq!(
        fs::read_to_string(worktree.join("mabo-path.txt")).expect("path"),
        worktree.display().to_string()
    );
    assert_eq!(
        fs::read_to_string(worktree.join("ptm-flag.txt")).expect("old ptm flag"),
        ""
    );
    assert_eq!(
        fs::read_to_string(worktree.join("ptm-name.txt")).expect("old ptm name"),
        ""
    );
    assert_eq!(
        fs::read_to_string(worktree.join("ptm-path.txt")).expect("old ptm path"),
        ""
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

    let deleted = repo.mabo(&["delete", "--force", "feature/hooks-order"]);
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
    let source_created = repo.mabo(&["create", "feature/source"]);
    assert!(
        source_created.status.success(),
        "{}\n{}",
        text(&source_created.stdout),
        text(&source_created.stderr)
    );
    let source = managed(&repo, "feature/source");
    fs::write(
        repo.repo.join(".mabo.toml"),
        "[hooks]\npost-create = [\"touch from-main.txt\"]\npre-delete = [\"touch pre-from-main.txt\"]\n",
    )
    .expect("main hooks");
    fs::write(
        source.join(".mabo.toml"),
        r#"[hooks]
post-create = ["printf '%s' \"$MABO_ROOT_PATH\" > root-path.txt"]
pre-delete = ["printf '%s' \"$MABO_ROOT_PATH\" > \"$MABO_ROOT_PATH/pre-root.txt\""]
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
        .command(env!("CARGO_BIN_EXE_mabo"), &["create", "feature/child"])
        .current_dir(&source)
        .output()
        .expect("create");
    assert!(
        created.status.success(),
        "{}\n{}",
        text(&created.stdout),
        text(&created.stderr)
    );
    let child = managed(&repo, "feature/child");
    assert_eq!(
        fs::read_to_string(child.join("root-path.txt")).expect("root path"),
        source_path
    );
    assert!(!child.join("from-main.txt").exists());

    let deleted = repo
        .command(
            env!("CARGO_BIN_EXE_mabo"),
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
    let created = repo.mabo(&["create", "feature/no-json"]);
    assert!(
        created.status.success(),
        "{}\n{}",
        text(&created.stdout),
        text(&created.stderr)
    );
    assert!(managed(&repo, "feature/no-json/README.md").is_file());
}

#[test]
fn preferences_and_project_registry() {
    let repo = Repo::new();
    let set = repo.mabo(&["preferences", "set", "keep-branch", "true"]);
    assert!(set.status.success(), "{}", text(&set.stderr));
    let set_stdout = text(&set.stdout);
    assert!(set_stdout.contains("keep-branch"), "{set_stdout}");
    assert!(set_stdout.contains("true"), "{set_stdout}");
    assert!(
        set_stdout.contains(
            repo.home
                .join(".config/maboroshi/config.toml")
                .to_str()
                .expect("path")
        ),
        "{set_stdout}"
    );
    let get = repo.mabo(&["preferences", "get", "keep-branch"]);
    assert_eq!(text(&get.stdout), "true");

    let added = repo.mabo(&["project", "add", "--json"]);
    assert!(added.status.success(), "{}", text(&added.stderr));
    let value: serde_json::Value = serde_json::from_str(&text(&added.stdout)).expect("json");
    assert_eq!(value["data"]["status"], "added");
    assert_eq!(value["data"]["project"]["name"], "repo");
    assert_eq!(
        value["data"]["project"]["rootPath"],
        repo.repo.to_string_lossy().as_ref()
    );

    repo.mabo(&["preferences", "set", "ghq-discovery", "false"]);
    let listed = repo.mabo(&["project", "list", "--json"]);
    assert!(listed.status.success(), "{}", text(&listed.stderr));
    let catalog: serde_json::Value = serde_json::from_str(&text(&listed.stdout)).expect("catalog");
    assert_eq!(catalog["schema"], 2);
    assert_eq!(catalog["data"]["projects"][0]["source"], "registry");
    assert_eq!(
        catalog["data"]["projects"][0]["id"],
        value["data"]["project"]["id"]
    );
    assert_eq!(catalog["data"]["projects"][0]["name"], "repo");
    assert_eq!(catalog["data"]["projects"][0]["canonicalName"], "repo");

    let removed = repo.mabo(&[
        "project",
        "remove",
        value["data"]["project"]["id"].as_str().expect("id"),
        "--json",
    ]);
    assert!(removed.status.success(), "{}", text(&removed.stderr));
    let empty = repo.mabo(&["project", "list", "--json"]);
    let empty_catalog: serde_json::Value =
        serde_json::from_str(&text(&empty.stdout)).expect("empty");
    assert_eq!(
        empty_catalog["data"]["projects"].as_array().map(Vec::len),
        Some(0)
    );
}

#[test]
fn project_registry_is_stored_under_xdg_state_home_maboroshi() {
    let repo = Repo::new();
    let legacy = repo.root.join("state/phantom");
    let previous = repo.root.join("state/ptm");
    write_legacy_registry(&legacy);
    write_legacy_registry(&previous);
    let legacy_body = fs::read_to_string(legacy.join("projects.json")).expect("legacy");
    let previous_body = fs::read_to_string(previous.join("projects.json")).expect("previous");

    let added = repo.mabo(&["project", "add", "--json"]);
    assert!(added.status.success(), "{}", text(&added.stderr));
    let registry = fs::read_to_string(
        fs::read_dir(repo.root.join("state/maboroshi/repos"))
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path(),
    )
    .expect("registry");
    assert!(registry.contains("\"name\": \"repo\""));
    assert!(!registry.contains("proj_550e8400-e29b-41d4-a716-446655440000"));
    assert_eq!(
        fs::read_to_string(legacy.join("projects.json")).expect("legacy unchanged"),
        legacy_body
    );
    assert_eq!(
        fs::read_to_string(previous.join("projects.json")).expect("previous unchanged"),
        previous_body
    );

    let disabled = repo.mabo(&["preferences", "set", "ghq-discovery", "false"]);
    assert!(disabled.status.success(), "{}", text(&disabled.stderr));
    let listed = repo.mabo(&["project", "list", "--json"]);
    assert!(listed.status.success(), "{}", text(&listed.stderr));
    let catalog: serde_json::Value = serde_json::from_str(&text(&listed.stdout)).expect("catalog");
    assert_eq!(
        catalog["data"]["projects"].as_array().map(Vec::len),
        Some(1)
    );
    assert_eq!(catalog["data"]["projects"][0]["name"], "repo");
    assert_eq!(catalog["data"]["projects"][0]["source"], "registry");

    let help = repo.mabo(&["project", "--help"]);
    assert!(help.status.success(), "{}", text(&help.stderr));
    let help_text = text(&help.stdout);
    assert!(help_text.contains("$XDG_STATE_HOME/maboroshi"));
    assert!(help_text.contains("~/.local/state/maboroshi"));
    assert!(!help_text.contains("XDG_STATE_HOME/phantom"));
    assert!(!help_text.contains(".local/state/phantom"));
    assert!(!help_text.contains("XDG_STATE_HOME/ptm"));
    assert!(!help_text.contains(".local/state/ptm"));
}

#[test]
fn project_registry_defaults_to_home_local_state_maboroshi() {
    let repo = Repo::new();
    let legacy = repo.home.join(".local/state/phantom");
    let previous = repo.home.join(".local/state/ptm");
    write_legacy_registry(&legacy);
    write_legacy_registry(&previous);
    let legacy_body = fs::read_to_string(legacy.join("projects.json")).expect("legacy");
    let previous_body = fs::read_to_string(previous.join("projects.json")).expect("previous");
    let disabled = repo.mabo(&["preferences", "set", "ghq-discovery", "false"]);
    assert!(disabled.status.success(), "{}", text(&disabled.stderr));

    let added = repo
        .command(env!("CARGO_BIN_EXE_mabo"), &["project", "add", "--json"])
        .env_remove("XDG_STATE_HOME")
        .output()
        .expect("add");
    assert!(added.status.success(), "{}", text(&added.stderr));
    let registry = fs::read_to_string(
        fs::read_dir(repo.home.join(".local/state/maboroshi/repos"))
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path(),
    )
    .expect("registry");
    assert!(registry.contains("\"name\": \"repo\""));
    assert!(!registry.contains("proj_550e8400-e29b-41d4-a716-446655440000"));
    assert_eq!(
        fs::read_to_string(legacy.join("projects.json")).expect("legacy unchanged"),
        legacy_body
    );
    assert_eq!(
        fs::read_to_string(previous.join("projects.json")).expect("previous unchanged"),
        previous_body
    );

    let listed = repo
        .command(env!("CARGO_BIN_EXE_mabo"), &["project", "list", "--names"])
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
    let path = repo.home.join(".config/maboroshi/config.toml");
    let gitconfig = fs::read_to_string(repo.home.join(".gitconfig")).expect("gitconfig");

    let missing = repo.mabo(&["preferences", "get", "keep-branch"]);
    assert!(missing.status.success(), "{}", text(&missing.stderr));
    let missing_stdout = text(&missing.stdout);
    assert!(missing_stdout.contains("is not set"), "{missing_stdout}");
    assert!(
        missing_stdout.contains(path.to_str().expect("path")),
        "{missing_stdout}"
    );
    assert!(!path.exists());

    let invalid_bool = repo.mabo(&["preferences", "set", "keep-branch", "yes"]);
    assert_eq!(invalid_bool.status.code(), Some(2));
    assert!(
        text(&invalid_bool.stderr).contains("true"),
        "{}",
        text(&invalid_bool.stderr)
    );
    assert!(!path.exists());

    let set = repo.mabo(&["preferences", "set", "directory-name-separator", "-"]);
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
    let updated = repo.mabo(&["preferences", "set", "keep-branch", "true"]);
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

    let removed = repo.mabo(&["preferences", "remove", "keep-branch"]);
    assert!(removed.status.success(), "{}", text(&removed.stderr));
    let written = fs::read_to_string(&path).expect("removed");
    assert!(!written.contains("keep-branch"), "{written}");
    assert!(written.contains("# separator"), "{written}");

    fs::write(&path, "{\n").expect("invalid");
    let invalid = repo.mabo(&["preferences", "get", "keep-branch"]);
    assert_eq!(invalid.status.code(), Some(1));
    let stderr = text(&invalid.stderr);
    assert!(stderr.contains(path.to_str().expect("path")), "{stderr}");

    fs::write(&path, "editor = \"code\"\n").expect("unknown");
    let unknown = repo.mabo(&["preferences", "get", "ghq-discovery"]);
    assert_eq!(unknown.status.code(), Some(1));
    let stderr = text(&unknown.stderr);
    assert!(stderr.contains("editor"), "{stderr}");
    assert!(stderr.contains(path.to_str().expect("path")), "{stderr}");

    fs::remove_file(&path).expect("cleanup");
    repo.git(&["config", "--global", "phantom.keepBranch", "true"]);
    repo.git(&["config", "--global", "ptm.keepBranch", "true"]);
    let ignored = repo.mabo(&["preferences", "get", "keep-branch"]);
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
    let removable = managed(&repo, "removable");
    repo.git(&[
        "worktree",
        "add",
        "-b",
        "removable",
        removable.to_str().expect("path"),
        "HEAD",
    ]);
    repo.mabo(&["preferences", "set", "keep-branch", "true"]);
    let deleted = repo.mabo(&["delete", "removable"]);
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
    let command = repo.mabo(&["ai", "feature"]);
    assert_eq!(command.status.code(), Some(2));
    assert!(text(&command.stderr).contains("Unknown command 'ai feature'"));

    let preference = repo.mabo(&["preferences", "set", "ai", "claude"]);
    assert_eq!(preference.status.code(), Some(2));
    let stderr = text(&preference.stderr);
    assert!(stderr.contains("Unknown preference 'ai'"), "{stderr}");
    assert!(stderr.contains("worktrees-directory"), "{stderr}");
}

#[test]
fn removed_edit_command_and_editor_preference_are_unknown() {
    let repo = Repo::new();
    let command = repo.mabo(&["edit", "feature"]);
    assert_eq!(command.status.code(), Some(2));
    assert!(text(&command.stderr).contains("Unknown command 'edit feature'"));

    let preference = repo.mabo(&["preferences", "get", "editor"]);
    assert_eq!(preference.status.code(), Some(2));
    let stderr = text(&preference.stderr);
    assert!(stderr.contains("Unknown preference 'editor'"), "{stderr}");
    assert!(stderr.contains("worktrees-directory"), "{stderr}");
}

#[test]
fn removed_shell_command_and_flag_are_unknown() {
    let repo = Repo::new();
    let command = repo.mabo(&["shell", "feature"]);
    assert_eq!(command.status.code(), Some(2));
    assert!(text(&command.stderr).contains("Unknown command 'shell feature'"));

    for args in [
        vec!["create", "name", "--shell"],
        vec!["attach", "main", "-s"],
    ] {
        let output = repo.mabo(&args);
        assert_eq!(
            output.status.code(),
            Some(2),
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
        let output = repo.mabo(&args);
        assert_eq!(
            output.status.code(),
            Some(2),
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
    let result = repo.mabo(&["list", "--no-default"]);
    assert_eq!(result.status.code(), Some(0), "{}", text(&result.stderr));
    assert!(text(&result.stdout).contains("No sub worktrees found"));
}

#[test]
fn project_add_from_a_linked_worktree_is_idempotent() {
    let repo = Repo::new();
    let added = repo.mabo(&["project", "add", "--json"]);
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
            env!("CARGO_BIN_EXE_mabo"),
            &["project", "add", linked.to_str().expect("path"), "--json"],
        )
        .current_dir(&linked)
        .output()
        .expect("add");
    assert!(again.status.success(), "{}", text(&again.stderr));
    let again_value: serde_json::Value = serde_json::from_str(&text(&again.stdout)).expect("json");
    assert_eq!(again_value["data"]["status"], "existing");
    assert_eq!(again_value["data"]["project"], value["data"]["project"]);
}

#[test]
fn project_list_discovers_ghq_and_warns_when_discovery_fails() {
    let repo = Repo::new();
    let bin = repo.root.join("bin");
    fs::create_dir_all(&bin).expect("bin");
    let ghq = bin.join("ghq");
    fs::write(
        &ghq,
        "#!/bin/sh\nif [ \"$1\" != \"list\" ] || [ \"$2\" != \"--full-path\" ]; then\n  exit 2\nfi\nprintf \"%s\\n\" \"$MABO_TEST_GHQ_PROJECT\"\n",
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
        .command(env!("CARGO_BIN_EXE_mabo"), &["project", "list", "--json"])
        .env("PATH", &path)
        .env("MABO_TEST_GHQ_PROJECT", &repo.repo)
        .output()
        .expect("list");
    assert!(discovered.status.success(), "{}", text(&discovered.stderr));
    let catalog: serde_json::Value = serde_json::from_str(&text(&discovered.stdout)).expect("json");
    assert_eq!(catalog["schema"], 2);
    assert_eq!(catalog["data"]["projects"][0]["source"], "ghq");
    assert_eq!(
        catalog["data"]["projects"][0]["rootPath"],
        repo.repo.to_string_lossy().as_ref()
    );

    fs::write(
        &ghq,
        "#!/bin/sh\nprintf '%s\\n' 'simulated ghq failure' >&2\nexit 17\n",
    )
    .expect("fail");
    fs::set_permissions(&ghq, perms).expect("chmod");
    let added = repo
        .command(env!("CARGO_BIN_EXE_mabo"), &["project", "add", "--json"])
        .env("PATH", &path)
        .output()
        .expect("add");
    assert!(added.status.success(), "{}", text(&added.stderr));
    let warned = repo
        .command(env!("CARGO_BIN_EXE_mabo"), &["project", "list", "--json"])
        .env("PATH", &path)
        .output()
        .expect("warn");
    assert!(warned.status.success(), "{}", text(&warned.stderr));
    assert!(text(&warned.stdout).contains("\"source\": \"registry\""));
    assert!(json_value(&warned)["warnings"]
        .as_array()
        .is_some_and(|warnings| !warnings.is_empty()));
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
            env!("CARGO_BIN_EXE_mabo"),
            &["create", "copied", "--copy-file", "notes.log"],
        )
        .current_dir(repo.repo.join("nested"))
        .output()
        .expect("mabo");
    assert!(
        created.status.success(),
        "{}\n{}",
        text(&created.stdout),
        text(&created.stderr)
    );
    let worktree = managed(&repo, "copied");
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
    let attached = repo.mabo(&["attach", "attached"]);
    assert!(attached.status.success(), "{}", text(&attached.stderr));
    let attached_path = managed(&repo, "attached");
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
        ".git/maboroshi/worktrees/source",
    ]);
    let source = repo.repo.join(".git/maboroshi/worktrees/source");
    fs::write(source.join("secret.env"), "from-source\n").expect("source env");

    let created = repo
        .command(env!("CARGO_BIN_EXE_mabo"), &["create", "copied"])
        .current_dir(&source)
        .output()
        .expect("mabo");
    assert!(
        created.status.success(),
        "{}\n{}",
        text(&created.stdout),
        text(&created.stderr)
    );
    assert_eq!(
        read_copy(&managed(&repo, "copied/secret.env")),
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
    let output = Command::new(env!("CARGO_BIN_EXE_mabo"))
        .args(["create", "copied", "--copy-file", "*.env"])
        .current_dir(&repo_dir)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("HOME", &home)
        .env("XDG_CONFIG_HOME", home.join(".config"))
        .env("XDG_STATE_HOME", root.join("state"))
        .env("XDG_DATA_HOME", root.join("xdg"))
        .output()
        .expect("mabo");
    assert!(output.status.success(), "{}", text(&output.stderr));
    assert_eq!(
        fs::read_to_string(
            managed_directory(&repo_dir, &root.join("xdg")).join("copied/kept.env"),
        )
        .expect("copied"),
        "kept\n"
    );
    let _ = fs::remove_dir_all(root);
}

#[test]
fn concurrent_project_add_processes_keep_every_record() {
    let repo = Repo::new();
    repo.mabo(&["preferences", "set", "ghq-discovery", "false"]);
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
                env!("CARGO_BIN_EXE_mabo"),
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
    let listed = repo.mabo(&["project", "list", "--names"]);
    assert!(listed.status.success(), "{}", text(&listed.stderr));
    let names = text(&listed.stdout);
    for index in 0..6 {
        assert!(names.contains(&format!("project-{index}")), "{names}");
    }
}

#[test]
fn create_and_attach_exec_export_mabo_env() {
    let repo = Repo::new();
    let script = "printf '%s\\n' \"$MABO\" \"$MABO_NAME\" \"$MABO_PATH\" \"$PTM\" \"$PTM_NAME\" \"$PTM_PATH\" \"$PHANTOM\" \"$PHANTOM_NAME\" \"$PHANTOM_PATH\" > mabo-env.txt";
    let created = repo.mabo(&["create", "feature/env", "--exec", script]);
    assert!(
        created.status.success(),
        "{}\n{}",
        text(&created.stdout),
        text(&created.stderr)
    );
    let worktree = managed(&repo, "feature/env");
    assert_mabo_env(&worktree, "feature/env");

    repo.git(&["branch", "attached-env"]);
    let attached = repo.mabo(&["attach", "attached-env", "--exec", script]);
    assert!(
        attached.status.success(),
        "{}\n{}",
        text(&attached.stdout),
        text(&attached.stderr)
    );
    assert_mabo_env(&managed(&repo, "attached-env"), "attached-env");

    let execed = repo.mabo(&["exec", "feature/env", "--", "sh", "-c", script]);
    assert!(execed.status.success(), "{}", text(&execed.stderr));
    assert_mabo_env(&worktree, "feature/env");
}

fn assert_mabo_env(worktree: &std::path::Path, name: &str) {
    let recorded = fs::read_to_string(worktree.join("mabo-env.txt")).expect("mabo env");
    let mut lines = recorded.lines();
    assert_eq!(lines.next(), Some("1"), "{recorded}");
    assert_eq!(lines.next(), Some(name), "{recorded}");
    assert_eq!(
        lines.next(),
        Some(worktree.to_string_lossy().as_ref()),
        "{recorded}"
    );
    for _ in 0..6 {
        assert_eq!(lines.next(), Some(""), "{recorded}");
    }
}

#[test]
fn parent_cleanup_failure_still_deletes_the_branch() {
    let repo = Repo::new();
    let created = repo.mabo(&["create", "cursor/foo"]);
    assert!(created.status.success(), "{}", text(&created.stderr));
    let root = managed_root(&repo);
    use std::os::unix::fs::PermissionsExt;
    let _reset = ModeReset(&root);
    let mut perms = fs::metadata(&root).expect("meta").permissions();
    perms.set_mode(0o555);
    fs::set_permissions(&root, perms).expect("chmod");

    let deleted = repo.mabo(&["delete", "cursor/foo"]);
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
        let output = repo.mabo(&args);
        assert_eq!(
            output.status.code(),
            Some(2),
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

    let help = repo.mabo(&["--help"]);
    assert!(help.status.success(), "{}", text(&help.stderr));
    assert!(
        !text(&help.stdout).to_ascii_lowercase().contains("mcp"),
        "top-level help should not mention MCP:\n{}",
        text(&help.stdout)
    );

    let preferences = repo.mabo(&["preferences", "--help"]);
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
fn delete_removes_empty_parents_but_keeps_the_project_directory_and_marker() {
    let repo = Repo::new();
    let created = repo.mabo(&["create", "cursor/foo"]);
    assert!(created.status.success(), "{}", text(&created.stderr));
    let project = managed_root(&repo);
    let marker_path = project.join(maboroshi::paths::PROJECT_MARKER);
    let marker = fs::read(&marker_path).expect("marker");
    let ceiling = project.parent().expect("maboroshi/worktrees");
    let parent = project.join("cursor");
    assert!(parent.join("foo").is_dir());
    let deleted = repo.mabo(&["delete", "cursor/foo"]);
    assert!(deleted.status.success(), "{}", text(&deleted.stderr));
    assert!(!parent.join("foo").exists());
    assert!(!parent.exists(), "empty parent directory should be removed");
    assert!(project.is_dir(), "empty project directory should stay");
    assert_eq!(fs::read(&marker_path).expect("retained marker"), marker);
    assert!(ceiling.is_dir(), "maboroshi/worktrees should stay");

    assert!(repo.mabo(&["create", "cursor/foo"]).status.success());
    assert!(repo.mabo(&["create", "cursor/bar"]).status.success());
    assert!(repo.mabo(&["delete", "cursor/foo"]).status.success());
    assert!(parent.join("bar").is_dir());
    assert!(parent.is_dir(), "parent still holds another worktree");
    assert!(project.is_dir(), "project directory still holds a worktree");
    assert!(repo.mabo(&["delete", "cursor/bar"]).status.success());
    assert!(!parent.exists());
    assert!(project.is_dir());
    assert_eq!(fs::read(&marker_path).expect("retained marker"), marker);
    assert!(ceiling.is_dir());

    assert!(repo.mabo(&["create", "a/b/c"]).status.success());
    assert!(repo.mabo(&["delete", "a/b/c"]).status.success());
    assert!(!managed(&repo, "a").exists());
    assert!(ceiling.is_dir());
}

#[test]
fn detached_worktree_keeps_its_directory_name() {
    let repo = Repo::new();
    let worktree = managed(&repo, "next");
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
    let names = repo.mabo(&["list", "--names", "--no-default"]);
    assert!(names.status.success(), "{}", text(&names.stderr));
    assert_eq!(text(&names.stdout), "next");
    let listed = repo.mabo(&["list", "--no-default"]);
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

    let found = repo.mabo(&["where", "next"]);
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
    let names_after = repo.mabo(&["list", "--names", "--no-default"]);
    assert_eq!(text(&names_after.stdout), "next");

    repo.git(&[
        "worktree",
        "add",
        "-b",
        "topic",
        managed(&repo, "alias").to_str().expect("path"),
        "HEAD",
    ]);
    let by_directory = repo.mabo(&["where", "alias"]);
    let by_branch = repo.mabo(&["where", "topic"]);
    let alias = managed(&repo, "alias");
    assert_eq!(text(&by_directory.stdout), alias.to_string_lossy());
    assert_eq!(text(&by_branch.stdout), alias.to_string_lossy());
    let both = repo.mabo(&["list", "--names", "--no-default"]);
    let listed_names = text(&both.stdout);
    assert!(listed_names.contains("next"), "{listed_names}");
    assert!(listed_names.contains("alias"), "{listed_names}");
    assert!(!listed_names.lines().any(|line| line == "topic"));
}

#[test]
fn directory_name_is_preferred_over_another_worktrees_branch() {
    let repo = Repo::new();
    let branch_topic = managed(&repo, "a");
    let directory_topic = managed(&repo, "topic");
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

    let found = repo.mabo(&["where", "topic"]);
    assert_eq!(found.status.code(), Some(0), "{}", text(&found.stderr));
    assert_eq!(
        text(&found.stdout),
        directory_topic.to_string_lossy(),
        "directory name should win over branch topic checked out at a"
    );

    let deleted = repo.mabo(&["delete", "topic", "--keep-branch"]);
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
  printf '%s\n' '{"url":"https://github.com/acme/demo","owner":{"login":"acme"},"name":"demo"}'
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

fn publish_pr_topic(repo: &Repo) {
    let origin = repo.root.join("origin.git");
    let init = repo
        .command(
            "git",
            &[
                "init",
                "--bare",
                "-b",
                "main",
                origin.to_str().expect("origin"),
            ],
        )
        .output()
        .expect("bare");
    assert!(init.status.success(), "{}", text(&init.stderr));
    repo.git(&["remote", "add", "origin", origin.to_str().expect("origin")]);
    repo.git(&["checkout", "-b", "topic"]);
    fs::write(repo.repo.join("topic.txt"), "topic\n").expect("topic");
    repo.git(&["add", "topic.txt"]);
    repo.git(&["commit", "-m", "topic"]);
    repo.git(&["push", "origin", "main", "topic"]);
    repo.git(&["push", "origin", "topic:refs/pull/7/head"]);
    repo.git(&["checkout", "main"]);
    repo.git(&["branch", "-D", "topic"]);
}

fn local_branch(repo: &Repo, name: &str) -> String {
    let listed = repo
        .command("git", &["branch", "--list", name])
        .output()
        .expect("branch");
    assert!(listed.status.success(), "{}", text(&listed.stderr));
    text(&listed.stdout)
}

#[test]
fn pr_checkout_requires_the_branch_not_only_the_directory() {
    let repo = Repo::new();
    let path = fake_gh_for_topic_pr(&repo);
    let directory = managed(&repo, "topic");
    reserve_project_dir(&repo.repo, &repo.root.join("xdg"));
    repo.git(&[
        "worktree",
        "add",
        "-b",
        "other",
        directory.to_str().expect("path"),
        "HEAD",
    ]);
    let output = repo
        .command(env!("CARGO_BIN_EXE_mabo"), &["github", "checkout", "7"])
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
    let checked_out = managed(&matching, "topic");
    matching.git(&[
        "worktree",
        "add",
        "-b",
        "topic",
        checked_out.to_str().expect("path"),
        "HEAD",
    ]);
    let again = matching
        .command(env!("CARGO_BIN_EXE_mabo"), &["github", "checkout", "7"])
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
    let value: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap_or_else(|error| {
        panic!(
            "stdout is not JSON ({error})\n{}\n{}",
            text(&output.stdout),
            text(&output.stderr)
        )
    });
    let command = value["command"].as_str().expect("command");
    assert!(!command.is_empty());
    assert_envelope(output, command)
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
    let empty = repo.mabo(&["list", "--json", "--no-default"]);
    assert!(empty.status.success(), "{}", text(&empty.stderr));
    let empty_json = json_value(&empty);
    assert_eq!(empty_json["schema"], 2);
    assert_eq!(
        empty_json["data"]["worktrees"].as_array().map(Vec::len),
        Some(0)
    );
    assert!(text(&empty.stderr).is_empty(), "{}", text(&empty.stderr));

    let created = repo.mabo(&["create", "feature/json", "--json", "--base", "HEAD"]);
    assert!(created.status.success(), "{}", text(&created.stderr));
    let created_json = json_value(&created);
    assert_eq!(created_json["schema"], 2);
    assert_worktree_object(
        &created_json["data"]["worktree"],
        "feature/json",
        &managed(&repo, "feature/json"),
    );
    assert_eq!(created_json["data"]["worktree"]["branch"], "feature/json");
    assert_eq!(created_json["data"]["worktree"]["head"], head);
    assert_eq!(created_json["data"]["worktree"]["base"], "HEAD");
    assert_eq!(created_json["data"]["worktree"]["dirty"], false);
    assert_eq!(created_json["data"]["worktree"]["detached"], false);
    assert_eq!(created_json["data"]["copyFiles"]["ok"], true);
    assert!(created_json["data"]["copyFiles"]["error"].is_null());
    assert_eq!(created_json["data"]["postCreate"]["ran"], false);
    assert_eq!(created_json["data"]["postCreate"]["ok"], true);
    assert!(created_json["data"]["postCreate"]["command"].is_null());
    assert!(created_json["data"]["postCreate"]["exitCode"].is_null());
    assert!(created_json["data"]["exec"].is_null());
    assert!(!text(&created.stdout).contains("Created worktree"));

    let duplicate = repo.mabo(&["create", "feature/json", "--json"]);
    assert_eq!(duplicate.status.code(), Some(4));
    let duplicate_json = json_value(&duplicate);
    assert_eq!(duplicate_json["error"]["code"], "exists");
    assert!(duplicate_json["error"].get("exitCode").is_none());
    assert!(
        text(&duplicate.stderr).is_empty(),
        "{}",
        text(&duplicate.stderr)
    );

    let both = repo.mabo(&["list", "--json", "--names"]);
    assert_eq!(both.status.code(), Some(2));
    assert_eq!(json_value(&both)["error"]["code"], "usage");

    let listed = repo.mabo(&["list", "--json"]);
    assert!(listed.status.success(), "{}", text(&listed.stderr));
    let listed_json = json_value(&listed);
    let worktrees = listed_json["data"]["worktrees"]
        .as_array()
        .expect("worktrees");
    assert!(worktrees
        .iter()
        .any(|entry| entry["default"] == true && entry["branch"] == "main"));
    let feature = worktrees
        .iter()
        .find(|entry| entry["name"] == "feature/json")
        .expect("feature");
    assert_eq!(feature["head"], head);
    assert_eq!(feature["dirty"], false);
    assert_eq!(feature["base"], "refs/heads/main");

    let worktree = managed(&repo, "feature/json");
    fs::write(worktree.join("README.md"), "dirty\n").expect("dirty");
    let dirty = repo.mabo(&["list", "--json", "--no-default"]);
    let dirty_json = json_value(&dirty);
    assert_eq!(dirty_json["data"]["worktrees"][0]["dirty"], true);
    assert_eq!(
        dirty_json["data"]["worktrees"].as_array().map(Vec::len),
        Some(1)
    );

    let located = repo.mabo(&["where", "feature/json", "--json"]);
    assert!(located.status.success(), "{}", text(&located.stderr));
    let located_json = json_value(&located);
    assert_eq!(located_json["schema"], 2);
    assert_worktree_object(&located_json["data"]["worktree"], "feature/json", &worktree);
    assert!(!text(&located.stdout).contains("feature/json ("));

    let missing = repo.mabo(&["where", "missing-worktree", "--json"]);
    assert_eq!(missing.status.code(), Some(3));
    let missing_json = json_value(&missing);
    assert_eq!(missing_json["schema"], 2);
    assert_eq!(missing_json["error"]["code"], "not_found");
    assert!(missing_json["error"].get("exitCode").is_none());
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
    let attached = repo.mabo(&["attach", "existing-json", "--json"]);
    assert!(attached.status.success(), "{}", text(&attached.stderr));
    let attached_json = json_value(&attached);
    assert_worktree_object(
        &attached_json["data"]["worktree"],
        "existing-json",
        &managed(&repo, "existing-json"),
    );
    assert!(attached_json["data"]["worktree"]["base"].is_null());
    assert_eq!(attached_json["data"]["worktree"]["branch"], "existing-json");
    assert_eq!(attached_json["data"]["copyFiles"]["ok"], true);
    assert!(attached_json["data"]["exec"].is_null());

    let kept = repo.mabo(&["delete", "existing-json", "--keep-branch", "--json"]);
    assert!(kept.status.success(), "{}", text(&kept.stderr));
    let kept_json = json_value(&kept);
    assert!(kept_json["error"].is_null());
    assert_eq!(kept_json["data"]["deleted"][0]["branchDeleted"], false);
    assert!(kept_json["data"]["deleted"][0]["branchError"].is_null());
    assert!(kept_json["data"]["deleted"][0]["error"].is_null());
    assert_eq!(
        kept_json["data"]["deleted"][0]["worktree"]["name"],
        "existing-json"
    );
    let branch = repo
        .command("git", &["branch", "--list", "existing-json"])
        .output()
        .expect("branch");
    assert!(text(&branch.stdout).contains("existing-json"));

    fs::write(worktree.join("README.md"), "# phantom\n").expect("restore");
    repo.git(&["branch", "second-json"]);
    assert!(repo.mabo(&["attach", "second-json"]).status.success());
    let partial = repo.mabo(&["delete", "feature/json", "missing-json", "--json"]);
    assert_eq!(partial.status.code(), Some(3), "{}", text(&partial.stderr));
    let partial_json = json_value(&partial);
    assert_eq!(
        partial_json["data"]["deleted"].as_array().map(Vec::len),
        Some(1)
    );
    assert!(partial_json["data"]["deleted"][0]["worktree"].is_null());
    assert!(partial_json["data"]["deleted"][0]["error"]
        .as_str()
        .unwrap_or("")
        .contains("missing-json"));
    assert_eq!(partial_json["error"]["code"], "not_found");
    assert!(partial_json["error"].get("exitCode").is_none());
    assert!(worktree.is_dir(), "a later refusal deletes nothing");
    assert!(branch_listed(&repo, "feature/json"));

    let outside = repo.root.join("outside");
    fs::create_dir_all(&outside).expect("outside");
    let not_repo = repo
        .command(env!("CARGO_BIN_EXE_mabo"), &["list", "--json"])
        .current_dir(&outside)
        .output()
        .expect("list");
    assert_eq!(not_repo.status.code(), Some(3));
    let not_repo_json = json_value(&not_repo);
    assert_eq!(not_repo_json["error"]["code"], "not_repository");
    assert!(not_repo_json["error"].get("exitCode").is_none());
    assert!(
        text(&not_repo.stderr).is_empty(),
        "{}",
        text(&not_repo.stderr)
    );

    let project_modes = repo.mabo(&["project", "list", "--json", "--names"]);
    assert_eq!(project_modes.status.code(), Some(2));
    assert_eq!(json_value(&project_modes)["error"]["code"], "usage");
    assert_eq!(json_value(&project_modes)["schema"], 2);
}

#[test]
fn json_mode_keeps_hook_and_exec_output_off_stdout() {
    let repo = Repo::new();
    fs::write(
        repo.repo.join(".mabo.toml"),
        "[hooks]\npost-create = [\"echo HOOK_STDOUT_MARKER\"]\npre-delete = [\"echo PRE_DELETE_MARKER\"]\n",
    )
    .expect("hooks");
    let created = repo.mabo(&[
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
    assert_eq!(created_json["data"]["postCreate"]["ran"], true);
    assert_eq!(created_json["data"]["postCreate"]["ok"], true);
    assert_eq!(created_json["data"]["postCreate"]["exitCode"], 0);
    assert_eq!(created_json["data"]["exec"]["ok"], true);
    assert_eq!(created_json["data"]["exec"]["exitCode"], 0);
    assert_eq!(created_json["data"]["exec"]["command"], "echo EXEC_MARKER");

    let deleted = repo.mabo(&["delete", "--force", "feature/hooks-json", "--json"]);
    assert!(deleted.status.success(), "{}", text(&deleted.stderr));
    assert!(!text(&deleted.stdout).contains("PRE_DELETE_MARKER"));
    assert!(text(&deleted.stderr).contains("PRE_DELETE_MARKER"));
    assert_eq!(
        json_value(&deleted)["data"]["deleted"][0]["branchDeleted"],
        true
    );

    fs::write(
        repo.repo.join(".mabo.toml"),
        "[hooks]\npost-create = [\"echo HOOK_FAIL_MARKER\", \"exit 7\"]\n",
    )
    .expect("failing hook");
    let failed = repo.mabo(&["create", "feature/hook-fail", "--json"]);
    assert_eq!(failed.status.code(), Some(6), "{}", text(&failed.stderr));
    let failed_json = json_value(&failed);
    assert_eq!(failed_json["data"]["postCreate"]["ok"], false);
    assert_eq!(failed_json["data"]["postCreate"]["exitCode"], 7);
    assert_eq!(failed_json["data"]["postCreate"]["command"], "exit 7");
    assert_eq!(failed_json["data"]["worktree"]["name"], "feature/hook-fail");
    assert!(!text(&failed.stdout).contains("HOOK_FAIL_MARKER"));
    assert!(text(&failed.stderr).contains("HOOK_FAIL_MARKER"));
    assert!(managed(&repo, "feature/hook-fail/README.md").is_file());

    fs::write(repo.repo.join(".mabo.toml"), "").expect("clear hooks");
    let exec_failed = repo.mabo(&[
        "create",
        "feature/exec-fail",
        "--json",
        "--exec",
        "echo EXEC_FAIL; exit 3",
    ]);
    assert_eq!(exec_failed.status.code(), Some(6));
    let exec_json = json_value(&exec_failed);
    assert_eq!(exec_json["data"]["exec"]["ok"], false);
    assert_eq!(exec_json["data"]["exec"]["exitCode"], 3);
    assert_eq!(exec_json["data"]["worktree"]["branch"], "feature/exec-fail");
    assert!(text(&exec_failed.stderr)
        .lines()
        .any(|line| line == "EXEC_FAIL"));
    assert!(!text(&exec_failed.stderr).contains("failed with exit code"));
}

#[test]
fn json_reports_detached_head_and_copy_errors() {
    let repo = Repo::new();
    let detached = managed(&repo, "next");
    reserve_project_dir(&repo.repo, &repo.root.join("xdg"));
    repo.git(&[
        "worktree",
        "add",
        "--detach",
        detached.to_str().expect("path"),
        "HEAD",
    ]);
    let listed = repo.mabo(&["list", "--json", "--no-default"]);
    assert!(listed.status.success(), "{}", text(&listed.stderr));
    let entry = &json_value(&listed)["data"]["worktrees"][0];
    assert_eq!(entry["name"], "next");
    assert!(entry["branch"].is_null());
    assert_eq!(entry["detached"], true);
    assert_eq!(entry["head"], full_head(&repo));
    assert_eq!(entry["default"], false);

    std::os::unix::fs::symlink("elsewhere", repo.repo.join(".worktreeinclude")).expect("symlink");
    let created = repo.mabo(&["create", "feature/copy", "--json"]);
    assert_eq!(created.status.code(), Some(6), "{}", text(&created.stderr));
    let created_json = json_value(&created);
    assert_eq!(created_json["data"]["copyFiles"]["ok"], false);
    assert!(created_json["data"]["copyFiles"]["error"]
        .as_str()
        .unwrap_or("")
        .contains("symlink"));
    assert_eq!(created_json["data"]["worktree"]["name"], "feature/copy");
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
        let output = repo.mabo(args);
        assert_eq!(
            output.status.code(),
            Some(2),
            "{args:?}\nstdout:\n{}\nstderr:\n{}",
            text(&output.stdout),
            text(&output.stderr)
        );
        if args.contains(&"--json") {
            let value = json_value(&output);
            assert_eq!(value["schema"], 2, "{args:?} {value}");
            assert_eq!(value["error"]["code"], "usage", "{args:?} {value}");
            assert!(value["error"].get("exitCode").is_none(), "{args:?} {value}");
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
    let listed = repo.mabo(&["list", "--json"]);
    assert!(listed.status.success(), "{}", text(&listed.stderr));
    let listed_json = json_value(&listed);
    let worktrees = listed_json["data"]["worktrees"]
        .as_array()
        .expect("worktrees");
    assert_eq!(worktrees.len(), 1, "{listed_json}");
    assert_eq!(worktrees[0]["name"], "main");
    assert_eq!(worktrees[0]["branch"], "main");
    assert_eq!(worktrees[0]["default"], true);
    assert!(
        worktrees[0]["head"].is_null(),
        "unborn HEAD should be null, got {}",
        worktrees[0]["head"]
    );

    let located = repo.mabo(&["where", "main", "--json"]);
    assert!(located.status.success(), "{}", text(&located.stderr));
    let located_json = json_value(&located);
    assert!(
        located_json["data"]["worktree"]["head"].is_null(),
        "{located_json}"
    );
    assert_eq!(located_json["data"]["worktree"]["branch"], "main");
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
        &["clone", "--bogus", "owner/repo"],
        &["clone", "owner/repo", "--json", "--depth"],
    ];
    for args in cases {
        let output = repo.mabo(args);
        assert_eq!(
            output.status.code(),
            Some(2),
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
            assert_eq!(value["error"]["code"], "usage", "{args:?} {value}");
            assert!(value["error"].get("exitCode").is_none(), "{args:?} {value}");
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
        let output = repo.mabo(args);
        assert_eq!(
            output.status.code(),
            Some(2),
            "{args:?}\n{}\n{}",
            text(&output.stdout),
            text(&output.stderr)
        );
        if args.contains(&"--json") {
            let value = json_value(&output);
            assert_eq!(value["error"]["code"], "usage", "{args:?} {value}");
            assert!(value["error"].get("exitCode").is_none(), "{args:?} {value}");
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
    assert!(!managed(&repo, "a/../x").exists());

    let missing_delete = repo.mabo(&["delete", "nope"]);
    assert_eq!(missing_delete.status.code(), Some(3));
    let missing_json = repo.mabo(&["delete", "nope", "--json"]);
    assert_eq!(missing_json.status.code(), Some(3));
    let missing_value = json_value(&missing_json);
    assert_eq!(missing_value["error"]["code"], "not_found");
    assert!(missing_value["error"].get("exitCode").is_none());
    assert_eq!(repo.mabo(&["where", "nope"]).status.code(), Some(3));
    assert_eq!(repo.mabo(&["exec", "nope", "true"]).status.code(), Some(3));
}

#[test]
fn json_exec_signal_and_spawn_failure_return_the_worktree() {
    let repo = Repo::new();
    let signaled = repo.mabo(&["create", "sig", "--json", "--exec", "kill -TERM $$"]);
    assert_eq!(
        signaled.status.code(),
        Some(6),
        "{}\n{}",
        text(&signaled.stdout),
        text(&signaled.stderr)
    );
    let signaled_json = json_value(&signaled);
    assert!(
        signaled_json["error"]["code"] == "partial",
        "{signaled_json}"
    );
    assert_eq!(signaled_json["data"]["worktree"]["name"], "sig");
    assert_eq!(signaled_json["data"]["exec"]["ok"], false);
    assert_eq!(signaled_json["data"]["exec"]["command"], "kill -TERM $$");
    assert_eq!(signaled_json["data"]["exec"]["exitCode"], 143);
    assert_eq!(signaled_json["data"]["exec"]["signal"], "SIGTERM");
    assert!(signaled_json["data"]["exec"]["error"].is_null());
    assert!(managed(&repo, "sig/README.md").is_file());

    repo.git(&["branch", "attach-sig"]);
    let attached = repo.mabo(&["attach", "attach-sig", "--json", "--exec", "kill -TERM $$"]);
    assert_eq!(
        attached.status.code(),
        Some(6),
        "{}",
        text(&attached.stderr)
    );
    let attached_json = json_value(&attached);
    assert_eq!(attached_json["data"]["worktree"]["name"], "attach-sig");
    assert_eq!(attached_json["data"]["exec"]["ok"], false);
    assert_eq!(attached_json["data"]["exec"]["signal"], "SIGTERM");
    assert!(
        attached_json["error"]["code"] == "partial",
        "{attached_json}"
    );

    let human = repo.mabo(&["create", "sig-human", "--exec", "kill -TERM $$"]);
    assert_eq!(human.status.code(), Some(6));
    assert!(text(&human.stdout).contains("Created worktree 'sig-human'"));
    assert!(text(&human.stderr).contains("SIGTERM"));

    let spawned = repo
        .command(
            env!("CARGO_BIN_EXE_mabo"),
            &["create", "spawn", "--json", "--exec", "true"],
        )
        .env("SHELL", "/no/such/maboroshi-shell")
        .output()
        .expect("spawn");
    assert_eq!(
        spawned.status.code(),
        Some(6),
        "{}\n{}",
        text(&spawned.stdout),
        text(&spawned.stderr)
    );
    let spawned_json = json_value(&spawned);
    assert!(spawned_json["error"]["code"] == "partial", "{spawned_json}");
    assert_eq!(spawned_json["data"]["worktree"]["name"], "spawn");
    assert_eq!(spawned_json["data"]["exec"]["ok"], false);
    assert_eq!(spawned_json["data"]["exec"]["exitCode"], 1);
    assert!(spawned_json["data"]["exec"]["signal"].is_null());
    let spawn_error = spawned_json["data"]["exec"]["error"].as_str().unwrap_or("");
    assert!(
        spawn_error.contains("ENOENT") && spawn_error.contains("/no/such/maboroshi-shell"),
        "{spawn_error}"
    );
    assert!(managed(&repo, "spawn/README.md").is_file());

    repo.git(&["branch", "attach-spawn"]);
    let attach_spawn = repo
        .command(
            env!("CARGO_BIN_EXE_mabo"),
            &["attach", "attach-spawn", "--json", "--exec", "true"],
        )
        .env("SHELL", "/no/such/maboroshi-shell")
        .output()
        .expect("attach spawn");
    assert_eq!(attach_spawn.status.code(), Some(6));
    let attach_json = json_value(&attach_spawn);
    assert_eq!(attach_json["data"]["worktree"]["name"], "attach-spawn");
    assert_eq!(attach_json["data"]["exec"]["ok"], false);
    assert!(attach_json["data"]["exec"]["error"]
        .as_str()
        .unwrap_or("")
        .contains("ENOENT"));
    assert!(attach_json["error"]["code"] == "partial", "{attach_json}");

    let interrupted = repo.mabo(&["create", "sigint", "--json", "--exec", "kill -INT $$"]);
    assert_eq!(
        interrupted.status.code(),
        Some(6),
        "{}\n{}",
        text(&interrupted.stdout),
        text(&interrupted.stderr)
    );
    let interrupted_json = json_value(&interrupted);
    assert_eq!(interrupted_json["data"]["exec"]["signal"], "SIGINT");
    assert_eq!(interrupted_json["data"]["exec"]["exitCode"], 130);
    assert!(
        interrupted_json["error"]["code"] == "partial",
        "{interrupted_json}"
    );
}

#[test]
fn json_post_create_signal_and_spawn_return_the_worktree() {
    let repo = Repo::new();
    fs::write(
        repo.repo.join(".mabo.toml"),
        "[hooks]\npost-create = [\"kill -TERM $$\"]\n",
    )
    .expect("hooks");
    let created = repo.mabo(&["create", "h", "--json"]);
    assert_eq!(
        created.status.code(),
        Some(6),
        "{}\n{}",
        text(&created.stdout),
        text(&created.stderr)
    );
    let created_json = json_value(&created);
    assert!(created_json["error"]["code"] == "partial", "{created_json}");
    assert_eq!(created_json["data"]["worktree"]["name"], "h");
    assert_eq!(created_json["data"]["postCreate"]["ok"], false);
    assert_eq!(
        created_json["data"]["postCreate"]["command"],
        "kill -TERM $$"
    );
    assert_eq!(created_json["data"]["postCreate"]["exitCode"], 143);
    assert_eq!(created_json["data"]["postCreate"]["signal"], "SIGTERM");
    assert!(created_json["data"]["postCreate"]["error"].is_null());
    assert!(managed(&repo, "h/README.md").is_file());

    repo.git(&["branch", "attach-hook"]);
    let attached = repo.mabo(&["attach", "attach-hook", "--json"]);
    assert_eq!(
        attached.status.code(),
        Some(6),
        "{}",
        text(&attached.stderr)
    );
    let attached_json = json_value(&attached);
    assert!(
        attached_json["error"]["code"] == "partial",
        "{attached_json}"
    );
    assert_eq!(attached_json["data"]["worktree"]["name"], "attach-hook");
    assert_eq!(attached_json["data"]["postCreate"]["ok"], false);
    assert_eq!(attached_json["data"]["postCreate"]["signal"], "SIGTERM");
    assert_eq!(attached_json["data"]["postCreate"]["exitCode"], 143);

    fs::write(
        repo.repo.join(".mabo.toml"),
        "[hooks]\npost-create = [\"true\"]\n",
    )
    .expect("spawn hook");
    let spawned = repo
        .command(
            env!("CARGO_BIN_EXE_mabo"),
            &["create", "hook-spawn", "--json"],
        )
        .env("SHELL", "/nonexistent")
        .output()
        .expect("hook spawn");
    assert_eq!(
        spawned.status.code(),
        Some(6),
        "{}\n{}",
        text(&spawned.stdout),
        text(&spawned.stderr)
    );
    let spawned_json = json_value(&spawned);
    assert!(spawned_json["error"]["code"] == "partial", "{spawned_json}");
    assert_eq!(spawned_json["data"]["worktree"]["name"], "hook-spawn");
    assert_eq!(spawned_json["data"]["postCreate"]["ok"], false);
    assert_eq!(spawned_json["data"]["postCreate"]["exitCode"], 1);
    assert!(spawned_json["data"]["postCreate"]["signal"].is_null());
    let spawn_error = spawned_json["data"]["postCreate"]["error"]
        .as_str()
        .unwrap_or("");
    assert!(
        spawn_error.contains("ENOENT") && spawn_error.contains("/nonexistent"),
        "{spawn_error}"
    );
    assert!(managed(&repo, "hook-spawn/README.md").is_file());

    repo.git(&["branch", "attach-hook-spawn"]);
    let attach_spawn = repo
        .command(
            env!("CARGO_BIN_EXE_mabo"),
            &["attach", "attach-hook-spawn", "--json"],
        )
        .env("SHELL", "/nonexistent")
        .output()
        .expect("attach hook spawn");
    assert_eq!(attach_spawn.status.code(), Some(6));
    let attach_json = json_value(&attach_spawn);
    assert_eq!(attach_json["data"]["postCreate"]["ok"], false);
    assert!(attach_json["data"]["postCreate"]["error"]
        .as_str()
        .unwrap_or("")
        .contains("ENOENT"));
    assert!(attach_json["error"]["code"] == "partial", "{attach_json}");
    assert!(managed(&repo, "attach-hook-spawn/README.md").is_file());

    fs::write(
        repo.repo.join(".mabo.toml"),
        "[hooks]\npre-delete = [\"kill -TERM $$\"]\n",
    )
    .expect("pre-delete signal");
    let deleted = repo.mabo(&["delete", "--force", "h", "--json"]);
    assert_eq!(
        deleted.status.code(),
        Some(1),
        "{}\n{}",
        text(&deleted.stdout),
        text(&deleted.stderr)
    );
    let deleted_json = json_value(&deleted);
    assert_eq!(deleted_json["error"]["code"], "signaled");
    assert!(deleted_json["error"].get("exitCode").is_none());
    assert_eq!(deleted_json["data"]["deleted"][0]["worktree"]["name"], "h");
    assert!(paths_match(
        deleted_json["data"]["deleted"][0]["worktree"]["path"]
            .as_str()
            .unwrap_or(""),
        &managed(&repo, "h")
    ));
    assert!(managed(&repo, "h").is_dir());

    fs::write(
        repo.repo.join(".mabo.toml"),
        "[hooks]\npre-delete = [\"true\"]\n",
    )
    .expect("pre-delete spawn");
    let pre_spawn = repo
        .command(
            env!("CARGO_BIN_EXE_mabo"),
            &["delete", "--force", "attach-hook", "--json"],
        )
        .env("SHELL", "/nonexistent")
        .output()
        .expect("pre-delete spawn");
    assert_eq!(pre_spawn.status.code(), Some(1));
    let pre_json = json_value(&pre_spawn);
    assert_eq!(pre_json["error"]["code"], "spawn");
    assert!(pre_json["error"].get("exitCode").is_none());
    assert_eq!(
        pre_json["data"]["deleted"][0]["worktree"]["name"],
        "attach-hook"
    );
    assert!(paths_match(
        pre_json["data"]["deleted"][0]["worktree"]["path"]
            .as_str()
            .unwrap_or(""),
        &managed(&repo, "attach-hook")
    ));
    assert!(managed(&repo, "attach-hook").is_dir());
}

#[test]
fn detached_exec_resolves_the_created_path_when_names_are_flattened() {
    let repo = Repo::new();
    let set = repo.mabo(&["preferences", "set", "directory-name-separator", "-"]);
    assert!(set.status.success(), "{}", text(&set.stderr));

    let created = repo.mabo(&[
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
    let directory = managed(&repo, "feature-topic");
    assert!(directory.join("README.md").is_file());
    let abbrev = repo
        .command("git", &["rev-parse", "--abbrev-ref", "HEAD"])
        .current_dir(&directory)
        .output()
        .expect("abbrev");
    assert_eq!(text(&abbrev.stdout), "HEAD");

    let json_created = repo.mabo(&[
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
        json_value_created["error"].is_null(),
        "{json_value_created}"
    );
    assert_eq!(json_value_created["data"]["exec"]["ok"], true);
    assert_eq!(
        json_value_created["data"]["worktree"]["name"],
        "feature-json-topic"
    );
    assert_eq!(json_value_created["data"]["worktree"]["detached"], true);
    assert!(json_value_created["data"]["worktree"]["branch"].is_null());
    assert!(paths_match(
        json_value_created["data"]["worktree"]["path"]
            .as_str()
            .unwrap_or(""),
        &managed(&repo, "feature-json-topic")
    ));

    repo.git(&["branch", "feature/attached"]);
    let attached = repo.mabo(&[
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
    assert!(attached_json["error"].is_null(), "{attached_json}");
    assert_eq!(
        attached_json["data"]["worktree"]["name"],
        "feature-attached"
    );
    assert_eq!(attached_json["data"]["worktree"]["detached"], true);
    assert!(paths_match(
        attached_json["data"]["worktree"]["path"]
            .as_str()
            .unwrap_or(""),
        &managed(&repo, "feature-attached")
    ));

    fs::write(
        repo.repo.join(".mabo.toml"),
        "[hooks]\npost-create = [\"git checkout -q --detach\"]\n",
    )
    .expect("detach hook");
    let bin = repo.root.join("bin");
    fs::create_dir_all(&bin).expect("bin");
    let gh = bin.join("gh");
    fs::write(
        &gh,
        "#!/bin/sh\nif [ \"$1\" = \"repo\" ]; then\n  printf '%s\\n' '{\"url\":\"https://github.com/acme/demo\",\"owner\":{\"login\":\"acme\"},\"name\":\"demo\"}'\n  exit 0\nfi\nprintf '%s\\n' '{\"number\":7}'\nexit 0\n",
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
            env!("CARGO_BIN_EXE_mabo"),
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
    assert!(checkout_json["error"].is_null(), "{checkout_json}");
    assert_eq!(checkout_json["data"]["worktree"]["name"], "issues-7");
    assert_eq!(checkout_json["data"]["worktree"]["detached"], true);
    assert_eq!(checkout_json["data"]["postCreate"]["ok"], true);
    assert!(paths_match(
        checkout_json["data"]["worktree"]["path"]
            .as_str()
            .unwrap_or(""),
        &managed(&repo, "issues-7")
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
        "#!/bin/sh\nif [ \"$1\" = \"repo\" ]; then\n  printf '%s\\n' '{\"url\":\"https://github.com/acme/demo\",\"owner\":{\"login\":\"acme\"},\"name\":\"demo\"}'\n  exit 0\nfi\nprintf '%s\\n' '{\"number\":7}'\nexit 0\n",
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
            env!("CARGO_BIN_EXE_mabo"),
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
    assert_eq!(checkout_json["schema"], 2);
    assert_eq!(checkout_json["data"]["github"]["kind"], "issue");
    assert_eq!(checkout_json["data"]["github"]["number"], 7);
    assert!(checkout_json["data"]["github"]["headRef"].is_null());
    assert_eq!(checkout_json["data"]["github"]["alreadyExists"], false);
    assert_worktree_object(
        &checkout_json["data"]["worktree"],
        "issues/7",
        &managed(&repo, "issues/7"),
    );
    assert_eq!(checkout_json["data"]["worktree"]["branch"], "issues/7");
    assert_eq!(checkout_json["data"]["worktree"]["base"], "HEAD");
    assert_eq!(
        checkout_json["data"]["worktree"]["links"]["issue"]["number"],
        7
    );
    assert_eq!(
        checkout_json["data"]["worktree"]["links"]["issue"]["url"],
        "https://github.com/acme/demo/issues/7"
    );
    assert!(checkout_json["data"]["worktree"]["links"]["pr"].is_null());
    assert!(checkout_json["data"]["worktree"]["createdAt"].is_string());
    assert!(!text(&checkout.stdout).contains("Created worktree"));

    let missing = repo
        .command(
            env!("CARGO_BIN_EXE_mabo"),
            &["github", "checkout", "--json"],
        )
        .env("PATH", &path)
        .output()
        .expect("missing");
    assert_eq!(missing.status.code(), Some(2));
    assert_eq!(json_value(&missing)["error"]["code"], "usage");

    let matching = Repo::new();
    let matching_path = fake_gh_for_topic_pr(&matching);
    let checked_out = managed(&matching, "topic");
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
            env!("CARGO_BIN_EXE_mabo"),
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
    assert_eq!(again_json["data"]["github"]["kind"], "pullRequest");
    assert_eq!(again_json["data"]["github"]["number"], 7);
    assert_eq!(again_json["data"]["github"]["headRef"], "topic");
    assert_eq!(again_json["data"]["github"]["alreadyExists"], true);
    assert!(again_json["data"]["worktree"]["base"].is_null());
    assert_eq!(again_json["data"]["postCreate"]["ran"], false);
    assert_worktree_object(&again_json["data"]["worktree"], "topic", &checked_out);
    assert_eq!(again_json["data"]["worktree"]["links"]["pr"]["number"], 7);
    assert_eq!(
        again_json["data"]["worktree"]["links"]["pr"]["url"],
        "https://github.com/acme/demo/pull/7"
    );
    assert!(again_json["data"]["worktree"]["links"]["issue"].is_null());
    assert!(!text(&again.stdout).contains("already checked out"));
}

#[test]
fn exec_passes_command_options_through() {
    let repo = Repo::new();
    let created = repo.mabo(&["create", "feature/exec-flags"]);
    assert!(created.status.success(), "{}", text(&created.stderr));

    let direct = repo.mabo(&[
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

    let separated = repo.mabo(&[
        "exec",
        "feature/exec-flags",
        "--",
        "git",
        "branch",
        "--show-current",
    ]);
    assert!(separated.status.success(), "{}", text(&separated.stderr));
    assert_eq!(text(&separated.stdout), "feature/exec-flags");

    let nested = repo.mabo(&[
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
    assert!(!text(&nested.stdout).contains("mabo exec <worktree-name>"));

    let help = repo.mabo(&["exec", "--help"]);
    assert!(help.status.success(), "{}", text(&help.stderr));
    assert!(text(&help.stdout)
        .contains("mabo exec [--project <ref>] <worktree-name> <command> [args...]"));

    let early = repo.mabo(&["exec", "--show-current", "feature/exec-flags", "true"]);
    assert_eq!(early.status.code(), Some(2));
    assert!(text(&early.stderr).contains("Unknown option '--show-current'"));
}

#[test]
fn exec_help_skips_output_values_and_preserves_child_help() {
    let repo = Repo::new();
    for args in [
        vec!["--output", "text", "exec", "--help"],
        vec!["exec", "--output", "text", "--help"],
        vec!["--output=text", "exec", "--help"],
        vec!["exec", "--output=text", "--help"],
    ] {
        let out = repo.mabo(&args);
        assert!(out.status.success(), "{args:?}: {}", text(&out.stderr));
        assert!(text(&out.stdout)
            .contains("mabo exec [--project <ref>] <worktree-name> <command> [args...]"));
        assert!(out.stderr.is_empty());
    }
    let value = repo.mabo(&["exec", "--output", "--help"]);
    assert_eq!(value.status.code(), Some(2));
    assert!(text(&value.stderr).contains("Invalid output mode"));

    for prefix in [
        vec!["exec"],
        vec!["--output", "text", "exec"],
        vec!["exec", "--output", "text"],
    ] {
        for separator in [false, true] {
            let mut args = prefix.clone();
            args.push("main");
            if separator {
                args.push("--");
            }
            args.extend(["printf", "%s", "--help"]);
            let out = repo.mabo(&args);
            assert!(out.status.success(), "{args:?}: {}", text(&out.stderr));
            assert_eq!(text(&out.stdout), "--help", "{args:?}");
            assert!(out.stderr.is_empty());
        }
    }
}

#[test]
fn create_and_attach_exec_pass_command_options_through() {
    let repo = Repo::new();
    let created = repo.mabo(&[
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

    let env_exec = repo.mabo(&[
        "create",
        "feature/exec-env-args",
        "--exec",
        "sh",
        "-c",
        "printf '%s\\n' \"$MABO_NAME\"",
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

    let short = repo.mabo(&[
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

    let missing = repo.mabo(&["create", "feature/missing-exec", "--exec"]);
    assert_eq!(missing.status.code(), Some(2));
    assert!(text(&missing.stderr).contains("Option '--exec <value>' argument missing"));

    repo.git(&["branch", "attached-exec-flags"]);
    let attached = repo.mabo(&[
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

    let help_arg = repo.mabo(&[
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
    assert!(!text(&help_arg.stdout).contains("mabo create [name]"));

    let option_after = repo.mabo(&[
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

    let created = repo.mabo(&["create", "a", "--exec=echo", "--exec=true"]);
    assert_eq!(created.status.code(), Some(2), "{}", text(&created.stderr));
    assert!(
        text(&created.stderr).contains(message),
        "{}",
        text(&created.stderr)
    );
    assert_eq!(text(&created.stdout), "");
    assert!(!managed(&repo, "a").exists());

    let quoted = repo.mabo(&["create", "b", "--exec=echo one", "--exec=echo two"]);
    assert_eq!(quoted.status.code(), Some(2), "{}", text(&quoted.stderr));
    assert!(
        text(&quoted.stderr).contains(message),
        "{}",
        text(&quoted.stderr)
    );
    assert!(!managed(&repo, "b").exists());

    let mixed = repo.mabo(&["create", "c", "-xecho", "--exec=true"]);
    assert_eq!(mixed.status.code(), Some(2), "{}", text(&mixed.stderr));
    assert!(text(&mixed.stderr).contains(message));

    repo.git(&["branch", "attached-repeat"]);
    let attached = repo.mabo(&["attach", "attached-repeat", "--exec=echo", "--exec=true"]);
    assert_eq!(
        attached.status.code(),
        Some(2),
        "{}",
        text(&attached.stderr)
    );
    assert!(
        text(&attached.stderr).contains(message),
        "{}",
        text(&attached.stderr)
    );
    assert_eq!(text(&attached.stdout), "");
    assert!(!managed(&repo, "attached-repeat").exists());

    let attached_short = repo.mabo(&["attach", "attached-repeat", "-xecho", "-xtrue"]);
    assert_eq!(
        attached_short.status.code(),
        Some(2),
        "{}",
        text(&attached_short.stderr)
    );
    assert!(text(&attached_short.stderr).contains(message));

    let trailing = repo.mabo(&["create", "kept", "--exec", "echo", "--exec"]);
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
        repo.mabo(&["attach", "attached-repeat", "--exec", "echo", "--exec=true"]);
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
    let created = repo.mabo(&["create", "feature/exec"]);
    assert!(created.status.success(), "{}", text(&created.stderr));
    let output = repo.mabo(&["exec", "feature/exec", "--", "sh", "-c", "exit 4"]);
    assert_eq!(output.status.code(), Some(4));
    assert!(text(&output.stderr).contains("failed with exit code 4"));
}

#[test]
fn clone_registration_failure_preserves_completed_clone_and_fetch_results() {
    for json in [false, true] {
        let repo = Repo::new();
        let bare = repo.root.join("bare.git");
        repo.git(&[
            "clone",
            "--bare",
            repo.repo.to_str().expect("repo"),
            bare.to_str().expect("bare"),
        ]);
        let root = repo.root.join("clones");
        assert!(repo
            .mabo(&["preferences", "set", "root", root.to_str().expect("root")])
            .status
            .success());
        append_instead_of(&repo, &bare, "https://github.com/example/widget.git");

        // A file at the records-directory path prevents registration writes,
        // including when tests run as a user that can bypass Unix permissions.
        let registry = repo.root.join("state/maboroshi/repos");
        fs::create_dir_all(registry.parent().expect("state dir")).expect("state dir");
        fs::write(&registry, "blocked registry\n").expect("block registry");
        let destination = root.join("github.com/example/widget");
        for (update, cloned, updated, status) in [
            (false, true, false, 6),
            (true, false, true, 6),
            (false, false, false, 1),
        ] {
            if update {
                repo.git(&["commit", "--allow-empty", "-m", "advance origin"]);
                repo.git(&["push", bare.to_str().expect("bare"), "main"]);
            }
            let mut args = vec!["clone", "example/widget"];
            if update {
                args.push("--update");
            }
            if json {
                args.push("--json");
            }
            let output = repo.mabo(&args);
            assert_eq!(
                output.status.code(),
                Some(status),
                "{} {}",
                text(&output.stdout),
                text(&output.stderr)
            );
            assert!(destination.join(".git").is_dir());
            assert_eq!(
                fs::read_to_string(&registry).expect("registry"),
                "blocked registry\n"
            );
            if json {
                let value = json_value(&output);
                assert_eq!(value["schema"], 2);
                assert_eq!(value["command"], "clone");
                assert_eq!(value["ok"], false);
                assert_eq!(
                    value["error"]["code"],
                    if status == 6 { "partial" } else { "failed" }
                );
                assert!(value["error"]["message"]
                    .as_str()
                    .expect("message")
                    .contains("register"));
                assert_eq!(
                    value["data"]["path"],
                    canonical(&destination).to_string_lossy().as_ref()
                );
                assert_eq!(value["data"]["host"], "github.com");
                assert_eq!(value["data"]["owner"], "example");
                assert_eq!(value["data"]["repo"], "widget");
                assert_eq!(
                    value["data"]["remoteUrl"],
                    "https://github.com/example/widget.git"
                );
                assert_eq!(value["data"]["cloned"], cloned);
                assert_eq!(value["data"]["updated"], updated);
            } else {
                assert!(text(&output.stdout).contains(destination.to_str().expect("path")));
                assert!(text(&output.stderr).contains("register"));
            }
            if update {
                let fetched = repo
                    .command("git", &["rev-parse", "refs/remotes/origin/main"])
                    .current_dir(&destination)
                    .output()
                    .expect("fetched ref");
                let origin = repo
                    .command("git", &["rev-parse", "HEAD"])
                    .output()
                    .expect("origin ref");
                assert!(fetched.status.success());
                assert_eq!(text(&fetched.stdout), text(&origin.stdout));
            }
        }
        fs::remove_file(&registry).expect("unblock registry");
        let retried = repo.mabo(&["clone", "example/widget", "--json"]);
        assert!(retried.status.success(), "{}", text(&retried.stderr));
        let value = json_value(&retried);
        assert_eq!(value["data"]["cloned"], false);
        assert_eq!(value["data"]["updated"], false);
        assert_eq!(fs::read_dir(&registry).expect("registered").count(), 1);
    }
}

#[test]
fn clone_from_a_local_bare_repo_is_idempotent_and_json() {
    let repo = Repo::new();
    repo.git(&["branch", "feature"]);
    let bare = repo.root.join("bare.git");
    repo.git(&[
        "clone",
        "--bare",
        repo.repo.to_str().expect("repo"),
        bare.to_str().expect("bare"),
    ]);
    let root = repo.root.join("clones");
    let set = repo.mabo(&["preferences", "set", "root", root.to_str().expect("root")]);
    assert!(set.status.success(), "{}", text(&set.stderr));
    append_instead_of(&repo, &bare, "https://github.com/example/widget.git");

    let help = repo.mabo(&["clone", "--help"]);
    assert!(help.status.success(), "{}", text(&help.stderr));
    let help_text = text(&help.stdout);
    assert!(help_text.contains("mabo clone"));
    assert!(help_text.contains("--update"));
    assert!(help_text.contains("--branch <value>"));
    assert!(help_text.contains("~/ghq"));

    let missing = repo.mabo(&["clone", "--json"]);
    assert_eq!(missing.status.code(), Some(2));
    let missing_json: serde_json::Value =
        serde_json::from_str(&text(&missing.stdout)).expect("usage json");
    assert_eq!(missing_json["schema"], 2);
    assert_eq!(missing_json["error"]["code"], "usage");
    assert!(missing_json["error"].get("exitCode").is_none());

    let bad_depth = repo.mabo(&["clone", "example/widget", "--depth", "0", "--json"]);
    assert_eq!(
        bad_depth.status.code(),
        Some(2),
        "{}",
        text(&bad_depth.stdout)
    );
    let bad_depth_json: serde_json::Value =
        serde_json::from_str(&text(&bad_depth.stdout)).expect("depth json");
    assert_eq!(bad_depth_json["error"]["code"], "usage");

    let bad_url = repo.mabo(&["clone", "not a repo", "--json"]);
    assert_eq!(bad_url.status.code(), Some(2));
    let bad_url_json: serde_json::Value =
        serde_json::from_str(&text(&bad_url.stdout)).expect("url json");
    assert_eq!(bad_url_json["error"]["code"], "usage");
    assert!(bad_url_json["error"]["message"]
        .as_str()
        .unwrap_or_default()
        .contains("not a repo"));

    let cloned = repo.mabo(&[
        "clone",
        "example/widget",
        "--branch",
        "feature",
        "--depth",
        "1",
        "--json",
    ]);
    assert!(
        cloned.status.success(),
        "{}\n{}",
        text(&cloned.stdout),
        text(&cloned.stderr)
    );
    assert!(
        text(&cloned.stderr).contains("Cloning into"),
        "git progress should stay on stderr: {}",
        text(&cloned.stderr)
    );
    assert!(!text(&cloned.stdout).contains("Cloning into"));
    let value: serde_json::Value = serde_json::from_str(&text(&cloned.stdout)).expect("clone json");
    let destination = canonical(&root.join("github.com/example/widget"));
    assert_eq!(value["schema"], 2);
    assert_eq!(
        value["data"]["path"],
        destination.to_string_lossy().as_ref()
    );
    assert_eq!(value["data"]["host"], "github.com");
    assert_eq!(value["data"]["owner"], "example");
    assert_eq!(value["data"]["repo"], "widget");
    assert_eq!(
        value["data"]["remoteUrl"],
        "https://github.com/example/widget.git"
    );
    assert_eq!(value["data"]["cloned"], true);
    assert_eq!(value["data"]["updated"], false);
    assert!(value.get("project").is_none());
    let branch = repo
        .command("git", &["branch", "--show-current"])
        .current_dir(&destination)
        .output()
        .expect("branch");
    assert_eq!(text(&branch.stdout), "feature");
    let shallow = repo
        .command("git", &["rev-parse", "--is-shallow-repository"])
        .current_dir(&destination)
        .output()
        .expect("shallow");
    assert_eq!(text(&shallow.stdout), "true");

    fs::write(destination.join("local.txt"), "keep\n").expect("marker");
    let again = repo.mabo(&["clone", "git@github.com:example/widget.git"]);
    assert!(again.status.success(), "{}", text(&again.stderr));
    let again_text = text(&again.stdout);
    assert!(
        again_text.contains(&destination.to_string_lossy().to_string()),
        "{again_text}"
    );
    assert!(again_text.contains("Already cloned"), "{again_text}");
    assert_eq!(
        fs::read_to_string(destination.join("local.txt")).expect("marker"),
        "keep\n"
    );
    let listed = repo.mabo(&["project", "list", "--json"]);
    assert!(listed.status.success(), "{}", text(&listed.stderr));
    let catalog: serde_json::Value = serde_json::from_str(&text(&listed.stdout)).expect("catalog");
    let registered = catalog["data"]["projects"]
        .as_array()
        .expect("projects")
        .iter()
        .find(|project| project["rootPath"] == value["data"]["path"])
        .expect("registered project");
    assert_eq!(registered["source"], "registry");
    assert_eq!(registered["name"], "widget");
    assert_eq!(registered["canonicalName"], "github.com/example/widget");

    let updated = repo.mabo(&[
        "clone",
        "https://github.com/example/widget.git",
        "--update",
        "--json",
    ]);
    assert!(
        updated.status.success(),
        "{}\n{}",
        text(&updated.stdout),
        text(&updated.stderr)
    );
    let updated_json: serde_json::Value =
        serde_json::from_str(&text(&updated.stdout)).expect("update json");
    assert_eq!(updated_json["data"]["cloned"], false);
    assert_eq!(updated_json["data"]["updated"], true);
    assert_eq!(updated_json["data"]["path"], value["data"]["path"]);
    assert_eq!(
        fs::read_to_string(destination.join("local.txt")).expect("marker"),
        "keep\n"
    );

    let created = repo
        .command(env!("CARGO_BIN_EXE_mabo"), &["create", "topic"])
        .current_dir(&destination)
        .output()
        .expect("worktree");
    assert!(
        created.status.success(),
        "{}\n{}",
        text(&created.stdout),
        text(&created.stderr)
    );
    assert!(managed_directory(&destination, &repo.root.join("xdg"))
        .join("topic")
        .is_dir());

    let mismatch_path = root.join("github.com/example/other");
    fs::create_dir_all(&mismatch_path).expect("mismatch dir");
    let init = repo
        .command("git", &["init", "-b", "main"])
        .current_dir(&mismatch_path)
        .output()
        .expect("init");
    assert!(init.status.success(), "{}", text(&init.stderr));
    let remote = repo
        .command(
            "git",
            &[
                "remote",
                "add",
                "origin",
                "https://github.com/example/different.git",
            ],
        )
        .current_dir(&mismatch_path)
        .output()
        .expect("remote");
    assert!(remote.status.success(), "{}", text(&remote.stderr));
    let mismatch = repo.mabo(&["clone", "example/other", "--json"]);
    assert_eq!(
        mismatch.status.code(),
        Some(2),
        "{}\n{}",
        text(&mismatch.stdout),
        text(&mismatch.stderr)
    );
    let mismatch_json: serde_json::Value =
        serde_json::from_str(&text(&mismatch.stdout)).expect("mismatch json");
    assert_eq!(mismatch_json["schema"], 2);
    assert_eq!(mismatch_json["error"]["code"], "usage");
    assert!(mismatch_json["error"].get("exitCode").is_none());
    let message = mismatch_json["error"]["message"]
        .as_str()
        .unwrap_or_default();
    assert!(message.contains("does not match"), "{message}");
    assert!(message.contains("different.git"), "{message}");

    let empty = root.join("github.com/example/empty");
    fs::create_dir_all(&empty).expect("empty");
    let not_repo = repo.mabo(&["clone", "example/empty"]);
    assert_eq!(
        not_repo.status.code(),
        Some(2),
        "{}",
        text(&not_repo.stderr)
    );
    assert!(text(&not_repo.stderr).contains("not a Git repository"));

    let removed = repo.mabo(&["project", "remove", "widget"]);
    assert!(removed.status.success(), "{}", text(&removed.stderr));
    let discovered = repo.mabo(&["project", "list", "--json"]);
    assert!(discovered.status.success(), "{}", text(&discovered.stderr));
    let discovered_json: serde_json::Value =
        serde_json::from_str(&text(&discovered.stdout)).expect("discovered");
    let found = discovered_json["data"]["projects"]
        .as_array()
        .expect("projects")
        .iter()
        .find(|project| project["rootPath"] == value["data"]["path"])
        .expect("scanned project");
    assert_eq!(found["source"], "ghq");
}

#[test]
fn clone_root_resolution_order() {
    let repo = Repo::new();
    let bare = repo.root.join("bare.git");
    repo.git(&[
        "clone",
        "--bare",
        repo.repo.to_str().expect("repo"),
        bare.to_str().expect("bare"),
    ]);
    append_instead_of(&repo, &bare, "https://github.com/example/widget.git");

    let config_root = repo.root.join("from-config");
    let git_root = repo.home.join("from-git");
    let second_root = repo.root.join("second-root");
    let env_root = repo.root.join("from-env");
    let default_root = repo.home.join("ghq");
    let invalid = repo.mabo(&["preferences", "set", "root", "relative/path"]);
    assert_eq!(invalid.status.code(), Some(2), "{}", text(&invalid.stderr));
    assert!(text(&invalid.stderr).contains("absolute"));
    let set = repo.mabo(&[
        "preferences",
        "set",
        "root",
        config_root.to_str().expect("config root"),
    ]);
    assert!(set.status.success(), "{}", text(&set.stderr));
    repo.git(&["config", "--global", "--add", "ghq.root", "~/from-git"]);
    repo.git(&[
        "config",
        "--global",
        "--add",
        "ghq.root",
        second_root.to_str().expect("second"),
    ]);

    let first = clone_widget(&repo, Some(&env_root));
    assert_clone_landed(&first, &config_root);
    assert!(!git_root.join("github.com/example/widget").exists());
    assert!(!env_root.join("github.com/example/widget").exists());
    assert!(!second_root.join("github.com/example/widget").exists());

    let removed = repo.mabo(&["preferences", "remove", "root"]);
    assert!(removed.status.success(), "{}", text(&removed.stderr));
    let from_git = clone_widget(&repo, Some(&env_root));
    assert_clone_landed(&from_git, &git_root);
    assert!(!second_root.join("github.com/example/widget").exists());
    assert!(!env_root.join("github.com/example/widget").exists());

    repo.git(&["config", "--global", "--unset-all", "ghq.root"]);
    let from_env = clone_widget(&repo, Some(&env_root));
    assert_clone_landed(&from_env, &env_root);

    let from_home = clone_widget(&repo, None);
    assert_clone_landed(&from_home, &default_root);
}

#[test]
fn clone_names_the_remote_origin_when_default_remote_name_is_upstream() {
    let repo = Repo::new();
    let bare = repo.root.join("bare.git");
    repo.git(&[
        "clone",
        "--bare",
        repo.repo.to_str().expect("repo"),
        bare.to_str().expect("bare"),
    ]);
    append_instead_of(&repo, &bare, "https://github.com/example/widget.git");
    repo.git(&["config", "--global", "clone.defaultRemoteName", "upstream"]);
    let root = repo.root.join("clones");
    let set = repo.mabo(&["preferences", "set", "root", root.to_str().expect("root")]);
    assert!(set.status.success(), "{}", text(&set.stderr));

    let cloned = repo.mabo(&["clone", "example/widget", "--json"]);
    assert!(
        cloned.status.success(),
        "{}\n{}",
        text(&cloned.stdout),
        text(&cloned.stderr)
    );
    let destination = canonical(&root.join("github.com/example/widget"));
    let remotes = repo
        .command("git", &["remote"])
        .current_dir(&destination)
        .output()
        .expect("remote");
    assert!(remotes.status.success(), "{}", text(&remotes.stderr));
    assert_eq!(text(&remotes.stdout), "origin");

    let again = repo.mabo(&["clone", "example/widget", "--update", "--json"]);
    assert!(
        again.status.success(),
        "{}\n{}",
        text(&again.stdout),
        text(&again.stderr)
    );
    let again_json: serde_json::Value = serde_json::from_str(&text(&again.stdout)).expect("json");
    assert_eq!(again_json["data"]["cloned"], false);
    assert_eq!(again_json["data"]["updated"], true);
    assert_eq!(
        again_json["data"]["path"],
        destination.to_string_lossy().as_ref()
    );
}

#[test]
fn clone_lowercases_remote_url_host() {
    let repo = Repo::new();
    let bare = repo.root.join("bare.git");
    repo.git(&[
        "clone",
        "--bare",
        repo.repo.to_str().expect("repo"),
        bare.to_str().expect("bare"),
    ]);
    append_instead_of(&repo, &bare, "https://GitHub.com/example/widget.git");
    append_instead_of(&repo, &bare, "https://github.com/example/widget.git");
    let root = repo.root.join("clones");
    let set = repo.mabo(&["preferences", "set", "root", root.to_str().expect("root")]);
    assert!(set.status.success(), "{}", text(&set.stderr));

    let cloned = repo.mabo(&["clone", "https://GitHub.com/example/widget.git", "--json"]);
    assert!(
        cloned.status.success(),
        "{}\n{}",
        text(&cloned.stdout),
        text(&cloned.stderr)
    );
    let value: serde_json::Value = serde_json::from_str(&text(&cloned.stdout)).expect("json");
    assert_eq!(value["data"]["host"], "github.com");
    assert_eq!(
        value["data"]["remoteUrl"],
        "https://github.com/example/widget.git"
    );
    assert_eq!(
        value["data"]["path"],
        canonical(&root.join("github.com/example/widget"))
            .to_string_lossy()
            .as_ref()
    );
}

#[test]
fn clone_overlong_owner_is_validation() {
    let repo = Repo::new();
    let root = repo.root.join("clones");
    let set = repo.mabo(&["preferences", "set", "root", root.to_str().expect("root")]);
    assert!(set.status.success(), "{}", text(&set.stderr));
    let owner = "o".repeat(256);
    let source = format!("example.com/{owner}/widget");
    let output = repo.mabo(&["clone", &source, "--json"]);
    assert_eq!(
        output.status.code(),
        Some(2),
        "{}\n{}",
        text(&output.stdout),
        text(&output.stderr)
    );
    let value: serde_json::Value = serde_json::from_str(&text(&output.stdout)).expect("json");
    assert_eq!(value["schema"], 2);
    assert_eq!(value["error"]["code"], "usage");
    assert!(value["error"].get("exitCode").is_none());
    let message = value["error"]["message"].as_str().unwrap_or_default();
    assert!(message.contains("Failed to create"), "{message}");
    assert!(text(&output.stderr).is_empty(), "{}", text(&output.stderr));
    assert!(!root.join("example.com").exists());
}

#[test]
fn clone_overlong_name_with_existing_parent_is_validation() {
    let repo = Repo::new();
    let root = repo.root.join("clones");
    let set = repo.mabo(&["preferences", "set", "root", root.to_str().expect("root")]);
    assert!(set.status.success(), "{}", text(&set.stderr));

    let host = root.join("github.com");
    fs::create_dir_all(&host).expect("host");
    let owner = "w".repeat(300);
    assert_clone_validation(&repo, &format!("github.com/{owner}/widget"));
    assert!(host.is_dir());
    assert!(!host.join(&owner).exists());

    let owner_dir = root.join("example.test").join("acme");
    fs::create_dir_all(&owner_dir).expect("owner");
    let repo_name = "w".repeat(300);
    assert_clone_validation(&repo, &format!("example.test/acme/{repo_name}"));
    assert!(owner_dir.is_dir());
    assert!(!owner_dir.join(&repo_name).exists());
}

fn assert_clone_validation(repo: &Repo, source: &str) {
    let output = repo.mabo(&["clone", source, "--json"]);
    assert_eq!(
        output.status.code(),
        Some(2),
        "{source}\n{}\n{}",
        text(&output.stdout),
        text(&output.stderr)
    );
    let value: serde_json::Value = serde_json::from_str(&text(&output.stdout)).expect("json");
    assert_eq!(value["schema"], 2);
    assert_eq!(value["error"]["code"], "usage");
    assert!(value["error"].get("exitCode").is_none());
    let message = value["error"]["message"].as_str().unwrap_or_default();
    assert!(
        message.contains("File name too long"),
        "{source}: {message}"
    );
    assert!(text(&output.stderr).is_empty(), "{}", text(&output.stderr));
}

#[test]
fn clone_surfaces_unreadable_git_config_for_an_existing_checkout() {
    let repo = Repo::new();
    let bare = repo.root.join("bare.git");
    repo.git(&[
        "clone",
        "--bare",
        repo.repo.to_str().expect("repo"),
        bare.to_str().expect("bare"),
    ]);
    append_instead_of(&repo, &bare, "https://github.com/example/widget.git");
    let root = repo.root.join("clones");
    let set = repo.mabo(&["preferences", "set", "root", root.to_str().expect("root")]);
    assert!(set.status.success(), "{}", text(&set.stderr));
    let cloned = repo.mabo(&["clone", "example/widget", "--json"]);
    assert!(
        cloned.status.success(),
        "{}\n{}",
        text(&cloned.stdout),
        text(&cloned.stderr)
    );

    let broken = repo.root.join("broken.gitconfig");
    fs::write(&broken, "[[[[ not valid\n").expect("config");
    let again = repo
        .command(
            env!("CARGO_BIN_EXE_mabo"),
            &["clone", "example/widget", "--json"],
        )
        .env("GIT_CONFIG_GLOBAL", &broken)
        .output()
        .expect("clone");
    assert_eq!(
        again.status.code(),
        Some(1),
        "{}\n{}",
        text(&again.stdout),
        text(&again.stderr)
    );
    let value: serde_json::Value = serde_json::from_str(&text(&again.stdout)).expect("json");
    assert_eq!(value["schema"], 2);
    assert_eq!(value["error"]["code"], "failed");
    assert!(value["error"].get("exitCode").is_none());
    let message = value["error"]["message"].as_str().unwrap_or_default();
    assert!(
        message.contains("bad config line"),
        "git's error should be in the message: {message}"
    );
    assert!(
        !message.contains("not a Git repository"),
        "config failure was reported as a missing repository: {message}"
    );
    assert!(text(&again.stderr).is_empty(), "{}", text(&again.stderr));
}

#[test]
fn clone_removes_stale_staging_directories() {
    let repo = Repo::new();
    let bare = repo.root.join("bare.git");
    repo.git(&[
        "clone",
        "--bare",
        repo.repo.to_str().expect("repo"),
        bare.to_str().expect("bare"),
    ]);
    append_instead_of(&repo, &bare, "https://github.com/example/widget.git");
    let root = repo.root.join("clones");
    let set = repo.mabo(&["preferences", "set", "root", root.to_str().expect("root")]);
    assert!(set.status.success(), "{}", text(&set.stderr));
    let owner = root.join("github.com").join("example");
    fs::create_dir_all(&owner).expect("owner");
    let dead_pid = unused_pid();
    let dead = owner.join(format!(".maboroshi-clone-{dead_pid}-{}", uuid_token()));
    fs::create_dir_all(dead.join(".git")).expect("dead");
    fs::write(dead.join("payload.txt"), "stale").expect("payload");
    let live = owner.join(format!(
        ".maboroshi-clone-{}-{}",
        std::process::id(),
        uuid_token()
    ));
    fs::create_dir_all(&live).expect("live");
    fs::write(live.join("payload.txt"), "live").expect("live");

    let cloned = repo.mabo(&["clone", "example/widget", "--json"]);
    assert!(
        cloned.status.success(),
        "{}\n{}",
        text(&cloned.stdout),
        text(&cloned.stderr)
    );
    assert!(!dead.exists(), "stale staging directory remained");
    assert_eq!(
        fs::read_to_string(live.join("payload.txt")).expect("live"),
        "live"
    );
    assert!(owner.join("widget").join(".git").exists());
}

#[test]
fn clone_rejects_file_urls() {
    let repo = Repo::new();
    let output = repo.mabo(&["clone", "file:///tmp/repo.git", "--json"]);
    assert_eq!(output.status.code(), Some(2), "{}", text(&output.stdout));
    let value: serde_json::Value = serde_json::from_str(&text(&output.stdout)).expect("json");
    assert_eq!(value["error"]["code"], "usage");
    assert!(value["error"].get("exitCode").is_none());
    let message = value["error"]["message"].as_str().unwrap_or_default();
    assert!(message.contains("file"), "{message}");
    assert!(message.contains("https"), "{message}");
}

fn unused_pid() -> u32 {
    for pid in 1_000_000..1_001_000 {
        let alive = std::process::Command::new("kill")
            .args(["-0", &pid.to_string()])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map(|status| status.success())
            .unwrap_or(true);
        if !alive {
            return pid;
        }
    }
    panic!("no unused pid");
}

fn uuid_token() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    format!(
        "{:08x}-{:04x}-4{:03x}-8{:03x}-{:012x}",
        (nanos & 0xffff_ffff) as u32,
        ((nanos >> 32) & 0xffff) as u32,
        ((nanos >> 48) & 0xfff) as u32,
        std::process::id() & 0xfff,
        nanos & 0xffff_ffff_ffff
    )
}

fn append_instead_of(repo: &Repo, bare: &std::path::Path, url: &str) {
    let path = repo.home.join(".gitconfig");
    let mut body = fs::read_to_string(&path).unwrap_or_default();
    // file:// makes `--depth` apply. A plain path is a local clone and Git ignores depth.
    body.push_str(&format!(
        "\n[url \"file://{}\"]\n\tinsteadOf = {url}\n",
        bare.display()
    ));
    fs::write(path, body).expect("gitconfig");
}

fn clone_widget(repo: &Repo, ghq_root: Option<&std::path::Path>) -> std::process::Output {
    let mut command = repo.command(
        env!("CARGO_BIN_EXE_mabo"),
        &["clone", "example/widget", "--json"],
    );
    if let Some(root) = ghq_root {
        command.env("GHQ_ROOT", root);
    }
    command.output().expect("clone")
}

fn assert_clone_landed(output: &std::process::Output, root: &std::path::Path) {
    assert!(
        output.status.success(),
        "{}\n{}",
        text(&output.stdout),
        text(&output.stderr)
    );
    let value: serde_json::Value = serde_json::from_str(&text(&output.stdout)).expect("json");
    let expected = canonical(&root.join("github.com/example/widget"));
    assert_eq!(value["data"]["path"], expected.to_string_lossy().as_ref());
    assert_eq!(value["data"]["cloned"], true);
    assert_eq!(value["data"]["host"], "github.com");
    assert_eq!(value["data"]["owner"], "example");
    assert_eq!(value["data"]["repo"], "widget");
}

fn canonical(path: &std::path::Path) -> PathBuf {
    fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

fn same_dir(left: &str, right: &std::path::Path) -> bool {
    fs::canonicalize(left).ok() == fs::canonicalize(right).ok()
}

fn silent_ghq_path(repo: &Repo) -> String {
    let bin = repo.root.join("bin");
    fs::create_dir_all(&bin).expect("bin");
    let ghq = bin.join("ghq");
    fs::write(&ghq, "#!/bin/sh\nexit 0\n").expect("ghq");
    use std::os::unix::fs::PermissionsExt;
    let mut perms = fs::metadata(&ghq).expect("meta").permissions();
    perms.set_mode(0o755);
    fs::set_permissions(&ghq, perms).expect("chmod");
    format!(
        "{}:{}",
        bin.display(),
        std::env::var("PATH").unwrap_or_default()
    )
}

fn git_at(repo: &Repo, dir: &std::path::Path, args: &[&str]) {
    let output = repo
        .command("git", args)
        .current_dir(dir)
        .output()
        .expect("git");
    assert!(
        output.status.success(),
        "git {} failed: {}",
        args.join(" "),
        text(&output.stderr)
    );
}

fn init_named_repo(repo: &Repo, relative: &str, origin: &str) -> PathBuf {
    let path = repo.root.join("clones").join(relative);
    fs::create_dir_all(&path).expect("project dir");
    git_at(repo, &path, &["init", "-b", "main"]);
    git_at(
        repo,
        &path,
        &["config", "user.email", "phantom-rust@example.com"],
    );
    git_at(repo, &path, &["config", "user.name", "Phantom Rust"]);
    fs::write(path.join("README.md"), "hi\n").expect("readme");
    git_at(repo, &path, &["add", "README.md"]);
    git_at(repo, &path, &["commit", "-m", "initial"]);
    git_at(repo, &path, &["remote", "add", "origin", origin]);
    path
}

#[test]
fn project_option_resolves_paths_suffixes_and_errors() {
    let repo = Repo::new();
    let path_env = silent_ghq_path(&repo);
    let clones = repo.root.join("clones");
    let set = repo.mabo(&["preferences", "set", "root", clones.to_str().expect("root")]);
    assert!(set.status.success(), "{}", text(&set.stderr));
    let only = init_named_repo(
        &repo,
        "github.com/acme/ptm805only",
        "https://github.com/acme/ptm805only.git",
    );
    let acme_widget = init_named_repo(
        &repo,
        "github.com/acme/ptm805widget",
        "https://github.com/acme/ptm805widget.git",
    );
    let other_widget = init_named_repo(
        &repo,
        "github.com/other/ptm805widget",
        "https://github.com/other/ptm805widget.git",
    );
    let placed = init_named_repo(
        &repo,
        "github.com/acme/placed",
        "https://gitlab.com/other/renamed.git",
    );
    let run = |args: &[&str], cwd: &std::path::Path| {
        repo.command(env!("CARGO_BIN_EXE_mabo"), args)
            .env("PATH", &path_env)
            .current_dir(cwd)
            .output()
            .expect("mabo")
    };

    let catalog = run(&["project", "list", "--json"], &repo.home);
    assert!(catalog.status.success(), "{}", text(&catalog.stderr));
    let catalog_json = json_value(&catalog);
    let only_entry = catalog_json["data"]["projects"]
        .as_array()
        .expect("projects")
        .iter()
        .find(|project| project["canonicalName"] == "github.com/acme/ptm805only")
        .expect("only project");
    assert_eq!(only_entry["name"], "ptm805only");
    assert_eq!(only_entry["canonicalName"], "github.com/acme/ptm805only");
    let placed_entry = catalog_json["data"]["projects"]
        .as_array()
        .expect("projects")
        .iter()
        .find(|project| project["canonicalName"] == "gitlab.com/other/renamed")
        .expect("placed project");
    assert_eq!(placed_entry["name"], "placed");

    for reference in [
        "ptm805only",
        "acme/ptm805only",
        "github.com/acme/ptm805only",
    ] {
        let located = run(&["where", "--project", reference, "main"], &repo.home);
        assert!(
            located.status.success(),
            "{reference}: {}\n{}",
            text(&located.stdout),
            text(&located.stderr)
        );
        assert!(
            same_dir(&text(&located.stdout), &only),
            "{reference} -> {}",
            text(&located.stdout)
        );
    }
    let by_remote = run(&["where", "--project", "other/renamed", "main"], &repo.home);
    assert!(by_remote.status.success(), "{}", text(&by_remote.stderr));
    assert!(same_dir(&text(&by_remote.stdout), &placed));
    let by_location = run(&["where", "--project", "acme/placed", "main"], &repo.home);
    assert!(
        by_location.status.success(),
        "{}",
        text(&by_location.stderr)
    );
    assert!(same_dir(&text(&by_location.stdout), &placed));

    let ambiguous = run(&["list", "--project", "ptm805widget", "--json"], &repo.home);
    assert_eq!(
        ambiguous.status.code(),
        Some(2),
        "{}",
        text(&ambiguous.stdout)
    );
    let ambiguous_json = json_value(&ambiguous);
    assert_eq!(ambiguous_json["schema"], 2);
    assert_eq!(ambiguous_json["error"]["code"], "ambiguous");
    assert!(ambiguous_json["error"].get("exitCode").is_none());
    let message = ambiguous_json["error"]["message"].as_str().unwrap_or("");
    assert!(
        message.contains("github.com/acme/ptm805widget"),
        "{message}"
    );
    assert!(
        message.contains("github.com/other/ptm805widget"),
        "{message}"
    );
    assert!(
        message.contains(&acme_widget.to_string_lossy().to_string())
            || message.contains(&canonical(&acme_widget).to_string_lossy().to_string()),
        "{message}"
    );
    assert!(
        message.contains(&other_widget.to_string_lossy().to_string())
            || message.contains(&canonical(&other_widget).to_string_lossy().to_string()),
        "{message}"
    );
    let unique = run(
        &["where", "--project", "acme/ptm805widget", "main"],
        &repo.home,
    );
    assert!(unique.status.success(), "{}", text(&unique.stderr));
    assert!(same_dir(&text(&unique.stdout), &acme_widget));

    let missing = run(
        &["list", "--project", "no-such-ptm805", "--json"],
        &repo.home,
    );
    assert_eq!(missing.status.code(), Some(3), "{}", text(&missing.stdout));
    let missing_json = json_value(&missing);
    assert_eq!(missing_json["error"]["code"], "not_found");
    assert!(missing_json["error"].get("exitCode").is_none());
    assert_eq!(
        missing_json["error"]["message"],
        "Project 'no-such-ptm805' not found"
    );
    let prefix = run(
        &["where", "--project", "github.com/acme", "main", "--json"],
        &repo.home,
    );
    assert_eq!(prefix.status.code(), Some(3), "{}", text(&prefix.stdout));
    assert_eq!(json_value(&prefix)["error"]["code"], "not_found");

    let created = repo.mabo(&["create", "feature"]);
    assert!(created.status.success(), "{}", text(&created.stderr));
    let worktree = managed(&repo, "feature");
    let nested = worktree.join("nested");
    fs::create_dir_all(&nested).expect("nested");
    let sub = repo.repo.join("sub");
    fs::create_dir_all(&sub).expect("sub");

    let absolute = run(
        &["where", "-p", repo.repo.to_str().expect("repo"), "main"],
        &repo.home,
    );
    assert!(absolute.status.success(), "{}", text(&absolute.stderr));
    assert!(same_dir(&text(&absolute.stdout), &repo.repo));
    let relative = run(&["where", "--project", "./repo", "main"], &repo.root);
    assert!(relative.status.success(), "{}", text(&relative.stderr));
    assert!(same_dir(&text(&relative.stdout), &repo.repo));
    let dotted = run(&["where", "--project", ".", "main"], &sub);
    assert!(dotted.status.success(), "{}", text(&dotted.stderr));
    assert!(same_dir(&text(&dotted.stdout), &repo.repo));
    let tilde = repo
        .command(
            env!("CARGO_BIN_EXE_mabo"),
            &["where", "--project", "~/repo", "main"],
        )
        .env("PATH", &path_env)
        .env("HOME", &repo.root)
        .current_dir(&repo.home)
        .output()
        .expect("tilde");
    assert!(tilde.status.success(), "{}", text(&tilde.stderr));
    assert!(same_dir(&text(&tilde.stdout), &repo.repo));

    let inside = run(
        &[
            "list",
            "--json",
            "--project",
            nested.to_str().expect("nested"),
        ],
        &repo.home,
    );
    assert!(
        inside.status.success(),
        "{}\n{}",
        text(&inside.stdout),
        text(&inside.stderr)
    );
    let inside_json = json_value(&inside);
    let worktrees = inside_json["data"]["worktrees"]
        .as_array()
        .expect("worktrees");
    let default_tree = worktrees
        .iter()
        .find(|worktree| worktree["default"].as_bool() == Some(true))
        .expect("default worktree");
    assert!(same_dir(
        default_tree["path"].as_str().unwrap_or(""),
        &repo.repo
    ));
    let feature_tree = worktrees
        .iter()
        .find(|worktree| worktree["name"] == "feature")
        .expect("feature");
    assert_eq!(feature_tree["default"], false);
    let from_link = run(&["where", "--project", ".", "main"], &worktree);
    assert!(from_link.status.success(), "{}", text(&from_link.stderr));
    assert!(same_dir(&text(&from_link.stdout), &repo.repo));
    let created_from_link = run(
        &[
            "create",
            "--project",
            nested.to_str().expect("nested"),
            "from-link",
        ],
        &repo.home,
    );
    assert!(
        created_from_link.status.success(),
        "{}\n{}",
        text(&created_from_link.stdout),
        text(&created_from_link.stderr)
    );
    assert!(managed(&repo, "from-link").is_dir());
    assert!(!worktree.join(".git/maboroshi/worktrees/from-link").exists());

    let file = run(
        &[
            "list",
            "--project",
            repo.repo.join("README.md").to_str().expect("readme"),
            "--json",
        ],
        &repo.home,
    );
    assert_eq!(file.status.code(), Some(2), "{}", text(&file.stdout));
    let file_json = json_value(&file);
    assert_eq!(file_json["error"]["code"], "usage");
    assert!(file_json["error"]["message"]
        .as_str()
        .unwrap_or("")
        .contains("not a directory"));
    let outside = run(
        &[
            "list",
            "--project",
            repo.home.to_str().expect("home"),
            "--json",
        ],
        &repo.home,
    );
    assert_eq!(outside.status.code(), Some(3), "{}", text(&outside.stdout));
    assert_eq!(json_value(&outside)["error"]["code"], "not_repository");
    let absent = run(
        &[
            "where",
            "--project",
            "/no/such/ptm805-path",
            "main",
            "--json",
        ],
        &repo.home,
    );
    assert_eq!(absent.status.code(), Some(3), "{}", text(&absent.stdout));
    let absent_json = json_value(&absent);
    assert_eq!(absent_json["error"]["code"], "not_found");
    assert!(absent_json["error"].get("exitCode").is_none());
    assert_eq!(
        absent_json["error"]["message"],
        "Path '/no/such/ptm805-path' does not exist"
    );

    let repeated = run(
        &[
            "list",
            "--project",
            "acme/ptm805only",
            "--project",
            "acme/ptm805only",
            "--json",
        ],
        &repo.home,
    );
    assert_eq!(
        repeated.status.code(),
        Some(2),
        "{}",
        text(&repeated.stdout)
    );
    assert!(json_value(&repeated)["error"]["message"]
        .as_str()
        .unwrap_or("")
        .contains("only be specified once"));

    let checkout_bin = repo.root.join("bin/gh");
    fs::write(
        &checkout_bin,
        "#!/bin/sh\nif [ \"$1\" = \"repo\" ]; then\n  printf '%s\\n' '{\"url\":\"https://github.com/acme/demo\",\"owner\":{\"login\":\"acme\"},\"name\":\"demo\"}'\n  exit 0\nfi\nprintf '%s\\n' '{\"number\":9}'\nexit 0\n",
    )
    .expect("gh");
    use std::os::unix::fs::PermissionsExt;
    let mut perms = fs::metadata(&checkout_bin).expect("meta").permissions();
    perms.set_mode(0o755);
    fs::set_permissions(&checkout_bin, perms).expect("chmod");
    let checkout = run(
        &[
            "github",
            "checkout",
            "--project",
            repo.repo.to_str().expect("repo"),
            "9",
            "--json",
        ],
        &repo.home,
    );
    assert!(
        checkout.status.success(),
        "{}\n{}",
        text(&checkout.stdout),
        text(&checkout.stderr)
    );
    assert!(managed(&repo, "issues/9").is_dir());
    let missing_checkout = run(
        &[
            "gh",
            "checkout",
            "--project",
            "no-such-ptm805",
            "9",
            "--json",
        ],
        &repo.home,
    );
    assert_eq!(missing_checkout.status.code(), Some(3));
    assert_eq!(json_value(&missing_checkout)["error"]["code"], "not_found");
}

#[test]
fn exec_project_option_passes_later_options_to_the_command() {
    let repo = Repo::new();
    let path_env = silent_ghq_path(&repo);
    let clones = repo.root.join("clones");
    let set = repo.mabo(&["preferences", "set", "root", clones.to_str().expect("root")]);
    assert!(set.status.success(), "{}", text(&set.stderr));
    let project = init_named_repo(
        &repo,
        "github.com/acme/ptm805exec",
        "https://github.com/acme/ptm805exec.git",
    );
    let run = |args: &[&str]| {
        repo.command(env!("CARGO_BIN_EXE_mabo"), args)
            .env("PATH", &path_env)
            .current_dir(&repo.home)
            .output()
            .expect("mabo")
    };
    let created = run(&["create", "--project", "acme/ptm805exec", "foo"]);
    assert!(
        created.status.success(),
        "{}\n{}",
        text(&created.stdout),
        text(&created.stderr)
    );
    assert!(managed_directory(&project, &repo.root.join("xdg"))
        .join("foo")
        .is_dir());

    let passed = run(&[
        "exec",
        "--project",
        "acme/ptm805exec",
        "foo",
        "pwd",
        "--project",
        "y",
    ]);
    assert_eq!(passed.status.code(), Some(1), "{}", text(&passed.stderr));
    let stderr = text(&passed.stderr);
    assert!(
        stderr.contains("unrecognized option '--project'"),
        "pwd should receive --project y: {stderr}"
    );
    assert!(!stderr.contains("Unknown option"), "{stderr}");
    assert!(!stderr.contains("matches multiple"), "{stderr}");

    let printed = run(&[
        "exec",
        "--project",
        "acme/ptm805exec",
        "foo",
        "printf",
        "%s\n",
        "--project",
        "y",
    ]);
    assert!(
        printed.status.success(),
        "{}\n{}",
        text(&printed.stdout),
        text(&printed.stderr)
    );
    assert_eq!(text(&printed.stdout), "--project\ny");

    let missing = run(&[
        "exec",
        "--project",
        "no-such-ptm805",
        "foo",
        "pwd",
        "--project",
        "y",
    ]);
    assert_eq!(missing.status.code(), Some(3), "{}", text(&missing.stderr));
    assert!(text(&missing.stderr).contains("Project 'no-such-ptm805' not found"));
    assert!(!text(&missing.stderr).contains("unrecognized option"));
}

#[test]
fn project_option_ignores_the_callers_config_and_matches_directory_names() {
    let repo = Repo::new();
    let path_env = silent_ghq_path(&repo);
    let tool = repo.root.join("tool");
    fs::create_dir_all(&tool).expect("tool");
    git_at(&repo, &tool, &["init", "-b", "main"]);
    git_at(
        &repo,
        &tool,
        &["config", "user.email", "phantom-rust@example.com"],
    );
    git_at(&repo, &tool, &["config", "user.name", "Phantom Rust"]);
    fs::write(tool.join("README.md"), "tool\n").expect("readme");
    git_at(&repo, &tool, &["add", "README.md"]);
    git_at(&repo, &tool, &["commit", "-m", "initial"]);
    let feature = tool.join(".git/maboroshi/worktrees/h1");
    git_at(
        &repo,
        &tool,
        &[
            "worktree",
            "add",
            "-b",
            "h1",
            feature.to_str().expect("h1"),
            "HEAD",
        ],
    );
    let localname = repo.root.join("localname");
    fs::create_dir_all(&localname).expect("localname");
    git_at(&repo, &localname, &["init", "-b", "main"]);
    git_at(
        &repo,
        &localname,
        &["config", "user.email", "phantom-rust@example.com"],
    );
    git_at(&repo, &localname, &["config", "user.name", "Phantom Rust"]);
    fs::write(localname.join("README.md"), "local\n").expect("readme");
    git_at(&repo, &localname, &["add", "README.md"]);
    git_at(&repo, &localname, &["commit", "-m", "initial"]);
    git_at(
        &repo,
        &localname,
        &[
            "remote",
            "add",
            "origin",
            "https://github.com/acme/ptm805renamed.git",
        ],
    );
    for path in [&tool, &localname] {
        let added = repo.mabo(&["project", "add", path.to_str().expect("path"), "--json"]);
        assert!(added.status.success(), "{}", text(&added.stderr));
    }
    fs::write(repo.repo.join(".mabo.toml"), "not = [\n").expect("invalid config");

    let run = |args: &[&str]| {
        repo.command(env!("CARGO_BIN_EXE_mabo"), args)
            .env("PATH", &path_env)
            .output()
            .expect("mabo")
    };
    let listed = run(&["list", "-p", "tool"]);
    assert!(
        listed.status.success(),
        "{}\n{}",
        text(&listed.stdout),
        text(&listed.stderr)
    );
    assert!(!text(&listed.stderr).contains("Invalid .mabo.toml"));
    assert!(
        text(&listed.stdout).contains("h1"),
        "{}",
        text(&listed.stdout)
    );
    let located = run(&["where", "-p", "tool", "h1"]);
    assert!(located.status.success(), "{}", text(&located.stderr));
    assert!(same_dir(&text(&located.stdout), &feature));
    let created = run(&["create", "-p", "tool", "z1"]);
    assert!(
        created.status.success(),
        "{}\n{}",
        text(&created.stdout),
        text(&created.stderr)
    );
    assert!(managed_directory(&tool, &repo.root.join("xdg"))
        .join("z1")
        .is_dir());
    assert!(!text(&created.stderr).contains("Invalid .mabo.toml"));
    assert!(!managed(&repo, "z1").exists());

    let by_directory = run(&["where", "-p", "localname", "main"]);
    assert!(
        by_directory.status.success(),
        "{}",
        text(&by_directory.stderr)
    );
    assert!(same_dir(&text(&by_directory.stdout), &localname));
    let by_suffix = run(&["where", "--project", "ptm805renamed", "main"]);
    assert!(by_suffix.status.success(), "{}", text(&by_suffix.stderr));
    assert!(same_dir(&text(&by_suffix.stdout), &localname));

    let option_value = run(&["list", "-p", "--json"]);
    assert_eq!(option_value.status.code(), Some(2));
    assert!(option_value.stdout.is_empty());
    assert!(text(&option_value.stderr).contains("looks like an option"));
    let option_json = run(&["list", "--json", "-p", "--json"]);
    assert_eq!(
        option_json.status.code(),
        Some(2),
        "{}",
        text(&option_json.stdout)
    );
    let option_body = json_value(&option_json);
    assert_eq!(option_body["error"]["code"], "usage");
    assert!(option_body["error"].get("exitCode").is_none());
    assert!(option_body["error"]["message"]
        .as_str()
        .unwrap_or("")
        .contains("looks like an option"));
    let option_later = run(&["where", "--json", "-p", "--bogus", "main"]);
    assert_eq!(option_later.status.code(), Some(2));
    assert_eq!(json_value(&option_later)["error"]["code"], "usage");
    let option_human = run(&["where", "-p", "--nope", "main"]);
    assert_eq!(
        option_human.status.code(),
        Some(2),
        "{}",
        text(&option_human.stderr)
    );
    assert!(text(&option_human.stderr).contains("looks like an option"));
    assert!(!text(&option_human.stdout).contains("\"version\""));

    let help = run(&["exec", "--project", "tool", "--help"]);
    assert!(help.status.success(), "{}", text(&help.stderr));
    assert!(text(&help.stdout).contains("mabo exec"));
    assert!(!text(&help.stderr).contains("Unknown option"));
}

#[test]
fn github_checkout_project_passes_the_selected_host() {
    let repo = Repo::new();
    fs::write(repo.repo.join(".mabo.toml"), "not = [\n").expect("invalid config");
    let tool = repo.root.join("ghe-tool");
    fs::create_dir_all(&tool).expect("tool");
    git_at(&repo, &tool, &["init", "-b", "main"]);
    git_at(
        &repo,
        &tool,
        &["config", "user.email", "phantom-rust@example.com"],
    );
    git_at(&repo, &tool, &["config", "user.name", "Phantom Rust"]);
    fs::write(tool.join("README.md"), "ghe\n").expect("readme");
    git_at(&repo, &tool, &["add", "README.md"]);
    git_at(&repo, &tool, &["commit", "-m", "initial"]);
    git_at(
        &repo,
        &tool,
        &[
            "remote",
            "add",
            "origin",
            "ssh://git@ghe.corp.example:2222/acme/tool.git",
        ],
    );
    let bin = repo.root.join("bin");
    fs::create_dir_all(&bin).expect("bin");
    let log = repo.root.join("gh.log");
    let gh = bin.join("gh");
    fs::write(
        &gh,
        "#!/bin/sh\nprintf '%s\\n' \"pwd=$(pwd)\" >> \"$MABO_GH_LOG\"\nprintf '%s\\n' \"$*\" >> \"$MABO_GH_LOG\"\nif [ \"$1\" = \"repo\" ]; then\n  printf '%s\\n' \"$MABO_GH_REPO_JSON\"\n  exit 0\nfi\nprintf '%s\\n' '{\"number\":3}'\nexit 0\n",
    )
    .expect("gh");
    use std::os::unix::fs::PermissionsExt;
    let mut perms = fs::metadata(&gh).expect("meta").permissions();
    perms.set_mode(0o755);
    fs::set_permissions(&gh, perms).expect("chmod");
    let path_env = format!(
        "{}:{}",
        bin.display(),
        std::env::var("PATH").unwrap_or_default()
    );
    let checkout = repo
        .command(
            env!("CARGO_BIN_EXE_mabo"),
            &[
                "github",
                "checkout",
                "-p",
                tool.to_str().expect("tool"),
                "3",
                "--json",
            ],
        )
        .env("PATH", &path_env)
        .env("MABO_GH_LOG", &log)
        .env(
            "MABO_GH_REPO_JSON",
            r#"{"url":"https://ghe.corp.example/acme/tool","owner":{"login":"acme"},"name":"tool"}"#,
        )
        .output()
        .expect("checkout");
    assert!(
        checkout.status.success(),
        "{}\n{}",
        text(&checkout.stdout),
        text(&checkout.stderr)
    );
    assert!(!text(&checkout.stderr).contains("Invalid .mabo.toml"));
    assert!(managed_directory(&tool, &repo.root.join("xdg"))
        .join("issues/3")
        .is_dir());
    let recorded = fs::read_to_string(&log).expect("gh log");
    assert!(
        recorded.contains("--hostname ghe.corp.example"),
        "{recorded}"
    );
    assert!(!recorded.contains(":2222"), "{recorded}");
    assert!(recorded.contains("repos/acme/tool/issues/3"), "{recorded}");
    let tool_pwd = canonical(&tool).to_string_lossy().to_string();
    assert!(recorded.contains(&format!("pwd={tool_pwd}")), "{recorded}");
    assert!(!recorded.contains(&format!("pwd={}", repo.repo.display())));

    fs::write(&log, "").expect("truncate");
    let local = repo
        .command(env!("CARGO_BIN_EXE_mabo"), &["github", "checkout", "4"])
        .current_dir(&tool)
        .env("PATH", &path_env)
        .env("MABO_GH_LOG", &log)
        .env(
            "MABO_GH_REPO_JSON",
            r#"{"url":"https://ghe.corp.example/acme/tool","owner":{"login":"acme"},"name":"tool"}"#,
        )
        .output()
        .expect("local checkout");
    assert!(
        local.status.success(),
        "{}\n{}",
        text(&local.stdout),
        text(&local.stderr)
    );
    let local_log = fs::read_to_string(&log).expect("local log");
    assert!(
        local_log.contains("--hostname ghe.corp.example"),
        "{local_log}"
    );
    assert!(!local_log.contains(":2222"), "{local_log}");

    let alias = repo.root.join("alias-tool");
    fs::create_dir_all(&alias).expect("alias");
    git_at(&repo, &alias, &["init", "-b", "main"]);
    git_at(
        &repo,
        &alias,
        &["config", "user.email", "phantom-rust@example.com"],
    );
    git_at(&repo, &alias, &["config", "user.name", "Phantom Rust"]);
    fs::write(alias.join("README.md"), "alias\n").expect("readme");
    git_at(&repo, &alias, &["add", "README.md"]);
    git_at(&repo, &alias, &["commit", "-m", "initial"]);
    git_at(&repo, &alias, &["remote", "add", "origin", "gh:acme/tool"]);
    fs::write(&log, "").expect("truncate");
    let aliased = repo
        .command(
            env!("CARGO_BIN_EXE_mabo"),
            &[
                "github",
                "checkout",
                "-p",
                alias.to_str().expect("alias"),
                "5",
            ],
        )
        .env("PATH", &path_env)
        .env("MABO_GH_LOG", &log)
        .env(
            "MABO_GH_REPO_JSON",
            r#"{"url":"https://github.com/acme/tool","owner":{"login":"acme"},"name":"tool"}"#,
        )
        .output()
        .expect("alias checkout");
    assert!(
        aliased.status.success(),
        "{}\n{}",
        text(&aliased.stdout),
        text(&aliased.stderr)
    );
    let alias_log = fs::read_to_string(&log).expect("alias log");
    assert!(alias_log.contains("--hostname github.com"), "{alias_log}");
    assert!(
        !alias_log.contains("--hostname gh\n") && !alias_log.contains("--hostname gh "),
        "{alias_log}"
    );
}

#[test]
fn relative_origin_is_not_a_github_project_name() {
    let repo = Repo::new();
    let path_env = silent_ghq_path(&repo);
    let project = repo.root.join("ptm805local");
    fs::create_dir_all(&project).expect("project");
    git_at(&repo, &project, &["init", "-b", "main"]);
    git_at(
        &repo,
        &project,
        &["config", "user.email", "phantom-rust@example.com"],
    );
    git_at(&repo, &project, &["config", "user.name", "Phantom Rust"]);
    fs::write(project.join("README.md"), "local\n").expect("readme");
    git_at(&repo, &project, &["add", "README.md"]);
    git_at(&repo, &project, &["commit", "-m", "initial"]);
    git_at(
        &repo,
        &project,
        &["remote", "add", "origin", "backups/widget.git"],
    );
    let added = repo.mabo(&["project", "add", project.to_str().expect("path"), "--json"]);
    assert!(added.status.success(), "{}", text(&added.stderr));
    let listed = repo
        .command(env!("CARGO_BIN_EXE_mabo"), &["project", "list", "--json"])
        .env("PATH", &path_env)
        .output()
        .expect("list");
    assert!(listed.status.success(), "{}", text(&listed.stderr));
    let catalog = json_value(&listed);
    let entry = catalog["data"]["projects"]
        .as_array()
        .expect("projects")
        .iter()
        .find(|project| project["name"] == "ptm805local")
        .expect("project");
    assert_eq!(entry["canonicalName"], "ptm805local");
    assert!(!entry["canonicalName"]
        .as_str()
        .unwrap_or("")
        .contains("github.com"));
    let matched = repo
        .command(
            env!("CARGO_BIN_EXE_mabo"),
            &["where", "-p", "github.com/backups/widget", "main", "--json"],
        )
        .env("PATH", &path_env)
        .output()
        .expect("where");
    assert_eq!(matched.status.code(), Some(3), "{}", text(&matched.stdout));
    assert_eq!(json_value(&matched)["error"]["code"], "not_found");
    let by_name = repo
        .command(
            env!("CARGO_BIN_EXE_mabo"),
            &["where", "-p", "ptm805local", "main"],
        )
        .env("PATH", &path_env)
        .output()
        .expect("name");
    assert!(by_name.status.success(), "{}", text(&by_name.stderr));
    assert!(same_dir(&text(&by_name.stdout), &project));

    let git_dir = repo.mabo(&[
        "where",
        "-p",
        repo.repo.join(".git").to_str().expect("git"),
        "main",
    ]);
    assert!(
        git_dir.status.success(),
        "{}\n{}",
        text(&git_dir.stdout),
        text(&git_dir.stderr)
    );
    assert!(same_dir(&text(&git_dir.stdout), &repo.repo));
    let objects = repo.mabo(&[
        "where",
        "-p",
        repo.repo.join(".git/objects").to_str().expect("objects"),
        "main",
    ]);
    assert!(objects.status.success(), "{}", text(&objects.stderr));
    assert!(same_dir(&text(&objects.stdout), &repo.repo));
    assert!(!text(&objects.stderr).contains("must be run in a work tree"));
}

#[test]
fn worktree_metadata_is_recorded_filtered_updated_and_removed() {
    let repo = Repo::new();
    let help = repo.mabo(&["meta", "--help"]);
    assert!(help.status.success(), "{}", text(&help.stderr));
    assert!(text(&help.stdout).contains("meta set"));

    let plain = repo.mabo(&["create", "plain", "--json"]);
    assert!(plain.status.success(), "{}", text(&plain.stderr));
    let plain_json = json_value(&plain);
    assert!(plain_json["data"]["worktree"]["owner"].is_null());
    assert!(plain_json["data"]["worktree"]["purpose"].is_null());
    assert!(plain_json["data"]["worktree"]["createdAt"].is_string());
    assert_eq!(
        plain_json["data"]["worktree"]["createdAt"],
        plain_json["data"]["worktree"]["lastUsedAt"]
    );
    assert!(plain_json["data"]["worktree"]["links"]["pr"].is_null());

    let ignored = repo
        .command(env!("CARGO_BIN_EXE_mabo"), &["create", "legacy", "--json"])
        .env("PHANTOM_AGENT_ID", "phantom-v6")
        .env("PTM_AGENT_ID", "ptm")
        .output()
        .expect("legacy env");
    assert!(ignored.status.success(), "{}", text(&ignored.stderr));
    assert!(json_value(&ignored)["data"]["worktree"]["owner"].is_null());

    let created = repo
        .command(
            env!("CARGO_BIN_EXE_mabo"),
            &[
                "create",
                "feature",
                "--json",
                "--purpose",
                "fix the flake",
                "--pr",
                "774",
                "--owner",
                "from-flag",
            ],
        )
        .env("MABO_AGENT_ID", "from-env")
        .output()
        .expect("create");
    assert!(created.status.success(), "{}", text(&created.stderr));
    let created_json = json_value(&created);
    assert_eq!(created_json["schema"], 2);
    assert_eq!(created_json["data"]["worktree"]["owner"], "from-flag");
    assert_eq!(created_json["data"]["worktree"]["purpose"], "fix the flake");
    assert_eq!(
        created_json["data"]["worktree"]["links"]["pr"]["number"],
        774
    );
    assert!(created_json["data"]["worktree"]["links"]["pr"]["url"].is_null());
    assert!(created_json["data"]["worktree"]["createdAt"].is_string());
    let created_at = created_json["data"]["worktree"]["createdAt"]
        .as_str()
        .expect("created")
        .to_string();
    let created_from = created_json["data"]["worktree"]["createdFrom"]
        .as_str()
        .expect("createdFrom")
        .to_string();
    assert_eq!(
        created_from,
        created_json["data"]["worktree"]["head"]
            .as_str()
            .expect("head")
    );

    let from_env = repo
        .command(
            env!("CARGO_BIN_EXE_mabo"),
            &["create", "env-owned", "--json"],
        )
        .env("MABO_AGENT_ID", "from-env")
        .output()
        .expect("env");
    assert!(from_env.status.success(), "{}", text(&from_env.stderr));
    assert_eq!(
        json_value(&from_env)["data"]["worktree"]["owner"],
        "from-env"
    );

    let listed = repo.mabo(&["list", "--owner", "from-flag"]);
    assert!(listed.status.success(), "{}", text(&listed.stderr));
    let listed_text = text(&listed.stdout);
    assert!(listed_text.contains("feature"));
    assert!(listed_text.contains("[from-flag]"));
    assert!(listed_text.contains("fix the flake"));
    assert!(!listed_text.contains("plain"));
    assert!(!listed_text.contains("env-owned"));

    let listed_json = json_value(&repo.mabo(&["list", "--json", "--owner", "from-env"]));
    assert_eq!(
        listed_json["data"]["worktrees"].as_array().map(Vec::len),
        Some(1)
    );
    assert_eq!(listed_json["data"]["worktrees"][0]["name"], "env-owned");

    let none = repo.mabo(&["list", "--names", "--owner", "nobody"]);
    assert!(none.status.success(), "{}", text(&none.stderr));
    assert!(text(&none.stdout).is_empty());
    let none_human = repo.mabo(&["list", "--owner", "nobody"]);
    assert!(text(&none_human.stdout).contains("No worktrees found for owner 'nobody'"));

    let invalid = repo.mabo(&["create", "nope", "--owner", " "]);
    assert_eq!(invalid.status.code(), Some(2));
    let invalid_json = repo.mabo(&["meta", "set", "feature", "--pr", "not-a-link", "--json"]);
    assert_eq!(invalid_json.status.code(), Some(2));
    assert_eq!(json_value(&invalid_json)["error"]["code"], "usage");
    assert!(json_value(&invalid_json)["error"].get("exitCode").is_none());

    let missing = repo.mabo(&["meta", "set", "missing", "--owner", "grok", "--json"]);
    assert_eq!(missing.status.code(), Some(3));
    assert_eq!(json_value(&missing)["error"]["code"], "not_found");

    let unset = repo.mabo(&["meta", "set", "feature", "--json"]);
    assert_eq!(unset.status.code(), Some(2));

    let updated = repo.mabo(&[
        "meta",
        "set",
        "feature",
        "--purpose",
        "land the fix",
        "--issue",
        "https://github.com/phantompane/phantom/issues/12",
        "--json",
    ]);
    assert!(updated.status.success(), "{}", text(&updated.stderr));
    let updated_json = json_value(&updated);
    assert_eq!(updated_json["data"]["worktree"]["owner"], "from-flag");
    assert_eq!(updated_json["data"]["worktree"]["purpose"], "land the fix");
    assert_eq!(
        updated_json["data"]["worktree"]["links"]["pr"]["number"],
        774
    );
    assert_eq!(
        updated_json["data"]["worktree"]["links"]["issue"]["number"],
        12
    );
    assert_eq!(updated_json["data"]["worktree"]["createdAt"], created_at);
    assert_eq!(
        updated_json["data"]["worktree"]["createdFrom"],
        created_from
    );

    let file = repo.repo.join(".git/maboroshi/workspaces");
    let mut document: serde_json::Value =
        serde_json::from_str(&records::read_to_string(&file).expect("store")).expect("store json");
    let records = document["worktrees"].as_array_mut().expect("records");
    let feature = records
        .iter_mut()
        .find(|record| record["path"].as_str().unwrap_or("").ends_with("/feature"))
        .expect("feature record");
    feature["lastUsedAt"] = serde_json::json!("2000-01-01T00:00:00.000Z");
    records::write(
        &file,
        format!(
            "{}\n",
            serde_json::to_string_pretty(&document).expect("encode")
        ),
    )
    .expect("rewrite");

    let located = repo.mabo(&["where", "feature", "--json"]);
    assert!(located.status.success(), "{}", text(&located.stderr));
    let located_json = json_value(&located);
    assert_eq!(located_json["data"]["worktree"]["createdAt"], created_at);
    assert_ne!(
        located_json["data"]["worktree"]["lastUsedAt"],
        "2000-01-01T00:00:00.000Z"
    );
    let human_where = repo.mabo(&["where", "feature"]);
    assert!(
        text(&human_where.stdout).starts_with('/'),
        "{}",
        text(&human_where.stdout)
    );

    document =
        serde_json::from_str(&records::read_to_string(&file).expect("store")).expect("store json");
    let records = document["worktrees"].as_array_mut().expect("records");
    let feature = records
        .iter_mut()
        .find(|record| record["path"].as_str().unwrap_or("").ends_with("/feature"))
        .expect("feature record");
    feature["lastUsedAt"] = serde_json::json!("2000-01-01T00:00:00.000Z");
    records::write(
        &file,
        format!(
            "{}\n",
            serde_json::to_string_pretty(&document).expect("encode")
        ),
    )
    .expect("rewrite");
    let ran = repo.mabo(&["exec", "feature", "true"]);
    assert!(ran.status.success(), "{}", text(&ran.stderr));
    let after_exec = json_value(&repo.mabo(&["list", "--json", "--owner", "from-flag"]));
    assert_ne!(
        after_exec["data"]["worktrees"][0]["lastUsedAt"],
        "2000-01-01T00:00:00.000Z"
    );

    repo.git(&["branch", "side"]);
    let attached = repo.mabo(&[
        "attach",
        "side",
        "--json",
        "--owner",
        "reviewer",
        "--pr",
        "https://github.com/phantompane/phantom/pull/12",
    ]);
    assert!(attached.status.success(), "{}", text(&attached.stderr));
    let attached_json = json_value(&attached);
    assert_eq!(attached_json["data"]["worktree"]["owner"], "reviewer");
    assert_eq!(
        attached_json["data"]["worktree"]["links"]["pr"]["number"],
        12
    );
    assert!(attached_json["data"]["worktree"]["base"].is_null());

    let deleted = repo.mabo(&["delete", "feature", "--keep-branch", "--json"]);
    assert!(deleted.status.success(), "{}", text(&deleted.stderr));
    let deleted_json = json_value(&deleted);
    assert_eq!(
        deleted_json["data"]["deleted"][0]["worktree"]["owner"],
        "from-flag"
    );
    let after_delete = repo.mabo(&["list", "--json", "--owner", "from-flag"]);
    assert_eq!(
        json_value(&after_delete)["data"]["worktrees"]
            .as_array()
            .map(Vec::len),
        Some(0)
    );
    let store: serde_json::Value =
        serde_json::from_str(&records::read_to_string(&file).expect("store")).expect("store json");
    assert!(store["worktrees"]
        .as_array()
        .expect("records")
        .iter()
        .all(|record| !record["path"].as_str().unwrap_or("").ends_with("/feature")));

    records::write(&file, "{not json").expect("corrupt");
    let broken = repo.mabo(&["list", "--json"]);
    assert!(broken.status.success(), "{}", text(&broken.stderr));
    let broken_json = json_value(&broken);
    assert_eq!(broken_json["schema"], 2);
    assert!(broken_json["error"].is_null());
    assert!(text(&broken.stderr).contains("invalid JSON"));
    assert!(text(&broken.stderr).contains("workspaces"));
    assert!(broken_json["warnings"]
        .as_array()
        .expect("warnings")
        .iter()
        .any(|warning| warning["message"]
            .as_str()
            .unwrap_or_default()
            .contains("invalid JSON")));
    assert_eq!(records::read_to_string(&file).expect("kept"), "{not json");
    let refused = repo.mabo(&["create", "after-corrupt", "--json"]);
    assert_eq!(refused.status.code(), Some(1));
    assert_eq!(json_value(&refused)["error"]["code"], "failed");
    assert!(json_value(&refused)["error"]["message"]
        .as_str()
        .unwrap_or("")
        .contains("workspaces"));
    assert!(!managed(&repo, "after-corrupt").exists());
    assert_eq!(records::read_to_string(&file).expect("kept"), "{not json");
}

#[test]
fn github_recheckout_keeps_the_original_owner() {
    let repo = Repo::new();
    let created = repo
        .command(
            env!("CARGO_BIN_EXE_mabo"),
            &[
                "create",
                "topic",
                "--owner",
                "creator",
                "--purpose",
                "original task",
                "--json",
            ],
        )
        .output()
        .expect("create");
    assert!(created.status.success(), "{}", text(&created.stderr));
    let created_at = json_value(&created)["data"]["worktree"]["createdAt"]
        .as_str()
        .expect("created")
        .to_string();
    let file = repo.repo.join(".git/maboroshi/workspaces");
    let mut document: serde_json::Value =
        serde_json::from_str(&records::read_to_string(&file).expect("store")).expect("json");
    document["worktrees"][0]["lastUsedAt"] = serde_json::json!("2000-01-01T00:00:00.000Z");
    records::write(
        &file,
        format!(
            "{}\n",
            serde_json::to_string_pretty(&document).expect("encode")
        ),
    )
    .expect("rewrite");

    let path = fake_gh_for_topic_pr(&repo);
    let again = repo
        .command(
            env!("CARGO_BIN_EXE_mabo"),
            &[
                "github",
                "checkout",
                "7",
                "--json",
                "--purpose",
                "stolen",
                "--owner",
                "intruder",
            ],
        )
        .env("PATH", &path)
        .env("MABO_AGENT_ID", "intruder")
        .output()
        .expect("checkout");
    assert!(again.status.success(), "{}", text(&again.stderr));
    let again_json = json_value(&again);
    assert_eq!(again_json["data"]["github"]["alreadyExists"], true);
    assert_eq!(again_json["data"]["worktree"]["owner"], "creator");
    assert_eq!(again_json["data"]["worktree"]["purpose"], "original task");
    assert_eq!(again_json["data"]["worktree"]["createdAt"], created_at);
    assert_ne!(
        again_json["data"]["worktree"]["lastUsedAt"],
        "2000-01-01T00:00:00.000Z"
    );
    assert_eq!(again_json["data"]["worktree"]["links"]["pr"]["number"], 7);
    let listed = repo.mabo(&["list", "--json", "--owner", "creator"]);
    assert_eq!(
        json_value(&listed)["data"]["worktrees"]
            .as_array()
            .map(Vec::len),
        Some(1)
    );
}

#[test]
fn github_checkout_refuses_before_fetch_when_the_metadata_store_is_unusable() {
    let corrupt = Repo::new();
    publish_pr_topic(&corrupt);
    let corrupt_path = fake_gh_for_topic_pr(&corrupt);
    let file = corrupt.repo.join(".git/maboroshi/workspaces");
    fs::create_dir_all(file.parent().expect("dir")).expect("dir");
    records::write(&file, "{not json").expect("corrupt");
    let refused = corrupt
        .command(env!("CARGO_BIN_EXE_mabo"), &["github", "checkout", "7"])
        .env("PATH", &corrupt_path)
        .output()
        .expect("checkout");
    assert_eq!(refused.status.code(), Some(1), "{}", text(&refused.stdout));
    assert!(
        text(&refused.stdout).is_empty(),
        "{}",
        text(&refused.stdout)
    );
    let stderr = text(&refused.stderr);
    assert!(stderr.contains("workspaces"), "{stderr}");
    assert!(stderr.contains("invalid JSON"), "{stderr}");
    assert_eq!(records::read_to_string(&file).expect("kept"), "{not json");
    assert!(
        local_branch(&corrupt, "topic").is_empty(),
        "corrupt store left {}",
        local_branch(&corrupt, "topic")
    );
    assert!(!managed(&corrupt, "topic").exists());

    let locked = Repo::new();
    publish_pr_topic(&locked);
    let locked_path = fake_gh_for_topic_pr(&locked);
    let metadata_dir = locked.repo.join(".git/maboroshi/workspaces");
    fs::create_dir_all(&metadata_dir).expect("dir");
    let store = "{\n  \"version\": 1,\n  \"worktrees\": []\n}\n";
    records::write(&metadata_dir, store).expect("store");
    let before = records::read_to_string(&metadata_dir).expect("snapshot");
    let mut perms = fs::metadata(&metadata_dir).expect("meta").permissions();
    use std::os::unix::fs::PermissionsExt;
    perms.set_mode(0o555);
    fs::set_permissions(&metadata_dir, perms).expect("chmod");
    let _restore = ModeReset(&metadata_dir);
    let unwritable = locked
        .command(
            env!("CARGO_BIN_EXE_mabo"),
            &["github", "checkout", "7", "--json"],
        )
        .env("PATH", &locked_path)
        .output()
        .expect("checkout");
    assert_eq!(
        unwritable.status.code(),
        Some(1),
        "{}",
        text(&unwritable.stdout)
    );
    let unwritable_json = json_value(&unwritable);
    assert_eq!(unwritable_json["error"]["code"], "failed");
    assert!(unwritable_json["error"].get("exitCode").is_none());
    assert!(unwritable_json["error"]["message"]
        .as_str()
        .unwrap_or("")
        .contains("not writable"));
    assert!(
        text(&unwritable.stderr).is_empty(),
        "{}",
        text(&unwritable.stderr)
    );
    assert!(
        local_branch(&locked, "topic").is_empty(),
        "unwritable store left {}",
        local_branch(&locked, "topic")
    );
    assert!(!managed(&locked, "topic").exists());
    drop(_restore);
    assert_eq!(
        records::read_to_string(&metadata_dir).expect("kept"),
        before
    );

    let ready = Repo::new();
    publish_pr_topic(&ready);
    let ready_path = fake_gh_for_topic_pr(&ready);
    let checked_out = ready
        .command(
            env!("CARGO_BIN_EXE_mabo"),
            &["github", "checkout", "7", "--json"],
        )
        .env("PATH", &ready_path)
        .output()
        .expect("checkout");
    assert!(
        checked_out.status.success(),
        "{}\n{}",
        text(&checked_out.stdout),
        text(&checked_out.stderr)
    );
    let checked_out_json = json_value(&checked_out);
    assert!(checked_out_json["error"].is_null(), "{checked_out_json}");
    assert_eq!(checked_out_json["data"]["github"]["kind"], "pullRequest");
    assert_eq!(checked_out_json["data"]["github"]["headRef"], "topic");
    assert_eq!(checked_out_json["data"]["github"]["alreadyExists"], false);
    assert_eq!(checked_out_json["data"]["metadata"]["ok"], true);
    assert!(managed(&ready, "topic").is_dir());
    assert!(
        local_branch(&ready, "topic").contains("topic"),
        "{}",
        local_branch(&ready, "topic")
    );
    let upstream = ready
        .command("git", &["rev-parse", "--abbrev-ref", "topic@{upstream}"])
        .output()
        .expect("upstream");
    assert!(upstream.status.success(), "{}", text(&upstream.stderr));
    assert_eq!(text(&upstream.stdout), "origin/topic");
}

#[test]
fn delete_refuses_when_metadata_is_not_writable() {
    let repo = Repo::new();
    let created = repo.mabo(&["create", "doomed", "--owner", "creator", "--json"]);
    assert!(created.status.success(), "{}", text(&created.stderr));
    let metadata_dir = repo.repo.join(".git/maboroshi/workspaces");
    let store = records::read_to_string(&metadata_dir).expect("store");
    use std::os::unix::fs::PermissionsExt;
    let mut locked = fs::metadata(&metadata_dir).expect("meta").permissions();
    locked.set_mode(0o555);
    fs::set_permissions(&metadata_dir, locked).expect("chmod");
    let _restore = ModeReset(&metadata_dir);
    let deleted = repo.mabo(&["delete", "doomed", "--keep-branch", "--json"]);
    assert_eq!(deleted.status.code(), Some(1), "{}", text(&deleted.stdout));
    let deleted_json = json_value(&deleted);
    assert!(deleted_json["error"]["message"]
        .as_str()
        .unwrap_or("")
        .contains("workspaces"));
    assert!(deleted_json["error"].get("exitCode").is_none());
    assert!(managed(&repo, "doomed").is_dir());
    drop(_restore);
    assert_eq!(records::read_to_string(&metadata_dir).expect("kept"), store);
}

#[test]
fn create_replaces_a_record_left_by_git_worktree_remove() {
    let repo = Repo::new();
    let created = repo.mabo(&[
        "create",
        "feature",
        "--owner",
        "first",
        "--purpose",
        "old task",
        "--json",
    ]);
    assert!(created.status.success(), "{}", text(&created.stderr));
    let created_at = json_value(&created)["data"]["worktree"]["createdAt"]
        .as_str()
        .expect("created")
        .to_string();
    let path = managed(&repo, "feature");
    repo.git(&["worktree", "remove", path.to_str().expect("path")]);
    repo.git(&["branch", "-D", "feature"]);
    let again = repo.mabo(&[
        "create",
        "feature",
        "--owner",
        "second",
        "--purpose",
        "new task",
        "--json",
    ]);
    assert!(again.status.success(), "{}", text(&again.stderr));
    let again_json = json_value(&again);
    assert_eq!(again_json["data"]["worktree"]["owner"], "second");
    assert_eq!(again_json["data"]["worktree"]["purpose"], "new task");
    assert_ne!(again_json["data"]["worktree"]["createdAt"], created_at);
    assert_eq!(again_json["data"]["metadata"]["ok"], true);
    let listed = repo.mabo(&["list", "--names", "--owner", "first"]);
    assert!(text(&listed.stdout).is_empty(), "{}", text(&listed.stdout));
    assert_eq!(
        json_value(&repo.mabo(&["list", "--json", "--owner", "second"]))["data"]["worktrees"]
            .as_array()
            .map(Vec::len),
        Some(1)
    );
}

// Metadata save failure injection is only supported in debug builds.
#[cfg(debug_assertions)]
#[test]
fn metadata_save_failure_after_create_still_runs_hooks() {
    let repo = Repo::new();
    fs::write(
        repo.repo.join(".mabo.toml"),
        "[hooks]\npost-create = [\"touch hook-ran\"]\n",
    )
    .expect("hooks");
    let created = repo
        .command(
            env!("CARGO_BIN_EXE_mabo"),
            &["create", "feature", "--owner", "creator", "--json"],
        )
        .env("MABO_TEST_FAIL_METADATA_SAVE", "1")
        .output()
        .expect("create");
    assert_eq!(created.status.code(), Some(6), "{}", text(&created.stdout));
    let created_json = json_value(&created);
    assert!(created_json["error"]["code"] == "partial", "{created_json}");
    assert_eq!(created_json["data"]["worktree"]["name"], "feature");
    assert!(created_json["data"]["worktree"]["owner"].is_null());
    assert_eq!(created_json["data"]["metadata"]["ok"], false);
    assert!(created_json["data"]["metadata"]["error"]
        .as_str()
        .unwrap_or("")
        .contains("injected"));
    assert_eq!(created_json["data"]["postCreate"]["ok"], true);
    assert_eq!(created_json["data"]["copyFiles"]["ok"], true);
    assert!(managed(&repo, "feature/hook-ran").is_file());
    assert!(text(&created.stderr).contains("Warning"));
    assert!(text(&created.stderr).contains("injected"));
    assert!(!created_json["warnings"]
        .as_array()
        .expect("warnings")
        .is_empty());
}

#[test]
fn readers_warn_on_corrupt_metadata_and_still_run() {
    let repo = Repo::new();
    let created = repo.mabo(&["create", "feature", "--owner", "creator", "--json"]);
    assert!(created.status.success(), "{}", text(&created.stderr));
    let id = json_value(&created)["data"]["worktree"]["id"]
        .as_str()
        .expect("workspace id")
        .to_string();
    assert!(repo
        .mabo(&["create", "healthy", "--owner", "reader"])
        .status
        .success());
    let file = repo
        .repo
        .join(".git/maboroshi/workspaces")
        .join(format!("{id}.json"));
    fs::write(&file, "{not json").expect("corrupt");

    let listed = repo.mabo(&["list", "--json", "--no-default"]);
    assert!(listed.status.success(), "{}", text(&listed.stderr));
    let listed_json = json_value(&listed);
    assert_eq!(listed_json["data"]["worktrees"][0]["name"], "feature");
    assert!(listed_json["data"]["worktrees"][0]["owner"].is_null());
    assert!(text(&listed.stderr).contains("workspaces"));
    let healthy = listed_json["data"]["worktrees"]
        .as_array()
        .unwrap()
        .iter()
        .find(|tree| tree["name"] == "healthy")
        .unwrap();
    assert_eq!(healthy["owner"], "reader");
    assert!(healthy["id"].as_str().unwrap().starts_with("ws_"));
    assert!(!listed_json["warnings"]
        .as_array()
        .expect("warnings")
        .is_empty());

    let located = repo.mabo(&["where", "feature", "--json"]);
    assert!(located.status.success(), "{}", text(&located.stderr));
    assert!(json_value(&located)["data"]["worktree"]["owner"].is_null());
    assert!(text(&located.stderr).contains("invalid JSON"));
    let human = repo.mabo(&["where", "feature"]);
    assert!(human.status.success());
    assert!(text(&human.stdout).starts_with('/'));

    let ran = repo.mabo(&["exec", "feature", "true"]);
    assert!(ran.status.success(), "{}", text(&ran.stderr));
    assert!(text(&ran.stderr).contains("invalid JSON"));

    assert_eq!(fs::read_to_string(&file).expect("kept"), "{not json");
}

#[test]
fn owner_flag_rejects_a_value_that_looks_like_an_option() {
    let repo = Repo::new();
    let value = repo.mabo(&["list", "--owner", "--json"]);
    assert_eq!(value.status.code(), Some(2));
    assert!(value.stdout.is_empty());
    assert!(text(&value.stderr).contains("looks like an option"));
    let listed = repo.mabo(&["list", "--json", "--owner", "--json"]);
    assert_eq!(listed.status.code(), Some(2), "{}", text(&listed.stdout));
    let listed_json = json_value(&listed);
    assert_eq!(listed_json["error"]["code"], "usage");
    assert!(listed_json["error"].get("exitCode").is_none());
    assert!(listed_json["error"]["message"]
        .as_str()
        .unwrap_or("")
        .contains("looks like an option"));
    assert!(listed_json["error"]["message"]
        .as_str()
        .unwrap_or("")
        .contains("--json"));
    assert!(text(&listed.stderr).is_empty(), "{}", text(&listed.stderr));

    let value = repo.mabo(&["create", "feature", "--purpose", "--json"]);
    assert_eq!(value.status.code(), Some(2));
    assert!(value.stdout.is_empty());
    assert!(text(&value.stderr).contains("looks like an option"));
    let created = repo.mabo(&["create", "feature", "--json", "--purpose", "--json"]);
    assert_eq!(created.status.code(), Some(2));
    assert_eq!(json_value(&created)["error"]["code"], "usage");
    assert!(!managed(&repo, "feature").exists());
}

#[test]
fn exec_command_json_flag_does_not_switch_mabo_to_json() {
    let repo = Repo::new();
    let created = repo.mabo(&["create", "topic", "--exec", "npm", "test", "--json"]);
    let stdout = text(&created.stdout);
    assert!(
        stdout.contains("Created worktree 'topic'"),
        "{stdout}\n{}",
        text(&created.stderr)
    );
    assert!(
        stdout.contains("Executing command in worktree 'topic': npm test --json"),
        "{stdout}"
    );
    assert!(
        serde_json::from_str::<serde_json::Value>(&stdout).is_err(),
        "stdout should stay human logs, not a JSON document:\n{stdout}"
    );
}

#[test]
fn separate_git_dir_creates_the_default_worktree_under_xdg() {
    let root = std::env::temp_dir().join(format!(
        "mabo-sep-default-{}-{}",
        std::process::id(),
        uuid()
    ));
    let home = root.join("home");
    let checkout = root.join("checkout");
    let sep = root.join("sep.git");
    let template = root.join("git-template");
    fs::create_dir_all(home.join(".config/git")).expect("home");
    fs::create_dir_all(&template).expect("git template");
    fs::write(home.join(".gitconfig"), "").expect("gitconfig");
    fs::create_dir_all(&checkout).expect("checkout");
    let init = std::process::Command::new("git")
        .args([
            "init",
            "--separate-git-dir",
            sep.to_str().expect("sep"),
            "-b",
            "main",
        ])
        .current_dir(&checkout)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_TEMPLATE_DIR", &template)
        .env("HOME", &home)
        .output()
        .expect("init");
    assert!(
        init.status.success(),
        "{}",
        String::from_utf8_lossy(&init.stderr)
    );
    let git = |args: &[&str]| {
        let output = std::process::Command::new("git")
            .args(args)
            .current_dir(&checkout)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("HOME", &home)
            .output()
            .expect("git");
        assert!(
            output.status.success(),
            "git {} failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&output.stderr)
        );
    };
    git(&["config", "user.name", "Phantom Rust"]);
    git(&["config", "user.email", "phantom-rust@example.com"]);
    fs::write(checkout.join("README.md"), "# sep\n").expect("readme");
    git(&["add", "README.md"]);
    git(&["commit", "-m", "initial"]);
    assert!(checkout.join(".git").is_file(), ".git is a gitdir file");

    let created = std::process::Command::new(env!("CARGO_BIN_EXE_mabo"))
        .args(["create", "feature", "--json"])
        .current_dir(&checkout)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("HOME", &home)
        .env("XDG_CONFIG_HOME", home.join(".config"))
        .env("XDG_STATE_HOME", root.join("state"))
        .env("XDG_DATA_HOME", root.join("xdg"))
        .env_remove("MABO_OUTPUT")
        .env_remove("MABO_NO_INPUT")
        .env_remove("MABO_AGENT_ID")
        .output()
        .expect("mabo");
    assert!(
        created.status.success(),
        "{}\n{}",
        text(&created.stdout),
        text(&created.stderr)
    );
    let created_json = json_value(&created);
    assert_eq!(created_json["schema"], 2);
    let worktree = managed_directory(&checkout, &root.join("xdg")).join("feature");
    assert_worktree_object(&created_json["data"]["worktree"], "feature", &worktree);
    assert!(worktree.is_dir());
    assert!(!sep
        .join("maboroshi")
        .join("worktrees")
        .join("feature")
        .exists());
    assert!(sep.join("maboroshi").join("workspaces").is_dir());
    assert!(checkout.join(".git").is_file(), ".git stayed a gitdir file");
    assert!(!checkout.join(".git").join("maboroshi").exists());
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn separate_git_dir_writes_metadata_in_the_common_dir() {
    let root = std::env::temp_dir().join(format!("mabo-sep-{}-{}", std::process::id(), uuid()));
    let home = root.join("home");
    let checkout = root.join("checkout");
    let sep = root.join("sep.git");
    let worktrees = root.join("worktrees");
    fs::create_dir_all(home.join(".config/git")).expect("home");
    fs::write(home.join(".gitconfig"), "").expect("gitconfig");
    fs::create_dir_all(&checkout).expect("checkout");
    let init = std::process::Command::new("git")
        .args([
            "init",
            "--separate-git-dir",
            sep.to_str().expect("sep"),
            "-b",
            "main",
        ])
        .current_dir(&checkout)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("HOME", &home)
        .output()
        .expect("init");
    assert!(
        init.status.success(),
        "{}",
        String::from_utf8_lossy(&init.stderr)
    );
    let git = |args: &[&str]| {
        let output = std::process::Command::new("git")
            .args(args)
            .current_dir(&checkout)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("HOME", &home)
            .output()
            .expect("git");
        assert!(
            output.status.success(),
            "git {} failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&output.stderr)
        );
    };
    git(&["config", "user.name", "Phantom Rust"]);
    git(&["config", "user.email", "phantom-rust@example.com"]);
    fs::write(checkout.join("README.md"), "# sep\n").expect("readme");
    git(&["add", "README.md"]);
    git(&["commit", "-m", "initial"]);
    assert!(checkout.join(".git").is_file(), ".git is a gitdir file");

    let mabo = |args: &[&str]| {
        std::process::Command::new(env!("CARGO_BIN_EXE_mabo"))
            .args(args)
            .current_dir(&checkout)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("HOME", &home)
            .env("XDG_CONFIG_HOME", home.join(".config"))
            .env("XDG_STATE_HOME", root.join("state"))
            .env("XDG_DATA_HOME", root.join("xdg"))
            .env_remove("MABO_OUTPUT")
            .env_remove("MABO_NO_INPUT")
            .env_remove("MABO_AGENT_ID")
            .output()
            .expect("mabo")
    };
    let pref = mabo(&[
        "preferences",
        "set",
        "worktrees-directory",
        worktrees.to_str().expect("worktrees"),
    ]);
    assert!(pref.status.success(), "{}", text(&pref.stderr));
    let created = mabo(&["create", "feature", "--owner", "sep", "--json"]);
    assert!(
        created.status.success(),
        "{}\n{}",
        text(&created.stdout),
        text(&created.stderr)
    );
    assert!(worktrees.join("feature").is_dir());
    let store = sep.join("maboroshi").join("workspaces");
    let document: serde_json::Value =
        serde_json::from_str(&records::read_to_string(&store).expect("common store"))
            .expect("json");
    assert!(document["worktrees"]
        .as_array()
        .expect("records")
        .iter()
        .any(|record| record["owner"] == "sep"));
    assert!(!checkout.join(".git").join("maboroshi").exists());
    let _ = fs::remove_dir_all(&root);
}

struct SeparateCheckout {
    root: PathBuf,
    checkout: PathBuf,
    git_dir: PathBuf,
    home: PathBuf,
}

impl SeparateCheckout {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("mabo-sep-root-{}", uuid()));
        let home = root.join("home");
        let checkout = root.join("deep").join("checkout");
        let git_dir = root.join("var").join("sep.git");
        fs::create_dir_all(home.join(".config/git")).expect("home");
        fs::write(home.join(".gitconfig"), "").expect("gitconfig");
        fs::create_dir_all(&checkout).expect("checkout");
        fs::create_dir_all(git_dir.parent().expect("git dir parent")).expect("git dir parent");
        let repo = Self {
            root,
            checkout,
            git_dir,
            home,
        };
        repo.git(&[
            "init",
            "--separate-git-dir",
            repo.git_dir.to_str().expect("git dir"),
            "-b",
            "main",
        ]);
        repo.git(&["config", "user.name", "Phantom Rust"]);
        repo.git(&["config", "user.email", "phantom-rust@example.com"]);
        fs::write(repo.checkout.join("README.md"), "# sep\n").expect("readme");
        repo.git(&["add", "README.md"]);
        repo.git(&["commit", "-m", "initial"]);
        assert!(
            repo.checkout.join(".git").is_file(),
            ".git is a gitdir file"
        );
        repo
    }

    fn git(&self, args: &[&str]) {
        let output = self
            .command("git", args, &self.checkout)
            .output()
            .expect("git");
        assert!(
            output.status.success(),
            "git {} failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn mabo(&self, cwd: &Path, args: &[&str]) -> std::process::Output {
        self.command(env!("CARGO_BIN_EXE_mabo"), args, cwd)
            .output()
            .expect("mabo")
    }

    fn command(&self, program: &str, args: &[&str], cwd: &Path) -> Command {
        let mut command = Command::new(program);
        command
            .args(args)
            .current_dir(cwd)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("HOME", &self.home)
            .env("XDG_CONFIG_HOME", self.home.join(".config"))
            .env("XDG_STATE_HOME", self.root.join("state"))
            .env("XDG_DATA_HOME", self.root.join("xdg"))
            .env_remove("GHQ_ROOT")
            .env_remove("MABO_OUTPUT")
            .env_remove("MABO_NO_INPUT")
            .env_remove("MABO_AGENT_ID")
            .env_remove("PHANTOM_AGENT_ID")
            .env_remove("GIT_CONFIG_GLOBAL")
            .env_remove("GIT_CONFIG_SYSTEM")
            .env_remove("GIT_CONFIG_COUNT")
            .env_remove("GIT_CONFIG_PARAMETERS");
        if std::path::Path::new(program)
            .file_name()
            .and_then(|name| name.to_str())
            == Some("mabo")
        {
            command.env("MABO_TRUST_ALL", "1");
        }
        if program.ends_with("git") && args.first() == Some(&"init") {
            let template = self.root.join("git-template");
            fs::create_dir_all(&template).expect("git template");
            command.env("GIT_TEMPLATE_DIR", &template);
        }
        command
    }
}

impl Drop for SeparateCheckout {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[test]
fn separate_git_dir_delete_current_removes_the_linked_worktree() {
    let repo = SeparateCheckout::new();
    let created = repo.mabo(&repo.checkout, &["create", "linked"]);
    assert!(
        created.status.success(),
        "{}\n{}",
        text(&created.stdout),
        text(&created.stderr)
    );
    let linked = managed_directory(&repo.checkout, &repo.root.join("xdg")).join("linked");
    assert!(
        linked.is_dir(),
        "default worktree lives under XDG data home"
    );
    assert!(!repo
        .git_dir
        .join("maboroshi")
        .join("worktrees")
        .join("linked")
        .exists());
    let deleted = repo.mabo(&linked, &["delete", "--current"]);
    let stdout = text(&deleted.stdout);
    let stderr = text(&deleted.stderr);
    assert!(
        deleted.status.success(),
        "delete --current from the linked worktree should remove it\n{stdout}\n{stderr}"
    );
    assert!(
        stdout.contains("Deleted worktree 'linked'"),
        "{stdout}\n{stderr}"
    );
    assert!(!linked.exists(), "linked worktree should be removed");
    assert!(
        repo.checkout.join("README.md").is_file(),
        "main checkout stays"
    );
    assert!(
        repo.checkout.join(".git").is_file(),
        "main checkout stays a gitfile, not the deleted worktree"
    );
    let branch = repo
        .command("git", &["branch", "--list", "linked"], &repo.checkout)
        .output()
        .expect("branch");
    assert!(branch.status.success(), "{}", text(&branch.stderr));
    assert!(
        text(&branch.stdout).is_empty(),
        "delete --current removes the worktree branch: {}",
        text(&branch.stdout)
    );
    let main = repo
        .command("git", &["branch", "--list", "main"], &repo.checkout)
        .output()
        .expect("main");
    assert!(
        text(&main.stdout).contains("main"),
        "{}",
        text(&main.stdout)
    );
}

#[test]
fn separate_git_dir_relative_worktrees_directory_joins_the_main_checkout() {
    let repo = SeparateCheckout::new();
    let pref = repo.mabo(
        &repo.checkout,
        &["preferences", "set", "worktrees-directory", "../wt"],
    );
    assert!(pref.status.success(), "{}", text(&pref.stderr));
    let first = repo.mabo(&repo.checkout, &["create", "r1"]);
    assert!(
        first.status.success(),
        "{}\n{}",
        text(&first.stdout),
        text(&first.stderr)
    );
    let first_path = repo.root.join("deep").join("wt").join("r1");
    assert!(
        first_path.is_dir(),
        "from the main checkout, ../wt is deep/wt"
    );
    let second = repo.mabo(&first_path, &["create", "r2"]);
    let stdout = text(&second.stdout);
    let stderr = text(&second.stderr);
    assert!(second.status.success(), "{stdout}\n{stderr}");
    let expected = repo.root.join("deep").join("wt").join("r2");
    assert!(
        expected.is_dir(),
        "relative worktrees-directory stays joined to the main checkout\n{stdout}\n{stderr}"
    );
    assert!(
        !repo
            .root
            .join("deep")
            .join("wt")
            .join("wt")
            .join("r2")
            .exists(),
        "must not nest under the linked worktree"
    );
    assert!(
        !repo.root.join("var").join("wt").join("r2").exists(),
        "must not join the relative directory to the separate git dir"
    );
    assert!(repo.checkout.join("README.md").is_file());
}

#[test]
fn submodule_delete_current_and_relative_directory_use_the_submodule_checkout() {
    let root = std::env::temp_dir().join(format!("mabo-sub-root-{}", uuid()));
    let home = root.join("home");
    let remote = root.join("remote");
    let superproject = root.join("super");
    let checkout = superproject.join("sub");
    fs::create_dir_all(home.join(".config/git")).expect("home");
    fs::write(home.join(".gitconfig"), "").expect("gitconfig");
    fs::create_dir_all(&remote).expect("remote");
    fs::create_dir_all(&superproject).expect("super");
    let git = |cwd: &Path, args: &[&str]| {
        let output = Command::new("git")
            .args(args)
            .current_dir(cwd)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("HOME", &home)
            .env_remove("GIT_CONFIG_GLOBAL")
            .env_remove("GIT_CONFIG_SYSTEM")
            .output()
            .expect("git");
        assert!(
            output.status.success(),
            "git {} failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&output.stderr)
        );
    };
    git(&remote, &["init", "-b", "main"]);
    git(&remote, &["config", "user.name", "Phantom Rust"]);
    git(
        &remote,
        &["config", "user.email", "phantom-rust@example.com"],
    );
    fs::write(remote.join("f"), "hi\n").expect("file");
    git(&remote, &["add", "f"]);
    git(&remote, &["commit", "-m", "initial"]);
    git(&superproject, &["init", "-b", "main"]);
    git(&superproject, &["config", "user.name", "Phantom Rust"]);
    git(
        &superproject,
        &["config", "user.email", "phantom-rust@example.com"],
    );
    let added = Command::new("git")
        .args([
            "-c",
            "protocol.file.allow=always",
            "submodule",
            "add",
            remote.to_str().expect("remote"),
            "sub",
        ])
        .current_dir(&superproject)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("HOME", &home)
        .env_remove("GIT_CONFIG_GLOBAL")
        .output()
        .expect("submodule add");
    assert!(
        added.status.success(),
        "{}",
        String::from_utf8_lossy(&added.stderr)
    );
    git(&superproject, &["commit", "-m", "add submodule"]);
    let mabo = |cwd: &Path, args: &[&str]| {
        Command::new(env!("CARGO_BIN_EXE_mabo"))
            .args(args)
            .current_dir(cwd)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("HOME", &home)
            .env("XDG_CONFIG_HOME", home.join(".config"))
            .env("XDG_STATE_HOME", root.join("state"))
            .env("XDG_DATA_HOME", root.join("xdg"))
            .env_remove("MABO_OUTPUT")
            .env_remove("MABO_NO_INPUT")
            .env_remove("MABO_AGENT_ID")
            .output()
            .expect("mabo")
    };
    let created = mabo(&checkout, &["create", "linked"]);
    assert!(
        created.status.success(),
        "{}\n{}",
        text(&created.stdout),
        text(&created.stderr)
    );
    let linked = managed_directory(&checkout, &root.join("xdg")).join("linked");
    assert!(!superproject
        .join(".git/modules/sub/maboroshi/worktrees/linked")
        .exists());
    assert!(linked.is_dir());
    let deleted = mabo(&linked, &["delete", "--current"]);
    assert!(
        deleted.status.success(),
        "{}\n{}",
        text(&deleted.stdout),
        text(&deleted.stderr)
    );
    assert!(!linked.exists());
    assert!(checkout.join(".git").is_file(), "submodule checkout stays");
    let pref = mabo(
        &checkout,
        &["preferences", "set", "worktrees-directory", "../wt"],
    );
    assert!(pref.status.success(), "{}", text(&pref.stderr));
    let first = mabo(&checkout, &["create", "r1"]);
    assert!(first.status.success(), "{}", text(&first.stderr));
    let first_path = superproject.join("wt").join("r1");
    assert!(first_path.is_dir());
    let second = mabo(&first_path, &["create", "r2"]);
    assert!(
        second.status.success(),
        "{}\n{}",
        text(&second.stdout),
        text(&second.stderr)
    );
    assert!(superproject.join("wt").join("r2").is_dir());
    assert!(!superproject.join("wt").join("wt").join("r2").exists());
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn ambiguous_gitfiles_fail_until_core_worktree_is_set() {
    let root = std::env::temp_dir().join(format!("mabo-ambiguous-{}", uuid()));
    let home = root.join("home");
    let real = root.join("zz-real");
    let copy = root.join("aa-copy");
    let git_dir = root.join("var").join("sep.git");
    fs::create_dir_all(home.join(".config/git")).expect("home");
    fs::write(home.join(".gitconfig"), "").expect("gitconfig");
    fs::create_dir_all(&real).expect("checkout");
    fs::create_dir_all(git_dir.parent().expect("parent")).expect("var");
    let git = |cwd: &Path, args: &[&str]| {
        let output = Command::new("git")
            .args(args)
            .current_dir(cwd)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("HOME", &home)
            .env("GIT_TEMPLATE_DIR", {
                let template = root.join("git-template");
                fs::create_dir_all(&template).expect("template");
                template
            })
            .env_remove("GIT_CONFIG_GLOBAL")
            .env_remove("GIT_CONFIG_SYSTEM")
            .output()
            .expect("git");
        assert!(
            output.status.success(),
            "git {} failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&output.stderr)
        );
    };
    git(
        &real,
        &[
            "init",
            "--separate-git-dir",
            git_dir.to_str().expect("git dir"),
            "-b",
            "main",
        ],
    );
    git(&real, &["config", "user.name", "Phantom Rust"]);
    git(&real, &["config", "user.email", "phantom-rust@example.com"]);
    git(&real, &["commit", "--allow-empty", "-m", "initial"]);
    copy_dir(&real, &copy);
    let linked = git_dir.join("maboroshi").join("worktrees").join("q");
    git(
        &real,
        &[
            "worktree",
            "add",
            "-b",
            "q",
            linked.to_str().expect("linked"),
        ],
    );
    let mabo = |cwd: &Path, args: &[&str]| {
        Command::new(env!("CARGO_BIN_EXE_mabo"))
            .args(args)
            .current_dir(cwd)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("HOME", &home)
            .env("XDG_CONFIG_HOME", home.join(".config"))
            .env("XDG_STATE_HOME", root.join("state"))
            .env("XDG_DATA_HOME", root.join("xdg"))
            .env_remove("MABO_OUTPUT")
            .env_remove("MABO_NO_INPUT")
            .env_remove("MABO_AGENT_ID")
            .output()
            .expect("mabo")
    };

    for checkout in [&copy, &real] {
        let here = mabo(checkout, &["list", "--json"]);
        assert!(
            here.status.success(),
            "running inside {} should use that checkout\n{}\n{}",
            checkout.display(),
            text(&here.stdout),
            text(&here.stderr)
        );
        let main = default_worktree(&json_value(&here));
        assert!(
            paths_match(main["path"].as_str().unwrap_or(""), checkout),
            "got {}",
            main["path"]
        );
        assert_eq!(main["default"], true);
        let ran = mabo(checkout, &["exec", "main", "pwd"]);
        assert!(ran.status.success(), "{}", text(&ran.stderr));
        assert!(
            paths_match(text(&ran.stdout).trim(), checkout),
            "exec main ran in {}",
            text(&ran.stdout)
        );
    }

    let listed = mabo(&linked, &["list"]);
    assert_eq!(
        listed.status.code(),
        Some(1),
        "two gitfiles must not resolve to the first sorted checkout\n{}\n{}",
        text(&listed.stdout),
        text(&listed.stderr)
    );
    let stderr = text(&listed.stderr);
    assert!(stderr.contains(real.to_str().expect("real")), "{stderr}");
    assert!(stderr.contains(copy.to_str().expect("copy")), "{stderr}");
    assert!(stderr.contains("core.worktree"), "{stderr}");
    assert!(!stderr.to_ascii_lowercase().contains("fatal:"), "{stderr}");
    assert!(text(&listed.stdout).is_empty(), "{}", text(&listed.stdout));

    let json_error = mabo(&linked, &["list", "--json"]);
    assert_eq!(json_error.status.code(), Some(1));
    assert!(
        text(&json_error.stderr).is_empty(),
        "{}",
        text(&json_error.stderr)
    );
    let error = json_value(&json_error);
    assert_eq!(error["schema"], 2);
    assert_eq!(error["error"]["code"], "failed");
    assert!(error["error"].get("exitCode").is_none());
    let message = error["error"]["message"].as_str().unwrap_or("");
    assert!(message.contains(real.to_str().expect("real")), "{message}");
    assert!(message.contains(copy.to_str().expect("copy")), "{message}");
    assert!(message.contains("core.worktree"), "{message}");
    assert!(
        !message.to_ascii_lowercase().contains("fatal:"),
        "{message}"
    );

    git(
        &real,
        &["config", "core.worktree", real.to_str().expect("real")],
    );
    let resolved = mabo(&linked, &["list", "--json"]);
    assert!(
        resolved.status.success(),
        "{}\n{}",
        text(&resolved.stdout),
        text(&resolved.stderr)
    );
    let main = default_worktree(&json_value(&resolved));
    assert!(
        paths_match(main["path"].as_str().unwrap_or(""), &real),
        "core.worktree selects zz-real, got {}",
        main["path"]
    );
    assert_eq!(main["default"], true);
    let ran = mabo(&linked, &["exec", "main", "pwd"]);
    assert!(
        ran.status.success(),
        "{}\n{}",
        text(&ran.stdout),
        text(&ran.stderr)
    );
    assert!(
        paths_match(text(&ran.stdout).trim(), &real),
        "exec main ran in {}",
        text(&ran.stdout)
    );
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn missing_separate_checkout_names_the_git_dir() {
    let root = std::env::temp_dir().join(format!("mabo-missing-checkout-{}", uuid()));
    let home = root.join("home");
    let checkout = root.join("deep").join("checkout");
    let git_dir = root.join("var").join("sep.git");
    fs::create_dir_all(home.join(".config/git")).expect("home");
    fs::write(home.join(".gitconfig"), "").expect("gitconfig");
    fs::create_dir_all(&checkout).expect("checkout");
    fs::create_dir_all(git_dir.parent().expect("parent")).expect("var");
    let init = Command::new("git")
        .args([
            "init",
            "--separate-git-dir",
            git_dir.to_str().expect("git dir"),
            "-b",
            "main",
        ])
        .current_dir(&checkout)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("HOME", &home)
        .env_remove("GIT_CONFIG_GLOBAL")
        .output()
        .expect("init");
    assert!(
        init.status.success(),
        "{}",
        String::from_utf8_lossy(&init.stderr)
    );
    fs::remove_dir_all(&checkout).expect("remove checkout");
    let listed = Command::new(env!("CARGO_BIN_EXE_mabo"))
        .args(["list", "--json"])
        .current_dir(&git_dir)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("HOME", &home)
        .env("XDG_CONFIG_HOME", home.join(".config"))
        .env("XDG_STATE_HOME", root.join("state"))
        .env("XDG_DATA_HOME", root.join("xdg"))
        .env_remove("MABO_OUTPUT")
        .env_remove("MABO_NO_INPUT")
        .env_remove("MABO_AGENT_ID")
        .output()
        .expect("mabo");
    assert_eq!(
        listed.status.code(),
        Some(1),
        "{}\n{}",
        text(&listed.stdout),
        text(&listed.stderr)
    );
    assert!(text(&listed.stderr).is_empty(), "{}", text(&listed.stderr));
    let error = json_value(&listed);
    let message = error["error"]["message"].as_str().unwrap_or("");
    assert!(
        message.contains(git_dir.to_str().expect("git dir")),
        "{message}"
    );
    assert!(message.contains("core.worktree"), "{message}");
    assert!(
        !message.to_ascii_lowercase().contains("fatal:"),
        "{message}"
    );
    assert_eq!(error["error"]["code"], "failed");
    assert!(error["error"].get("exitCode").is_none());
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn separate_git_dir_outside_the_search_lists_from_the_checkout() {
    let root = std::env::temp_dir().join(format!("mabo-far-checkout-{}", uuid()));
    let home = root.join("home");
    fs::create_dir_all(home.join(".config/git")).expect("home");
    fs::write(home.join(".gitconfig"), "").expect("gitconfig");
    let mabo = |cwd: &Path, args: &[&str]| {
        Command::new(env!("CARGO_BIN_EXE_mabo"))
            .args(args)
            .current_dir(cwd)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("HOME", &home)
            .env("XDG_CONFIG_HOME", home.join(".config"))
            .env("XDG_STATE_HOME", root.join("state"))
            .env("XDG_DATA_HOME", root.join("xdg"))
            .env_remove("MABO_OUTPUT")
            .env_remove("MABO_NO_INPUT")
            .env_remove("MABO_AGENT_ID")
            .env_remove("GIT_CONFIG_GLOBAL")
            .env_remove("GIT_CONFIG_SYSTEM")
            .output()
            .expect("mabo")
    };
    let init_checkout = |checkout: &Path, git_dir: &Path| {
        fs::create_dir_all(checkout).expect("checkout");
        fs::create_dir_all(git_dir.parent().expect("git parent")).expect("git parent");
        let init = Command::new("git")
            .args([
                "init",
                "--separate-git-dir",
                git_dir.to_str().expect("git dir"),
                "-b",
                "main",
            ])
            .current_dir(checkout)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("HOME", &home)
            .env_remove("GIT_CONFIG_GLOBAL")
            .output()
            .expect("init");
        assert!(
            init.status.success(),
            "{}",
            String::from_utf8_lossy(&init.stderr)
        );
        let git = |args: &[&str]| {
            let output = Command::new("git")
                .args(args)
                .current_dir(checkout)
                .env("GIT_CONFIG_NOSYSTEM", "1")
                .env("HOME", &home)
                .output()
                .expect("git");
            assert!(
                output.status.success(),
                "git {} failed: {}",
                args.join(" "),
                String::from_utf8_lossy(&output.stderr)
            );
        };
        git(&["config", "user.name", "Phantom Rust"]);
        git(&["config", "user.email", "phantom-rust@example.com"]);
        git(&["commit", "--allow-empty", "-m", "initial"]);
    };

    for index in 1..=30 {
        let wide = root.join(format!("dir{index:02}"));
        for name in ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"] {
            fs::create_dir_all(wide.join(name)).expect("wide child");
        }
    }
    let wide_checkout = root.join("src").join("proj");
    init_checkout(&wide_checkout, &root.join(".gitdirs").join("proj.git"));
    let listed = mabo(&wide_checkout, &["list", "--json"]);
    assert!(
        listed.status.success(),
        "list from a checkout beside wide siblings\n{}\n{}",
        text(&listed.stdout),
        text(&listed.stderr)
    );
    let main = default_worktree(&json_value(&listed));
    assert!(
        paths_match(main["path"].as_str().unwrap_or(""), &wide_checkout),
        "{}",
        main["path"]
    );
    assert_eq!(main["default"], true);

    let deep_checkout = root
        .join("1")
        .join("2")
        .join("3")
        .join("4")
        .join("5")
        .join("6");
    init_checkout(&deep_checkout, &root.join("deep.git"));
    let deep = mabo(&deep_checkout, &["list", "--json"]);
    assert!(
        deep.status.success(),
        "list from a checkout six levels down\n{}\n{}",
        text(&deep.stdout),
        text(&deep.stderr)
    );
    let deep_main = default_worktree(&json_value(&deep));
    assert!(
        paths_match(deep_main["path"].as_str().unwrap_or(""), &deep_checkout),
        "{}",
        deep_main["path"]
    );
    assert_eq!(deep_main["default"], true);
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn core_worktree_without_a_gitfile_names_that_path() {
    let repo = SeparateCheckout::new();
    let created = repo.mabo(&repo.checkout, &["create", "linked"]);
    assert!(
        created.status.success(),
        "{}\n{}",
        text(&created.stdout),
        text(&created.stderr)
    );
    let empty = repo.root.join("empty");
    fs::create_dir_all(&empty).expect("empty");
    repo.git(&["config", "core.worktree", empty.to_str().expect("empty")]);
    let linked = managed_directory(&repo.checkout, &repo.root.join("xdg")).join("linked");
    let listed = repo.mabo(&linked, &["list"]);
    assert_eq!(
        listed.status.code(),
        Some(1),
        "{}\n{}",
        text(&listed.stdout),
        text(&listed.stderr)
    );
    let stderr = text(&listed.stderr);
    assert!(stderr.contains(empty.to_str().expect("empty")), "{stderr}");
    assert!(stderr.contains("gitfile"), "{stderr}");
    assert!(!stderr.contains("Set the main checkout"), "{stderr}");
    assert!(!stderr.to_ascii_lowercase().contains("fatal:"), "{stderr}");
    let json = repo.mabo(&linked, &["list", "--json"]);
    assert_eq!(json.status.code(), Some(1));
    assert!(text(&json.stderr).is_empty(), "{}", text(&json.stderr));
    let message = json_value(&json)["error"]["message"]
        .as_str()
        .unwrap_or("")
        .to_string();
    assert!(message.contains("gitfile"), "{message}");
    assert!(
        message.contains(empty.to_str().expect("empty")),
        "{message}"
    );
    assert!(!message.contains("Set the main checkout"), "{message}");
}

#[test]
fn separate_git_dir_lists_and_execs_the_main_checkout() {
    let repo = SeparateCheckout::new();
    let created = repo.mabo(&repo.checkout, &["create", "linked"]);
    assert!(
        created.status.success(),
        "{}\n{}",
        text(&created.stdout),
        text(&created.stderr)
    );
    let linked = managed_directory(&repo.checkout, &repo.root.join("xdg")).join("linked");
    assert_main_checkout(&repo, &linked, &repo.checkout, &repo.git_dir);
}

#[test]
fn submodule_lists_and_execs_the_main_checkout() {
    let root = std::env::temp_dir().join(format!("mabo-sub-list-{}", uuid()));
    let home = root.join("home");
    let remote = root.join("remote");
    let superproject = root.join("super");
    let checkout = superproject.join("sub");
    fs::create_dir_all(home.join(".config/git")).expect("home");
    fs::write(home.join(".gitconfig"), "").expect("gitconfig");
    fs::create_dir_all(&remote).expect("remote");
    fs::create_dir_all(&superproject).expect("super");
    let git = |cwd: &Path, args: &[&str]| {
        let output = Command::new("git")
            .args(args)
            .current_dir(cwd)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("HOME", &home)
            .env_remove("GIT_CONFIG_GLOBAL")
            .env_remove("GIT_CONFIG_SYSTEM")
            .output()
            .expect("git");
        assert!(
            output.status.success(),
            "git {} failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&output.stderr)
        );
    };
    git(&remote, &["init", "-b", "main"]);
    git(&remote, &["config", "user.name", "Phantom Rust"]);
    git(
        &remote,
        &["config", "user.email", "phantom-rust@example.com"],
    );
    fs::write(remote.join("f"), "hi\n").expect("file");
    git(&remote, &["add", "f"]);
    git(&remote, &["commit", "-m", "initial"]);
    git(&superproject, &["init", "-b", "main"]);
    git(&superproject, &["config", "user.name", "Phantom Rust"]);
    git(
        &superproject,
        &["config", "user.email", "phantom-rust@example.com"],
    );
    let added = Command::new("git")
        .args([
            "-c",
            "protocol.file.allow=always",
            "submodule",
            "add",
            remote.to_str().expect("remote"),
            "sub",
        ])
        .current_dir(&superproject)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("HOME", &home)
        .env_remove("GIT_CONFIG_GLOBAL")
        .output()
        .expect("submodule add");
    assert!(
        added.status.success(),
        "{}",
        String::from_utf8_lossy(&added.stderr)
    );
    git(&superproject, &["commit", "-m", "add submodule"]);
    let mabo = |cwd: &Path, args: &[&str]| {
        Command::new(env!("CARGO_BIN_EXE_mabo"))
            .args(args)
            .current_dir(cwd)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("HOME", &home)
            .env("XDG_CONFIG_HOME", home.join(".config"))
            .env("XDG_STATE_HOME", root.join("state"))
            .env("XDG_DATA_HOME", root.join("xdg"))
            .env_remove("MABO_OUTPUT")
            .env_remove("MABO_NO_INPUT")
            .env_remove("MABO_AGENT_ID")
            .output()
            .expect("mabo")
    };
    let created = mabo(&checkout, &["create", "linked"]);
    assert!(
        created.status.success(),
        "{}\n{}",
        text(&created.stdout),
        text(&created.stderr)
    );
    let git_dir = superproject.join(".git").join("modules").join("sub");
    let linked = managed_directory(&checkout, &root.join("xdg")).join("linked");
    assert!(git_dir.join("maboroshi").join("workspaces").is_dir());
    assert!(!git_dir
        .join("maboroshi")
        .join("worktrees")
        .join("linked")
        .exists());
    let listed = mabo(&linked, &["list"]);
    assert!(
        listed.status.success(),
        "{}\n{}",
        text(&listed.stdout),
        text(&listed.stderr)
    );
    let stdout = text(&listed.stdout);
    assert!(
        stdout
            .lines()
            .any(|line| line.starts_with("main (") && line.contains("sub)")),
        "main entry should be the submodule checkout\n{stdout}"
    );
    let json = mabo(&linked, &["list", "--json"]);
    assert!(json.status.success(), "{}", text(&json.stderr));
    assert!(text(&json.stderr).is_empty(), "{}", text(&json.stderr));
    let main = default_worktree(&json_value(&json));
    assert!(
        paths_match(main["path"].as_str().unwrap_or(""), &checkout),
        "{}",
        main["path"]
    );
    assert_eq!(main["default"], true);
    let hidden = mabo(&linked, &["list", "--no-default", "--json"]);
    assert!(hidden.status.success(), "{}", text(&hidden.stderr));
    let hidden_rows = json_value(&hidden)["data"]["worktrees"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    assert!(
        hidden_rows.iter().all(|row| row["default"] != true
            && !paths_match(row["path"].as_str().unwrap_or(""), &checkout)),
        "{hidden_rows:?}"
    );
    assert!(
        hidden_rows.iter().any(|row| row["name"] == "linked"),
        "{hidden_rows:?}"
    );
    let ran = mabo(&linked, &["exec", "main", "pwd"]);
    assert!(
        ran.status.success(),
        "{}\n{}",
        text(&ran.stdout),
        text(&ran.stderr)
    );
    assert!(
        paths_match(text(&ran.stdout).trim(), &checkout),
        "exec main ran in {}",
        text(&ran.stdout)
    );
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn running_inside_dot_git_returns_a_mabo_error() {
    let repo = Repo::new();
    for cwd in [repo.repo.join(".git"), repo.repo.join(".git").join("refs")] {
        let listed = repo
            .command(env!("CARGO_BIN_EXE_mabo"), &["list"])
            .current_dir(&cwd)
            .output()
            .expect("mabo");
        assert_eq!(
            listed.status.code(),
            Some(1),
            "{} should not be a work tree\n{}\n{}",
            cwd.display(),
            text(&listed.stdout),
            text(&listed.stderr)
        );
        let stderr = text(&listed.stderr);
        assert!(stderr.contains("work tree"), "{stderr}");
        assert!(!stderr.to_ascii_lowercase().contains("fatal:"), "{stderr}");
        assert!(text(&listed.stdout).is_empty(), "{}", text(&listed.stdout));

        let json = repo
            .command(env!("CARGO_BIN_EXE_mabo"), &["list", "--json"])
            .current_dir(&cwd)
            .output()
            .expect("mabo");
        assert_eq!(json.status.code(), Some(1), "{}", cwd.display());
        assert!(text(&json.stderr).is_empty(), "{}", text(&json.stderr));
        let error = json_value(&json);
        assert_eq!(error["schema"], 2);
        assert_eq!(error["error"]["code"], "failed");
        assert!(error["error"].get("exitCode").is_none());
        let message = error["error"]["message"].as_str().unwrap_or("");
        assert!(message.contains("work tree"), "{message}");
        assert!(
            !message.to_ascii_lowercase().contains("fatal:"),
            "{message}"
        );
        assert!(error["data"]["worktrees"].is_null());
    }
}

fn assert_main_checkout(repo: &SeparateCheckout, linked: &Path, checkout: &Path, git_dir: &Path) {
    let listed = repo.mabo(linked, &["list"]);
    assert!(
        listed.status.success(),
        "{}\n{}",
        text(&listed.stdout),
        text(&listed.stderr)
    );
    let stdout = text(&listed.stdout);
    assert!(
        stdout.contains("deep/checkout"),
        "human list should name the checkout\n{stdout}"
    );
    assert!(
        !stdout.contains("sep.git"),
        "human list should not show the git dir\n{stdout}"
    );
    let json = repo.mabo(linked, &["list", "--json"]);
    assert!(json.status.success(), "{}", text(&json.stderr));
    assert!(text(&json.stderr).is_empty(), "{}", text(&json.stderr));
    let document = json_value(&json);
    assert_eq!(document["schema"], 2);
    let rows = document["data"]["worktrees"].as_array().expect("worktrees");
    assert!(
        rows.iter()
            .all(|row| !paths_match(row["path"].as_str().unwrap_or(""), git_dir)),
        "git dir is still a worktree path: {rows:?}"
    );
    let main = default_worktree(&document);
    assert!(
        paths_match(main["path"].as_str().unwrap_or(""), checkout),
        "{}",
        main["path"]
    );
    assert_eq!(main["default"], true);
    let hidden = repo.mabo(linked, &["list", "--no-default"]);
    assert!(hidden.status.success(), "{}", text(&hidden.stderr));
    let hidden_text = text(&hidden.stdout);
    assert!(
        !hidden_text.lines().any(|line| line.starts_with("main ")),
        "--no-default still shows main\n{hidden_text}"
    );
    assert!(hidden_text.contains("linked"), "{hidden_text}");
    let ran = repo.mabo(linked, &["exec", "main", "pwd"]);
    assert!(
        ran.status.success(),
        "{}\n{}",
        text(&ran.stdout),
        text(&ran.stderr)
    );
    assert!(
        paths_match(text(&ran.stdout).trim(), checkout),
        "exec main ran in {}",
        text(&ran.stdout)
    );
}

fn default_worktree(document: &serde_json::Value) -> serde_json::Value {
    document["data"]["worktrees"]
        .as_array()
        .and_then(|rows| rows.iter().find(|row| row["default"] == true))
        .cloned()
        .unwrap_or_else(|| panic!("no default worktree in {document}"))
}

fn copy_dir(from: &Path, to: &Path) {
    let status = Command::new("cp")
        .args(["-a", from.to_str().expect("from"), to.to_str().expect("to")])
        .status()
        .expect("cp");
    assert!(status.success(), "cp failed");
}

#[test]
fn blocked_project_import_exits_failure_and_preserves_legacy_for_retry() {
    for json in [false, true] {
        let repo = Repo::new();
        let state = repo.root.join("state/maboroshi");
        fs::create_dir_all(&state).unwrap();
        let legacy = state.join("projects.json");
        let fixture = include_str!("fixtures/alpha6/projects.json");
        fs::write(&legacy, fixture).unwrap();
        let target = state.join("repos");
        fs::write(&target, "blocker").unwrap();
        let mut args = vec!["project", "add"];
        if json {
            args.push("--json");
        }
        let failed = repo.mabo(&args);
        assert_eq!(failed.status.code(), Some(1), "{}", text(&failed.stdout));
        if json {
            assert_eq!(json_value(&failed)["ok"], false);
            assert!(failed.stderr.is_empty());
        } else {
            assert!(!failed.stderr.is_empty());
        }
        assert_eq!(fs::read_to_string(&legacy).unwrap(), fixture);
        assert!(!legacy.with_extension("json.imported").exists());
        assert_eq!(fs::read_to_string(&target).unwrap(), "blocker");
        fs::remove_file(&target).unwrap();
        let retried = repo.mabo(&args);
        assert!(retried.status.success(), "{}", text(&retried.stderr));
        let store = maboroshi::projects::ProjectRegistryStore::new(state);
        let records = store.list().unwrap();
        assert_eq!(records.len(), 3);
        let original: serde_json::Value = serde_json::from_str(fixture).unwrap();
        for project in original["projects"].as_array().unwrap() {
            assert!(records
                .iter()
                .any(|record| serde_json::to_value(record).unwrap() == *project));
        }
        assert!(!legacy.exists());
        assert_eq!(
            fs::read_to_string(legacy.with_extension("json.imported")).unwrap(),
            fixture
        );
    }
}

#[test]
fn blocked_workspace_import_exits_failure_and_preserves_legacy_for_retry() {
    for json in [false, true] {
        let repo = Repo::new();
        let legacy = repo.repo.join(".git/maboroshi/worktrees.json");
        fs::create_dir_all(legacy.parent().unwrap()).unwrap();
        let fixture = include_str!("fixtures/alpha6/worktrees.json");
        fs::write(&legacy, fixture).unwrap();
        let before = maboroshi::metadata::load_strict(&repo.repo).unwrap();
        let target = legacy.parent().unwrap().join("workspaces");
        fs::write(&target, "blocker").unwrap();
        let mut args = vec!["meta", "set", "main", "--owner", "new-owner"];
        if json {
            args.push("--json");
        }
        let failed = repo.mabo(&args);
        assert_eq!(failed.status.code(), Some(1), "{}", text(&failed.stdout));
        if json {
            assert_eq!(json_value(&failed)["ok"], false);
            assert!(failed.stderr.is_empty());
        } else {
            assert!(!failed.stderr.is_empty());
        }
        assert_eq!(fs::read_to_string(&legacy).unwrap(), fixture);
        assert!(!legacy.with_extension("json.imported").exists());
        assert_eq!(fs::read_to_string(&target).unwrap(), "blocker");
        fs::remove_file(&target).unwrap();
        assert_eq!(
            maboroshi::metadata::load_strict(&repo.repo).unwrap(),
            before
        );
        let retried = repo.mabo(&args);
        assert!(retried.status.success(), "{}", text(&retried.stderr));
        let after = maboroshi::metadata::load_strict(&repo.repo).unwrap();
        assert_eq!(after.len(), before.len() + 1);
        for (path, old) in before {
            let mut imported = after[&path].clone();
            imported.id = None;
            assert_eq!(imported, old);
        }
        assert!(!legacy.exists());
        assert_eq!(
            fs::read_to_string(legacy.with_extension("json.imported")).unwrap(),
            fixture
        );
    }
}

#[test]
fn duplicate_legacy_metadata_paths_block_mutations() {
    let repo = Repo::new();
    let created = repo.mabo(&["create", "kept", "--owner", "creator"]);
    assert!(created.status.success(), "{}", text(&created.stderr));
    repo.git(&["branch", "side"]);
    fs::remove_dir_all(repo.repo.join(".git/maboroshi/workspaces")).expect("remove records");
    let file = repo.repo.join(".git/maboroshi/worktrees.json");
    let body = "{\n  \"version\": 1,\n  \"worktrees\": [\n    {\"path\": \"/tmp/one\", \"owner\": \"a\"},\n    {\"path\": \"/tmp/one\", \"owner\": \"b\"}\n  ]\n}\n";
    records::write(&file, body).expect("duplicate");
    let before = records::read_to_string(&file).expect("snapshot");
    for args in [
        vec!["create", "other", "--json"],
        vec!["attach", "side", "--json"],
        vec!["delete", "kept", "--json"],
        vec!["meta", "set", "kept", "--owner", "nope", "--json"],
        vec!["gc", "--json"],
    ] {
        let output = repo.mabo(&args);
        assert!(
            !output.status.success(),
            "{args:?}\n{}\n{}",
            text(&output.stdout),
            text(&output.stderr)
        );
        let message = format!("{}{}", text(&output.stdout), text(&output.stderr));
        assert!(message.contains("duplicate path"), "{args:?}\n{message}");
        assert_eq!(
            records::read_to_string(&file).expect("kept"),
            before,
            "{args:?}"
        );
    }
    assert!(managed(&repo, "kept").is_dir());
    assert!(!managed(&repo, "other").exists());
    assert!(!managed(&repo, "side").exists());
}

fn worktree_dir(repo: &Repo, name: &str) -> PathBuf {
    managed_root(repo).join(name)
}

fn branch_listed(repo: &Repo, name: &str) -> bool {
    let output = repo
        .command("git", &["branch", "--list", name])
        .output()
        .expect("branch");
    !text(&output.stdout).is_empty()
}

fn worktree_registered(repo: &Repo, name: &str) -> bool {
    let output = repo
        .command("git", &["worktree", "list", "--porcelain"])
        .output()
        .expect("worktrees");
    let path = worktree_dir(repo, name);
    text(&output.stdout).contains(&path.to_string_lossy().to_string())
}

fn reserve_project_dir(git_root: &Path, xdg: &Path) {
    let common = maboroshi::git::canonical_common_dir(git_root).expect("common dir");
    let directory = maboroshi::paths::default_worktrees_directory(git_root, &common, xdg).path;
    maboroshi::paths::ensure_worktrees_directory(&directory, Some(&common)).expect("project dir");
}

fn land_branch(repo: &Repo, name: &str) {
    commit_in_worktree(repo, name);
    repo.git(&["merge", "--ff-only", name]);
}

fn commit_in_worktree(repo: &Repo, name: &str) {
    let file = format!("{name}.txt");
    commit_file(repo, name, &file, &format!("{name}\n"));
}

fn commit_file(repo: &Repo, name: &str, file: &str, body: &str) {
    let dir = worktree_dir(repo, name);
    fs::write(dir.join(file), body).expect("note");
    for args in [vec!["add", file], vec!["commit", "-m", file]] {
        let output = repo
            .command("git", &args)
            .current_dir(&dir)
            .output()
            .expect("commit");
        assert!(
            output.status.success(),
            "git {args:?}: stderr={} stdout={}",
            text(&output.stderr),
            text(&output.stdout)
        );
    }
}

fn publish_branch(repo: &Repo, name: &str) {
    let bare = repo.root.join("origin.git");
    let spec = bare.to_str().expect("bare path");
    if !bare.exists() {
        repo.git(&["init", "--bare", spec]);
        repo.git(&["remote", "add", "origin", spec]);
        repo.git(&["push", "-u", "origin", "main"]);
    }
    repo.git(&["push", "-u", "origin", name]);
}

fn squash_onto_main(repo: &Repo, name: &str) {
    repo.git(&["merge", "--squash", name]);
    let message = format!("squash {name}");
    repo.git(&["commit", "-m", &message]);
    if repo.root.join("origin.git").exists() {
        repo.git(&["push", "origin", "main"]);
        repo.git(&["push", "origin", "--delete", name]);
    }
}

fn clear_created_from(repo: &Repo, name: &str) {
    let file = repo.repo.join(".git/maboroshi/workspaces");
    let mut document: serde_json::Value =
        serde_json::from_str(&records::read_to_string(&file).expect("store")).expect("json");
    let records = document["worktrees"].as_array_mut().expect("records");
    let record = records
        .iter_mut()
        .find(|record| {
            record["path"].as_str().is_some_and(|path| {
                Path::new(path).file_name().and_then(|part| part.to_str()) == Some(name)
            })
        })
        .expect(name);
    record
        .as_object_mut()
        .expect("record")
        .remove("createdFrom");
    records::write(
        &file,
        format!(
            "{}\n",
            serde_json::to_string_pretty(&document).expect("encode")
        ),
    )
    .expect("rewrite");
}

fn age_metadata(repo: &Repo, name: &str) {
    let file = repo.repo.join(".git/maboroshi/workspaces");
    let mut document: serde_json::Value =
        serde_json::from_str(&records::read_to_string(&file).expect("store")).expect("json");
    let records = document["worktrees"].as_array_mut().expect("records");
    let record = records
        .iter_mut()
        .find(|record| {
            record["path"].as_str().is_some_and(|path| {
                Path::new(path).file_name().and_then(|part| part.to_str()) == Some(name)
            })
        })
        .expect(name);
    record["lastUsedAt"] = serde_json::json!("2000-01-01T00:00:00.000Z");
    records::write(
        &file,
        serde_json::to_string_pretty(&document).expect("encode"),
    )
    .expect("rewrite");
}

#[test]
fn gc_dry_run_keeps_a_merged_worktree_until_apply() {
    let repo = Repo::new();
    assert!(repo.mabo(&["create", "feature"]).status.success());
    land_branch(&repo, "feature");
    let plan = repo.mabo(&["gc"]);
    assert!(plan.status.success(), "{}", text(&plan.stderr));
    let planned = text(&plan.stdout);
    assert!(
        planned.contains("would remove feature [merged]"),
        "{planned}"
    );
    assert!(planned.contains("Re-run with --apply"), "{planned}");
    assert!(worktree_dir(&repo, "feature").is_dir());
    assert!(branch_listed(&repo, "feature"));

    let applied = repo.mabo(&["gc", "--apply"]);
    assert!(applied.status.success(), "{}", text(&applied.stderr));
    let removed = text(&applied.stdout);
    assert!(removed.contains("removed feature [merged]"), "{removed}");
    assert!(!worktree_dir(&repo, "feature").is_dir());
    assert!(!branch_listed(&repo, "feature"));
    assert!(!worktree_registered(&repo, "feature"));

    let again = repo.mabo(&["gc", "--apply"]);
    assert!(again.status.success(), "{}", text(&again.stderr));
    assert!(text(&again.stdout).contains("Nothing to clean up."));
}

#[test]
fn gc_json_reports_the_plan_and_rejects_a_bad_duration() {
    let repo = Repo::new();
    assert!(repo
        .mabo(&["create", "feature", "--owner", "grok"])
        .status
        .success());
    land_branch(&repo, "feature");
    let plan = repo.mabo(&["gc", "--json"]);
    assert!(plan.status.success(), "{}", text(&plan.stderr));
    assert!(text(&plan.stderr).is_empty(), "{}", text(&plan.stderr));
    let document = json_value(&plan);
    assert_eq!(document["schema"], 2);
    assert_eq!(document["data"]["applied"], false);
    assert!(document["error"].is_null());
    assert_eq!(document["data"]["candidates"][0]["name"], "feature");
    assert_eq!(document["data"]["candidates"][0]["owner"], "grok");
    assert_eq!(
        document["data"]["candidates"][0]["reasons"],
        serde_json::json!(["merged"])
    );
    assert_eq!(document["data"]["candidates"][0]["action"], "wouldRemove");
    assert!(document["data"]["candidates"][0]["detail"].is_null());
    assert!(document["data"]["candidates"][0]["branchDeleted"].is_null());
    assert!(document["data"]["candidates"][0]["path"]
        .as_str()
        .unwrap()
        .ends_with("/feature"));

    let bad = repo.mabo(&["gc", "--older-than", "14", "--json"]);
    assert_eq!(bad.status.code(), Some(2));
    assert!(text(&bad.stderr).is_empty(), "{}", text(&bad.stderr));
    let error = json_value(&bad);
    assert_eq!(error["error"]["code"], "usage");
    assert!(error["error"].get("exitCode").is_none());
    assert!(worktree_dir(&repo, "feature").is_dir());
}

#[test]
fn gc_skips_dirty_unpushed_current_and_other_agents() {
    let repo = Repo::new();
    assert!(repo.mabo(&["create", "dirty"]).status.success());
    land_branch(&repo, "dirty");
    fs::write(worktree_dir(&repo, "dirty").join("local.txt"), "x\n").expect("dirty");
    assert!(repo.mabo(&["create", "wip"]).status.success());
    commit_in_worktree(&repo, "wip");
    assert!(repo.mabo(&["create", "here"]).status.success());
    land_branch(&repo, "here");
    assert!(repo
        .mabo(&["create", "bob", "--owner", "bob"])
        .status
        .success());
    commit_in_worktree(&repo, "bob");
    age_metadata(&repo, "bob");

    let plan = repo.mabo(&["gc"]);
    assert!(
        plan.status.success(),
        "{}\n{}",
        text(&plan.stdout),
        text(&plan.stderr)
    );
    let planned = text(&plan.stdout);
    assert!(planned.contains("skip dirty [merged] dirty"), "{planned}");
    assert!(planned.contains("would remove here [merged]"), "{planned}");
    assert!(!planned.contains("wip"), "{planned}");
    assert!(!planned.contains("bob"), "{planned}");
    assert!(worktree_dir(&repo, "dirty").is_dir());

    let aged = repo.mabo(&["gc", "--older-than", "14d"]);
    assert!(aged.status.success(), "{}", text(&aged.stderr));
    let aged_text = text(&aged.stdout);
    assert!(
        aged_text.contains("skip bob [olderThan] other agent"),
        "{aged_text}"
    );
    assert!(!aged_text.contains("would remove dirty"), "{aged_text}");

    let current = repo
        .command(env!("CARGO_BIN_EXE_mabo"), &["gc", "--apply"])
        .current_dir(worktree_dir(&repo, "here"))
        .output()
        .expect("gc");
    assert!(current.status.success(), "{}", text(&current.stderr));
    let current_text = text(&current.stdout);
    assert!(
        current_text.contains("skip here [merged] current worktree"),
        "{current_text}"
    );
    assert!(
        current_text.contains("skip dirty [merged] dirty"),
        "{current_text}"
    );
    assert!(worktree_dir(&repo, "here").is_dir());
    assert!(worktree_dir(&repo, "dirty").is_dir());

    let forced = repo.mabo(&["gc", "--force"]);
    assert!(forced.status.success(), "{}", text(&forced.stderr));
    let forced_text = text(&forced.stdout);
    assert!(
        forced_text.contains("removed dirty [merged]"),
        "{forced_text}"
    );
    assert!(
        forced_text.contains("removed here [merged]"),
        "{forced_text}"
    );
    assert!(!worktree_dir(&repo, "dirty").is_dir());
    assert!(!worktree_dir(&repo, "here").is_dir());
    assert!(worktree_dir(&repo, "wip").is_dir());
    assert!(worktree_dir(&repo, "bob").is_dir());
}

#[test]
fn gc_drops_a_missing_directory_and_keeps_an_unpushed_branch() {
    let repo = Repo::new();
    assert!(repo.mabo(&["create", "gone"]).status.success());
    land_branch(&repo, "gone");
    assert!(repo.mabo(&["create", "local"]).status.success());
    commit_in_worktree(&repo, "local");
    fs::remove_dir_all(worktree_dir(&repo, "gone")).expect("rm gone");
    fs::remove_dir_all(worktree_dir(&repo, "local")).expect("rm local");

    let applied = repo.mabo(&["gc", "--apply"]);
    assert!(applied.status.success(), "{}", text(&applied.stderr));
    let text = text(&applied.stdout);
    assert!(text.contains("removed gone [merged, orphaned]"), "{text}");
    assert!(
        text.contains("removed local [orphaned] kept the branch because it has unpushed commits"),
        "{text}"
    );
    assert!(!worktree_registered(&repo, "gone"));
    assert!(!worktree_registered(&repo, "local"));
    assert!(!branch_listed(&repo, "gone"));
    assert!(branch_listed(&repo, "local"));
}

#[test]
fn gc_skips_missing_registration_with_changed_branch_or_head() {
    for change in ["branch", "head"] {
        let repo = Repo::new();
        assert!(repo.mabo(&["create", "a-trigger"]).status.success());
        land_branch(&repo, "a-trigger");
        assert!(repo.mabo(&["create", "z-local"]).status.success());
        commit_in_worktree(&repo, "z-local");
        repo.git(&["branch", "replacement", "main"]);
        let original = text(
            &repo
                .command("git", &["rev-parse", "z-local"])
                .output()
                .unwrap()
                .stdout,
        );
        fs::remove_dir_all(managed(&repo, "z-local")).unwrap();
        let command = if change == "branch" {
            format!(
                "printf 'ref: refs/heads/replacement\\n' > '{}'",
                repo.repo.join(".git/worktrees/z-local/HEAD").display()
            )
        } else {
            "git update-ref refs/heads/z-local main".to_string()
        };
        fs::write(
            repo.repo.join(".mabo.toml"),
            format!("[hooks]\npre-delete = [\"{command}\"]\n"),
        )
        .unwrap();
        let out = repo.mabo(&["gc", "--apply", "--json"]);
        let doc = json_value(&out);
        assert!(branch_listed(&repo, "z-local"), "{change}: {doc}");
        assert!(worktree_registered(&repo, "z-local"), "{change}: {doc}");
        let item = doc["data"]["candidates"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["name"] == "z-local")
            .unwrap();
        assert_eq!(item["action"], "skipped", "{change}: {doc}");
        assert!(item["detail"].as_str().unwrap().contains("changed"));
        assert!(out.status.success(), "{doc}");
        if change == "branch" {
            let after = repo
                .command("git", &["rev-parse", "z-local"])
                .output()
                .unwrap();
            assert_eq!(text(&after.stdout), original);
        }
    }
}

#[test]
fn gc_apply_rechecks_only_each_target_pull_request() {
    use std::os::unix::fs::PermissionsExt;
    for kind in ["live", "missing", "orphan"] {
        let repo = Repo::new();
        let count = 4;
        for number in 1..=count {
            let name = format!("topic-{number}");
            let url = format!("https://github.com/acme/demo/pull/{number}");
            let created = repo.mabo(&["create", &name, "--pr", &url]);
            assert!(created.status.success(), "{}", text(&created.stderr));
            if kind == "missing" {
                fs::remove_dir_all(managed(&repo, &name)).unwrap();
            } else if kind == "orphan" {
                repo.git(&[
                    "worktree",
                    "remove",
                    "--force",
                    managed(&repo, &name).to_str().unwrap(),
                ]);
            }
        }
        let bin = repo.root.join("bin");
        fs::create_dir_all(&bin).unwrap();
        let gh = bin.join("gh");
        let calls = repo.root.join("gh-calls");
        fs::write(
            &gh,
            format!(
                r#"#!/bin/sh
test "$1 $2" = 'pr view' || exit 1
printf '%s\n' "$3" >> '{}'
printf '%s\n' '{{"state":"MERGED"}}'
"#,
                calls.display()
            ),
        )
        .unwrap();
        fs::set_permissions(&gh, fs::Permissions::from_mode(0o755)).unwrap();
        let path = format!(
            "{}:{}",
            bin.display(),
            std::env::var("PATH").unwrap_or_default()
        );
        let out = repo
            .command(
                env!("CARGO_BIN_EXE_mabo"),
                &["gc", "--pr", "--apply", "--force", "--json"],
            )
            .env("PATH", path)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "{} {}",
            text(&out.stdout),
            text(&out.stderr)
        );
        let doc = json_value(&out);
        let candidates = doc["data"]["candidates"].as_array().unwrap();
        assert_eq!(candidates.len(), count);
        assert!(candidates.iter().all(|item| item["action"] == "removed"));
        let calls = fs::read_to_string(calls).unwrap();
        assert_eq!(calls.lines().count(), 2 * count, "{kind}: {calls}");
        for number in 1..=count {
            let url = format!("https://github.com/acme/demo/pull/{number}");
            assert_eq!(calls.lines().filter(|line| *line == url).count(), 2);
        }
    }
}

#[test]
fn gc_rechecks_pull_request_eligibility_after_pre_delete_hooks() {
    use std::os::unix::fs::PermissionsExt;
    let repo = Repo::new();
    assert!(repo
        .mabo(&[
            "create",
            "topic",
            "--pr",
            "https://github.com/acme/demo/pull/7"
        ])
        .status
        .success());
    let bin = repo.root.join("bin");
    fs::create_dir_all(&bin).unwrap();
    let state = repo.root.join("pr-state");
    fs::write(&state, "{\"state\":\"MERGED\"}\n").unwrap();
    let gh = bin.join("gh");
    fs::write(&gh, format!("#!/bin/sh\ncat '{}'\n", state.display())).unwrap();
    fs::set_permissions(&gh, fs::Permissions::from_mode(0o755)).unwrap();
    fs::write(
        repo.repo.join(".mabo.toml"),
        format!(
            r#"[hooks]
pre-delete = ["echo '{{\"state\":\"OPEN\"}}' > '{}' "]
"#,
            state.display()
        ),
    )
    .unwrap();
    let path = format!(
        "{}:{}",
        bin.display(),
        std::env::var("PATH").unwrap_or_default()
    );
    let out = repo
        .command(
            env!("CARGO_BIN_EXE_mabo"),
            &["gc", "--pr", "--force", "--json"],
        )
        .env("PATH", path)
        .output()
        .unwrap();
    assert_eq!(
        out.status.code(),
        Some(1),
        "{} {}",
        text(&out.stdout),
        text(&out.stderr)
    );
    let doc = json_value(&out);
    assert_eq!(doc["data"]["candidates"][0]["action"], "failed");
    assert!(doc["data"]["candidates"][0]["detail"]
        .as_str()
        .unwrap()
        .contains("no longer qualifies"));
    assert!(managed(&repo, "topic").exists());
    assert!(branch_listed(&repo, "topic"));
}

#[test]
fn gc_closed_pull_request_stays_until_force_and_keep_branch_is_honored() {
    let repo = Repo::new();
    assert!(repo
        .mabo(&[
            "create",
            "topic",
            "--pr",
            "https://github.com/acme/demo/pull/7",
        ])
        .status
        .success());
    commit_in_worktree(&repo, "topic");
    let bin = repo.root.join("bin");
    fs::create_dir_all(&bin).expect("bin");
    let gh = bin.join("gh");
    fs::write(&gh, "#!/bin/sh\nprintf '%s\\n' '{\"state\":\"MERGED\"}'\n").expect("gh");
    let mut perms = fs::metadata(&gh).expect("meta").permissions();
    use std::os::unix::fs::PermissionsExt;
    perms.set_mode(0o755);
    fs::set_permissions(&gh, perms).expect("chmod");
    let path = format!(
        "{}:{}",
        bin.display(),
        std::env::var("PATH").unwrap_or_default()
    );

    let plan = repo
        .command(env!("CARGO_BIN_EXE_mabo"), &["gc", "--pr", "--json"])
        .env("PATH", &path)
        .output()
        .expect("gc");
    assert!(plan.status.success(), "{}", text(&plan.stderr));
    let document = json_value(&plan);
    assert_eq!(
        document["data"]["candidates"][0]["reasons"],
        serde_json::json!(["pullRequest"])
    );
    assert_eq!(document["data"]["candidates"][0]["action"], "skipped");
    assert_eq!(document["data"]["candidates"][0]["detail"], "unpushed");
    assert!(worktree_dir(&repo, "topic").is_dir());

    fs::create_dir_all(repo.home.join(".config/maboroshi")).expect("config dir");
    fs::write(
        repo.home.join(".config/maboroshi/config.toml"),
        "keep-branch = true\n",
    )
    .expect("preference");
    let forced = repo
        .command(
            env!("CARGO_BIN_EXE_mabo"),
            &["gc", "--pr", "--force", "--json"],
        )
        .env("PATH", &path)
        .output()
        .expect("force");
    assert!(forced.status.success(), "{}", text(&forced.stderr));
    let removed = json_value(&forced);
    assert_eq!(removed["data"]["applied"], true);
    assert_eq!(removed["data"]["candidates"][0]["action"], "removed");
    assert_eq!(removed["data"]["candidates"][0]["branchDeleted"], false);
    assert!(!worktree_dir(&repo, "topic").is_dir());
    assert!(branch_listed(&repo, "topic"));
}

#[test]
fn gc_metadata_io_failure_after_removal_exits_partial_for_a_single_candidate() {
    use std::os::unix::fs::PermissionsExt;
    let real_git = std::env::split_paths(&std::env::var_os("PATH").expect("PATH"))
        .map(|dir| dir.join("git"))
        .find(|file| file.is_file())
        .expect("git");
    for missing in [false, true] {
        for json in [false, true] {
            let repo = Repo::new();
            assert!(repo.mabo(&["create", "feature"]).status.success());
            land_branch(&repo, "feature");
            if missing {
                fs::remove_dir_all(worktree_dir(&repo, "feature")).expect("missing checkout");
            }
            let bin = repo.root.join("bin");
            fs::create_dir(&bin).expect("bin");
            let wrapper = bin.join("git");
            // Let Git really remove the checkout/registration, then replace
            // the records directory with a file to cause a real I/O failure.
            fs::write(
                &wrapper,
                r#"#!/bin/sh
case " $* " in
  *" worktree remove "*)
    "$REAL_GIT" "$@" || exit $?
    mv "$METADATA_DIR" "$METADATA_DIR.saved" || exit $?
    printf 'not a directory' > "$METADATA_DIR"
    ;;
  *) exec "$REAL_GIT" "$@" ;;
esac
"#,
            )
            .expect("wrapper");
            fs::set_permissions(&wrapper, fs::Permissions::from_mode(0o755)).expect("chmod");
            let mut paths = vec![bin];
            paths.extend(std::env::split_paths(
                &std::env::var_os("PATH").expect("PATH"),
            ));
            let mut args = vec![
                "gc",
                "--apply",
                if missing { "--orphaned" } else { "--merged" },
            ];
            if json {
                args.push("--json");
            }
            let out = repo
                .command(env!("CARGO_BIN_EXE_mabo"), &args)
                .env("PATH", std::env::join_paths(paths).expect("paths"))
                .env("REAL_GIT", &real_git)
                .env("METADATA_DIR", repo.repo.join(".git/maboroshi/workspaces"))
                .output()
                .expect("gc");
            assert_eq!(
                out.status.code(),
                Some(6),
                "{} {}",
                text(&out.stdout),
                text(&out.stderr)
            );
            assert!(!worktree_dir(&repo, "feature").exists());
            assert!(!worktree_registered(&repo, "feature"));
            if json {
                let value = assert_envelope(&out, "gc");
                assert_eq!(value["error"]["code"], "partial");
                let candidates = value["data"]["candidates"].as_array().expect("candidates");
                assert_eq!(candidates.len(), 1);
                assert_eq!(candidates[0]["action"], "failed");
                let detail = candidates[0]["detail"].as_str().expect("detail");
                assert!(
                    detail.contains("metadata") && detail.contains("not writable"),
                    "{detail}"
                );
            } else {
                assert!(text(&out.stdout).contains("Failed 1"));
            }
        }
    }
}

#[test]
fn gc_failure_before_removal_exits_failure() {
    let repo = Repo::new();
    assert!(repo.mabo(&["create", "feature"]).status.success());
    land_branch(&repo, "feature");
    fs::write(
        repo.repo.join(".mabo.toml"),
        "[hooks]\npre-delete = [\"exit 42\"]\n",
    )
    .expect("hook");
    let out = repo.mabo(&["gc", "--merged", "--apply", "--json"]);
    assert_eq!(out.status.code(), Some(1));
    assert_eq!(assert_envelope(&out, "gc")["error"]["code"], "failed");
    assert!(worktree_dir(&repo, "feature").is_dir());
    assert!(worktree_registered(&repo, "feature"));
}

#[test]
fn gc_runs_pre_delete_hooks_only_when_applying() {
    let repo = Repo::new();
    assert!(repo.mabo(&["create", "feature"]).status.success());
    land_branch(&repo, "feature");
    assert!(repo.mabo(&["create", "other"]).status.success());
    land_branch(&repo, "other");
    fs::write(
        repo.repo.join(".mabo.toml"),
        "[hooks]\npre-delete = [\"test \\\"$MABO_NAME\\\" != feature && touch \\\"$MABO_ROOT_PATH/hooked\\\"\"]\n",
    )
    .expect("hooks");

    let plan = repo.mabo(&["gc"]);
    assert!(plan.status.success(), "{}", text(&plan.stderr));
    assert!(!repo.repo.join("hooked").exists());
    assert!(worktree_dir(&repo, "feature").is_dir());

    let applied = repo.mabo(&["gc", "--apply", "--json"]);
    assert_eq!(applied.status.code(), Some(6), "{}", text(&applied.stdout));
    assert!(
        text(&applied.stderr).is_empty()
            || text(&applied.stderr).contains("pre-delete")
            || text(&applied.stderr).contains("Running")
    );
    let document = json_value(&applied);
    assert_eq!(document["error"]["code"], "partial");
    assert!(document["error"].get("exitCode").is_none());
    let failed = document["data"]["candidates"]
        .as_array()
        .expect("candidates")
        .iter()
        .find(|entry| entry["name"] == "feature")
        .expect("feature");
    assert_eq!(failed["action"], "failed");
    let removed = document["data"]["candidates"]
        .as_array()
        .expect("candidates")
        .iter()
        .find(|entry| entry["name"] == "other")
        .expect("other");
    assert_eq!(removed["action"], "removed");
    assert!(worktree_dir(&repo, "feature").is_dir());
    assert!(!worktree_dir(&repo, "other").is_dir());
    assert!(repo.repo.join("hooked").exists());
}

fn gh_path(repo: &Repo, body: &str) -> String {
    let bin = repo.root.join("bin");
    fs::create_dir_all(&bin).expect("bin");
    let gh = bin.join("gh");
    fs::write(&gh, body).expect("gh");
    let mut perms = fs::metadata(&gh).expect("meta").permissions();
    use std::os::unix::fs::PermissionsExt;
    perms.set_mode(0o755);
    fs::set_permissions(&gh, perms).expect("chmod");
    format!(
        "{}:{}",
        bin.display(),
        std::env::var("PATH").unwrap_or_default()
    )
}

#[test]
fn gc_apply_removes_a_merged_worktree_when_another_remote_branch_is_ahead() {
    let repo = Repo::new();
    assert!(repo.mabo(&["create", "feature"]).status.success());
    land_branch(&repo, "feature");
    let bare = repo.root.join("origin.git");
    repo.git(&["init", "--bare", bare.to_str().expect("bare")]);
    repo.git(&["remote", "add", "origin", bare.to_str().expect("bare")]);
    repo.git(&["push", "origin", "main"]);
    repo.git(&["checkout", "-b", "ahead"]);
    fs::write(repo.repo.join("ahead.txt"), "ahead\n").expect("ahead");
    repo.git(&["add", "ahead.txt"]);
    repo.git(&["commit", "-m", "ahead"]);
    repo.git(&["push", "origin", "ahead"]);
    repo.git(&["checkout", "main"]);

    let applied = repo.mabo(&["gc", "--apply"]);
    assert!(applied.status.success(), "{}", text(&applied.stderr));
    let output = text(&applied.stdout);
    assert!(output.contains("removed feature [merged]"), "{output}");
    assert!(!output.contains("unpushed"), "{output}");
    assert!(!worktree_dir(&repo, "feature").is_dir());
    assert!(!branch_listed(&repo, "feature"));
    assert!(branch_listed(&repo, "main"));
    assert!(branch_listed(&repo, "ahead"));
}

#[test]
fn gc_does_not_remove_a_worktree_checked_out_on_the_default_branch() {
    let repo = Repo::new();
    fs::write(repo.repo.join("second.txt"), "second\n").expect("second");
    repo.git(&["add", "second.txt"]);
    repo.git(&["commit", "-m", "second"]);
    let bare = repo.root.join("origin.git");
    repo.git(&["init", "--bare", bare.to_str().expect("bare")]);
    repo.git(&["remote", "add", "origin", bare.to_str().expect("bare")]);
    repo.git(&["push", "origin", "main"]);
    repo.git(&["remote", "set-head", "origin", "main"]);
    repo.git(&["checkout", "-b", "dev"]);
    let attached = repo.mabo(&["attach", "main"]);
    assert!(
        attached.status.success(),
        "{}\n{}",
        text(&attached.stdout),
        text(&attached.stderr)
    );

    let applied = repo.mabo(&["gc", "--apply"]);
    assert!(applied.status.success(), "{}", text(&applied.stderr));
    let output = text(&applied.stdout);
    assert!(
        output.contains("skip main [merged] default branch"),
        "{output}"
    );
    assert!(worktree_dir(&repo, "main").is_dir());
    assert!(branch_listed(&repo, "main"));
    assert!(branch_listed(&repo, "dev"));
}

#[test]
fn gc_keeps_a_fresh_worktree_when_the_branch_reflog_is_missing() {
    let repo = Repo::new();
    repo.git(&["config", "core.logAllRefUpdates", "false"]);
    let created = repo.mabo(&["create", "fresh", "--json"]);
    assert!(created.status.success(), "{}", text(&created.stderr));
    let head = json_value(&created)["data"]["worktree"]["head"]
        .as_str()
        .expect("head")
        .to_string();
    assert!(
        !repo.repo.join(".git/logs/refs/heads/fresh").exists(),
        "the fresh branch reflog must be absent"
    );
    repo.git(&["commit", "--allow-empty", "-m", "advance"]);

    let applied = repo.mabo(&["gc", "--apply"]);
    assert!(applied.status.success(), "{}", text(&applied.stderr));
    let output = text(&applied.stdout);
    assert!(output.contains("Nothing to clean up."), "{output}");
    assert!(worktree_dir(&repo, "fresh").is_dir());
    assert!(branch_listed(&repo, "fresh"));
    assert_eq!(
        json_value(&created)["data"]["worktree"]["createdFrom"],
        head,
        "create records the base commit"
    );

    age_metadata(&repo, "fresh");
    let aged = repo.mabo(&["gc", "--older-than", "14d", "--apply"]);
    assert!(aged.status.success(), "{}", text(&aged.stderr));
    let aged_text = text(&aged.stdout);
    assert!(
        aged_text.contains("removed fresh [olderThan]"),
        "{aged_text}"
    );
    assert!(!worktree_dir(&repo, "fresh").is_dir());
    assert!(!branch_listed(&repo, "fresh"));
}

#[test]
fn gc_removes_a_merged_worktree_when_the_branch_reflog_is_missing() {
    let repo = Repo::new();
    assert!(repo.mabo(&["create", "feature"]).status.success());
    land_branch(&repo, "feature");
    let reflog = repo.repo.join(".git/logs/refs/heads/feature");
    assert!(reflog.is_file(), "feature reflog");
    fs::remove_file(&reflog).expect("remove reflog");

    let applied = repo.mabo(&["gc", "--apply"]);
    assert!(applied.status.success(), "{}", text(&applied.stderr));
    let output = text(&applied.stdout);
    assert!(output.contains("removed feature [merged]"), "{output}");
    assert!(!worktree_dir(&repo, "feature").is_dir());
    assert!(!branch_listed(&repo, "feature"));
}

#[test]
fn gc_removes_an_attached_branch_that_already_moved_past_its_creation_commit() {
    let repo = Repo::new();
    repo.git(&["checkout", "-b", "landed"]);
    fs::write(repo.repo.join("landed.txt"), "landed\n").expect("landed");
    repo.git(&["add", "landed.txt"]);
    repo.git(&["commit", "-m", "landed"]);
    repo.git(&["checkout", "main"]);
    repo.git(&["merge", "--ff-only", "landed"]);
    let attached = repo.mabo(&["attach", "landed"]);
    assert!(attached.status.success(), "{}", text(&attached.stderr));

    let applied = repo.mabo(&["gc", "--apply"]);
    assert!(applied.status.success(), "{}", text(&applied.stderr));
    let output = text(&applied.stdout);
    assert!(output.contains("removed landed [merged]"), "{output}");
    assert!(!worktree_dir(&repo, "landed").is_dir());
    assert!(!branch_listed(&repo, "landed"));
}

#[test]
fn gc_removes_an_attached_merged_branch_when_its_reflog_is_missing() {
    let repo = Repo::new();
    repo.git(&["checkout", "-b", "landed"]);
    fs::write(repo.repo.join("landed.txt"), "landed\n").expect("landed");
    repo.git(&["add", "landed.txt"]);
    repo.git(&["commit", "-m", "landed"]);
    repo.git(&["checkout", "main"]);
    repo.git(&["merge", "--ff-only", "landed"]);
    let reflog = repo.repo.join(".git/logs/refs/heads/landed");
    assert!(reflog.is_file(), "landed reflog");
    fs::remove_file(&reflog).expect("remove reflog");
    let attached = repo.mabo(&["attach", "landed"]);
    assert!(attached.status.success(), "{}", text(&attached.stderr));

    let applied = repo.mabo(&["gc", "--apply"]);
    assert!(applied.status.success(), "{}", text(&applied.stderr));
    let output = text(&applied.stdout);
    assert!(output.contains("removed landed [merged]"), "{output}");
    assert!(!worktree_dir(&repo, "landed").is_dir());
    assert!(!branch_listed(&repo, "landed"));
}

#[test]
fn gc_keeps_an_older_record_by_its_reflog_when_created_from_is_absent() {
    let repo = Repo::new();
    assert!(repo.mabo(&["create", "fresh"]).status.success());
    clear_created_from(&repo, "fresh");

    let applied = repo.mabo(&["gc", "--apply"]);
    assert!(applied.status.success(), "{}", text(&applied.stderr));
    let output = text(&applied.stdout);
    assert!(output.contains("Nothing to clean up."), "{output}");
    assert!(worktree_dir(&repo, "fresh").is_dir());
    assert!(branch_listed(&repo, "fresh"));
}

#[test]
fn gc_keeps_a_worktree_still_at_its_creation_point() {
    let repo = Repo::new();
    assert!(repo.mabo(&["create", "fresh"]).status.success());
    assert!(repo
        .mabo(&["create", "theirs", "--owner", "other"])
        .status
        .success());

    let applied = repo.mabo(&["gc", "--apply"]);
    assert!(applied.status.success(), "{}", text(&applied.stderr));
    let output = text(&applied.stdout);
    assert!(output.contains("Nothing to clean up."), "{output}");
    assert!(worktree_dir(&repo, "fresh").is_dir());
    assert!(worktree_dir(&repo, "theirs").is_dir());
    assert!(branch_listed(&repo, "fresh"));
    assert!(branch_listed(&repo, "theirs"));

    age_metadata(&repo, "fresh");
    let aged = repo.mabo(&["gc", "--older-than", "14d", "--apply"]);
    assert!(aged.status.success(), "{}", text(&aged.stderr));
    let aged_text = text(&aged.stdout);
    assert!(
        aged_text.contains("removed fresh [olderThan]"),
        "{aged_text}"
    );
    assert!(!worktree_dir(&repo, "fresh").is_dir());
    assert!(worktree_dir(&repo, "theirs").is_dir());
    assert!(branch_listed(&repo, "theirs"));
}

#[test]
fn gc_views_pull_requests_by_url_and_reports_an_unconfirmed_number() {
    let repo = Repo::new();
    assert!(repo
        .mabo(&[
            "create",
            "alpha",
            "--pr",
            "https://github.com/acme/alpha/pull/7",
        ])
        .status
        .success());
    assert!(repo
        .mabo(&[
            "create",
            "beta",
            "--pr",
            "https://github.com/acme/beta/pull/7",
        ])
        .status
        .success());
    assert!(repo
        .mabo(&["create", "local", "--pr", "4"])
        .status
        .success());
    let log = repo.root.join("gh.log");
    let path = gh_path(
        &repo,
        &format!(
            "#!/bin/sh\nprintf '%s\\n' \"$*\" >> '{}'\nif [ \"$1\" = repo ]; then\nexit 1\nfi\nprintf '%s\\n' '{{\"state\":\"MERGED\"}}'\nexit 0\n",
            log.display()
        ),
    );

    let applied = repo
        .command(
            env!("CARGO_BIN_EXE_mabo"),
            &["gc", "--pr", "--apply", "--json"],
        )
        .env("PATH", &path)
        .output()
        .expect("gc");
    assert!(applied.status.success(), "{}", text(&applied.stderr));
    let document = json_value(&applied);
    let candidates = document["data"]["candidates"]
        .as_array()
        .expect("candidates");
    let alpha = candidates
        .iter()
        .find(|entry| entry["name"] == "alpha")
        .expect("alpha");
    assert_eq!(alpha["reasons"], serde_json::json!(["pullRequest"]));
    assert_eq!(alpha["action"], "removed");
    let beta = candidates
        .iter()
        .find(|entry| entry["name"] == "beta")
        .expect("beta");
    assert_eq!(beta["action"], "removed");
    let local = candidates
        .iter()
        .find(|entry| entry["name"] == "local")
        .expect("local");
    assert_eq!(local["action"], "skipped");
    assert_eq!(local["detail"], "pr status unavailable");
    assert!(worktree_dir(&repo, "local").is_dir());
    assert!(!worktree_dir(&repo, "alpha").is_dir());
    assert!(text(&applied.stderr).contains("pull request status unavailable for local"));
    let logged = fs::read_to_string(&log).expect("gh log");
    assert!(
        logged.contains("https://github.com/acme/alpha/pull/7"),
        "{logged}"
    );
    assert!(
        logged.contains("https://github.com/acme/beta/pull/7"),
        "{logged}"
    );
    assert!(!logged.contains("pr view 4"), "{logged}");
}

#[test]
fn removing_the_last_worktree_keeps_the_project_marker_for_the_next_create() {
    for gc in [false, true] {
        let repo = Repo::new();
        assert!(repo.mabo(&["create", "feature/last"]).status.success());
        let project = managed_root(&repo);
        let marker_path = project.join(maboroshi::paths::PROJECT_MARKER);
        let marker = fs::read(&marker_path).expect("marker");
        let removed = if gc {
            commit_file(&repo, "feature/last", "landed.txt", "landed\n");
            repo.git(&["merge", "--ff-only", "feature/last"]);
            repo.mabo(&["gc", "--apply", "--merged", "--json"])
        } else {
            repo.mabo(&["delete", "feature/last", "--json"])
        };
        assert!(
            removed.status.success(),
            "{} {}",
            text(&removed.stdout),
            text(&removed.stderr)
        );
        assert!(!managed(&repo, "feature/last").exists());
        assert!(
            !project.join("feature").exists(),
            "empty name parents are still removed"
        );
        assert!(project.is_dir());
        assert_eq!(fs::read(&marker_path).expect("retained marker"), marker);
        assert_eq!(fs::read_dir(&project).expect("project dir").count(), 1);
        let created = repo.mabo(&["create", "next", "--json"]);
        assert!(
            created.status.success(),
            "{} {}",
            text(&created.stdout),
            text(&created.stderr)
        );
        assert!(managed(&repo, "next").join("README.md").is_file());
        assert_eq!(fs::read(&marker_path).expect("reused marker"), marker);
    }
}

#[test]
fn deleting_the_last_worktree_between_directory_claim_and_git_add_keeps_the_marker() {
    use std::os::unix::fs::PermissionsExt;
    let repo = Repo::new();
    assert!(repo.mabo(&["create", "last"]).status.success());
    let marker_path = managed_root(&repo).join(maboroshi::paths::PROJECT_MARKER);
    let marker = fs::read(&marker_path).expect("marker");
    let real_git = std::env::split_paths(&std::env::var_os("PATH").expect("PATH"))
        .map(|dir| dir.join("git"))
        .find(|file| file.is_file())
        .expect("git");
    let bin = repo.root.join("bin");
    fs::create_dir(&bin).expect("bin");
    let wrapper = bin.join("git");
    // The outer create has claimed the project directory but has not added
    // its checkout yet. Finish deletion in that exact window, without sleeps.
    fs::write(
        &wrapper,
        r#"#!/bin/sh
case " $* " in
  *" worktree add "*)
    "$MABO_BIN" delete last --json > "$DELETE_RESULT" || exit $?
    ;;
esac
exec "$REAL_GIT" "$@"
"#,
    )
    .expect("wrapper");
    fs::set_permissions(&wrapper, fs::Permissions::from_mode(0o755)).expect("chmod");
    let mut paths = vec![bin];
    paths.extend(std::env::split_paths(
        &std::env::var_os("PATH").expect("PATH"),
    ));
    let delete_result = repo.root.join("delete.json");
    let created = repo
        .command(
            env!("CARGO_BIN_EXE_mabo"),
            &["create", "replacement", "--json"],
        )
        .env("PATH", std::env::join_paths(paths).expect("paths"))
        .env("REAL_GIT", real_git)
        .env("MABO_BIN", env!("CARGO_BIN_EXE_mabo"))
        .env("DELETE_RESULT", &delete_result)
        .output()
        .expect("create");
    assert!(
        created.status.success(),
        "{} {}",
        text(&created.stdout),
        text(&created.stderr)
    );
    let deleted: serde_json::Value =
        serde_json::from_slice(&fs::read(delete_result).expect("delete ran")).expect("delete json");
    assert_eq!(deleted["ok"], true);
    assert!(!managed(&repo, "last").exists());
    assert!(managed(&repo, "replacement").join("README.md").is_file());
    assert_eq!(fs::read(&marker_path).expect("retained marker"), marker);
    let next = repo.mabo(&["create", "next", "--json"]);
    assert!(
        next.status.success(),
        "{} {}",
        text(&next.stdout),
        text(&next.stderr)
    );
}

#[test]
fn new_worktrees_land_under_xdg_and_a_preference_still_wins() {
    let repo = Repo::new();
    let created = repo.mabo(&["create", "feature", "--json"]);
    assert!(
        created.status.success(),
        "{}\n{}",
        text(&created.stdout),
        text(&created.stderr)
    );
    let path = managed(&repo, "feature");
    assert!(path.join("README.md").is_file());
    assert!(paths_match(
        json_value(&created)["data"]["worktree"]["path"]
            .as_str()
            .unwrap_or(""),
        &path
    ));
    assert!(!repo.repo.join(".git/maboroshi/worktrees/feature").exists());
    assert!(repo.repo.join(".git/maboroshi/workspaces").is_dir());
    let common = maboroshi::git::canonical_common_dir(&repo.repo).expect("common dir");
    let marker = fs::read_to_string(managed_root(&repo).join(maboroshi::paths::PROJECT_MARKER))
        .expect("marker");
    assert_eq!(marker.trim_end(), common.to_string_lossy());

    let preference = repo.mabo(&["preferences", "set", "worktrees-directory", "../custom-wt"]);
    assert!(preference.status.success(), "{}", text(&preference.stderr));
    let custom = repo.mabo(&["create", "custom"]);
    assert!(
        custom.status.success(),
        "{}\n{}",
        text(&custom.stdout),
        text(&custom.stderr)
    );
    let custom_path = repo.root.join("custom-wt").join("custom");
    assert!(custom_path.join("README.md").is_file());
    assert!(!managed(&repo, "custom").exists());
    let removed = repo.mabo(&["delete", "custom"]);
    assert!(removed.status.success(), "{}", text(&removed.stderr));
    assert!(!custom_path.exists());
    assert!(
        custom_path.parent().expect("custom dir").is_dir(),
        "a preference directory stays when its last worktree is gone"
    );

    let legacy = repo.repo.join(".git/maboroshi/worktrees/legacy");
    repo.git(&[
        "worktree",
        "add",
        "-b",
        "legacy",
        legacy.to_str().expect("legacy"),
        "HEAD",
    ]);
    let names = repo.mabo(&["list", "--names", "--no-default"]);
    assert!(names.status.success(), "{}", text(&names.stderr));
    let listed = text(&names.stdout);
    assert!(listed.lines().any(|line| line == "feature"), "{listed}");
    assert!(listed.lines().any(|line| line == "legacy"), "{listed}");
    let found = repo.mabo(&["where", "legacy"]);
    assert!(found.status.success(), "{}", text(&found.stderr));
    assert!(paths_match(text(&found.stdout).trim(), &legacy));
    let refused = repo.mabo(&["delete", "legacy", "--keep-branch"]);
    assert!(!refused.status.success(), "{}", text(&refused.stdout));
    assert_eq!(refused.status.code(), Some(1), "{}", text(&refused.stderr));
    let refused_text = text(&refused.stderr);
    assert!(
        refused_text.contains("not created by mabo"),
        "{refused_text}"
    );
    assert!(
        refused_text.contains("git worktree remove"),
        "{refused_text}"
    );
    assert!(legacy.is_dir());
}

#[test]
fn relative_xdg_data_home_uses_the_home_fallback() {
    let repo = Repo::new();
    let created = repo
        .command(env!("CARGO_BIN_EXE_mabo"), &["create", "feature"])
        .env("XDG_DATA_HOME", "relative/data")
        .output()
        .expect("create");
    assert!(
        created.status.success(),
        "{}\n{}",
        text(&created.stdout),
        text(&created.stderr)
    );
    let data_home = maboroshi::paths::data_home(Some(&repo.home), Some(Path::new("relative/data")))
        .expect("fallback");
    assert_eq!(data_home, repo.home.join(".local/share"));
    assert!(managed_directory(&repo.repo, &data_home)
        .join("feature")
        .is_dir());
    assert!(!repo.root.join("relative/data").exists());
    assert!(!managed(&repo, "feature").exists());
}

#[test]
fn a_project_directory_owned_by_another_repository_is_refused() {
    let repo = Repo::new();
    let directory = managed_root(&repo);
    fs::create_dir_all(&directory).expect("project dir");
    fs::write(
        directory.join(maboroshi::paths::PROJECT_MARKER),
        "/other/repo/.git\n",
    )
    .expect("foreign marker");
    let created = repo.mabo(&["create", "feature"]);
    assert!(!created.status.success(), "{}", text(&created.stdout));
    let message = format!("{}\n{}", text(&created.stdout), text(&created.stderr));
    assert!(message.contains("belongs to"), "{message}");
    assert!(message.contains("/other/repo/.git"), "{message}");
    assert!(!directory.join("feature").exists());
}

#[test]
fn two_clones_do_not_share_a_worktree_directory() {
    let first = Repo::new();
    let second = Repo::new();
    assert!(first.mabo(&["create", "feature"]).status.success());
    assert!(second.mabo(&["create", "feature"]).status.success());
    let left = managed_root(&first);
    let right = managed_root(&second);
    assert_ne!(left, right);
    assert!(left.join("feature").is_dir());
    assert!(right.join("feature").is_dir());
    assert!(left
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.starts_with("repo-")));
}

#[test]
fn symlink_checkout_shares_the_project_directory() {
    let repo = Repo::new();
    let link = repo.root.join("link-name");
    std::os::unix::fs::symlink(&repo.repo, &link).expect("symlink");
    let created = repo.mabo(&["create", "from-real"]);
    assert!(created.status.success(), "{}", text(&created.stderr));
    let via_link = repo
        .command(
            env!("CARGO_BIN_EXE_mabo"),
            &[
                "create",
                "--project",
                link.to_str().expect("link"),
                "from-link",
            ],
        )
        .output()
        .expect("create");
    assert!(
        via_link.status.success(),
        "{}\n{}",
        text(&via_link.stdout),
        text(&via_link.stderr)
    );
    let project = managed_root(&repo);
    assert!(project.join("from-real").is_dir());
    assert!(project.join("from-link").is_dir());
    let projects = fs::read_dir(project.parent().expect("ceiling"))
        .expect("ceiling")
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false))
        .count();
    assert_eq!(
        projects, 1,
        "symlink spelling created a second project directory"
    );
    let deleted = repo
        .command(
            env!("CARGO_BIN_EXE_mabo"),
            &[
                "delete",
                "--project",
                link.to_str().expect("link"),
                "from-real",
            ],
        )
        .output()
        .expect("delete");
    assert!(
        deleted.status.success(),
        "{}\n{}",
        text(&deleted.stdout),
        text(&deleted.stderr)
    );
    assert!(!project.join("from-real").exists());
    assert!(project.join("from-link").is_dir());
}

#[test]
fn recorded_worktrees_outside_the_resolved_directory_can_be_deleted() {
    let repo = Repo::new();
    assert!(repo
        .mabo(&[
            "preferences",
            "set",
            "worktrees-directory",
            ".git/maboroshi/worktrees",
        ])
        .status
        .success());
    let created = repo.mabo(&["create", "feature/topic"]);
    assert!(created.status.success(), "{}", text(&created.stderr));
    let topic = repo.repo.join(".git/maboroshi/worktrees/feature/topic");
    let parent = repo.repo.join(".git/maboroshi/worktrees/feature");
    assert!(topic.is_dir());
    assert!(repo
        .mabo(&["preferences", "remove", "worktrees-directory"])
        .status
        .success());
    let deleted = repo.mabo(&["delete", "feature/topic"]);
    assert!(
        deleted.status.success(),
        "{}\n{}",
        text(&deleted.stdout),
        text(&deleted.stderr)
    );
    assert!(!topic.exists());
    assert!(parent.is_dir(), "parents of a recorded worktree stay");
    assert!(repo.repo.join(".git/maboroshi/worktrees").is_dir());

    let other = repo.root.join("other-xdg");
    let elsewhere_created = repo
        .command(env!("CARGO_BIN_EXE_mabo"), &["create", "elsewhere"])
        .env("XDG_DATA_HOME", &other)
        .output()
        .expect("elsewhere");
    assert!(
        elsewhere_created.status.success(),
        "{}\n{}",
        text(&elsewhere_created.stdout),
        text(&elsewhere_created.stderr)
    );
    let elsewhere = managed_directory(&repo.repo, &other).join("elsewhere");
    assert!(elsewhere.is_dir());
    fs::write(elsewhere.join("dirty.txt"), "dirty\n").expect("dirty");
    let blocked = repo.mabo(&["delete", "elsewhere"]);
    assert!(!blocked.status.success(), "{}", text(&blocked.stdout));
    assert!(
        text(&blocked.stderr).contains("uncommitted"),
        "{}",
        text(&blocked.stderr)
    );
    assert!(elsewhere.is_dir());
    fs::remove_file(elsewhere.join("dirty.txt")).expect("clean");
    let removed = repo.mabo(&["delete", "elsewhere"]);
    assert!(
        removed.status.success(),
        "{}\n{}",
        text(&removed.stdout),
        text(&removed.stderr)
    );
    assert!(!elsewhere.exists());
    assert!(
        elsewhere.parent().expect("project dir").is_dir(),
        "the other data directory's project dir stays"
    );

    let stray = repo.root.join("stray");
    repo.git(&[
        "worktree",
        "add",
        "-b",
        "stray",
        stray.to_str().expect("stray"),
        "HEAD",
    ]);
    fs::write(stray.join("stray.txt"), "stray\n").expect("stray note");
    for args in [vec!["add", "stray.txt"], vec!["commit", "-m", "stray"]] {
        let output = repo
            .command("git", &args)
            .current_dir(&stray)
            .output()
            .expect("commit stray");
        assert!(output.status.success(), "{}", text(&output.stderr));
    }
    repo.git(&["merge", "--ff-only", "stray"]);
    let refused = repo.mabo(&["delete", "stray"]);
    assert!(!refused.status.success(), "{}", text(&refused.stdout));
    assert_eq!(refused.status.code(), Some(1), "{}", text(&refused.stderr));
    let refused_text = text(&refused.stderr);
    assert!(
        refused_text.contains("not created by mabo"),
        "{refused_text}"
    );
    assert!(
        refused_text.contains(&format!("git worktree remove {}", stray.display())),
        "{refused_text}"
    );
    let cleaned = repo.mabo(&["gc", "--apply"]);
    assert!(cleaned.status.success(), "{}", text(&cleaned.stderr));
    assert!(
        !text(&cleaned.stdout).contains("stray"),
        "{}",
        text(&cleaned.stdout)
    );
    assert!(stray.is_dir());
}

#[test]
fn gc_removes_a_merged_recorded_worktree_outside_the_resolved_directory() {
    let repo = Repo::new();
    assert!(repo
        .mabo(&[
            "preferences",
            "set",
            "worktrees-directory",
            ".git/maboroshi/worktrees",
        ])
        .status
        .success());
    let created = repo.mabo(&["create", "landed"]);
    assert!(created.status.success(), "{}", text(&created.stderr));
    let landed = repo.repo.join(".git/maboroshi/worktrees/landed");
    fs::write(landed.join("landed.txt"), "landed\n").expect("note");
    for args in [vec!["add", "landed.txt"], vec!["commit", "-m", "landed"]] {
        let output = repo
            .command("git", &args)
            .current_dir(&landed)
            .output()
            .expect("commit");
        assert!(output.status.success(), "{}", text(&output.stderr));
    }
    repo.git(&["merge", "--ff-only", "landed"]);
    assert!(repo
        .mabo(&["preferences", "remove", "worktrees-directory"])
        .status
        .success());
    let applied = repo.mabo(&["gc", "--apply"]);
    assert!(
        applied.status.success(),
        "{}\n{}",
        text(&applied.stdout),
        text(&applied.stderr)
    );
    let stdout = text(&applied.stdout);
    assert!(
        stdout.contains("landed") && stdout.contains("Removed"),
        "{stdout}"
    );
    assert!(!landed.exists());
    assert!(repo.repo.join(".git/maboroshi/worktrees").is_dir());
}

#[test]
fn recorded_worktrees_outside_the_directory_keep_metadata_names() {
    let repo = Repo::new();
    assert!(repo
        .mabo(&[
            "preferences",
            "set",
            "worktrees-directory",
            ".git/maboroshi/worktrees",
        ])
        .status
        .success());
    let detached = repo.mabo(&["create", "next", "--exec", "git checkout -q --detach"]);
    assert!(
        detached.status.success(),
        "{}\n{}",
        text(&detached.stdout),
        text(&detached.stderr)
    );
    let nested = repo.mabo(&[
        "create",
        "feature/topic",
        "--exec",
        "git checkout -q --detach",
    ]);
    assert!(
        nested.status.success(),
        "{}\n{}",
        text(&nested.stdout),
        text(&nested.stderr)
    );
    let branched = repo.mabo(&["create", "kept"]);
    assert!(
        branched.status.success(),
        "{}\n{}",
        text(&branched.stdout),
        text(&branched.stderr)
    );
    repo.git(&["branch", "-m", "kept", "moved"]);
    assert!(repo
        .mabo(&["preferences", "remove", "worktrees-directory"])
        .status
        .success());

    let next = repo.repo.join(".git/maboroshi/worktrees/next");
    let topic = repo.repo.join(".git/maboroshi/worktrees/feature/topic");
    let kept = repo.repo.join(".git/maboroshi/worktrees/kept");
    let head = repo
        .command("git", &["rev-parse", "--short=7", "HEAD"])
        .current_dir(&next)
        .output()
        .expect("short head");
    assert!(head.status.success(), "{}", text(&head.stderr));
    let sha = text(&head.stdout);

    let names = repo.mabo(&["list", "--names", "--no-default"]);
    assert!(names.status.success(), "{}", text(&names.stderr));
    let listed = text(&names.stdout);
    assert!(listed.lines().any(|line| line == "next"), "{listed}");
    assert!(
        listed.lines().any(|line| line == "feature/topic"),
        "{listed}"
    );
    assert!(listed.lines().any(|line| line == "kept"), "{listed}");
    assert!(!listed.lines().any(|line| line == sha), "{listed}");
    assert!(!listed.lines().any(|line| line == "moved"), "{listed}");

    let found = repo.mabo(&["where", "next"]);
    assert!(found.status.success(), "{}", text(&found.stderr));
    assert!(paths_match(text(&found.stdout).trim(), &next));
    let found_topic = repo.mabo(&["where", "feature/topic"]);
    assert!(
        found_topic.status.success(),
        "{}",
        text(&found_topic.stderr)
    );
    assert!(paths_match(text(&found_topic.stdout).trim(), &topic));
    let found_kept = repo.mabo(&["where", "kept"]);
    assert!(found_kept.status.success(), "{}", text(&found_kept.stderr));
    assert!(paths_match(text(&found_kept.stdout).trim(), &kept));

    let ran = repo.mabo(&["exec", "next", "true"]);
    assert!(ran.status.success(), "{}", text(&ran.stderr));
    let marked = repo.mabo(&["meta", "set", "feature/topic", "--owner", "ada"]);
    assert!(marked.status.success(), "{}", text(&marked.stderr));
    let owned = text(&repo.mabo(&["list", "--names", "--owner", "ada"]).stdout);
    assert_eq!(owned, "feature/topic");

    let stray = repo.root.join("stray-detached");
    repo.git(&[
        "worktree",
        "add",
        "--detach",
        stray.to_str().expect("stray"),
        "HEAD",
    ]);
    let stray_head = repo
        .command("git", &["rev-parse", "--short=7", "HEAD"])
        .current_dir(&stray)
        .output()
        .expect("stray head");
    let stray_sha = text(&stray_head.stdout);
    let after_stray = text(&repo.mabo(&["list", "--names", "--no-default"]).stdout);
    assert!(
        after_stray.lines().any(|line| line == stray_sha),
        "{after_stray}"
    );
    assert!(
        !after_stray.lines().any(|line| line == "stray-detached"),
        "{after_stray}"
    );

    let deleted = repo.mabo(&["delete", "kept", "--keep-branch"]);
    assert!(
        deleted.status.success(),
        "{}\n{}",
        text(&deleted.stdout),
        text(&deleted.stderr)
    );
    assert!(!kept.exists());
    let moved = repo
        .command("git", &["branch", "--list", "moved"])
        .output()
        .expect("branch");
    assert!(
        text(&moved.stdout).contains("moved"),
        "{}",
        text(&moved.stdout)
    );

    let file = repo.repo.join(".git/maboroshi/workspaces");
    let mut document: serde_json::Value =
        serde_json::from_str(&records::read_to_string(&file).expect("store")).expect("store json");
    for record in document["worktrees"].as_array_mut().expect("records") {
        if record["path"]
            .as_str()
            .unwrap_or("")
            .ends_with("/worktrees/next")
        {
            record["lastUsedAt"] = serde_json::json!("2000-01-01T00:00:00.000Z");
        }
    }
    records::write(
        &file,
        format!(
            "{}\n",
            serde_json::to_string_pretty(&document).expect("encode")
        ),
    )
    .expect("rewrite");
    let planned = repo.mabo(&["gc", "--older-than", "1d", "--json"]);
    assert!(planned.status.success(), "{}", text(&planned.stderr));
    let candidates = json_value(&planned)["data"]["candidates"]
        .as_array()
        .expect("candidates")
        .clone();
    let next_row = candidates
        .iter()
        .find(|entry| entry["name"] == "next")
        .expect("gc names the detached worktree next");
    assert_eq!(next_row["action"], "wouldRemove");
    let applied = repo.mabo(&["gc", "--older-than", "1d", "--apply", "--json"]);
    assert!(
        applied.status.success(),
        "{}\n{}",
        text(&applied.stdout),
        text(&applied.stderr)
    );
    let removed = json_value(&applied)["data"]["candidates"]
        .as_array()
        .expect("candidates")
        .iter()
        .find(|entry| entry["name"] == "next")
        .expect("removed next")
        .clone();
    assert_eq!(removed["action"], "removed");
    assert!(!next.exists());
}

#[test]
fn delete_requests_the_same_worktree_once() {
    let repo = Repo::new();
    assert!(repo.mabo(&["create", "a"]).status.success());
    assert!(repo.mabo(&["create", "b"]).status.success());
    let deleted = repo.mabo(&["delete", "a", "b", "a"]);
    assert!(
        deleted.status.success(),
        "{}\n{}",
        text(&deleted.stdout),
        text(&deleted.stderr)
    );
    let stdout = text(&deleted.stdout);
    assert_eq!(
        stdout.matches("Deleted worktree 'a'").count(),
        1,
        "{stdout}"
    );
    assert_eq!(
        stdout.matches("Deleted worktree 'b'").count(),
        1,
        "{stdout}"
    );
    assert!(
        !text(&deleted.stderr).contains("not a working tree"),
        "{}",
        text(&deleted.stderr)
    );
    assert!(!managed(&repo, "a").exists());
    assert!(!managed(&repo, "b").exists());

    assert!(repo.mabo(&["create", "alias"]).status.success());
    repo.git(&["branch", "-m", "alias", "topic"]);
    let once = repo.mabo(&["delete", "alias", "topic"]);
    assert!(
        once.status.success(),
        "{}\n{}",
        text(&once.stdout),
        text(&once.stderr)
    );
    let once_stdout = text(&once.stdout);
    assert_eq!(
        once_stdout.matches("Deleted worktree").count(),
        1,
        "{once_stdout}"
    );
    assert!(
        once_stdout.contains("Deleted worktree 'alias'"),
        "{once_stdout}"
    );
    assert!(!managed(&repo, "alias").exists());
    assert!(
        !text(&once.stderr).contains("not a working tree"),
        "{}",
        text(&once.stderr)
    );
}

#[test]
fn list_shows_absolute_or_home_paths() {
    let repo = Repo::new();
    assert!(repo.mabo(&["create", "inside"]).status.success());
    let deep = repo.home.join("a/b/c");
    fs::create_dir_all(&deep).expect("deep");
    let listed = repo
        .command(
            env!("CARGO_BIN_EXE_mabo"),
            &[
                "list",
                "--project",
                repo.repo.to_str().expect("repo"),
                "--no-default",
            ],
        )
        .current_dir(&deep)
        .output()
        .expect("list");
    assert!(
        listed.status.success(),
        "{}\n{}",
        text(&listed.stdout),
        text(&listed.stderr)
    );
    let stdout = text(&listed.stdout);
    let line = stdout
        .lines()
        .find(|line| line.starts_with("inside ("))
        .expect("inside");
    assert!(
        !line.contains("../"),
        "list should not print a long relative path\n{line}"
    );
    let path = line.trim_start_matches("inside (").trim_end_matches(')');
    assert!(path.starts_with('/') || path.starts_with("~/"), "{line}");
    let home = repo.home.canonicalize().expect("home");
    let worktree = managed(&repo, "inside").canonicalize().expect("worktree");
    if worktree.starts_with(&home) {
        let rest = worktree.strip_prefix(&home).expect("under home");
        assert_eq!(path, format!("~/{}", rest.display()));
    } else {
        assert_eq!(path, worktree.to_string_lossy());
    }
}

#[test]
fn symlink_spelling_keeps_metadata_and_preserves_the_project_directory() {
    let repo = Repo::new();
    let created = repo.mabo(&["create", "feature", "--owner", "alice", "--json"]);
    assert!(
        created.status.success(),
        "{}\n{}",
        text(&created.stdout),
        text(&created.stderr)
    );
    let created_json = json_value(&created);
    let real = PathBuf::from(
        created_json["data"]["worktree"]["path"]
            .as_str()
            .expect("path"),
    );
    let created_from = created_json["data"]["worktree"]["createdFrom"]
        .as_str()
        .expect("createdFrom")
        .to_string();
    let created_at = created_json["data"]["worktree"]["createdAt"]
        .as_str()
        .expect("createdAt")
        .to_string();
    fs::write(real.join("landed.txt"), "landed\n").expect("note");
    for args in [vec!["add", "landed.txt"], vec!["commit", "-m", "landed"]] {
        let output = repo
            .command("git", &args)
            .current_dir(&real)
            .output()
            .expect("commit");
        assert!(output.status.success(), "{}", text(&output.stderr));
    }
    repo.git(&["merge", "--ff-only", "feature"]);

    let via = repo.root.join("via-project");
    std::os::unix::fs::symlink(real.parent().expect("project"), &via).expect("symlink");
    let spelled = via.join("feature");
    let gitdir = repo.repo.join(".git/worktrees/feature/gitdir");
    fs::write(&gitdir, format!("{}\n", spelled.join(".git").display())).expect("gitdir");

    let listed = repo.mabo(&["list", "--json", "--no-default"]);
    assert!(listed.status.success(), "{}", text(&listed.stderr));
    let entry = &json_value(&listed)["data"]["worktrees"][0];
    assert_eq!(entry["owner"], "alice");
    assert_eq!(entry["createdFrom"], created_from);
    assert_eq!(entry["createdAt"], created_at);
    let plan = repo.mabo(&["gc", "--json"]);
    assert!(plan.status.success(), "{}", text(&plan.stderr));
    let candidate = &json_value(&plan)["data"]["candidates"][0];
    assert_eq!(candidate["owner"], "alice");
    assert_eq!(candidate["name"], "feature");
    let deleted = repo.mabo(&["delete", "feature", "--json"]);
    assert!(
        deleted.status.success(),
        "{}\n{}",
        text(&deleted.stdout),
        text(&deleted.stderr)
    );
    let removed = &json_value(&deleted)["data"]["deleted"][0]["worktree"];
    assert_eq!(removed["owner"], "alice");
    assert_eq!(removed["createdFrom"], created_from);
    assert_eq!(removed["createdAt"], created_at);
    assert!(!real.exists());
    assert!(
        managed_root(&repo)
            .join(maboroshi::paths::PROJECT_MARKER)
            .is_file(),
        "last worktree deletion should keep the project directory and marker"
    );
    let store =
        records::read_to_string(repo.repo.join(".git/maboroshi/workspaces")).unwrap_or_default();
    assert!(!store.contains("alice"), "{store}");
}

#[test]
fn symlinked_xdg_data_home_create_attach_and_exec_succeed() {
    let repo = Repo::new();
    let real = repo.root.join("real-xdg");
    let link = repo.root.join("link-xdg");
    fs::create_dir_all(&real).expect("real xdg");
    std::os::unix::fs::symlink(&real, &link).expect("xdg link");
    let run = |args: &[&str]| {
        repo.command(env!("CARGO_BIN_EXE_mabo"), args)
            .env("XDG_DATA_HOME", &link)
            .output()
            .expect("mabo")
    };
    let created = run(&["create", "a", "--json"]);
    assert!(
        created.status.success(),
        "{}\n{}",
        text(&created.stdout),
        text(&created.stderr)
    );
    let created_json = json_value(&created);
    assert!(created_json["error"].is_null(), "{created_json}");
    assert_eq!(created_json["data"]["worktree"]["name"], "a");
    assert!(created_json["data"]["metadata"]["ok"]
        .as_bool()
        .unwrap_or(false));
    let json_path = created_json["data"]["worktree"]["path"]
        .as_str()
        .expect("path");
    let canonical = fs::canonicalize(Path::new(json_path)).expect("canonical");
    assert_eq!(Path::new(json_path), canonical);
    let message = text(&created.stderr);
    assert!(
        message.contains(json_path),
        "human message and JSON should use the same path\n{message}\n{json_path}"
    );
    assert!(!message.contains(link.to_str().expect("link")), "{message}");

    repo.git(&["branch", "attached"]);
    let attached = run(&["attach", "attached", "--json"]);
    assert!(
        attached.status.success(),
        "{}\n{}",
        text(&attached.stdout),
        text(&attached.stderr)
    );
    let attached_json = json_value(&attached);
    assert!(attached_json["error"].is_null(), "{attached_json}");
    assert_eq!(attached_json["data"]["worktree"]["name"], "attached");

    let executed = run(&["create", "b", "--json", "--exec", "true"]);
    assert!(
        executed.status.success(),
        "{}\n{}",
        text(&executed.stdout),
        text(&executed.stderr)
    );
    let executed_json = json_value(&executed);
    assert!(executed_json["error"].is_null(), "{executed_json}");
    assert_eq!(executed_json["data"]["exec"]["ok"], true);
    assert_eq!(executed_json["data"]["worktree"]["name"], "b");
}

#[test]
fn delete_current_recognizes_a_worktree_created_through_a_symlink() {
    let repo = Repo::new();
    let real = repo.root.join("real-xdg");
    let link = repo.root.join("link-xdg");
    fs::create_dir_all(&real).expect("real xdg");
    std::os::unix::fs::symlink(&real, &link).expect("xdg link");
    let created = repo
        .command(env!("CARGO_BIN_EXE_mabo"), &["create", "feature"])
        .env("XDG_DATA_HOME", &link)
        .output()
        .expect("create");
    assert!(
        created.status.success(),
        "{}\n{}",
        text(&created.stdout),
        text(&created.stderr)
    );
    let project = managed_directory(&repo.repo, &real);
    let via_link = link
        .join("maboroshi")
        .join("worktrees")
        .join(project.file_name().expect("project name"))
        .join("feature");
    let via_real = project.join("feature");
    assert!(via_link.is_dir());
    let canonical = via_link.canonicalize().expect("real");
    assert_ne!(canonical, via_link, "enter through the symlink spelling");
    let git_bin = text(
        &repo
            .command("sh", &["-c", "command -v git"])
            .output()
            .expect("locate git")
            .stdout,
    );
    let bin = repo.root.join("bin");
    fs::create_dir_all(&bin).expect("bin");
    let wrapper = bin.join("git");
    fs::write(
        &wrapper,
        format!(
            "#!/bin/sh\nif [ \"$1\" = \"rev-parse\" ] && [ \"$2\" = \"--show-toplevel\" ]; then\n  real=$({git_bin} rev-parse --show-toplevel) || exit $?\n  if [ \"$real\" = \"$REAL_TOP\" ]; then\n    printf '%s\\n' \"$LOGICAL_TOP\"\n    exit 0\n  fi\n  printf '%s\\n' \"$real\"\n  exit 0\nfi\nexec {git_bin} \"$@\"\n"
        ),
    )
    .expect("wrapper");
    use std::os::unix::fs::PermissionsExt;
    let mut perms = fs::metadata(&wrapper).expect("meta").permissions();
    perms.set_mode(0o755);
    fs::set_permissions(&wrapper, perms).expect("chmod");
    let path_env = format!(
        "{}:{}",
        bin.display(),
        std::env::var("PATH").unwrap_or_default()
    );
    let with_logical_top = |args: &[&str]| {
        repo.command(env!("CARGO_BIN_EXE_mabo"), args)
            .env("XDG_DATA_HOME", &link)
            .env("PATH", &path_env)
            .env("REAL_TOP", &canonical)
            .env("LOGICAL_TOP", &via_link)
            .current_dir(&via_link)
            .output()
            .expect("mabo")
    };
    let refused = with_logical_top(&["delete", "feature"]);
    assert_eq!(
        refused.status.code(),
        Some(4),
        "{}\n{}",
        text(&refused.stdout),
        text(&refused.stderr)
    );
    assert!(
        text(&refused.stderr).contains("current directory"),
        "{}",
        text(&refused.stderr)
    );
    assert!(via_real.is_dir());
    let deleted = with_logical_top(&["delete", "--current"]);
    assert!(
        deleted.status.success(),
        "{}\n{}",
        text(&deleted.stdout),
        text(&deleted.stderr)
    );
    assert!(
        text(&deleted.stdout).contains("Deleted worktree 'feature'"),
        "{}",
        text(&deleted.stdout)
    );
    assert!(!via_real.exists());
}

#[test]
fn recheckout_through_a_symlink_keeps_owner_and_refreshes_last_used() {
    let repo = Repo::new();
    let created = repo.mabo(&[
        "create",
        "issues/7",
        "--owner",
        "alice",
        "--purpose",
        "keep me",
        "--json",
    ]);
    assert!(
        created.status.success(),
        "{}\n{}",
        text(&created.stdout),
        text(&created.stderr)
    );
    let created_json = json_value(&created);
    let real = PathBuf::from(
        created_json["data"]["worktree"]["path"]
            .as_str()
            .expect("path"),
    );
    let created_at = created_json["data"]["worktree"]["createdAt"]
        .as_str()
        .expect("createdAt")
        .to_string();
    let created_from = created_json["data"]["worktree"]["createdFrom"]
        .as_str()
        .expect("createdFrom")
        .to_string();
    let last_used = created_json["data"]["worktree"]["lastUsedAt"]
        .as_str()
        .expect("lastUsedAt")
        .to_string();
    std::thread::sleep(std::time::Duration::from_millis(5));
    let via = repo.root.join("via-project");
    std::os::unix::fs::symlink(real.parent().expect("project"), &via).expect("symlink");
    let git_dir = repo
        .command("git", &["rev-parse", "--git-dir"])
        .current_dir(&real)
        .output()
        .expect("git dir");
    assert!(git_dir.status.success(), "{}", text(&git_dir.stderr));
    let printed = PathBuf::from(text(&git_dir.stdout).trim());
    let git_admin = if printed.is_absolute() {
        printed
    } else {
        real.join(printed)
    };
    let gitdir = git_admin.join("gitdir");
    fs::write(
        &gitdir,
        format!("{}\n", via.join("7").join(".git").display()),
    )
    .expect("gitdir");
    let bin = repo.root.join("bin");
    fs::create_dir_all(&bin).expect("bin");
    let gh = bin.join("gh");
    fs::write(
        &gh,
        "#!/bin/sh\nif [ \"$1\" = \"repo\" ]; then\n  printf '%s\\n' '{\"url\":\"https://github.com/acme/demo\",\"owner\":{\"login\":\"acme\"},\"name\":\"demo\"}'\n  exit 0\nfi\nprintf '%s\\n' '{\"number\":7}'\nexit 0\n",
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
    let again = repo
        .command(
            env!("CARGO_BIN_EXE_mabo"),
            &[
                "github",
                "checkout",
                "7",
                "--owner",
                "bob",
                "--purpose",
                "replace",
                "--json",
            ],
        )
        .env("PATH", &path)
        .output()
        .expect("checkout");
    assert!(
        again.status.success(),
        "{}\n{}",
        text(&again.stdout),
        text(&again.stderr)
    );
    let again_json = json_value(&again);
    assert!(again_json["error"].is_null(), "{again_json}");
    assert_eq!(again_json["data"]["github"]["alreadyExists"], true);
    let worktree = &again_json["data"]["worktree"];
    assert_eq!(worktree["owner"], "alice");
    assert_eq!(worktree["purpose"], "keep me");
    assert_eq!(worktree["createdAt"], created_at);
    assert_eq!(worktree["createdFrom"], created_from);
    assert_ne!(worktree["lastUsedAt"], last_used);
    assert_eq!(worktree["links"]["issue"]["number"], 7);
}

fn empty_commit(repo: &Repo, dir: &Path, message: &str) {
    let output = repo
        .command("git", &["commit", "--allow-empty", "-m", message])
        .current_dir(dir)
        .output()
        .expect("commit");
    assert!(
        output.status.success(),
        "git commit: {}",
        text(&output.stderr)
    );
}

#[test]
fn delete_refuses_a_branch_with_unpushed_commits() {
    let repo = Repo::new();
    let help = repo.mabo(&["delete", "--help"]);
    assert!(help.status.success(), "{}", text(&help.stderr));
    let help_text = text(&help.stdout);
    assert!(help_text.contains("unpushed"), "{help_text}");
    assert!(help_text.contains("current directory"), "{help_text}");

    assert!(repo.mabo(&["create", "u"]).status.success());
    let worktree = managed(&repo, "u");
    empty_commit(&repo, &worktree, "x");
    let refused = repo.mabo(&["delete", "u"]);
    assert_eq!(refused.status.code(), Some(4), "{}", text(&refused.stdout));
    let refused_text = text(&refused.stderr);
    assert!(refused_text.contains("unpushed"), "{refused_text}");
    assert!(
        refused_text.contains("Use --keep-branch to keep the branch, or --force to delete it."),
        "{refused_text}"
    );
    assert!(worktree.is_dir());
    assert!(branch_listed(&repo, "u"));

    let json = repo.mabo(&["delete", "u", "--json"]);
    assert_eq!(json.status.code(), Some(4));
    assert!(text(&json.stderr).is_empty(), "{}", text(&json.stderr));
    let document = json_value(&json);
    assert_eq!(document["error"]["code"], "unpreserved");
    assert!(document["error"].get("exitCode").is_none());
    assert!(document["error"]["message"]
        .as_str()
        .unwrap_or("")
        .contains("unpushed"));
    assert_eq!(document["data"]["deleted"][0]["branchDeleted"], false);
    assert_eq!(document["data"]["deleted"][0]["worktree"]["name"], "u");
    assert!(worktree.is_dir());
    assert!(branch_listed(&repo, "u"));

    assert!(repo.mabo(&["create", "kept"]).status.success());
    let kept_dir = managed(&repo, "kept");
    empty_commit(&repo, &kept_dir, "keep");
    let kept = repo.mabo(&["delete", "kept", "--keep-branch"]);
    assert!(
        kept.status.success(),
        "{}\n{}",
        text(&kept.stdout),
        text(&kept.stderr)
    );
    assert!(text(&kept.stdout).contains("kept its branch 'kept'"));
    assert!(!kept_dir.exists());
    assert!(branch_listed(&repo, "kept"));

    let forced = repo.mabo(&["delete", "u", "--force"]);
    assert!(
        forced.status.success(),
        "{}\n{}",
        text(&forced.stdout),
        text(&forced.stderr)
    );
    assert!(text(&forced.stdout).contains("and its branch 'u'"));
    assert!(!worktree.exists());
    assert!(!branch_listed(&repo, "u"));

    let bare = repo.root.join("origin.git");
    repo.git(&["init", "--bare", bare.to_str().expect("bare")]);
    repo.git(&["remote", "add", "origin", bare.to_str().expect("origin")]);
    repo.git(&["push", "-u", "origin", "main"]);

    assert!(repo.mabo(&["create", "shipped"]).status.success());
    let shipped = managed(&repo, "shipped");
    empty_commit(&repo, &shipped, "ship");
    repo.git(&["push", "-u", "origin", "shipped"]);
    let removed = repo.mabo(&["delete", "shipped"]);
    assert!(
        removed.status.success(),
        "{}\n{}",
        text(&removed.stdout),
        text(&removed.stderr)
    );
    assert!(!shipped.exists());
    assert!(!branch_listed(&repo, "shipped"));

    assert!(repo.mabo(&["create", "behind"]).status.success());
    let behind = managed(&repo, "behind");
    empty_commit(&repo, &behind, "first");
    repo.git(&["push", "-u", "origin", "behind"]);
    empty_commit(&repo, &behind, "second");
    let behind_refused = repo.mabo(&["delete", "behind"]);
    assert_eq!(behind_refused.status.code(), Some(4));
    assert!(
        text(&behind_refused.stderr).contains("unpushed"),
        "{}",
        text(&behind_refused.stderr)
    );
    assert!(behind.is_dir());
    assert!(branch_listed(&repo, "behind"));

    assert!(repo.mabo(&["create", "landed"]).status.success());
    commit_in_worktree(&repo, "landed");
    repo.git(&["merge", "--ff-only", "landed"]);
    let landed = repo.mabo(&["delete", "landed"]);
    assert!(
        landed.status.success(),
        "{}\n{}",
        text(&landed.stdout),
        text(&landed.stderr)
    );
    assert!(!managed(&repo, "landed").exists());
    assert!(!branch_listed(&repo, "landed"));
}

#[test]
fn delete_refuses_when_unpushed_commits_cannot_be_checked() {
    let repo = Repo::new();
    assert!(repo.mabo(&["create", "mystery"]).status.success());
    repo.git(&["branch", "-m", "main", "trunk"]);
    let mystery = managed(&repo, "mystery");
    let unknown = repo.mabo(&["delete", "mystery"]);
    assert_eq!(unknown.status.code(), Some(4), "{}", text(&unknown.stdout));
    assert!(
        text(&unknown.stderr).contains("could not be checked"),
        "{}",
        text(&unknown.stderr)
    );
    assert!(mystery.is_dir());
    assert!(branch_listed(&repo, "mystery"));
    let forced = repo.mabo(&["delete", "mystery", "--force"]);
    assert!(
        forced.status.success(),
        "{}\n{}",
        text(&forced.stdout),
        text(&forced.stderr)
    );
    assert!(!mystery.exists());
}

#[test]
fn gc_and_delete_accept_a_squash_merged_branch_whose_remote_is_gone() {
    let repo = Repo::new();
    assert!(repo.mabo(&["create", "feature"]).status.success());
    commit_in_worktree(&repo, "feature");
    commit_file(&repo, "feature", "more.txt", "more\n");
    publish_branch(&repo, "feature");
    squash_onto_main(&repo, "feature");

    let plan = repo.mabo(&["gc"]);
    assert!(plan.status.success(), "{}", text(&plan.stderr));
    let planned = text(&plan.stdout);
    assert!(
        planned.contains("would remove feature [merged]"),
        "{planned}"
    );
    assert!(worktree_dir(&repo, "feature").is_dir());
    assert!(branch_listed(&repo, "feature"));

    let deleted = repo.mabo(&["delete", "feature"]);
    assert!(
        deleted.status.success(),
        "{}\n{}",
        text(&deleted.stdout),
        text(&deleted.stderr)
    );
    assert!(
        text(&deleted.stdout).contains("and its branch 'feature'"),
        "{}",
        text(&deleted.stdout)
    );
    assert!(!worktree_dir(&repo, "feature").exists());
    assert!(!branch_listed(&repo, "feature"));
}

#[test]
fn delete_refuses_a_squash_merged_branch_with_a_later_commit() {
    let repo = Repo::new();
    assert!(repo.mabo(&["create", "feature"]).status.success());
    commit_in_worktree(&repo, "feature");
    publish_branch(&repo, "feature");
    squash_onto_main(&repo, "feature");
    commit_file(&repo, "feature", "later.txt", "later\n");

    let refused = repo.mabo(&["delete", "feature"]);
    assert_eq!(refused.status.code(), Some(4), "{}", text(&refused.stdout));
    assert!(
        text(&refused.stderr).contains("unpushed"),
        "{}",
        text(&refused.stderr)
    );
    assert!(worktree_dir(&repo, "feature").is_dir());
    assert!(branch_listed(&repo, "feature"));

    let plan = repo.mabo(&["gc"]);
    assert!(plan.status.success(), "{}", text(&plan.stderr));
    let planned = text(&plan.stdout);
    assert!(!planned.contains("would remove feature"), "{planned}");
    assert!(worktree_dir(&repo, "feature").is_dir());
    assert!(branch_listed(&repo, "feature"));
}

#[test]
fn gc_and_delete_accept_a_rebase_merged_branch() {
    let repo = Repo::new();
    assert!(repo.mabo(&["create", "feature"]).status.success());
    commit_in_worktree(&repo, "feature");
    commit_file(&repo, "feature", "more.txt", "more\n");
    publish_branch(&repo, "feature");
    repo.git(&["cherry-pick", "feature~1"]);
    repo.git(&["cherry-pick", "feature"]);
    repo.git(&["push", "origin", "main"]);
    repo.git(&["push", "origin", "--delete", "feature"]);

    let plan = repo.mabo(&["gc"]);
    assert!(plan.status.success(), "{}", text(&plan.stderr));
    let planned = text(&plan.stdout);
    assert!(
        planned.contains("would remove feature [merged]"),
        "{planned}"
    );

    let deleted = repo.mabo(&["delete", "feature"]);
    assert!(
        deleted.status.success(),
        "{}\n{}",
        text(&deleted.stdout),
        text(&deleted.stderr)
    );
    assert!(!worktree_dir(&repo, "feature").exists());
    assert!(!branch_listed(&repo, "feature"));
}

#[test]
fn gc_applies_a_squash_merged_branch_with_no_remote_and_keeps_a_local_one() {
    let repo = Repo::new();
    assert!(repo.mabo(&["create", "local"]).status.success());
    commit_in_worktree(&repo, "local");
    assert!(repo.mabo(&["create", "squashed"]).status.success());
    commit_in_worktree(&repo, "squashed");
    squash_onto_main(&repo, "squashed");

    let refused = repo.mabo(&["delete", "local"]);
    assert_eq!(refused.status.code(), Some(4), "{}", text(&refused.stdout));
    assert!(
        text(&refused.stderr).contains("unpushed"),
        "{}",
        text(&refused.stderr)
    );
    assert!(worktree_dir(&repo, "local").is_dir());
    assert!(branch_listed(&repo, "local"));

    let applied = repo.mabo(&["gc", "--apply"]);
    assert!(applied.status.success(), "{}", text(&applied.stderr));
    let removed = text(&applied.stdout);
    assert!(removed.contains("removed squashed [merged]"), "{removed}");
    assert!(!removed.contains("local"), "{removed}");
    assert!(!worktree_dir(&repo, "squashed").exists());
    assert!(!branch_listed(&repo, "squashed"));
    assert!(worktree_dir(&repo, "local").is_dir());
    assert!(branch_listed(&repo, "local"));
}

#[test]
fn delete_refuses_the_worktree_that_contains_the_current_directory() {
    let repo = Repo::new();
    assert!(repo.mabo(&["create", "inside"]).status.success());
    assert!(repo.mabo(&["create", "other"]).status.success());
    let inside = managed(&repo, "inside");
    let other = managed(&repo, "other");

    let refused = repo
        .command(env!("CARGO_BIN_EXE_mabo"), &["delete", "inside"])
        .current_dir(&inside)
        .output()
        .expect("delete");
    assert_eq!(refused.status.code(), Some(4), "{}", text(&refused.stdout));
    assert!(
        text(&refused.stderr).contains("current directory"),
        "{}",
        text(&refused.stderr)
    );
    assert!(inside.is_dir());
    assert!(branch_listed(&repo, "inside"));

    let json = repo
        .command(env!("CARGO_BIN_EXE_mabo"), &["delete", "inside", "--json"])
        .current_dir(&inside)
        .output()
        .expect("json");
    assert_eq!(json.status.code(), Some(4));
    assert!(text(&json.stderr).is_empty(), "{}", text(&json.stderr));
    let document = json_value(&json);
    assert_eq!(document["error"]["code"], "refused");
    assert!(document["error"].get("exitCode").is_none());
    assert_eq!(document["data"]["deleted"][0]["worktree"]["name"], "inside");
    assert!(inside.is_dir());

    let neighbor = repo
        .command(env!("CARGO_BIN_EXE_mabo"), &["delete", "other"])
        .current_dir(&inside)
        .output()
        .expect("other");
    assert!(
        neighbor.status.success(),
        "{}\n{}",
        text(&neighbor.stdout),
        text(&neighbor.stderr)
    );
    assert!(!other.exists());
    assert!(inside.is_dir());

    let current = repo
        .command(env!("CARGO_BIN_EXE_mabo"), &["delete", "--current"])
        .current_dir(&inside)
        .output()
        .expect("current");
    assert!(
        current.status.success(),
        "{}\n{}",
        text(&current.stdout),
        text(&current.stderr)
    );
    assert!(!inside.exists());

    assert!(repo.mabo(&["create", "both"]).status.success());
    let both = managed(&repo, "both");
    empty_commit(&repo, &both, "local");
    let named = repo
        .command(env!("CARGO_BIN_EXE_mabo"), &["delete", "both"])
        .current_dir(&both)
        .output()
        .expect("named");
    assert_eq!(named.status.code(), Some(4));
    assert!(
        text(&named.stderr).contains("current directory"),
        "{}",
        text(&named.stderr)
    );
    assert!(both.is_dir());
    let via_current = repo
        .command(env!("CARGO_BIN_EXE_mabo"), &["delete", "--current"])
        .current_dir(&both)
        .output()
        .expect("current unpushed");
    assert_eq!(via_current.status.code(), Some(4));
    assert!(
        text(&via_current.stderr).contains("unpushed"),
        "{}",
        text(&via_current.stderr)
    );
    assert!(both.is_dir());
    assert!(branch_listed(&repo, "both"));
    let forced = repo
        .command(env!("CARGO_BIN_EXE_mabo"), &["delete", "both", "--force"])
        .current_dir(&both)
        .output()
        .expect("force");
    assert!(
        forced.status.success(),
        "{}\n{}",
        text(&forced.stdout),
        text(&forced.stderr)
    );
    assert!(!both.exists());
    assert!(!branch_listed(&repo, "both"));
}

fn rev_parse(repo: &Repo, dir: &Path, spec: &str) -> String {
    let output = repo
        .command("git", &["rev-parse", spec])
        .current_dir(dir)
        .output()
        .expect("rev-parse");
    assert!(
        output.status.success(),
        "git rev-parse {spec}: {}",
        text(&output.stderr)
    );
    text(&output.stdout)
}

#[test]
fn delete_and_gc_keep_a_branch_shadowed_by_a_tag() {
    let repo = Repo::new();
    assert!(repo.mabo(&["create", "v1"]).status.success());
    let worktree = managed(&repo, "v1");
    empty_commit(&repo, &worktree, "only on the branch");
    let commit = rev_parse(&repo, &repo.repo, "refs/heads/v1");
    repo.git(&["tag", "v1", "main"]);

    let refused = repo.mabo(&["delete", "v1"]);
    assert_eq!(refused.status.code(), Some(4), "{}", text(&refused.stdout));
    assert!(
        text(&refused.stderr).contains("unpushed"),
        "{}",
        text(&refused.stderr)
    );
    assert!(worktree.is_dir());
    assert!(branch_listed(&repo, "v1"));
    assert_eq!(rev_parse(&repo, &repo.repo, "refs/heads/v1"), commit);

    age_metadata(&repo, "v1");
    let cleaned = repo.mabo(&["gc", "--older-than", "14d", "--apply"]);
    assert!(
        cleaned.status.success(),
        "{}\n{}",
        text(&cleaned.stdout),
        text(&cleaned.stderr)
    );
    let cleaned_text = text(&cleaned.stdout);
    assert!(
        cleaned_text.contains("skip v1 [olderThan] unpushed"),
        "{cleaned_text}"
    );
    assert!(worktree.is_dir());
    assert!(branch_listed(&repo, "v1"));
    assert_eq!(rev_parse(&repo, &repo.repo, "refs/heads/v1"), commit);
}

#[test]
fn delete_refuses_a_detached_worktree_until_force() {
    let repo = Repo::new();
    assert!(repo.mabo(&["create", "dt"]).status.success());
    let worktree = managed(&repo, "dt");
    let detached = repo
        .command("git", &["checkout", "--detach"])
        .current_dir(&worktree)
        .output()
        .expect("detach");
    assert!(detached.status.success(), "{}", text(&detached.stderr));
    empty_commit(&repo, &worktree, "only here");
    let commit = rev_parse(&repo, &worktree, "HEAD");

    let refused = repo.mabo(&["delete", "dt"]);
    assert_eq!(refused.status.code(), Some(4), "{}", text(&refused.stdout));
    let refused_text = text(&refused.stderr);
    assert!(refused_text.contains("unpushed"), "{refused_text}");
    assert!(
        refused_text.contains("Use --force to delete anyway."),
        "{refused_text}"
    );
    assert!(!refused_text.contains("--keep-branch"), "{refused_text}");
    let kept = repo.mabo(&["delete", "dt", "--keep-branch"]);
    assert_eq!(kept.status.code(), Some(4), "{}", text(&kept.stdout));
    assert!(worktree.is_dir());
    assert_eq!(rev_parse(&repo, &worktree, "HEAD"), commit);

    let forced = repo.mabo(&["delete", "dt", "--force"]);
    assert!(
        forced.status.success(),
        "{}\n{}",
        text(&forced.stdout),
        text(&forced.stderr)
    );
    assert!(!worktree.exists());

    let bare = repo.root.join("origin.git");
    repo.git(&["init", "--bare", bare.to_str().expect("bare")]);
    repo.git(&["remote", "add", "origin", bare.to_str().expect("origin")]);
    repo.git(&["push", "-u", "origin", "main"]);
    assert!(repo.mabo(&["create", "shipped"]).status.success());
    let shipped = managed(&repo, "shipped");
    empty_commit(&repo, &shipped, "on the remote");
    repo.git(&["push", "-u", "origin", "shipped"]);
    let again = repo
        .command("git", &["checkout", "--detach"])
        .current_dir(&shipped)
        .output()
        .expect("detach shipped");
    assert!(again.status.success(), "{}", text(&again.stderr));
    let pushed = rev_parse(&repo, &shipped, "HEAD");
    let removed = repo.mabo(&["delete", "shipped"]);
    assert!(
        removed.status.success(),
        "{}\n{}",
        text(&removed.stdout),
        text(&removed.stderr)
    );
    assert!(!shipped.exists());
    assert_eq!(
        rev_parse(&repo, &repo.repo, &pushed),
        pushed,
        "the pushed commit stays reachable"
    );
}

#[test]
fn delete_checks_every_name_before_removing_any() {
    let repo = Repo::new();
    let marker = repo.root.join("hook-ran");
    fs::write(
        repo.repo.join(".mabo.toml"),
        format!("[hooks]\npre-delete = [\"touch {}\"]\n", marker.display()),
    )
    .expect("hooks");
    assert!(repo.mabo(&["create", "a"]).status.success());
    assert!(repo.mabo(&["create", "b"]).status.success());
    assert!(repo.mabo(&["create", "c"]).status.success());
    let a = managed(&repo, "a");
    let b = managed(&repo, "b");
    let c = managed(&repo, "c");
    empty_commit(&repo, &b, "local");

    let refused = repo.mabo(&["delete", "a", "b", "missing"]);
    assert_eq!(refused.status.code(), Some(4), "{}", text(&refused.stdout));
    let stderr = text(&refused.stderr);
    assert!(stderr.contains("unpushed"), "{stderr}");
    assert!(stderr.contains("missing"), "{stderr}");
    assert!(a.is_dir());
    assert!(b.is_dir());
    assert!(c.is_dir());
    assert!(!marker.exists(), "hooks run only after every name passes");
    assert!(branch_listed(&repo, "a"));
    assert!(branch_listed(&repo, "b"));

    let json = repo.mabo(&["delete", "a", "b", "missing", "--json"]);
    assert_eq!(json.status.code(), Some(4));
    assert!(text(&json.stderr).is_empty(), "{}", text(&json.stderr));
    let document = json_value(&json);
    let entries = document["data"]["deleted"].as_array().expect("deleted");
    assert_eq!(entries.len(), 2);
    assert_eq!(entries[0]["worktree"]["name"], "b");
    assert!(entries[0]["error"]
        .as_str()
        .unwrap_or("")
        .contains("unpushed"));
    assert!(entries[1]["worktree"].is_null());
    assert!(entries[1]["error"]
        .as_str()
        .unwrap_or("")
        .contains("missing"));
    assert_eq!(document["error"]["code"], "unpreserved");
    assert!(document["error"].get("exitCode").is_none());
    assert!(a.is_dir());
    assert!(b.is_dir());

    let removed = repo.mabo(&["delete", "a", "c"]);
    assert!(
        removed.status.success(),
        "{}\n{}",
        text(&removed.stdout),
        text(&removed.stderr)
    );
    assert!(!a.exists());
    assert!(!c.exists());
    assert!(b.is_dir());
    assert!(branch_listed(&repo, "b"));
}

#[test]
fn gc_keeps_the_current_worktree_when_its_parent_was_replaced_by_a_symlink() {
    let repo = Repo::new();
    assert!(repo.mabo(&["create", "here"]).status.success());
    land_branch(&repo, "here");
    assert!(repo.mabo(&["create", "gone"]).status.success());
    land_branch(&repo, "gone");
    let parent = managed_root(&repo);
    let moved = repo.root.join("moved-parent");
    fs::rename(&parent, &moved).expect("move parent");
    std::os::unix::fs::symlink(&moved, &parent).expect("symlink parent");
    let here = parent.join("here");
    assert!(here.is_dir());
    let applied = repo
        .command(env!("CARGO_BIN_EXE_mabo"), &["gc", "--apply"])
        .current_dir(&here)
        .output()
        .expect("gc");
    assert!(
        applied.status.success(),
        "{}\n{}",
        text(&applied.stdout),
        text(&applied.stderr)
    );
    let stdout = text(&applied.stdout);
    assert!(
        stdout.contains("skip here [merged] current worktree"),
        "{stdout}"
    );
    assert!(stdout.contains("removed gone [merged]"), "{stdout}");
    assert!(
        moved.join("here").is_dir(),
        "gc removed the worktree that contains the current directory"
    );
    assert!(
        parent.join("here").is_dir(),
        "gc removed the worktree reached through the symlink"
    );
    assert!(moved.is_dir(), "gc removed the current worktree's parent");
    assert!(
        parent
            .symlink_metadata()
            .expect("parent")
            .file_type()
            .is_symlink(),
        "gc removed the symlink that replaced the parent directory"
    );
    assert!(!moved.join("gone").exists());
}

#[test]
fn meta_set_records_an_outside_worktree_by_branch_instead_of_a_colliding_basename() {
    let repo = Repo::new();
    assert!(repo.mabo(&["create", "dup"]).status.success());
    let outside = repo.root.join("x").join("dup");
    fs::create_dir_all(outside.parent().expect("parent")).expect("x");
    repo.git(&[
        "worktree",
        "add",
        "-b",
        "zz",
        outside.to_str().expect("outside"),
        "HEAD",
    ]);
    let marked = repo.mabo(&["meta", "set", "zz", "--owner", "a"]);
    assert!(
        marked.status.success(),
        "{}\n{}",
        text(&marked.stdout),
        text(&marked.stderr)
    );
    assert!(
        text(&marked.stdout).contains("zz"),
        "{}",
        text(&marked.stdout)
    );
    let found = repo.mabo(&["where", "dup"]);
    assert!(
        found.status.success(),
        "{}\n{}",
        text(&found.stdout),
        text(&found.stderr)
    );
    assert!(paths_match(
        text(&found.stdout).trim(),
        &managed(&repo, "dup")
    ));
    let outside_where = repo.mabo(&["where", "zz"]);
    assert!(
        outside_where.status.success(),
        "{}\n{}",
        text(&outside_where.stdout),
        text(&outside_where.stderr)
    );
    assert!(paths_match(text(&outside_where.stdout).trim(), &outside));
    let stored =
        records::read_to_string(repo.repo.join(".git/maboroshi/workspaces")).expect("meta");
    assert!(stored.contains("\"name\": \"zz\""), "{stored}");
    let names = text(&repo.mabo(&["list", "--names", "--no-default"]).stdout);
    assert!(names.lines().any(|line| line == "dup"), "{names}");
    assert!(names.lines().any(|line| line == "zz"), "{names}");
    assert_eq!(
        names.lines().filter(|line| *line == "dup").count(),
        1,
        "{names}"
    );

    let loose = repo.root.join("x").join("loose");
    repo.git(&[
        "worktree",
        "add",
        "--detach",
        loose.to_str().expect("loose"),
        "HEAD",
    ]);
    assert!(repo.mabo(&["create", "loose"]).status.success());
    let head = repo
        .command("git", &["rev-parse", "--short=7", "HEAD"])
        .current_dir(&loose)
        .output()
        .expect("short head");
    assert!(head.status.success(), "{}", text(&head.stderr));
    let sha = text(&head.stdout);
    let detached = repo.mabo(&["meta", "set", &sha, "--owner", "b"]);
    assert!(
        detached.status.success(),
        "{}\n{}",
        text(&detached.stdout),
        text(&detached.stderr)
    );
    let found_loose = repo.mabo(&["where", "loose"]);
    assert!(
        found_loose.status.success(),
        "{}",
        text(&found_loose.stderr)
    );
    assert!(paths_match(
        text(&found_loose.stdout).trim(),
        &managed(&repo, "loose")
    ));
    let found_sha = repo.mabo(&["where", &sha]);
    assert!(found_sha.status.success(), "{}", text(&found_sha.stderr));
    assert!(paths_match(text(&found_sha.stdout).trim(), &loose));
    let stored =
        records::read_to_string(repo.repo.join(".git/maboroshi/workspaces")).expect("meta");
    assert!(stored.contains(&format!("\"name\": \"{sha}\"")), "{stored}");
    fs::write(loose.join("later.txt"), "later\n").expect("later");
    for args in [vec!["add", "later.txt"], vec!["commit", "-m", "later"]] {
        let output = repo
            .command("git", &args)
            .current_dir(&loose)
            .output()
            .expect("commit");
        assert!(output.status.success(), "{}", text(&output.stderr));
    }
    let later = repo
        .command("git", &["rev-parse", "--short=7", "HEAD"])
        .current_dir(&loose)
        .output()
        .expect("later head");
    assert!(later.status.success(), "{}", text(&later.stderr));
    let later_sha = text(&later.stdout);
    assert_ne!(later_sha, sha);
    let names_after = text(&repo.mabo(&["list", "--names", "--no-default"]).stdout);
    assert!(names_after.lines().any(|line| line == sha), "{names_after}");
    assert!(
        !names_after.lines().any(|line| line == later_sha),
        "{names_after}"
    );
    let still = repo.mabo(&["where", &sha]);
    assert!(still.status.success(), "{}", text(&still.stderr));
    assert!(paths_match(text(&still.stdout).trim(), &loose));
}

#[test]
fn meta_set_records_outside_worktrees_despite_orphaned_names() {
    for layout in [false, true] {
        let repo = Repo::new();
        let records_path = repo.repo.join(".git/maboroshi/worktrees.json");
        let missing = repo.root.join("missing");
        fs::create_dir_all(records_path.parent().expect("parent")).expect("directory");
        let records = serde_json::json!({
            "version": 1,
            "worktrees": [{"path": missing, "name": "shared"}]
        });
        records::write(&records_path, serde_json::to_vec(&records).expect("json"))
            .expect("records");
        let outside = if layout {
            repo.repo.join(".git/maboroshi/worktrees/shared")
        } else {
            repo.root.join("outside")
        };
        fs::create_dir_all(outside.parent().expect("parent")).expect("directory");
        repo.git(&[
            "worktree",
            "add",
            "-b",
            "shared",
            outside.to_str().expect("path"),
            "HEAD",
        ]);
        let marked = repo.mabo(&["meta", "set", "shared", "--owner", "a"]);
        assert!(marked.status.success(), "{}", text(&marked.stderr));
        let found = repo.mabo(&["where", "shared"]);
        assert!(found.status.success(), "{}", text(&found.stderr));
        assert!(paths_match(text(&found.stdout).trim(), &outside));
        let listed = repo.mabo(&["list", "--json", "--no-default"]);
        assert!(listed.status.success(), "{}", text(&listed.stderr));
        let document: serde_json::Value = serde_json::from_slice(&listed.stdout).expect("json");
        let worktrees = document["data"]["worktrees"].as_array().expect("worktrees");
        assert_eq!(worktrees.len(), 2);
        assert!(worktrees
            .iter()
            .all(|worktree| worktree["name"] == "shared"));
        assert_eq!(
            worktrees
                .iter()
                .filter(|worktree| worktree["orphaned"] == true)
                .count(),
            1
        );
        let cleaned = repo.mabo(&["gc", "--apply"]);
        assert!(cleaned.status.success(), "{}", text(&cleaned.stderr));
        let records: serde_json::Value =
            serde_json::from_slice(&records::read(&records_path).expect("records")).expect("json");
        assert!(!records["worktrees"]
            .as_array()
            .expect("records")
            .iter()
            .any(|record| record["path"] == missing.to_str().expect("path")));
    }
}

#[test]
fn meta_set_refuses_to_record_an_outside_worktree_under_a_taken_name() {
    let repo = Repo::new();
    assert!(repo.mabo(&["create", "dup"]).status.success());
    let outside = repo.repo.join(".git/maboroshi/worktrees/dup");
    fs::create_dir_all(outside.parent().expect("parent")).expect("parent");
    repo.git(&[
        "worktree",
        "add",
        "-b",
        "zz",
        outside.to_str().expect("outside"),
        "HEAD",
    ]);
    let meta_path = repo.repo.join(".git/maboroshi/workspaces");
    let before = records::read(&meta_path).expect("before");
    let marked = repo.mabo(&["meta", "set", "zz", "--owner", "a"]);
    assert_eq!(
        marked.status.code(),
        Some(1),
        "{}\n{}",
        text(&marked.stdout),
        text(&marked.stderr)
    );
    let message = format!("{}{}", text(&marked.stdout), text(&marked.stderr));
    assert!(
        message.contains("dup") && message.contains("already used"),
        "{message}"
    );
    let stored = records::read(&meta_path).expect("after");
    assert_eq!(stored, before, "a refused meta set rewrote worktrees.json");
    let found = repo.mabo(&["where", "dup"]);
    assert!(
        found.status.success(),
        "{}\n{}",
        text(&found.stdout),
        text(&found.stderr)
    );
    assert!(paths_match(
        text(&found.stdout).trim(),
        &managed(&repo, "dup")
    ));
}

#[test]
fn a_record_without_a_stored_name_keeps_the_ptm_folder_name() {
    let repo = Repo::new();
    let next = repo.repo.join(".git/ptm/worktrees/next");
    fs::create_dir_all(next.parent().expect("parent")).expect("parent");
    repo.git(&[
        "worktree",
        "add",
        "--detach",
        next.to_str().expect("next"),
        "HEAD",
    ]);
    let head = repo
        .command("git", &["rev-parse", "--short=7", "HEAD"])
        .current_dir(&next)
        .output()
        .expect("head");
    assert!(head.status.success(), "{}", text(&head.stderr));
    let sha = text(&head.stdout);
    let meta = repo.repo.join(".git/maboroshi/worktrees.json");
    fs::create_dir_all(meta.parent().expect("meta dir")).expect("meta dir");
    let path = next.to_string_lossy();
    records::write(
        &meta,
        format!(
            "{{\n  \"version\": 1,\n  \"worktrees\": [\n    {{\n      \"path\": \"{path}\",\n      \"createdAt\": \"2000-01-01T00:00:00.000Z\",\n      \"lastUsedAt\": \"2000-01-01T00:00:00.000Z\"\n    }}\n  ]\n}}\n"
        ),
    )
    .expect("record");
    let names = text(&repo.mabo(&["list", "--names", "--no-default"]).stdout);
    assert!(names.lines().any(|line| line == "next"), "{names}");
    assert!(!names.lines().any(|line| line == sha), "{names}");
    let plan = repo.mabo(&["gc", "--older-than", "14d"]);
    assert!(plan.status.success(), "{}", text(&plan.stderr));
    let planned = text(&plan.stdout);
    assert!(planned.contains("would remove next"), "{planned}");
    assert!(!planned.contains(&sha), "{planned}");
    let found = repo.mabo(&["where", "next"]);
    assert!(found.status.success(), "{}", text(&found.stderr));
    assert!(paths_match(text(&found.stdout).trim(), &next));
    let ran = repo.mabo(&["exec", "next", "true"]);
    assert!(ran.status.success(), "{}", text(&ran.stderr));
    let marked = repo.mabo(&["meta", "set", "next", "--owner", "ada"]);
    assert!(marked.status.success(), "{}", text(&marked.stderr));
    assert!(
        text(&marked.stdout).contains("next"),
        "{}",
        text(&marked.stdout)
    );
    let stored = records::read_to_string(&meta).expect("after set");
    assert!(!stored.contains("\"name\""), "{stored}");
    let still = repo.mabo(&["where", "next"]);
    assert!(still.status.success(), "{}", text(&still.stderr));
    assert!(paths_match(text(&still.stdout).trim(), &next));
    let deleted = repo.mabo(&["delete", "next"]);
    assert!(
        deleted.status.success(),
        "{}\n{}",
        text(&deleted.stdout),
        text(&deleted.stderr)
    );
    assert!(
        text(&deleted.stdout).contains("next"),
        "{}",
        text(&deleted.stdout)
    );
    assert!(!next.exists());
}

fn publish_tracking_branch(repo: &Repo, remote: &str, branch: &str) {
    let bare = repo.root.join(format!("{remote}.git"));
    if !bare.exists() {
        let path = bare.to_str().expect("bare");
        let init = repo
            .command("git", &["init", "--bare", "-b", "main", path])
            .output()
            .expect("bare");
        assert!(init.status.success(), "{}", text(&init.stderr));
        repo.git(&["remote", "add", remote, path]);
        repo.git(&["push", remote, "main"]);
    }
    repo.git(&["checkout", "main"]);
    if local_branch(repo, branch).is_empty() {
        repo.git(&["branch", branch, "main"]);
    }
    repo.git(&["push", remote, branch]);
    repo.git(&["checkout", "main"]);
    if !local_branch(repo, branch).is_empty() {
        repo.git(&["branch", "-D", branch]);
    }
}

fn upstream_name(repo: &Repo, branch: &str) -> String {
    let output = repo
        .command(
            "git",
            &[
                "rev-parse",
                "--abbrev-ref",
                &format!("{branch}@{{upstream}}"),
            ],
        )
        .output()
        .expect("upstream");
    assert!(output.status.success(), "{}", text(&output.stderr));
    text(&output.stdout)
}

#[test]
fn create_refuses_a_remote_tracking_name_and_attach_tracks_it() {
    let repo = Repo::new();
    repo.git(&["config", "branch.autoSetupMerge", "false"]);
    publish_tracking_branch(&repo, "origin", "feature/teammate");
    repo.git(&[
        "remote",
        "set-url",
        "origin",
        repo.root.join("missing.git").to_str().expect("missing"),
    ]);

    let created = repo.mabo(&["create", "feature/teammate"]);
    assert_eq!(created.status.code(), Some(4), "{}", text(&created.stderr));
    assert_eq!(
        text(&created.stderr),
        "Branch 'feature/teammate' already exists as a remote-tracking branch (origin). Run `mabo attach feature/teammate`."
    );
    assert!(local_branch(&repo, "feature/teammate").is_empty());

    let attached = repo.mabo(&["attach", "feature/teammate"]);
    assert!(attached.status.success(), "{}", text(&attached.stderr));
    assert!(text(&attached.stdout).contains("Attached worktree: feature/teammate"));
    assert_eq!(
        upstream_name(&repo, "feature/teammate"),
        "origin/feature/teammate"
    );
    assert!(managed(&repo, "feature/teammate")
        .join("README.md")
        .is_file());

    let again = repo.mabo(&["attach", "feature/teammate"]);
    assert_eq!(again.status.code(), Some(4));
    assert_eq!(
        text(&again.stderr),
        "Worktree 'feature/teammate' already exists"
    );
    let shadowed = repo.mabo(&["create", "feature/teammate"]);
    assert_eq!(shadowed.status.code(), Some(4));
    assert_eq!(
        text(&shadowed.stderr),
        "Worktree 'feature/teammate' already exists"
    );
}

#[test]
fn create_with_multiple_remotes_suggests_working_qualified_attach_commands() {
    for remote in ["origin", "upstream"] {
        let repo = Repo::new();
        repo.git(&["config", "branch.autoSetupMerge", "false"]);
        publish_tracking_branch(&repo, "origin", "feature/teammate");
        publish_tracking_branch(&repo, "upstream", "feature/teammate");

        let created = repo.mabo(&["create", "feature/teammate"]);
        assert_eq!(created.status.code(), Some(4), "{}", text(&created.stderr));
        let message = text(&created.stderr);
        assert_eq!(
            message,
            "Branch 'feature/teammate' already exists as a remote-tracking branch (origin, upstream). Run `mabo attach origin/feature/teammate` or `mabo attach upstream/feature/teammate`."
        );
        assert!(local_branch(&repo, "feature/teammate").is_empty());
        assert!(!managed(&repo, "feature/teammate").exists());

        let qualified = format!("{remote}/feature/teammate");
        let command = message
            .split('`')
            .find(|command| *command == format!("mabo attach {qualified}"))
            .expect("suggested attach command");
        let args: Vec<_> = command.split_whitespace().skip(1).collect();
        let attached = repo.mabo(&args);
        assert!(attached.status.success(), "{}", text(&attached.stderr));
        assert!(text(&attached.stdout).contains("Attached worktree: feature/teammate"));
        assert_eq!(upstream_name(&repo, "feature/teammate"), qualified);
        assert!(managed(&repo, "feature/teammate")
            .join("README.md")
            .is_file());
    }
}

#[test]
fn attach_qualified_remote_drops_the_remote_prefix() {
    let repo = Repo::new();
    repo.git(&["config", "branch.autoSetupMerge", "false"]);
    publish_tracking_branch(&repo, "origin", "feature/teammate");
    let attached = repo.mabo(&["attach", "origin/feature/teammate"]);
    assert!(attached.status.success(), "{}", text(&attached.stderr));
    assert!(text(&attached.stdout).contains("Attached worktree: feature/teammate"));
    assert_eq!(
        upstream_name(&repo, "feature/teammate"),
        "origin/feature/teammate"
    );
    assert!(managed(&repo, "feature/teammate").is_dir());
    assert!(local_branch(&repo, "origin/feature/teammate").is_empty());
}

#[test]
fn attach_qualified_remote_allows_special_characters_in_the_remote_name() {
    let repo = Repo::new();
    repo.git(&["config", "branch.autoSetupMerge", "false"]);
    publish_tracking_branch(&repo, "origin", "feature");
    publish_tracking_branch(&repo, "user@host", "feature");

    let ambiguous = repo.mabo(&["attach", "feature"]);
    assert_eq!(ambiguous.status.code(), Some(2));
    assert!(text(&ambiguous.stderr).contains("origin, user@host"));

    let attached = repo.mabo(&["attach", "user@host/feature"]);
    assert!(attached.status.success(), "{}", text(&attached.stderr));
    assert!(text(&attached.stdout).contains("Attached worktree: feature"));
    assert_eq!(upstream_name(&repo, "feature"), "user@host/feature");
    assert!(managed(&repo, "feature").join("README.md").is_file());
    assert!(local_branch(&repo, "user@host/feature").is_empty());

    let invalid = repo.mabo(&["attach", "invalid@name"]);
    assert_eq!(invalid.status.code(), Some(2), "{}", text(&invalid.stderr));
    assert!(text(&invalid.stderr).contains("Worktree name can only contain"));
}

#[test]
fn attach_lists_every_remote_that_has_the_name() {
    let repo = Repo::new();
    repo.git(&["config", "branch.autoSetupMerge", "false"]);
    publish_tracking_branch(&repo, "origin", "solo");
    publish_tracking_branch(&repo, "upstream", "solo");
    let attached = repo.mabo(&["attach", "solo"]);
    assert_eq!(
        attached.status.code(),
        Some(2),
        "{}",
        text(&attached.stderr)
    );
    assert_eq!(
        text(&attached.stderr),
        "Branch 'solo' exists on more than one remote (origin, upstream). Run `mabo attach <remote>/solo`."
    );
    assert!(local_branch(&repo, "solo").is_empty());
    assert!(!managed(&repo, "solo").exists());

    let chosen = repo.mabo(&["attach", "upstream/solo"]);
    assert!(chosen.status.success(), "{}", text(&chosen.stderr));
    assert_eq!(upstream_name(&repo, "solo"), "upstream/solo");
    assert!(managed(&repo, "solo").is_dir());
}

#[test]
fn attach_uses_the_local_branch_when_it_already_exists() {
    let repo = Repo::new();
    publish_tracking_branch(&repo, "origin", "feature/teammate");
    repo.git(&[
        "branch",
        "--no-track",
        "feature/teammate",
        "origin/feature/teammate",
    ]);
    let attached = repo.mabo(&["attach", "feature/teammate"]);
    assert!(attached.status.success(), "{}", text(&attached.stderr));
    let upstream = repo
        .command(
            "git",
            &["rev-parse", "--abbrev-ref", "feature/teammate@{upstream}"],
        )
        .output()
        .expect("upstream");
    assert!(
        !upstream.status.success(),
        "local branch should keep no upstream"
    );
}

#[test]
fn create_still_fails_for_a_local_branch_that_is_not_on_a_remote() {
    let repo = Repo::new();
    repo.git(&["branch", "lonely"]);
    let created = repo.mabo(&["create", "lonely"]);
    assert_eq!(created.status.code(), Some(1), "{}", text(&created.stderr));
    assert!(text(&created.stderr).contains("a branch named 'lonely' already exists"));
    assert!(!text(&created.stderr).contains("mabo attach"));
}

#[test]
fn help_describes_remote_aware_attach_and_create() {
    let repo = Repo::new();
    let attach_help = repo.mabo(&["attach", "--help"]);
    assert!(
        attach_help.status.success(),
        "{}",
        text(&attach_help.stderr)
    );
    let attach = text(&attach_help.stdout)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    assert!(attach.contains("mabo does not fetch"));
    assert!(attach.contains("attach exits 2 and lists those remotes"));
    assert!(!attach.contains("must already exist locally"));
    assert!(!attach.contains("first checkout the branch with git"));
    let create_help = repo.mabo(&["create", "--help"]);
    assert!(
        create_help.status.success(),
        "{}",
        text(&create_help.stderr)
    );
    let create = text(&create_help.stdout)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    assert!(create.contains("mabo attach <name>"));
    assert!(create.contains("create exits 4"));
    let meta = repo.mabo(&["meta", "set", "--help"]);
    assert!(meta.status.success());
    assert!(text(&meta.stdout).contains("A missing name exits 3"));
}

// Deterministic name candidates are only supported in debug builds.
#[cfg(debug_assertions)]
#[test]
fn nameless_create_skips_a_remote_tracking_candidate() {
    let repo = Repo::new();
    publish_tracking_branch(&repo, "origin", "bold-badger");
    let created = repo
        .command(env!("CARGO_BIN_EXE_mabo"), &["create"])
        .env("MABO_NAME_CANDIDATES", "bold-badger,calm-comet")
        .output()
        .expect("mabo");
    assert!(
        created.status.success(),
        "{}\n{}",
        text(&created.stdout),
        text(&created.stderr)
    );
    assert!(text(&created.stdout).contains("Created worktree 'calm-comet'"));
    assert!(local_branch(&repo, "bold-badger").is_empty());
    assert!(local_branch(&repo, "calm-comet").contains("calm-comet"));
    assert!(managed(&repo, "calm-comet").is_dir());
}

fn assert_no_upstream(repo: &Repo, branch: &str) {
    let spec = format!("{branch}@{{upstream}}");
    let output = repo
        .command("git", &["rev-parse", "--abbrev-ref", &spec])
        .output()
        .expect("upstream");
    let stderr = text(&output.stderr);
    assert!(
        !output.status.success(),
        "{branch} tracks {}",
        text(&output.stdout)
    );
    assert!(
        stderr.contains("no upstream configured"),
        "{branch} upstream check: {stderr}"
    );
    assert!(managed(repo, branch).is_dir(), "{branch} worktree missing");
}

#[test]
fn create_sets_no_upstream_from_the_base() {
    let repo = Repo::new();
    let origin = repo.root.join("origin.git");
    repo.git(&[
        "init",
        "--bare",
        "-b",
        "next",
        origin.to_str().expect("origin path"),
    ]);
    repo.git(&["branch", "next"]);
    repo.git(&[
        "remote",
        "add",
        "origin",
        origin.to_str().expect("origin path"),
    ]);
    repo.git(&["push", "origin", "next"]);
    repo.git(&["branch", "local-base"]);
    // `always` makes a local base and HEAD track too. Default git already
    // tracks a remote-tracking base. Create must refuse both.
    repo.git(&["config", "branch.autoSetupMerge", "always"]);

    let remote = repo.mabo(&["create", "x", "--base", "origin/next"]);
    assert!(
        remote.status.success(),
        "{}\n{}",
        text(&remote.stdout),
        text(&remote.stderr)
    );
    assert_no_upstream(&repo, "x");

    let local = repo.mabo(&["create", "from-local", "--base", "local-base"]);
    assert!(
        local.status.success(),
        "{}\n{}",
        text(&local.stdout),
        text(&local.stderr)
    );
    assert_no_upstream(&repo, "from-local");

    let default_base = repo.mabo(&["create", "from-head"]);
    assert!(
        default_base.status.success(),
        "{}\n{}",
        text(&default_base.stdout),
        text(&default_base.stderr)
    );
    assert_no_upstream(&repo, "from-head");
}

#[test]
fn orphaned_records_are_listed_and_deleted_without_hooks_or_branch_changes() {
    let repo = Repo::new();
    for name in ["gone", "json-gone"] {
        let created = repo.mabo(&["create", name]);
        assert!(created.status.success(), "{}", text(&created.stderr));
        repo.git(&[
            "worktree",
            "remove",
            managed(&repo, name).to_str().expect("path"),
        ]);
    }
    fs::write(
        repo.repo.join(".mabo.toml"),
        "[hooks]\npre-delete = [\"exit 99\"]\n",
    )
    .expect("hooks");
    let listed = repo.mabo(&["list"]);
    assert!(listed.status.success(), "{}", text(&listed.stderr));
    assert!(text(&listed.stdout)
        .lines()
        .any(|line| line.starts_with("gone (") && line.ends_with("[orphaned]")));
    let listed = repo.mabo(&["list", "--json"]);
    assert!(listed.status.success(), "{}", text(&listed.stderr));
    let document = json_value(&listed);
    let entries = document["data"]["worktrees"].as_array().expect("worktrees");
    assert_eq!(
        entries
            .iter()
            .find(|item| item["name"] == "gone")
            .expect("gone")["orphaned"],
        true
    );
    assert_eq!(
        entries
            .iter()
            .find(|item| item["default"] == true)
            .expect("default")["orphaned"],
        false
    );
    for command in ["where", "exec"] {
        let args = if command == "exec" {
            vec![command, "gone", "pwd"]
        } else {
            vec![command, "gone"]
        };
        let output = repo.mabo(&args);
        assert!(!output.status.success());
        assert!(
            text(&output.stderr).contains("orphaned"),
            "{}",
            text(&output.stderr)
        );
    }
    let deleted = repo.mabo(&["delete", "gone"]);
    assert_eq!(deleted.status.code(), Some(0), "{}", text(&deleted.stderr));
    assert!(text(&deleted.stdout).contains("already gone; removed only the stale record"));
    assert!(branch_listed(&repo, "gone"));
    let deleted = repo.mabo(&["delete", "json-gone", "--json"]);
    assert_eq!(deleted.status.code(), Some(0), "{}", text(&deleted.stderr));
    let document = json_value(&deleted);
    assert_eq!(document["data"]["deleted"][0]["worktree"]["orphaned"], true);
    assert_eq!(document["data"]["deleted"][0]["branchDeleted"], false);
    assert!(branch_listed(&repo, "json-gone"));
    let records: serde_json::Value = serde_json::from_slice(
        &records::read(repo.repo.join(".git/maboroshi/workspaces")).expect("records"),
    )
    .expect("json");
    assert_eq!(records["worktrees"], serde_json::json!([]));
    assert_eq!(repo.mabo(&["delete", "gone"]).status.code(), Some(3));
}

#[test]
fn delete_prefers_a_live_worktree_over_an_orphaned_record_with_the_same_name() {
    let repo = Repo::new();
    assert!(repo.mabo(&["create", "shared"]).status.success());
    let records_path = repo.repo.join(".git/maboroshi/workspaces");
    let mut records: serde_json::Value =
        serde_json::from_slice(&records::read(&records_path).expect("records")).expect("json");
    let missing = repo.root.join("missing");
    records["worktrees"]
        .as_array_mut()
        .expect("records")
        .push(serde_json::json!({"path": missing, "name": "shared"}));
    records::write(&records_path, serde_json::to_vec(&records).expect("json")).expect("records");
    let deleted = repo.mabo(&["delete", "shared"]);
    assert_eq!(deleted.status.code(), Some(0), "{}", text(&deleted.stderr));
    assert!(!managed(&repo, "shared").exists());
    let records: serde_json::Value =
        serde_json::from_slice(&records::read(records_path).expect("records")).expect("json");
    assert_eq!(records["worktrees"].as_array().expect("records").len(), 1);
    assert_eq!(
        records["worktrees"][0]["path"],
        missing.to_str().expect("path")
    );
}

#[test]
fn ambiguous_orphaned_names_leave_all_records_untouched() {
    let repo = Repo::new();
    let records_path = repo.repo.join(".git/maboroshi/worktrees.json");
    fs::create_dir_all(records_path.parent().expect("parent")).expect("directory");
    let records = serde_json::json!({
        "version": 1,
        "worktrees": [
            {"path": repo.root.join("missing-one"), "name": "shared"},
            {"path": repo.root.join("missing-two"), "name": "shared"}
        ]
    });
    let original = serde_json::to_vec(&records).expect("json");
    records::write(&records_path, &original).expect("records");
    let deleted = repo.mabo(&["delete", "shared"]);
    assert!(!deleted.status.success());
    assert!(text(&deleted.stderr).contains("More than one worktree is named"));
    assert_eq!(records::read(records_path).expect("records"), original);
}

fn assert_envelope(output: &std::process::Output, command: &str) -> serde_json::Value {
    let value: serde_json::Value =
        serde_json::from_slice(&output.stdout).expect("one JSON document");
    let keys = value
        .as_object()
        .expect("envelope")
        .keys()
        .map(String::as_str)
        .collect::<Vec<_>>();
    assert_eq!(
        keys,
        ["command", "data", "error", "ok", "schema", "warnings"]
    );
    assert_eq!(value["schema"], 2);
    assert_eq!(value["command"], command);
    assert_eq!(value["ok"], output.status.success());
    assert!(value["data"].is_object() || value["data"].is_null());
    assert!(value["data"].get("version").is_none());
    assert!(value["data"].get("schema").is_none());
    for warning in value["warnings"].as_array().expect("warnings") {
        assert!(warning["code"].is_string());
        assert!(warning["message"].is_string());
    }
    if output.status.success() {
        assert!(value["error"].is_null());
    } else {
        assert!(value["error"]["code"].is_string());
        assert!(value["error"]["message"].is_string());
    }
    value
}

#[test]
fn unresolved_usage_errors_honor_json_output_and_explicit_text() {
    let repo = Repo::new();
    for (args, mode, command) in [
        (vec!["frobnicate", "--json"], "text", "frobnicate"),
        (vec!["frobnicate", "--json"], "json", "frobnicate"),
        (vec!["frobnicate", "--output", "json"], "text", "frobnicate"),
        (vec!["frobnicate", "--output=json"], "text", "frobnicate"),
        (vec!["frobnicate"], "json", "frobnicate"),
        (vec!["frobnicate", "--help"], "json", "frobnicate"),
        (vec!["frobnicate", "--help", "--json"], "text", "frobnicate"),
        (vec!["--json", "frobnicate"], "text", "frobnicate"),
        (vec!["--json"], "text", ""),
        (vec!["--output", "json"], "text", ""),
        (vec!["--output=json"], "text", ""),
        (vec!["--no-input"], "json", ""),
        (vec!["--json", "--output"], "text", ""),
    ] {
        let out = repo
            .command(env!("CARGO_BIN_EXE_mabo"), &args)
            .env("MABO_OUTPUT", mode)
            .output()
            .expect("mabo");
        assert_eq!(
            out.status.code(),
            Some(2),
            "{args:?}: {}",
            text(&out.stdout)
        );
        let value = assert_envelope(&out, command);
        assert_eq!(value["error"]["code"], "usage");
        assert!(value["data"].is_null());
    }
    for args in [
        vec!["frobnicate", "--output", "text"],
        vec!["--output", "text"],
    ] {
        let out = repo
            .command(env!("CARGO_BIN_EXE_mabo"), &args)
            .env("MABO_OUTPUT", "json")
            .output()
            .expect("mabo");
        assert_eq!(out.status.code(), Some(2));
        assert!(text(&out.stdout).contains("USAGE"));
        assert!(!text(&out.stderr).is_empty());
    }
    for args in [vec!["--help"], vec!["version"], vec!["list", "--help"]] {
        let out = repo
            .command(env!("CARGO_BIN_EXE_mabo"), &args)
            .env("MABO_OUTPUT", "json")
            .output()
            .expect("mabo");
        assert!(out.status.success());
        assert!(serde_json::from_slice::<serde_json::Value>(&out.stdout).is_err());
    }
}

#[test]
fn unsupported_listing_modes_preserve_usage_output() {
    let repo = Repo::new();
    for (command, flag) in [
        ("create", "--names"),
        ("create", "--paths"),
        ("list", "--paths"),
        ("project add", "--names"),
        ("project add", "--paths"),
        ("frobnicate", "--names"),
        ("frobnicate", "--paths"),
        ("list", "--names=value"),
        ("project list", "--paths=value"),
    ] {
        for output_args in [vec![], vec!["--json"], vec!["--output", "json"]] {
            let mut args = command.split_whitespace().collect::<Vec<_>>();
            args.push(flag);
            args.extend(output_args);
            let out = repo
                .command(env!("CARGO_BIN_EXE_mabo"), &args)
                .env("MABO_OUTPUT", "json")
                .output()
                .expect("mabo");
            assert_eq!(out.status.code(), Some(2), "{args:?}");
            let value = assert_envelope(&out, command);
            assert_eq!(value["error"]["code"], "usage");
            assert!(value["data"].is_null());
            assert!(value["error"]["message"]
                .as_str()
                .expect("message")
                .contains(if command == "frobnicate" {
                    "Unknown command"
                } else {
                    "Unknown option"
                }));
        }
        let args = command
            .split_whitespace()
            .chain([flag, "--output", "text"])
            .collect::<Vec<_>>();
        let out = repo
            .command(env!("CARGO_BIN_EXE_mabo"), &args)
            .env("MABO_OUTPUT", "json")
            .output()
            .expect("mabo");
        assert_eq!(out.status.code(), Some(2), "{args:?}");
        assert!(serde_json::from_slice::<serde_json::Value>(&out.stdout).is_err());
        assert!(!out.stderr.is_empty());
    }

    assert!(repo.mabo(&["project", "add"]).status.success());
    for flag in ["--names", "--paths"] {
        let out = repo
            .command(env!("CARGO_BIN_EXE_mabo"), &["project", "list", flag])
            .env("MABO_OUTPUT", "json")
            .output()
            .expect("mabo");
        assert!(out.status.success(), "{}", text(&out.stderr));
        if flag == "--names" {
            assert_eq!(text(&out.stdout), "repo");
        } else {
            assert!(same_dir(&text(&out.stdout), &repo.repo));
        }
    }
}

#[test]
fn every_json_command_uses_the_same_error_envelope() {
    let repo = Repo::new();
    for command in [
        "create",
        "attach",
        "list",
        "where",
        "delete",
        "sync",
        "gc",
        "trust",
        "untrust",
        "meta set",
        "clone",
        "project add",
        "project list",
        "project remove",
        "github checkout",
    ] {
        let mut args = command.split_whitespace().collect::<Vec<_>>();
        args.extend(["--json", "--unknown-option"]);
        let out = repo.mabo(&args);
        assert_eq!(
            out.status.code(),
            Some(2),
            "{command}: {}",
            text(&out.stdout)
        );
        let value = assert_envelope(&out, command);
        assert_eq!(value["error"]["code"], "usage");
        assert!(value["data"].is_null());
    }
}

#[test]
fn output_environment_and_explicit_modes_have_deterministic_precedence() {
    let repo = Repo::new();
    let run = |args: &[&str], mode: &str| {
        repo.command(env!("CARGO_BIN_EXE_mabo"), args)
            .env("MABO_OUTPUT", mode)
            .output()
            .expect("mabo")
    };
    assert_envelope(&run(&["list"], "json"), "list");
    let out = run(&["list", "--output", "text"], "json");
    assert!(out.status.success());
    assert!(text(&out.stdout).contains("main ("));
    let out = run(&["list", "--names"], "json");
    assert!(out.status.success());
    assert_eq!(text(&out.stdout), "main");
    assert_envelope(&run(&["list", "--output=json"], "text"), "list");
    for args in [&["list"][..], &["list", "--output", "text"][..]] {
        assert_eq!(run(args, "invalid").status.code(), Some(2));
    }
    assert!(run(&["version"], "invalid").status.success());
    assert!(run(&["list", "--help"], "invalid").status.success());
    for flag in [vec!["--json"], vec!["--output", "json"]] {
        let mut args = vec!["exec"];
        args.extend(flag);
        args.extend(["main", "true"]);
        assert_eq!(run(&args, "json").status.code(), Some(2));
    }
    let out = run(&["exec", "main", "printf", "%s", "--json"], "invalid");
    assert!(out.status.success());
    assert_eq!(text(&out.stdout), "--json");
}

#[test]
fn non_interactive_git_gets_prompt_control_and_hooks_preserve_user_stdin() {
    use std::io::Write;
    use std::os::unix::fs::PermissionsExt;
    use std::process::Stdio;
    let repo = Repo::new();
    let bin = repo.root.join("bin");
    fs::create_dir_all(&bin).expect("bin");
    let wrapper = bin.join("git");
    let marker = repo.root.join("git-network-env");
    fs::write(&wrapper, "#!/bin/sh\nfor arg do case \"$arg\" in fetch|clone|ls-remote|pull|push) printf '%s' \"$GIT_TERMINAL_PROMPT\" > \"$PROMPT_MARKER\"; test \"$GIT_TERMINAL_PROMPT\" = 0 || exit 93;; esac; done\nexec /usr/bin/git \"$@\"\n").expect("wrapper");
    fs::set_permissions(&wrapper, fs::Permissions::from_mode(0o755)).expect("chmod");
    let remote = repo.repo.to_str().expect("repo");
    repo.git(&["remote", "add", "origin", remote]);
    repo.git(&["fetch", "origin"]);
    repo.git(&[
        "symbolic-ref",
        "refs/remotes/origin/HEAD",
        "refs/remotes/origin/main",
    ]);
    let out = repo
        .command(env!("CARGO_BIN_EXE_mabo"), &["sync", "--json"])
        .env(
            "PATH",
            format!(
                "{}:{}",
                bin.display(),
                std::env::var("PATH").unwrap_or_default()
            ),
        )
        .env("PROMPT_MARKER", &marker)
        .output()
        .expect("sync");
    assert!(
        out.status.success(),
        "{} {}",
        text(&out.stdout),
        text(&out.stderr)
    );
    assert_eq!(fs::read_to_string(&marker).expect("network git ran"), "0");
    fs::write(
        repo.repo.join(".mabo.toml"),
        "[hooks]\npost-create = [\"if read ignored; then exit 94; fi; echo HOOK_EOF\"]\n",
    )
    .expect("hook");
    let mut child = repo
        .command(
            env!("CARGO_BIN_EXE_mabo"),
            &[
                "create",
                "stdin",
                "--json",
                "--exec",
                "read line; test \"$line\" = sentinel",
            ],
        )
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("mabo");
    child
        .stdin
        .take()
        .expect("stdin")
        .write_all(b"sentinel\n")
        .expect("input");
    let out = child.wait_with_output().expect("result");
    assert!(
        out.status.success(),
        "{} {}",
        text(&out.stdout),
        text(&out.stderr)
    );
    assert!(text(&out.stderr).contains("HOOK_EOF"));
    assert_envelope(&out, "create");
}

#[test]
fn successful_json_commands_share_the_envelope_and_preserve_payload_keys() {
    let repo = Repo::new();
    repo.git(&["branch", "existing"]);
    let cases: &[(&[&str], &str, &str)] = &[
        (&["create", "topic", "--json"], "create", "worktree"),
        (&["attach", "existing", "--json"], "attach", "worktree"),
        (&["list", "--json"], "list", "worktrees"),
        (&["where", "topic", "--json"], "where", "worktree"),
        (
            &[
                "meta",
                "set",
                "topic",
                "--purpose",
                "contract test",
                "--json",
            ],
            "meta set",
            "worktree",
        ),
        (&["sync", "--json"], "sync", "default"),
        (&["gc", "--json"], "gc", "candidates"),
        (&["trust", "--yes", "--json"], "trust", "trustedAt"),
        (&["untrust", "--json"], "untrust", "removed"),
        (&["project", "add", "--json"], "project add", "project"),
        (&["project", "list", "--json"], "project list", "projects"),
        (
            &["project", "remove", "repo", "--json"],
            "project remove",
            "project",
        ),
        (&["delete", "topic", "--json"], "delete", "deleted"),
    ];
    for (args, command, key) in cases {
        let out = repo.mabo(args);
        assert!(
            out.status.success(),
            "{command}: {} {}",
            text(&out.stdout),
            text(&out.stderr)
        );
        let value = assert_envelope(&out, command);
        assert!(value["data"].get(key).is_some(), "{command}: {value}");
        if *command == "gc" {
            assert_eq!(value["data"]["plan"], true);
        }
    }
    publish_pr_topic(&repo);
    let gh_path = fake_gh_for_topic_pr(&repo);
    let out = repo
        .command(
            env!("CARGO_BIN_EXE_mabo"),
            &["github", "checkout", "7", "--json"],
        )
        .env("PATH", gh_path)
        .output()
        .expect("checkout");
    let value = assert_envelope(&out, "github checkout");
    assert!(out.status.success(), "{value}");
    assert!(value["data"]["worktree"].is_object());
    let bare = repo.root.join("origin.git");
    append_instead_of(&repo, &bare, "https://github.com/example/widget.git");
    let out = clone_widget(&repo, Some(&repo.root.join("clones")));
    let value = assert_envelope(&out, "clone");
    assert!(out.status.success(), "{value}");
    assert_eq!(value["data"]["cloned"], true);
}

#[test]
fn standalone_exec_preserves_stdin_for_gh_and_signal_statuses() {
    use std::io::Write;
    use std::process::Stdio;
    let repo = Repo::new();
    let path = gh_path(&repo, "#!/bin/sh\nread line; printf '%s' \"$line\"");
    let mut child = repo
        .command(env!("CARGO_BIN_EXE_mabo"), &["exec", "main", "gh"])
        .env("PATH", path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("exec");
    child
        .stdin
        .take()
        .expect("stdin")
        .write_all(b"sentinel\n")
        .expect("input");
    let out = child.wait_with_output().expect("exec result");
    assert!(out.status.success(), "{}", text(&out.stderr));
    assert_eq!(text(&out.stdout), "sentinel");
    let out = repo.mabo(&["exec", "main", "sh", "-c", "kill -TERM $$"]);
    assert_eq!(out.status.code(), Some(143));
}

#[test]
fn delete_partial_results_and_late_common_option_errors_keep_the_contract() {
    let repo = Repo::new();
    assert!(repo.mabo(&["create", "first"]).status.success());
    assert!(repo.mabo(&["create", "second"]).status.success());
    fs::write(
        repo.repo.join(".mabo.toml"),
        "[hooks]\npre-delete = [\"if [ \\\"$MABO_NAME\\\" = second ]; then exit 42; fi\"]\n",
    )
    .expect("hook");
    let out = repo.mabo(&["delete", "first", "second", "--json"]);
    assert_eq!(out.status.code(), Some(6));
    let value = assert_envelope(&out, "delete");
    assert_eq!(value["error"]["code"], "partial");
    assert_eq!(value["data"]["deleted"].as_array().expect("items").len(), 2);
    assert!(!managed(&repo, "first").exists());
    assert!(managed(&repo, "second").exists());
    let out = repo.mabo(&["delete", "second", "--json"]);
    assert_eq!(out.status.code(), Some(1));
    assert_eq!(assert_envelope(&out, "delete")["error"]["code"], "failed");
    {
        let out = repo.mabo(&["create", "late", "--output", "bad", "--json"]);
        assert_eq!(out.status.code(), Some(2));
        assert_eq!(assert_envelope(&out, "create")["error"]["code"], "usage");
    }
}

#[test]
fn common_options_can_precede_the_command_path() {
    let repo = Repo::new();
    assert_envelope(&repo.mabo(&["--output", "json", "list"]), "list");
    assert_envelope(&repo.mabo(&["--json", "project", "list"]), "project list");
    let out = repo.mabo(&["--no-input", "exec", "main", "printf", "%s", "--json"]);
    assert!(out.status.success());
    assert_eq!(text(&out.stdout), "--json");
}

#[test]
fn unsupported_exec_options_do_not_hide_json_usage_requests() {
    let repo = Repo::new();
    for command in ["list", "project list", "frobnicate", "project bogus"] {
        for exec in ["--exec", "-x"] {
            let args = command
                .split_whitespace()
                .chain([exec, "ignored", "--json"])
                .collect::<Vec<_>>();
            let out = repo
                .command(env!("CARGO_BIN_EXE_mabo"), &args)
                .env("MABO_OUTPUT", "text")
                .output()
                .expect("mabo");
            assert_eq!(out.status.code(), Some(2), "{args:?}");
            let key = if command == "project bogus" {
                "project"
            } else {
                command
            };
            let value = assert_envelope(&out, key);
            assert_eq!(value["error"]["code"], "usage");
            assert!(out.stderr.is_empty(), "{args:?}: {}", text(&out.stderr));
        }
    }
}

#[test]
fn invalid_usage_preserves_json_across_all_command_groups() {
    let repo = Repo::new();
    // Every JSON command, every parent group (including the gh alias), and
    // unresolved top-level commands must use exactly one usage envelope.
    for (command, invalid, key) in [
        ("create", "--bogus", "create"),
        ("attach", "--bogus", "attach"),
        ("list", "--bogus", "list"),
        ("where", "--bogus", "where"),
        ("delete", "--bogus", "delete"),
        ("sync", "--bogus", "sync"),
        ("gc", "--bogus", "gc"),
        ("trust", "--bogus", "trust"),
        ("untrust", "--bogus", "untrust"),
        ("clone", "--bogus", "clone"),
        ("meta set", "--bogus", "meta set"),
        ("project add", "--bogus", "project add"),
        ("project list", "--bogus", "project list"),
        ("project remove", "--bogus", "project remove"),
        ("github checkout", "--bogus", "github checkout"),
        ("gh checkout", "--bogus", "github checkout"),
        ("project", "bogus", "project"),
        ("meta", "bogus", "meta"),
        ("preferences", "bogus", "preferences"),
        ("github", "bogus", "github"),
        ("gh", "bogus", "github"),
        ("project", "--bogus", "project"),
        ("meta", "--bogus", "meta"),
        ("preferences", "--bogus", "preferences"),
        ("github", "--bogus", "github"),
        ("frobnicate", "--bogus", "frobnicate"),
    ] {
        for (output_args, env_mode) in [
            (vec!["--json"], "text"),
            (vec!["--output", "json"], "text"),
            (vec!["--output=json"], "text"),
            (vec![], "json"),
        ] {
            let mut args = command.split_whitespace().collect::<Vec<_>>();
            args.push(invalid);
            args.extend(output_args.iter().copied());
            let out = repo
                .command(env!("CARGO_BIN_EXE_mabo"), &args)
                .env("MABO_OUTPUT", env_mode)
                .output()
                .expect("mabo");
            assert_eq!(
                out.status.code(),
                Some(2),
                "{args:?}: {}",
                text(&out.stdout)
            );
            let value = assert_envelope(&out, key);
            assert_eq!(value["error"]["code"], "usage", "{args:?}");
            assert!(value["data"].is_null(), "{args:?}");
            assert!(out.stderr.is_empty(), "{args:?}: {}", text(&out.stderr));
        }
    }
}

#[test]
fn resolved_text_usage_errors_never_reenable_json() {
    let repo = Repo::new();
    for args in [
        vec!["list", "--owner", "--json", "--output", "text"],
        vec!["list", "--json", "--output", "text", "--owner"],
        vec!["list", "--output=text", "--owner", "--json"],
        vec!["list", "--project", "--json", "--output", "text"],
        vec!["list", "--json", "--output=text", "--project"],
        vec!["project", "bogus", "--json", "--output", "text"],
    ] {
        for env_mode in ["text", "json"] {
            let out = repo
                .command(env!("CARGO_BIN_EXE_mabo"), &args)
                .env("MABO_OUTPUT", env_mode)
                .output()
                .expect("mabo");
            assert_eq!(out.status.code(), Some(2), "{args:?}");
            assert!(out.stdout.is_empty(), "{args:?}: {}", text(&out.stdout));
            assert!(!out.stderr.is_empty(), "{args:?}");
        }
    }
}

#[test]
fn help_requests_skip_option_values_and_reject_missing_values() {
    let repo = Repo::new();
    for command in [
        "list",
        "create",
        "attach",
        "project list",
        "meta set",
        "gc",
        "clone",
    ] {
        for output in [
            vec!["--output", "--help"],
            vec!["--output=--help"],
            vec!["--help", "--output"],
        ] {
            let args = command
                .split_whitespace()
                .chain(["--json"])
                .chain(output)
                .collect::<Vec<_>>();
            let out = repo.mabo(&args);
            assert_eq!(out.status.code(), Some(2), "{args:?}");
            let value = assert_envelope(&out, command);
            assert_eq!(value["error"]["code"], "usage");
            assert!(value["error"]["message"]
                .as_str()
                .expect("message")
                .contains("output"));
        }
    }
    for (command, option) in [
        ("list", "--owner"),
        ("create", "--owner"),
        ("attach", "--owner"),
        ("meta set", "--owner"),
    ] {
        let args = command
            .split_whitespace()
            .chain(["--json", option, "--help"])
            .collect::<Vec<_>>();
        let out = repo.mabo(&args);
        assert_eq!(out.status.code(), Some(2), "{args:?}");
        assert_eq!(assert_envelope(&out, command)["error"]["code"], "usage");
    }
    // A real help request does not hide a missing command-option value either.
    for (command, option) in [
        ("list", "--owner"),
        ("create", "--base"),
        ("attach", "--exec"),
        ("gc", "--older-than"),
        ("clone", "--depth"),
    ] {
        let args = command
            .split_whitespace()
            .chain(["--help", option])
            .collect::<Vec<_>>();
        let out = repo
            .command(env!("CARGO_BIN_EXE_mabo"), &args)
            .env("MABO_OUTPUT", "json")
            .output()
            .expect("mabo");
        assert_eq!(out.status.code(), Some(2), "{args:?}");
        assert_eq!(assert_envelope(&out, command)["error"]["code"], "usage");
    }
    assert!(!managed(&repo, "--help").exists());
}

#[test]
fn output_and_help_scan_respects_command_option_arity_and_child_boundaries() {
    let repo = Repo::new();
    for args in [
        vec!["list", "--base", "--json"], // --base is not a list option.
        vec!["project", "list", "--owner", "--json"],
        vec!["gc", "--pr", "--json", "--bogus"], // --pr is a flag here.
    ] {
        let out = repo.mabo(&args);
        assert_eq!(out.status.code(), Some(2), "{args:?}");
        assert_eq!(json_value(&out)["error"]["code"], "usage");
    }
    for command in ["create", "attach"] {
        for exec in ["--exec", "-x"] {
            let out = repo.mabo(&[command, "--bogus", exec, "ignored", "--json", "--help"]);
            assert_eq!(out.status.code(), Some(2));
            assert!(out.stdout.is_empty());
            assert!(text(&out.stderr).contains("Unknown option"));
        }
        for exec in ["--exec=ignored", "-xignored"] {
            let out = repo.mabo(&[command, "--bogus", exec, "--json"]);
            assert_eq!(out.status.code(), Some(2));
            assert_eq!(assert_envelope(&out, command)["error"]["code"], "usage");
        }
    }
    let out = repo.mabo(&["list", "--owner", "alice", "--", "--json", "--help"]);
    assert_eq!(out.status.code(), Some(2));
    assert!(out.stdout.is_empty());
    assert!(text(&out.stderr).contains("Unexpected argument"));
    let out = repo.mabo(&["list", "--owner=--help", "--output=text"]);
    assert_eq!(out.status.code(), Some(2));
    assert!(out.stdout.is_empty());
    assert!(text(&out.stderr).contains("looks like an option"));
}
