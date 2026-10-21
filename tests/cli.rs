#[path = "common/records.rs"]
mod records;
#[path = "common/git.rs"]
mod test_git;
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
        test_git::write_config(&home);
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

    fn create_recorded(&self, args: &[&str]) -> std::process::Output {
        let mut create = vec!["create"];
        let mut intent = vec!["set", args[1]];
        let mut index = 1;
        while index < args.len() {
            if matches!(args[index], "--pr" | "--issue") {
                intent.extend_from_slice(&args[index..index + 2]);
                index += 2;
            } else {
                create.push(args[index]);
                index += 1;
            }
        }
        let created = self.mabo(&create);
        assert!(created.status.success(), "{}", text(&created.stderr));
        let set = self.mabo(&intent);
        assert!(set.status.success(), "{}", text(&set.stderr));
        self.mabo(&["show", args[1], "--json"])
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

// Close the reader before spawning, so even a short help page deterministically
// hits EPIPE instead of depending on scheduling or the platform's pipe capacity.
fn closed_pipe() -> std::io::PipeWriter {
    let (reader, writer) = std::io::pipe().expect("pipe");
    drop(reader);
    writer
}

fn assert_closed_stdout(repo: &Repo, args: &[&str], expected: i32) {
    let output = repo
        .command(env!("CARGO_BIN_EXE_mabo"), args)
        .stdout(closed_pipe())
        .output()
        .expect("mabo with closed stdout");
    let stderr = text(&output.stderr);
    assert!(!stderr.contains("panicked"), "{args:?}: {stderr}");
    assert_eq!(output.status.code(), Some(expected), "{args:?}: {stderr}");
}

#[test]
fn broken_pipe_help_stdout_preserves_success() {
    let repo = Repo::new();
    for args in [vec!["help", "--json"], vec!["help"], vec!["--help"]] {
        assert_closed_stdout(&repo, &args, 0);
    }
}

#[test]
fn broken_pipe_large_list_stdout_preserves_success() {
    let repo = Repo::new();
    for index in 0..16 {
        let path = repo.root.join(format!("workspace-{index}"));
        repo.git(&[
            "worktree",
            "add",
            "--detach",
            path.to_str().unwrap(),
            "HEAD",
        ]);
        maboroshi::metadata::write(
            &repo.repo,
            &path,
            &maboroshi::metadata::MetadataInput {
                purpose: Some("x".repeat(1024)),
                ..Default::default()
            },
        )
        .expect("workspace metadata");
    }
    for args in [vec!["list"], vec!["list", "--json"]] {
        let normal = repo.mabo(&args);
        assert!(normal.status.success(), "{}", text(&normal.stderr));
        assert!(normal.stdout.len() > 16 * 1024, "large output fixture");
        assert_closed_stdout(&repo, &args, 0);
    }
}

#[test]
fn broken_pipe_stderr_preserves_success_and_usage_status() {
    let repo = Repo::new();
    fs::create_dir_all(repo.home.join(".config/maboroshi")).unwrap();
    fs::write(
        repo.home.join(".config/maboroshi/config.toml"),
        "directory-name-separator = \"-\"\n",
    )
    .unwrap();
    // The warning succeeds with status 0; usage writes diagnostics and help with
    // status 2. Keep stdout available to catch accidental stream coupling.
    for (args, expected) in [
        (vec!["config", "list", "--json"], 0),
        (vec!["not-a-command"], 2),
    ] {
        let normal = repo.mabo(&args);
        assert_eq!(normal.status.code(), Some(expected));
        assert!(!normal.stderr.is_empty());
        let output = repo
            .command(env!("CARGO_BIN_EXE_mabo"), &args)
            .stderr(closed_pipe())
            .output()
            .unwrap();
        assert!(!text(&output.stdout).contains("panicked"));
        assert_eq!(output.status.code(), Some(expected), "{args:?}");
        assert_eq!(output.stdout, normal.stdout);
    }
    assert_closed_stdout(&repo, &["not-a-command", "--json"], 2);
}

#[test]
fn broken_pipe_progress_does_not_interrupt_create_or_setup() {
    for json in [false, true] {
        for (last_hook, expected, state) in [("true", 0, "ok"), ("exit 7", 6, "failed")] {
            let repo = Repo::new();
            fs::write(
                repo.repo.join(".mabo.toml"),
                format!("[hooks]\nsetup = [\"touch setup-completed\", \"{last_hook}\"]\n"),
            )
            .unwrap();
            let args = if json {
                vec!["create", "topic", "--json"]
            } else {
                vec!["create", "topic"]
            };
            let mut command = repo.command(env!("CARGO_BIN_EXE_mabo"), &args);
            if json {
                command.stderr(closed_pipe());
            } else {
                command.stdout(closed_pipe());
            }
            let output = command.output().unwrap();
            assert!(!text(&output.stderr).contains("panicked"));
            assert_eq!(
                output.status.code(),
                Some(expected),
                "{}",
                text(&output.stderr)
            );
            let shown = repo.mabo(&["show", "topic", "--json"]);
            assert!(shown.status.success(), "{}", text(&shown.stderr));
            let document: serde_json::Value = serde_json::from_slice(&shown.stdout).unwrap();
            let path = document["data"]["workspace"]["path"].as_str().unwrap();
            assert!(Path::new(path).join("setup-completed").is_file());
            assert_eq!(document["data"]["workspace"]["setup"]["state"], state);
        }
    }
}

#[cfg(target_os = "linux")]
#[test]
fn json_stderr_errors_are_included_before_emitting_the_envelope() {
    let repo = Repo::new();
    let args = ["config", "list", "--json"];
    let normal = repo
        .command(env!("CARGO_BIN_EXE_mabo"), &args)
        .env("GIT_CONFIG_COUNT", "broken")
        .output()
        .unwrap();
    assert!(normal.status.success(), "{}", text(&normal.stderr));
    assert!(!normal.stderr.is_empty());
    let expected = assert_envelope(&normal, "config list");
    assert!(!expected["warnings"].as_array().unwrap().is_empty());

    let output = repo
        .command(env!("CARGO_BIN_EXE_mabo"), &args)
        .env("GIT_CONFIG_COUNT", "broken")
        .stderr(fs::File::options().write(true).open("/dev/full").unwrap())
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(1));
    let document = assert_envelope(&output, "config list");
    assert_eq!(document["ok"], false);
    assert_eq!(document["error"]["code"], "failed");
    assert!(document["error"]["message"]
        .as_str()
        .unwrap()
        .starts_with("Failed to write stderr: "));
    assert_eq!(document["data"], expected["data"]);
    assert_eq!(document["warnings"], expected["warnings"]);
}

#[cfg(target_os = "linux")]
#[test]
fn json_stderr_errors_preserve_mutations_and_override_partial_status() {
    for last_hook in ["true", "exit 7"] {
        let repo = Repo::new();
        fs::write(
            repo.repo.join(".mabo.toml"),
            format!("[hooks]\nsetup = [\"touch setup-completed\", \"{last_hook}\"]\n"),
        )
        .unwrap();
        let output = repo
            .command(env!("CARGO_BIN_EXE_mabo"), &["create", "topic", "--json"])
            .stderr(fs::File::options().write(true).open("/dev/full").unwrap())
            .output()
            .unwrap();
        assert_eq!(output.status.code(), Some(1));
        let document = assert_envelope(&output, "create");
        assert_eq!(document["ok"], false);
        assert_eq!(document["error"]["code"], "failed");
        assert!(document["error"]["message"]
            .as_str()
            .unwrap()
            .starts_with("Failed to write stderr: "));
        let workspace = &document["data"]["workspace"];
        let path = workspace["path"].as_str().unwrap();
        assert!(Path::new(path).join("setup-completed").is_file());
        assert_eq!(
            workspace["setup"]["state"],
            if last_hook == "true" { "ok" } else { "failed" }
        );
    }
}

#[cfg(target_os = "linux")]
#[test]
fn output_errors_other_than_broken_pipe_fail_without_panicking() {
    let repo = Repo::new();
    for args in [vec!["help"], vec!["help", "--json"], vec!["--help"]] {
        let output = repo
            .command(env!("CARGO_BIN_EXE_mabo"), &args)
            .stdout(fs::File::options().write(true).open("/dev/full").unwrap())
            .output()
            .unwrap();
        let stderr = text(&output.stderr);
        assert!(!stderr.contains("panicked"), "{stderr}");
        assert!(stderr.contains("Failed to write stdout:"), "{stderr}");
        assert_eq!(output.status.code(), Some(1));
    }
    let output = repo
        .command(env!("CARGO_BIN_EXE_mabo"), &["help"])
        .stdout(fs::File::options().write(true).open("/dev/full").unwrap())
        .stderr(closed_pipe())
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(1));
    let output = repo
        .command(env!("CARGO_BIN_EXE_mabo"), &["not-a-command"])
        .stderr(fs::File::options().write(true).open("/dev/full").unwrap())
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(1));
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

    let disabled = mabo_color(&repo, &["create", "--pr", "--help"], None, Some("0"));
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
        &["path", "name"],
        &["remove", "name"],
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
    let subcommand = repo.mabo(&["-v"]);
    assert_eq!(text(&subcommand.stdout), version_line);

    let help = repo.mabo(&["--help"]);
    assert!(help.status.success());
    let help_text = text(&help.stdout);
    assert!(help_text.contains("mabo - Workspaces for parallel coding agents"));
    assert!(!help_text.contains("Phantom"), "{help_text}");
    assert!(help_text.contains("mabo <command> [options]"));
    assert!(help_text.contains("Run 'mabo <command> --help'"));
    assert!(!help_text.contains("phantom <command>"));

    for args in [["--version", "--help"], ["repo", "--help"]] {
        let command_help = repo.mabo(&args);
        assert!(command_help.status.success(), "{args:?}");
        let command_text = text(&command_help.stdout);
        assert!(
            !command_text.contains("Phantom"),
            "{args:?} still names Phantom:\n{command_text}"
        );
    }

    let where_help = repo.mabo(&["path", "--help"]);
    assert!(where_help.status.success());
    let where_text = text(&where_help.stdout);
    assert!(where_text.contains("mabo path"));
    assert!(where_text.contains("mabo path [--repo <ref>] [SEL] [options]"));
    assert!(!where_text.contains("phantom path"));

    let missing_where = repo.mabo(&["path"]);
    assert_eq!(missing_where.status.code(), Some(0));
    assert!(same_dir(&text(&missing_where.stdout), &repo.repo));

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
            &["list", "-R", worktree.to_str().expect("worktree"), "--json"],
        )
        .output()
        .expect("list workspace");
    assert!(
        from_worktree.status.success(),
        "{}",
        text(&from_worktree.stderr)
    );
    let from_gitfile = repo
        .command(
            env!("CARGO_BIN_EXE_mabo"),
            &["list", "-R", gitfile.to_str().expect("git file"), "--json"],
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
    fs::create_dir_all(&project).expect("repo");
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
            &["repo", "add", project.to_str().expect("repo"), "--json"],
        )
        .output()
        .expect("repo add");
    assert!(added.status.success(), "{}", text(&added.stderr));
    let catalog = repo.mabo(&["repo", "list", "--json"]);
    assert!(catalog.status.success(), "{}", text(&catalog.stderr));
    let catalog = json_value(&catalog);
    let entry = catalog["data"]["repos"]
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
    value["data"]["workspaces"]
        .as_array()
        .expect("worktrees")
        .iter()
        .find(|item| item["kind"] == "primary")
        .expect("primary checkout")["path"]
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
        vec!["create", "--branch", "main", "--tmux-vertical"],
        vec!["exec", "--tmux-h", "name", "true"],
        vec!["create", "--pr", "1", "--tmux"],
        vec!["create", "--pr", "1", "-t"],
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
    assert!(text(&created.stdout).contains("Created workspace 'feature/add-tests' at "));
    let worktree = managed(&repo, "feature/add-tests");
    assert!(worktree.join("README.md").is_file());
    assert!(!repo.repo.join(".git/phantom").exists());
    assert!(!repo.repo.join(".git/ptm").exists());
    assert!(repo.repo.join(".git/maboroshi/workspaces").is_dir());

    let duplicate = repo.mabo(&["create", "feature/add-tests"]);
    assert_eq!(duplicate.status.code(), Some(4));
    assert!(text(&duplicate.stderr).contains("already exists"));

    let names = repo.mabo(&["list", "--names", "--kind", "workspace"]);
    assert!(names.status.success(), "{}", text(&names.stderr));
    assert_eq!(text(&names.stdout), "feature/add-tests");

    let empty = repo.mabo(&["list", "--kind", "workspace"]);
    let _ = empty;
    let where_path = repo.mabo(&["path", "feature/add-tests"]);
    assert_eq!(where_path.status.code(), Some(0));
    assert_eq!(text(&where_path.stdout), worktree.to_string_lossy());

    let missing = repo.mabo(&["path", "missing-worktree"]);
    assert_eq!(missing.status.code(), Some(3));
    assert!(text(&missing.stderr).contains("not found"));

    repo.git(&["branch", "existing-feature"]);
    let attached = repo.mabo(&["create", "--branch", "existing-feature"]);
    assert!(attached.status.success(), "{}", text(&attached.stderr));
    assert!(text(&attached.stdout).contains("Created workspace 'existing-feature'"));
    let missing_branch = repo.mabo(&["create", "--branch", "missing-branch"]);
    assert_eq!(missing_branch.status.code(), Some(3));

    let kept = repo.mabo(&["remove", "existing-feature", "--keep-branch"]);
    assert!(kept.status.success(), "{}", text(&kept.stderr));
    assert!(text(&kept.stdout).contains("kept its branch 'existing-feature'"));
    let branch = repo
        .command("git", &["branch", "--list", "existing-feature"])
        .output()
        .expect("branch");
    assert!(text(&branch.stdout).contains("existing-feature"));

    let deleted = repo.mabo(&["remove", "feature/add-tests"]);
    assert!(deleted.status.success(), "{}", text(&deleted.stderr));
    assert!(text(&deleted.stdout).contains("and its branch 'feature/add-tests'"));
    assert!(!worktree.exists());
    let missing_delete = repo.mabo(&["remove", "missing-worktree"]);
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
        "[hooks]\nsetup = \"pnpm install\"\n",
    )
    .expect("schema");
    let created = repo.mabo(&["path", "feature/bad-toml"]);
    let stderr = text(&created.stderr);
    assert!(!created.status.success(), "{}", text(&created.stdout));
    assert!(stderr.contains(".mabo.toml"), "{stderr}");
    assert!(
        stderr.contains("setup") || stderr.contains("invalid type"),
        "{stderr}"
    );

    fs::write(
        repo.repo.join(".mabo.toml"),
        "worktreesDirectory = \".phantom\"\n",
    )
    .expect("unknown");
    let created = repo.mabo(&["path", "feature/bad-toml"]);
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
        "[hooks]\nsetup = [\"true\"]\n",
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
        .command(env!("CARGO_BIN_EXE_mabo"), &["create", "--issue", "7"])
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
        "[hooks]\nsetup = [\"phantom-missing-setup-bin\"]\n",
    )
    .expect("config");
    let created = repo.mabo(&["create", "feature/hooks"]);
    let worktree = managed(&repo, "feature/hooks");
    assert!(
        worktree.join("README.md").is_file(),
        "workspace should exist after a setup failure"
    );
    let stdout = text(&created.stdout);
    let stderr = text(&created.stderr);
    assert!(
        stdout.contains("Created workspace 'feature/hooks' at "),
        "stdout: {stdout}"
    );
    assert!(
        stdout.contains(&worktree.to_string_lossy().to_string()),
        "stdout: {stdout}"
    );
    assert!(
        stdout.contains("Executing: phantom-missing-setup-bin"),
        "stdout: {stdout}"
    );
    assert!(
        stderr.contains("Warning:"),
        "stderr should warn, not look like creation failed: {stderr}"
    );
    assert!(stderr.contains("phantom-missing-setup-bin"), "{stderr}");
    assert!(stderr.contains("127"), "{stderr}");
    assert_eq!(created.status.code(), Some(6), "{stderr}");

    repo.git(&["branch", "existing-hook"]);
    let attached = repo.mabo(&["create", "--branch", "existing-hook"]);
    let attached_path = managed(&repo, "existing-hook");
    assert!(attached_path.join("README.md").is_file());
    assert!(
        text(&attached.stdout).contains("Created workspace 'existing-hook'"),
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
        "[hooks]\nsetup = [\"touch setup.txt\"]\n",
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
    assert!(text(&created.stdout).contains("Running setup commands"));
    assert!(text(&created.stdout).contains("Executing: touch setup.txt"));
    assert!(worktree.join("setup.txt").is_file());
}

#[test]
fn hooks_run_in_order_stop_on_failure_and_export_root_path() {
    let repo = Repo::new();
    fs::write(
        repo.repo.join(".mabo.toml"),
        r#"[hooks]
setup = [
  "printf '%s' \"$MABO_REPO_PATH\" > root-path.txt",
  "printf '%s' \"$MABO\" > mabo-flag.txt",
  "printf '%s' \"$MABO_WORKSPACE\" > mabo-name.txt",
  "printf '%s' \"$MABO_WORKSPACE_PATH\" > mabo-path.txt",
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
pre-remove = [
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

    let deleted = repo.mabo(&[
        "remove",
        "--discard-changes",
        "--delete-unpreserved-branch",
        "feature/hooks-order",
    ]);
    let stderr = text(&deleted.stderr);
    assert!(!deleted.status.success(), "{}", text(&deleted.stdout));
    assert!(stderr.contains("exit code 9"), "{stderr}");
    assert!(
        worktree.exists(),
        "pre-remove failure should keep the workspace"
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
        "[hooks]\nsetup = [\"touch from-main.txt\"]\npre-remove = [\"touch pre-from-main.txt\"]\n",
    )
    .expect("main hooks");
    fs::write(
        source.join(".mabo.toml"),
        r#"[hooks]
setup = ["printf '%s' \"$MABO_REPO_PATH\" > root-path.txt"]
pre-remove = ["printf '%s' \"$MABO_REPO_PATH\" > \"$MABO_REPO_PATH/pre-root.txt\""]
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
        repo.repo.display().to_string()
    );
    assert!(!child.join("from-main.txt").exists());

    let deleted = repo
        .command(
            env!("CARGO_BIN_EXE_mabo"),
            &[
                "remove",
                "--discard-changes",
                "--delete-unpreserved-branch",
                "feature/child",
            ],
        )
        .current_dir(&source)
        .output()
        .expect("remove");
    assert!(
        deleted.status.success(),
        "{}\n{}",
        text(&deleted.stdout),
        text(&deleted.stderr)
    );
    assert_eq!(
        fs::read_to_string(repo.repo.join("pre-root.txt")).expect("pre-remove"),
        repo.repo.display().to_string()
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
    let set = repo.mabo(&["config", "set", "discover-ghq", "true"]);
    assert!(set.status.success(), "{}", text(&set.stderr));
    let set_stdout = text(&set.stdout);
    assert!(set_stdout.contains("discover-ghq"), "{set_stdout}");
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
    let get = repo.mabo(&["config", "get", "discover-ghq"]);
    assert_eq!(text(&get.stdout), "true");

    let added = repo.mabo(&["repo", "add", "--json"]);
    assert!(added.status.success(), "{}", text(&added.stderr));
    let value: serde_json::Value = serde_json::from_str(&text(&added.stdout)).expect("json");
    assert_eq!(value["data"]["status"], "added");
    assert_eq!(value["data"]["repo"]["name"], "repo");
    assert_eq!(
        value["data"]["repo"]["rootPath"],
        repo.repo.to_string_lossy().as_ref()
    );

    repo.mabo(&["config", "set", "discover-ghq", "false"]);
    let listed = repo.mabo(&["repo", "list", "--json"]);
    assert!(listed.status.success(), "{}", text(&listed.stderr));
    let catalog: serde_json::Value = serde_json::from_str(&text(&listed.stdout)).expect("catalog");
    assert_eq!(catalog["schema"], 2);
    assert_eq!(catalog["data"]["repos"][0]["source"], "registry");
    assert_eq!(
        catalog["data"]["repos"][0]["id"],
        value["data"]["repo"]["id"]
    );
    assert_eq!(catalog["data"]["repos"][0]["name"], "repo");
    assert_eq!(catalog["data"]["repos"][0]["canonicalName"], "repo");

    let removed = repo.mabo(&[
        "repo",
        "forget",
        value["data"]["repo"]["id"].as_str().expect("id"),
        "--json",
    ]);
    assert!(removed.status.success(), "{}", text(&removed.stderr));
    let empty = repo.mabo(&["repo", "list", "--json"]);
    let empty_catalog: serde_json::Value =
        serde_json::from_str(&text(&empty.stdout)).expect("empty");
    assert_eq!(
        empty_catalog["data"]["repos"].as_array().map(Vec::len),
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

    let added = repo.mabo(&["repo", "add", "--json"]);
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

    let disabled = repo.mabo(&["config", "set", "discover-ghq", "false"]);
    assert!(disabled.status.success(), "{}", text(&disabled.stderr));
    let listed = repo.mabo(&["repo", "list", "--json"]);
    assert!(listed.status.success(), "{}", text(&listed.stderr));
    let catalog: serde_json::Value = serde_json::from_str(&text(&listed.stdout)).expect("catalog");
    assert_eq!(catalog["data"]["repos"].as_array().map(Vec::len), Some(1));
    assert_eq!(catalog["data"]["repos"][0]["name"], "repo");
    assert_eq!(catalog["data"]["repos"][0]["source"], "registry");

    let help = repo.mabo(&["repo", "--help"]);
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
    let disabled = repo.mabo(&["config", "set", "discover-ghq", "false"]);
    assert!(disabled.status.success(), "{}", text(&disabled.stderr));

    let added = repo
        .command(env!("CARGO_BIN_EXE_mabo"), &["repo", "add", "--json"])
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
        .command(env!("CARGO_BIN_EXE_mabo"), &["repo", "list", "--names"])
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

    let missing = repo.mabo(&["config", "get", "discover-ghq"]);
    assert!(missing.status.success(), "{}", text(&missing.stderr));
    let missing_stdout = text(&missing.stdout);
    assert_eq!(missing_stdout, "true");
    assert!(!path.exists());

    let invalid_bool = repo.mabo(&["config", "set", "discover-ghq", "yes"]);
    assert_eq!(invalid_bool.status.code(), Some(2));
    assert!(
        text(&invalid_bool.stderr).contains("true"),
        "{}",
        text(&invalid_bool.stderr)
    );
    assert!(!path.exists());

    let set = repo.mabo(&["config", "set", "workspace-root", "../spaces"]);
    assert!(set.status.success(), "{}", text(&set.stderr));
    let written = fs::read_to_string(&path).expect("config");
    assert!(
        written.contains("workspace-root = \"../spaces\""),
        "{written}"
    );
    assert_eq!(
        fs::read_to_string(repo.home.join(".gitconfig")).expect("gitconfig"),
        gitconfig
    );

    fs::write(
        &path,
        "# header\ndiscover-ghq = false # inline\n\n# separator\nworkspace-root = \"../spaces\"\n",
    )
    .expect("seed");
    let updated = repo.mabo(&["config", "set", "discover-ghq", "true"]);
    assert!(updated.status.success(), "{}", text(&updated.stderr));
    let written = fs::read_to_string(&path).expect("updated");
    assert!(written.contains("# header"), "{written}");
    assert!(written.contains("# inline"), "{written}");
    assert!(written.contains("# separator"), "{written}");
    assert!(written.contains("discover-ghq = true"), "{written}");
    assert!(
        written.contains("workspace-root = \"../spaces\""),
        "{written}"
    );

    let removed = repo.mabo(&["config", "unset", "discover-ghq"]);
    assert!(removed.status.success(), "{}", text(&removed.stderr));
    let written = fs::read_to_string(&path).expect("removed");
    assert!(!written.contains("discover-ghq"), "{written}");
    assert!(written.contains("# separator"), "{written}");

    fs::write(&path, "{\n").expect("invalid");
    let invalid = repo.mabo(&["config", "get", "discover-ghq"]);
    assert_eq!(invalid.status.code(), Some(1));
    let stderr = text(&invalid.stderr);
    assert!(stderr.contains(path.to_str().expect("path")), "{stderr}");

    fs::write(&path, "editor = \"code\"\n").expect("unknown");
    let unknown = repo.mabo(&["config", "get", "discover-ghq"]);
    assert_eq!(unknown.status.code(), Some(1));
    let stderr = text(&unknown.stderr);
    assert!(stderr.contains("editor"), "{stderr}");
    assert!(stderr.contains(path.to_str().expect("path")), "{stderr}");

    fs::remove_file(&path).expect("cleanup");
    repo.git(&["config", "--global", "phantom.keepBranch", "true"]);
    repo.git(&["config", "--global", "ptm.keepBranch", "true"]);
    let ignored = repo.mabo(&["config", "get", "discover-ghq"]);
    assert!(ignored.status.success(), "{}", text(&ignored.stderr));
    assert!(text(&ignored.stdout) == "true", "{}", text(&ignored.stdout));
    assert!(!path.exists());
}

#[test]
fn keep_branch_preference_applies_to_delete() {
    let repo = Repo::new();
    let path = repo.home.join(".config/maboroshi/config.toml");
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(&path, "keep-branch = true\n").unwrap();
    assert!(repo.mabo(&["create", "removable"]).status.success());
    let out = repo.mabo(&["remove", "removable", "--json"]);
    assert_eq!(out.status.code(), Some(0));
    assert_eq!(json_value(&out)["data"]["items"][0]["branchDeleted"], true);
    assert!(!branch_listed(&repo, "removable"));
    assert!(repo.mabo(&["create", "explicit"]).status.success());
    assert!(repo
        .mabo(&["remove", "explicit", "--keep-branch"])
        .status
        .success());
    assert!(branch_listed(&repo, "explicit"));
    for command in ["get", "set", "unset"] {
        let mut args = vec!["config", command, "keep-branch"];
        if command == "set" {
            args.push("true");
        }
        assert_eq!(repo.mabo(&args).status.code(), Some(2));
    }
    assert!(repo
        .mabo(&["config", "set", "discover-ghq", "false"])
        .status
        .success());
    assert!(!fs::read_to_string(path).unwrap().contains("keep-branch"));
}

#[test]
fn removed_ai_command_and_preference_are_unknown() {
    let repo = Repo::new();
    let command = repo.mabo(&["ai", "feature"]);
    assert_eq!(command.status.code(), Some(2));
    assert!(text(&command.stderr).contains("Unknown command 'ai feature'"));

    let preference = repo.mabo(&["config", "set", "ai", "claude"]);
    assert_eq!(preference.status.code(), Some(2));
    let stderr = text(&preference.stderr);
    assert!(stderr.contains("Unknown config key 'ai'"), "{stderr}");
    assert!(stderr.contains("workspace-root"), "{stderr}");
}

#[test]
fn removed_edit_command_and_editor_preference_are_unknown() {
    let repo = Repo::new();
    let command = repo.mabo(&["edit", "feature"]);
    assert_eq!(command.status.code(), Some(2));
    assert!(text(&command.stderr).contains("Unknown command 'edit feature'"));

    let preference = repo.mabo(&["config", "get", "editor"]);
    assert_eq!(preference.status.code(), Some(2));
    let stderr = text(&preference.stderr);
    assert!(stderr.contains("Unknown config key 'editor'"), "{stderr}");
    assert!(stderr.contains("workspace-root"), "{stderr}");
}

#[test]
fn removed_shell_command_and_flag_are_unknown() {
    let repo = Repo::new();
    let command = repo.mabo(&["shell", "feature"]);
    assert_eq!(command.status.code(), Some(2));
    assert!(text(&command.stderr).contains("Unknown command 'shell feature'"));

    for args in [
        vec!["create", "name", "--shell"],
        vec!["create", "--branch", "main", "-s"],
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
        vec!["path", "--fzf"],
        vec!["remove", "--fzf"],
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
    let result = repo.mabo(&["list", "--kind", "workspace"]);
    assert_eq!(result.status.code(), Some(0), "{}", text(&result.stderr));
    assert!(text(&result.stdout).contains("No linked workspaces found"));
}

#[test]
fn project_add_from_a_linked_worktree_is_idempotent() {
    let repo = Repo::new();
    let added = repo.mabo(&["repo", "add", "--json"]);
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
            &["repo", "add", linked.to_str().expect("path"), "--json"],
        )
        .current_dir(&linked)
        .output()
        .expect("add");
    assert!(again.status.success(), "{}", text(&again.stderr));
    let again_value: serde_json::Value = serde_json::from_str(&text(&again.stdout)).expect("json");
    assert_eq!(again_value["data"]["status"], "existing");
    assert_eq!(again_value["data"]["repo"], value["data"]["repo"]);
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
        .command(env!("CARGO_BIN_EXE_mabo"), &["repo", "list", "--json"])
        .env("PATH", &path)
        .env("MABO_TEST_GHQ_PROJECT", &repo.repo)
        .output()
        .expect("list");
    assert!(discovered.status.success(), "{}", text(&discovered.stderr));
    let catalog: serde_json::Value = serde_json::from_str(&text(&discovered.stdout)).expect("json");
    assert_eq!(catalog["schema"], 2);
    assert_eq!(catalog["data"]["repos"][0]["source"], "ghq");
    assert_eq!(
        catalog["data"]["repos"][0]["rootPath"],
        repo.repo.to_string_lossy().as_ref()
    );

    fs::write(
        &ghq,
        "#!/bin/sh\nprintf '%s\\n' 'simulated ghq failure' >&2\nexit 17\n",
    )
    .expect("fail");
    fs::set_permissions(&ghq, perms).expect("chmod");
    let added = repo
        .command(env!("CARGO_BIN_EXE_mabo"), &["repo", "add", "--json"])
        .env("PATH", &path)
        .output()
        .expect("add");
    assert!(added.status.success(), "{}", text(&added.stderr));
    let warned = repo
        .command(env!("CARGO_BIN_EXE_mabo"), &["repo", "list", "--json"])
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
    let attached = repo.mabo(&["create", "--branch", "attached"]);
    assert!(attached.status.success(), "{}", text(&attached.stderr));
    let attached_path = managed(&repo, "attached");
    assert_eq!(read_copy(&attached_path.join("secret.env")), "secret\n");
    assert!(!attached_path.join("nested/skip.env").exists());
    assert!(!attached_path.join("other.log").exists());
}

#[test]
fn copies_gitignored_files_from_primary_even_from_another_checkout() {
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
        "from-main\n"
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
    test_git::write_config(&home);
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
    repo.mabo(&["config", "set", "discover-ghq", "false"]);
    let mut children = Vec::new();
    for index in 0..6 {
        let path = repo.root.join(format!("project-{index}"));
        fs::create_dir_all(&path).expect("repo");
        let init = repo
            .command("git", &["init", "-b", "main"])
            .current_dir(&path)
            .output()
            .expect("init");
        assert!(init.status.success(), "{}", text(&init.stderr));
        let child = repo
            .command(
                env!("CARGO_BIN_EXE_mabo"),
                &["repo", "add", path.to_str().expect("path"), "--json"],
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
    let listed = repo.mabo(&["repo", "list", "--names"]);
    assert!(listed.status.success(), "{}", text(&listed.stderr));
    let names = text(&listed.stdout);
    for index in 0..6 {
        assert!(names.contains(&format!("project-{index}")), "{names}");
    }
}

#[test]
fn create_and_attach_exec_export_mabo_env() {
    let repo = Repo::new();
    for (name, branch) in [("new-env", false), ("existing-env", true)] {
        if branch {
            repo.git(&["branch", name]);
        }
        let args = if branch {
            vec!["create", "--branch", name]
        } else {
            vec!["create", name]
        };
        assert!(repo.mabo(&args).status.success());
        let output = repo.mabo(&[
            "exec",
            name,
            "--",
            "sh",
            "-c",
            "printf '%s\n' \"$MABO\" \"$MABO_WORKSPACE\" \"$MABO_WORKSPACE_PATH\"",
        ]);
        assert!(output.status.success());
        assert_eq!(
            text(&output.stdout),
            format!("1\n{name}\n{}", managed(&repo, name).display())
        );
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

    let deleted = repo.mabo(&["remove", "cursor/foo"]);
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

    let preferences = repo.mabo(&["config", "--help"]);
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
    let deleted = repo.mabo(&["remove", "cursor/foo"]);
    assert!(deleted.status.success(), "{}", text(&deleted.stderr));
    assert!(!parent.join("foo").exists());
    assert!(!parent.exists(), "empty parent directory should be removed");
    assert!(project.is_dir(), "empty project directory should stay");
    assert_eq!(fs::read(&marker_path).expect("retained marker"), marker);
    assert!(ceiling.is_dir(), "maboroshi/worktrees should stay");

    assert!(repo.mabo(&["create", "cursor/foo"]).status.success());
    assert!(repo.mabo(&["create", "cursor/bar"]).status.success());
    assert!(repo.mabo(&["remove", "cursor/foo"]).status.success());
    assert!(parent.join("bar").is_dir());
    assert!(parent.is_dir(), "parent still holds another workspace");
    assert!(
        project.is_dir(),
        "project directory still holds a workspace"
    );
    assert!(repo.mabo(&["remove", "cursor/bar"]).status.success());
    assert!(!parent.exists());
    assert!(project.is_dir());
    assert_eq!(fs::read(&marker_path).expect("retained marker"), marker);
    assert!(ceiling.is_dir());

    assert!(repo.mabo(&["create", "a/b/c"]).status.success());
    assert!(repo.mabo(&["remove", "a/b/c"]).status.success());
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
    let names = repo.mabo(&["list", "--names", "--kind", "workspace"]);
    assert!(names.status.success(), "{}", text(&names.stderr));
    assert_eq!(text(&names.stdout), "next");
    let listed = repo.mabo(&["list", "--kind", "workspace"]);
    assert!(
        text(&listed.stdout)
            .lines()
            .any(|line| line.trim_start().starts_with("next  (detached)")),
        "{}",
        text(&listed.stdout)
    );
    assert!(
        !text(&listed.stdout).starts_with(&sha),
        "{}",
        text(&listed.stdout)
    );

    let found = repo.mabo(&["path", "next"]);
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
    let names_after = repo.mabo(&["list", "--names", "--kind", "workspace"]);
    assert_eq!(text(&names_after.stdout), "next");

    repo.git(&[
        "worktree",
        "add",
        "-b",
        "topic",
        managed(&repo, "alias").to_str().expect("path"),
        "HEAD",
    ]);
    let by_directory = repo.mabo(&["path", "alias"]);
    let by_branch = repo.mabo(&["path", "topic"]);
    let alias = managed(&repo, "alias");
    assert_eq!(text(&by_directory.stdout), alias.to_string_lossy());
    assert_eq!(text(&by_branch.stdout), alias.to_string_lossy());
    let both = repo.mabo(&["list", "--names", "--kind", "workspace"]);
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

    let found = repo.mabo(&["path", "topic"]);
    assert_eq!(found.status.code(), Some(0), "{}", text(&found.stderr));
    assert_eq!(
        text(&found.stdout),
        directory_topic.to_string_lossy(),
        "directory name should win over branch topic checked out at a"
    );

    let deleted = repo.mabo(&["remove", "topic", "--keep-branch"]);
    assert!(
        deleted.status.success(),
        "{}\n{}",
        text(&deleted.stdout),
        text(&deleted.stderr)
    );
    assert!(!directory_topic.exists());
    assert!(
        branch_topic.exists(),
        "delete topic must not remove the workspace whose branch is topic"
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
        .command(
            env!("CARGO_BIN_EXE_mabo"),
            &["create", "--pr", "7", "--reuse"],
        )
        .env("PATH", &path)
        .output()
        .expect("checkout");
    let combined = format!("{}\n{}", text(&output.stdout), text(&output.stderr));
    assert!(
        !combined.contains("Reused workspace"),
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
        .command(
            env!("CARGO_BIN_EXE_mabo"),
            &["create", "--pr", "7", "--reuse"],
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
    assert!(
        text(&again.stdout).contains("Reused workspace"),
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
    for field in [
        "id",
        "name",
        "kind",
        "path",
        "current",
        "repo",
        "managed",
        "orphaned",
        "branch",
        "head",
        "detached",
        "dirty",
        "base",
        "createdFrom",
        "upstream",
        "purpose",
        "links",
        "createdAt",
        "updatedAt",
    ] {
        assert!(value.get(field).is_some(), "missing {field}: {value}");
    }
    assert!(value["repo"]["root"].as_str().unwrap().starts_with('/'));
    assert!(value["repo"]["name"].is_string());
    assert_eq!(value["kind"], "workspace");
    assert!(value.get("rootPath").is_none());
    assert!(value.get("is_clean").is_none());
    for field in ["owner", "ownerRelation", "lastUsedAt"] {
        assert!(value.get(field).is_none(), "removed field {field}: {value}");
    }
}

#[test]
fn worktree_json_covers_list_where_create_attach_and_delete() {
    let repo = Repo::new();
    let head = full_head(&repo);
    let empty = repo.mabo(&["list", "--json", "--kind", "workspace"]);
    assert!(empty.status.success(), "{}", text(&empty.stderr));
    let empty_json = json_value(&empty);
    assert_eq!(empty_json["schema"], 2);
    assert_eq!(
        empty_json["data"]["workspaces"].as_array().map(Vec::len),
        Some(0)
    );
    assert!(text(&empty.stderr).is_empty(), "{}", text(&empty.stderr));

    let created = repo.mabo(&["create", "feature/json", "--json", "--base", "HEAD"]);
    assert!(created.status.success(), "{}", text(&created.stderr));
    let created_json = json_value(&created);
    assert_eq!(created_json["schema"], 2);
    assert_worktree_object(
        &created_json["data"]["workspace"],
        "feature/json",
        &managed(&repo, "feature/json"),
    );
    assert_eq!(created_json["data"]["workspace"]["branch"], "feature/json");
    assert_eq!(created_json["data"]["workspace"]["head"], head);
    assert_eq!(created_json["data"]["workspace"]["base"], "refs/heads/main");
    assert_eq!(created_json["data"]["workspace"]["dirty"], false);
    assert_eq!(created_json["data"]["workspace"]["detached"], false);
    assert!(created_json["data"]["copy"]["error"].is_null());
    assert!(created_json["data"]["copy"]["error"].is_null());
    assert_eq!(created_json["data"]["setup"]["ran"], false);
    assert_eq!(created_json["data"]["setup"]["ok"], true);
    assert!(created_json["data"]["setup"]["command"].is_null());
    assert!(created_json["data"]["setup"]["exitCode"].is_null());
    assert!(created_json["data"]["exec"].is_null());
    assert!(!text(&created.stdout).contains("Created workspace"));

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
    let worktrees = listed_json["data"]["workspaces"]
        .as_array()
        .expect("worktrees");
    assert!(worktrees
        .iter()
        .any(|entry| entry["kind"] == "primary" && entry["branch"] == "main"));
    let feature = worktrees
        .iter()
        .find(|entry| entry["name"] == "feature/json")
        .expect("feature");
    assert_eq!(feature["head"], head);
    assert_eq!(feature["dirty"], false);
    assert_eq!(feature["base"], "refs/heads/main");

    let worktree = managed(&repo, "feature/json");
    fs::write(worktree.join("README.md"), "dirty\n").expect("dirty");
    let dirty = repo.mabo(&["list", "--json", "--kind", "workspace"]);
    let dirty_json = json_value(&dirty);
    assert_eq!(dirty_json["data"]["workspaces"][0]["dirty"], true);
    assert_eq!(
        dirty_json["data"]["workspaces"].as_array().map(Vec::len),
        Some(1)
    );

    let located = repo.mabo(&["show", "feature/json", "--json"]);
    assert!(located.status.success(), "{}", text(&located.stderr));
    let located_json = json_value(&located);
    assert_eq!(located_json["schema"], 2);
    assert_worktree_object(
        &located_json["data"]["workspace"],
        "feature/json",
        &worktree,
    );
    assert!(!text(&located.stdout).contains("feature/json ("));

    let missing = repo.mabo(&["show", "missing-worktree", "--json"]);
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
    let attached = repo.mabo(&["create", "--branch", "existing-json", "--json"]);
    assert!(attached.status.success(), "{}", text(&attached.stderr));
    let attached_json = json_value(&attached);
    assert_worktree_object(
        &attached_json["data"]["workspace"],
        "existing-json",
        &managed(&repo, "existing-json"),
    );
    assert!(attached_json["data"]["workspace"]["base"].is_null());
    assert_eq!(
        attached_json["data"]["workspace"]["branch"],
        "existing-json"
    );
    assert!(attached_json["data"]["copy"]["error"].is_null());
    assert!(attached_json["data"]["exec"].is_null());

    let kept = repo.mabo(&["remove", "existing-json", "--keep-branch", "--json"]);
    assert!(kept.status.success(), "{}", text(&kept.stderr));
    let kept_json = json_value(&kept);
    assert!(kept_json["error"].is_null());
    assert_eq!(kept_json["data"]["items"][0]["branchDeleted"], false);
    assert!(kept_json["data"]["items"][0]["branchError"].is_null());
    assert!(kept_json["data"]["items"][0]["error"].is_null());
    assert_eq!(
        kept_json["data"]["items"][0]["workspace"]["name"],
        "existing-json"
    );
    let branch = repo
        .command("git", &["branch", "--list", "existing-json"])
        .output()
        .expect("branch");
    assert!(text(&branch.stdout).contains("existing-json"));

    fs::write(worktree.join("README.md"), "# phantom\n").expect("restore");
    repo.git(&["branch", "second-json"]);
    assert!(repo
        .mabo(&["create", "--branch", "second-json"])
        .status
        .success());
    let partial = repo.mabo(&["remove", "feature/json", "missing-json", "--json"]);
    assert_eq!(partial.status.code(), Some(3));
    let document = json_value(&partial);
    assert_eq!(document["data"]["items"].as_array().unwrap().len(), 2);
    assert_eq!(document["data"]["items"][0]["removed"], false);
    assert_eq!(document["data"]["items"][1]["error"]["code"], "not_found");
    assert!(worktree.exists());

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

    let project_modes = repo.mabo(&["repo", "list", "--json", "--names"]);
    assert_eq!(project_modes.status.code(), Some(2));
    assert_eq!(json_value(&project_modes)["error"]["code"], "usage");
    assert_eq!(json_value(&project_modes)["schema"], 2);
}

#[test]
fn json_mode_keeps_hook_and_exec_output_off_stdout() {
    let repo = Repo::new();
    fs::write(
        repo.repo.join(".mabo.toml"),
        "[hooks]\nsetup = [\"echo HOOK_STDOUT_MARKER\"]\npre-remove = [\"echo PRE_DELETE_MARKER\"]\n",
    )
    .expect("hooks");
    let created = repo.mabo(&["create", "feature/hooks-json", "--json"]);
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
    let executed = repo.mabo(&["exec", "feature/hooks-json", "--", "echo", "EXEC_MARKER"]);
    assert!(executed.status.success());
    assert_eq!(text(&executed.stdout), "EXEC_MARKER");
    assert_eq!(created_json["data"]["setup"]["ran"], true);
    assert_eq!(created_json["data"]["setup"]["ok"], true);
    assert_eq!(created_json["data"]["setup"]["exitCode"], 0);

    let deleted = repo.mabo(&[
        "remove",
        "--discard-changes",
        "--delete-unpreserved-branch",
        "feature/hooks-json",
        "--json",
    ]);
    assert!(deleted.status.success(), "{}", text(&deleted.stderr));
    assert!(!text(&deleted.stdout).contains("PRE_DELETE_MARKER"));
    assert!(text(&deleted.stderr).contains("PRE_DELETE_MARKER"));
    assert_eq!(
        json_value(&deleted)["data"]["items"][0]["branchDeleted"],
        true
    );

    fs::write(
        repo.repo.join(".mabo.toml"),
        "[hooks]\nsetup = [\"echo HOOK_FAIL_MARKER\", \"exit 7\"]\n",
    )
    .expect("failing hook");
    let failed = repo.mabo(&["create", "feature/hook-fail", "--json"]);
    assert_eq!(failed.status.code(), Some(6), "{}", text(&failed.stderr));
    let failed_json = json_value(&failed);
    assert_eq!(failed_json["data"]["setup"]["ok"], false);
    assert_eq!(failed_json["data"]["setup"]["exitCode"], 7);
    assert_eq!(failed_json["data"]["setup"]["command"], "exit 7");
    assert_eq!(
        failed_json["data"]["workspace"]["name"],
        "feature/hook-fail"
    );
    assert!(!text(&failed.stdout).contains("HOOK_FAIL_MARKER"));
    assert!(text(&failed.stderr).contains("HOOK_FAIL_MARKER"));
    assert!(managed(&repo, "feature/hook-fail/README.md").is_file());

    fs::write(repo.repo.join(".mabo.toml"), "").expect("clear hooks");
    assert!(repo
        .mabo(&["create", "feature/exec-fail", "--json"])
        .status
        .success());
    let exec_failed = repo.mabo(&[
        "exec",
        "feature/exec-fail",
        "--",
        "sh",
        "-c",
        "echo EXEC_FAIL; exit 3",
    ]);
    assert_eq!(exec_failed.status.code(), Some(3));
    assert_eq!(text(&exec_failed.stdout), "EXEC_FAIL");
    assert!(managed(&repo, "feature/exec-fail/README.md").is_file());
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
    let listed = repo.mabo(&["list", "--json", "--kind", "workspace"]);
    assert!(listed.status.success(), "{}", text(&listed.stderr));
    let entry = &json_value(&listed)["data"]["workspaces"][0];
    assert_eq!(entry["name"], "next");
    assert!(entry["branch"].is_null());
    assert_eq!(entry["detached"], true);
    assert_eq!(entry["head"], full_head(&repo));
    assert_eq!(entry["kind"], "workspace");

    std::os::unix::fs::symlink("elsewhere", repo.repo.join(".worktreeinclude")).expect("symlink");
    let created = repo.mabo(&["create", "feature/copy", "--json"]);
    assert_eq!(created.status.code(), Some(6), "{}", text(&created.stderr));
    let created_json = json_value(&created);
    assert!(!created_json["data"]["copy"]["error"].is_null());
    assert!(created_json["data"]["copy"]["error"]
        .as_str()
        .unwrap_or("")
        .contains("symlink"));
    assert_eq!(created_json["data"]["workspace"]["name"], "feature/copy");
}

#[test]
fn project_parse_errors_keep_the_validation_exit_code() {
    let repo = Repo::new();
    let cases: &[&[&str]] = &[
        &["repo", "add", "--unknown"],
        &["repo", "list", "--unknown"],
        &["repo", "forget", "--unknown"],
        &["repo", "add", "--unknown", "--json"],
        &["repo", "list", "--unknown", "--json"],
        &["repo", "forget", "--unknown", "--json"],
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
    let worktrees = listed_json["data"]["workspaces"]
        .as_array()
        .expect("worktrees");
    assert_eq!(worktrees.len(), 1, "{listed_json}");
    assert_eq!(worktrees[0]["name"], "main");
    assert_eq!(worktrees[0]["branch"], "main");
    assert_eq!(worktrees[0]["kind"], "primary");
    assert!(
        worktrees[0]["head"].is_null(),
        "unborn HEAD should be null, got {}",
        worktrees[0]["head"]
    );

    let located = repo.mabo(&["show", "main", "--json"]);
    assert!(located.status.success(), "{}", text(&located.stderr));
    let located_json = json_value(&located);
    assert!(
        located_json["data"]["workspace"]["head"].is_null(),
        "{located_json}"
    );
    assert_eq!(located_json["data"]["workspace"]["branch"], "main");
}

#[test]
fn argument_errors_are_validation_for_every_command() {
    let repo = Repo::new();
    let cases: &[&[&str]] = &[
        &["create", "topic", "--base"],
        &["create", "topic", "--json", "--base"],
        &["list", "--unknown"],
        &["list", "--json", "--unknown"],
        &["path", "--bogus"],
        &["show", "--json", "--bogus"],
        &["remove", "--bogus", "x"],
        &["remove", "--json", "--bogus", "x"],
        &["create", "--branch", "--zzz", "b"],
        &["create", "--json", "--branch", "--zzz", "b"],
        &["create", "--pr", "--bogus", "1"],
        &["create", "--pr", "1", "--json", "--base"],
        &["exec", "--bogus", "name", "true"],
        &["config", "get", "--bogus"],
        &["--version", "extra"],
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
            detail.contains("looks like an option")
                || detail.contains("Unknown option")
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
        &["create", "--branch", "a/../x"],
        &["create", "--branch", "a/../x", "--json"],
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

    let missing_delete = repo.mabo(&["remove", "nope"]);
    assert_eq!(missing_delete.status.code(), Some(3));
    let missing_json = repo.mabo(&["remove", "nope", "--json"]);
    assert_eq!(missing_json.status.code(), Some(3));
    let missing_value = json_value(&missing_json);
    assert_eq!(missing_value["error"]["code"], "not_found");
    assert!(missing_value["error"].get("exitCode").is_none());
    assert_eq!(repo.mabo(&["path", "nope"]).status.code(), Some(3));
    assert_eq!(
        repo.mabo(&["exec", "nope", "--", "true"]).status.code(),
        Some(3)
    );
}

#[test]
fn json_exec_signal_and_spawn_failure_return_the_worktree() {
    let repo = Repo::new();
    assert!(repo.mabo(&["create", "child", "--json"]).status.success());
    let signal = repo.mabo(&["exec", "child", "--", "sh", "-c", "kill -TERM $$"]);
    assert_eq!(signal.status.code(), Some(143));
    let missing = repo.mabo(&["exec", "child", "--", "missing-mabo-child-command"]);
    assert!(!missing.status.success());
    assert!(managed(&repo, "child").exists());
}

#[test]
fn json_post_create_signal_and_spawn_return_the_worktree() {
    let repo = Repo::new();
    fs::write(
        repo.repo.join(".mabo.toml"),
        "[hooks]\nsetup = [\"kill -TERM $$\"]\n",
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
    assert_eq!(created_json["data"]["workspace"]["name"], "h");
    assert_eq!(created_json["data"]["setup"]["ok"], false);
    assert_eq!(created_json["data"]["setup"]["command"], "kill -TERM $$");
    assert_eq!(created_json["data"]["setup"]["exitCode"], 143);
    assert_eq!(created_json["data"]["setup"]["signal"], "SIGTERM");
    assert!(created_json["data"]["setup"]["error"].is_string());
    assert!(managed(&repo, "h/README.md").is_file());

    repo.git(&["branch", "attach-hook"]);
    let attached = repo.mabo(&["create", "--branch", "attach-hook", "--json"]);
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
    assert_eq!(attached_json["data"]["workspace"]["name"], "attach-hook");
    assert_eq!(attached_json["data"]["setup"]["ok"], false);
    assert_eq!(attached_json["data"]["setup"]["signal"], "SIGTERM");
    assert_eq!(attached_json["data"]["setup"]["exitCode"], 143);

    fs::write(
        repo.repo.join(".mabo.toml"),
        "[hooks]\nsetup = [\"true\"]\n",
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
    assert_eq!(spawned_json["data"]["workspace"]["name"], "hook-spawn");
    assert_eq!(spawned_json["data"]["setup"]["ok"], false);
    assert_eq!(spawned_json["data"]["setup"]["exitCode"], 1);
    assert!(spawned_json["data"]["setup"]["signal"].is_null());
    let spawn_error = spawned_json["data"]["setup"]["error"]
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
            &["create", "--branch", "attach-hook-spawn", "--json"],
        )
        .env("SHELL", "/nonexistent")
        .output()
        .expect("attach hook spawn");
    assert_eq!(attach_spawn.status.code(), Some(6));
    let attach_json = json_value(&attach_spawn);
    assert_eq!(attach_json["data"]["setup"]["ok"], false);
    assert!(attach_json["data"]["setup"]["error"]
        .as_str()
        .unwrap_or("")
        .contains("ENOENT"));
    assert!(attach_json["error"]["code"] == "partial", "{attach_json}");
    assert!(managed(&repo, "attach-hook-spawn/README.md").is_file());

    fs::write(
        repo.repo.join(".mabo.toml"),
        "[hooks]\npre-remove = [\"kill -TERM $$\"]\n",
    )
    .expect("pre-remove signal");
    let deleted = repo.mabo(&[
        "remove",
        "--discard-changes",
        "--delete-unpreserved-branch",
        "h",
        "--json",
    ]);
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
    assert_eq!(deleted_json["data"]["items"][0]["workspace"]["name"], "h");
    assert!(paths_match(
        deleted_json["data"]["items"][0]["workspace"]["path"]
            .as_str()
            .unwrap_or(""),
        &managed(&repo, "h")
    ));
    assert!(managed(&repo, "h").is_dir());

    fs::write(
        repo.repo.join(".mabo.toml"),
        "[hooks]\npre-remove = [\"true\"]\n",
    )
    .expect("pre-remove spawn");
    let pre_spawn = repo
        .command(
            env!("CARGO_BIN_EXE_mabo"),
            &[
                "remove",
                "--discard-changes",
                "--delete-unpreserved-branch",
                "attach-hook",
                "--json",
            ],
        )
        .env("SHELL", "/nonexistent")
        .output()
        .expect("pre-remove spawn");
    assert_eq!(pre_spawn.status.code(), Some(1));
    let pre_json = json_value(&pre_spawn);
    assert_eq!(pre_json["error"]["code"], "spawn");
    assert!(pre_json["error"].get("exitCode").is_none());
    assert_eq!(
        pre_json["data"]["items"][0]["workspace"]["name"],
        "attach-hook"
    );
    assert!(paths_match(
        pre_json["data"]["items"][0]["workspace"]["path"]
            .as_str()
            .unwrap_or(""),
        &managed(&repo, "attach-hook")
    ));
    assert!(managed(&repo, "attach-hook").is_dir());
}

#[test]
fn detached_exec_resolves_the_created_path_with_a_configured_root() {
    let repo = Repo::new();
    assert!(repo
        .mabo(&["config", "set", "workspace-root", "custom"])
        .status
        .success());
    let output = repo.mabo(&["create", "detached", "--detach", "--json"]);
    assert!(output.status.success(), "{}", text(&output.stderr));
    let path = repo.repo.join("custom/detached");
    let ran = repo.mabo(&["exec", "detached", "--", "pwd"]);
    assert!(ran.status.success());
    assert!(paths_match(&text(&ran.stdout), &path));
}

#[test]
fn create_issue_refreshes_the_workspace_after_a_hook_detaches_head() {
    let repo = Repo::new();
    let set = repo.mabo(&["config", "set", "workspace-root", "../spaces"]);
    assert!(set.status.success(), "{}", text(&set.stderr));
    fs::write(
        repo.repo.join(".mabo.toml"),
        "[hooks]\nsetup = [\"test \\\"$(git branch --show-current)\\\" = issues/7 && git checkout -q --detach\"]\n",
    )
    .expect("detach hook");
    let bin = repo.root.join("bin");
    fs::create_dir_all(&bin).expect("bin");
    let gh = bin.join("gh");
    fs::write(
        &gh,
        r#"#!/bin/sh
set -eu
if [ "$1" = "repo" ]; then
  printf '%s\n' '{"url":"https://github.com/acme/demo","owner":{"login":"acme"},"name":"demo"}'
elif [ "$1" = "api" ] && [ "$2" = "repos/acme/demo/issues/7" ]; then
  printf '%s\n' '{"number":7,"title":"Issue with a detached checkout"}'
else
  echo "unexpected gh invocation: $*" >&2
  exit 1
fi
"#,
    )
    .expect("gh");
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(&gh, fs::Permissions::from_mode(0o755)).expect("chmod");
    let path = format!("{}:{}", bin.display(), std::env::var("PATH").expect("PATH"));
    let checkout = repo
        .command(
            env!("CARGO_BIN_EXE_mabo"),
            &["create", "--issue", "7", "--json"],
        )
        .env("PATH", path)
        .output()
        .expect("create issue");
    assert!(
        checkout.status.success(),
        "{}\n{}",
        text(&checkout.stdout),
        text(&checkout.stderr)
    );
    let document = json_value(&checkout);
    assert!(document["error"].is_null(), "{document}");
    assert_eq!(document["data"]["source"]["kind"], "issue");
    assert_eq!(document["data"]["source"]["number"], 7);
    assert_eq!(document["data"]["setup"]["ran"], true);
    assert_eq!(document["data"]["setup"]["ok"], true);
    let directory = repo.root.join("spaces/issues/7");
    let workspace = &document["data"]["workspace"];
    assert_worktree_object(workspace, "issues/7", &directory);
    assert_eq!(workspace["detached"], true);
    assert!(workspace["branch"].is_null());
    assert_eq!(workspace["links"]["issue"]["number"], 7);
    assert!(directory.join("README.md").is_file());
    let head = repo
        .command("git", &["rev-parse", "--abbrev-ref", "HEAD"])
        .current_dir(&directory)
        .output()
        .expect("detached HEAD");
    assert!(head.status.success(), "{}", text(&head.stderr));
    assert_eq!(text(&head.stdout), "HEAD");
    let ran = repo.mabo(&["exec", "issues/7", "--", "pwd"]);
    assert!(ran.status.success(), "{}", text(&ran.stderr));
    assert!(paths_match(&text(&ran.stdout), &directory));
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
            &["create", "--issue", "7", "--json"],
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
    assert_eq!(checkout_json["data"]["source"]["kind"], "issue");
    assert_eq!(checkout_json["data"]["source"]["number"], 7);
    assert!(checkout_json["data"]["source"]["headRef"].is_null());
    assert_eq!(checkout_json["data"]["source"]["reused"], false);
    assert_worktree_object(
        &checkout_json["data"]["workspace"],
        "issues/7",
        &managed(&repo, "issues/7"),
    );
    assert_eq!(checkout_json["data"]["workspace"]["branch"], "issues/7");
    assert_eq!(
        checkout_json["data"]["workspace"]["base"],
        "refs/heads/main"
    );
    assert_eq!(
        checkout_json["data"]["workspace"]["links"]["issue"]["number"],
        7
    );
    assert_eq!(
        checkout_json["data"]["workspace"]["links"]["issue"]["url"],
        "https://github.com/acme/demo/issues/7"
    );
    assert!(checkout_json["data"]["workspace"]["links"]["pr"].is_null());
    assert!(checkout_json["data"]["workspace"]["createdAt"].is_string());
    assert!(!text(&checkout.stdout).contains("Created workspace"));

    let missing = repo
        .command(
            env!("CARGO_BIN_EXE_mabo"),
            &["create", "--pr", "--json", "--output=json"],
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
            &["create", "--pr", "7", "--reuse", "--json"],
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
    assert_eq!(again_json["data"]["source"]["kind"], "pr");
    assert_eq!(again_json["data"]["source"]["number"], 7);
    assert_eq!(again_json["data"]["source"]["headRef"], "topic");
    assert_eq!(again_json["data"]["source"]["reused"], true);
    assert!(again_json["data"]["workspace"]["base"].is_null());
    assert_eq!(again_json["data"]["setup"]["ran"], false);
    assert_worktree_object(&again_json["data"]["workspace"], "topic", &checked_out);
    assert_eq!(again_json["data"]["workspace"]["links"]["pr"]["number"], 7);
    assert_eq!(
        again_json["data"]["workspace"]["links"]["pr"]["url"],
        "https://github.com/acme/demo/pull/7"
    );
    assert!(again_json["data"]["workspace"]["links"]["issue"].is_null());
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
        "--",
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
        "--",
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
    assert!(!text(&nested.stdout).contains("mabo exec <workspace-name>"));

    let help = repo.mabo(&["exec", "--help"]);
    assert!(help.status.success(), "{}", text(&help.stderr));
    assert!(text(&help.stdout).contains("mabo exec [--repo <ref>] [SEL] -- COMMAND [ARG...]"));

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
        assert!(text(&out.stdout).contains("mabo exec [--repo <ref>] [SEL] -- COMMAND [ARG...]"));
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
        {
            let mut args = prefix.clone();
            args.push("main");
            args.push("--");
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
    repo.git(&["branch", "existing"]);
    for args in [
        vec!["create", "new"],
        vec!["create", "--branch", "existing"],
    ] {
        assert!(repo.mabo(&args).status.success());
        let name = args.last().unwrap();
        let output = repo.mabo(&["exec", name, "--", "printf", "%s", "--json --repo --help"]);
        assert!(output.status.success());
        assert_eq!(text(&output.stdout), "--json --repo --help");
    }
}

#[test]
fn repeated_exec_options_are_rejected() {
    let repo = Repo::new();
    for args in [
        vec!["create", "removed", "--exec", "true", "--exec", "true"],
        vec!["create", "removed", "-x", "true"],
    ] {
        let out = repo.mabo(&args);
        assert_eq!(out.status.code(), Some(2));
        assert!(text(&out.stderr).contains("mabo exec SEL -- COMMAND"));
        assert!(!managed(&repo, "removed").exists());
    }
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
            .mabo(&["config", "set", "clone-root", root.to_str().expect("root")])
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
                    value["data"]["repo"]["root"],
                    canonical(&destination).to_string_lossy().as_ref()
                );
                assert_eq!(value["data"]["repo"]["name"], "github.com/example/widget");
                assert_eq!(
                    value["data"]["repo"]["remoteUrl"],
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
    let set = repo.mabo(&["config", "set", "clone-root", root.to_str().expect("root")]);
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
        value["data"]["repo"]["root"],
        destination.to_string_lossy().as_ref()
    );
    assert_eq!(value["data"]["repo"]["name"], "github.com/example/widget");
    assert_eq!(
        value["data"]["repo"]["remoteUrl"],
        "https://github.com/example/widget.git"
    );
    assert_eq!(value["data"]["cloned"], true);
    assert_eq!(value["data"]["updated"], false);
    assert!(value.get("repo").is_none());
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
    let listed = repo.mabo(&["repo", "list", "--json"]);
    assert!(listed.status.success(), "{}", text(&listed.stderr));
    let catalog: serde_json::Value = serde_json::from_str(&text(&listed.stdout)).expect("catalog");
    let registered = catalog["data"]["repos"]
        .as_array()
        .expect("projects")
        .iter()
        .find(|project| project["rootPath"] == value["data"]["repo"]["root"])
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
    assert_eq!(
        updated_json["data"]["repo"]["root"],
        value["data"]["repo"]["root"]
    );
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

    let removed = repo.mabo(&["repo", "forget", "widget"]);
    assert!(removed.status.success(), "{}", text(&removed.stderr));
    let discovered = repo.mabo(&["repo", "list", "--json"]);
    assert!(discovered.status.success(), "{}", text(&discovered.stderr));
    let discovered_json: serde_json::Value =
        serde_json::from_str(&text(&discovered.stdout)).expect("discovered");
    let found = discovered_json["data"]["repos"]
        .as_array()
        .expect("projects")
        .iter()
        .find(|project| project["rootPath"] == value["data"]["repo"]["root"])
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
    let invalid = repo.mabo(&["config", "set", "clone-root", "relative/path"]);
    assert_eq!(invalid.status.code(), Some(2), "{}", text(&invalid.stderr));
    assert!(text(&invalid.stderr).contains("absolute"));
    let set = repo.mabo(&[
        "config",
        "set",
        "clone-root",
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

    let removed = repo.mabo(&["config", "unset", "clone-root"]);
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
    let set = repo.mabo(&["config", "set", "clone-root", root.to_str().expect("root")]);
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
        again_json["data"]["repo"]["root"],
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
    let set = repo.mabo(&["config", "set", "clone-root", root.to_str().expect("root")]);
    assert!(set.status.success(), "{}", text(&set.stderr));

    let cloned = repo.mabo(&["clone", "https://GitHub.com/example/widget.git", "--json"]);
    assert!(
        cloned.status.success(),
        "{}\n{}",
        text(&cloned.stdout),
        text(&cloned.stderr)
    );
    let value: serde_json::Value = serde_json::from_str(&text(&cloned.stdout)).expect("json");
    assert_eq!(
        value["data"]["repo"]["remoteUrl"],
        "https://github.com/example/widget.git"
    );
    assert_eq!(
        value["data"]["repo"]["root"],
        canonical(&root.join("github.com/example/widget"))
            .to_string_lossy()
            .as_ref()
    );
}

#[test]
fn clone_overlong_owner_is_validation() {
    let repo = Repo::new();
    let root = repo.root.join("clones");
    let set = repo.mabo(&["config", "set", "clone-root", root.to_str().expect("root")]);
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
    let set = repo.mabo(&["config", "set", "clone-root", root.to_str().expect("root")]);
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
    let set = repo.mabo(&["config", "set", "clone-root", root.to_str().expect("root")]);
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
    let set = repo.mabo(&["config", "set", "clone-root", root.to_str().expect("root")]);
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
    assert_eq!(
        value["data"]["repo"]["root"],
        expected.to_string_lossy().as_ref()
    );
    assert_eq!(value["data"]["cloned"], true);
    assert_eq!(value["data"]["repo"]["name"], "github.com/example/widget");
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
    let set = repo.mabo(&[
        "config",
        "set",
        "clone-root",
        clones.to_str().expect("root"),
    ]);
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

    let catalog = run(&["repo", "list", "--json"], &repo.home);
    assert!(catalog.status.success(), "{}", text(&catalog.stderr));
    let catalog_json = json_value(&catalog);
    let only_entry = catalog_json["data"]["repos"]
        .as_array()
        .expect("projects")
        .iter()
        .find(|project| project["canonicalName"] == "github.com/acme/ptm805only")
        .expect("only project");
    assert_eq!(only_entry["name"], "ptm805only");
    assert_eq!(only_entry["canonicalName"], "github.com/acme/ptm805only");
    let placed_entry = catalog_json["data"]["repos"]
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
        let located = run(&["path", "--repo", reference, "main"], &repo.home);
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
    let by_remote = run(&["path", "--repo", "other/renamed", "main"], &repo.home);
    assert!(by_remote.status.success(), "{}", text(&by_remote.stderr));
    assert!(same_dir(&text(&by_remote.stdout), &placed));
    let by_location = run(&["path", "--repo", "acme/placed", "main"], &repo.home);
    assert!(
        by_location.status.success(),
        "{}",
        text(&by_location.stderr)
    );
    assert!(same_dir(&text(&by_location.stdout), &placed));

    let ambiguous = run(&["list", "--repo", "ptm805widget", "--json"], &repo.home);
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
    let unique = run(&["path", "--repo", "acme/ptm805widget", "main"], &repo.home);
    assert!(unique.status.success(), "{}", text(&unique.stderr));
    assert!(same_dir(&text(&unique.stdout), &acme_widget));

    let missing = run(&["list", "--repo", "no-such-ptm805", "--json"], &repo.home);
    assert_eq!(missing.status.code(), Some(3), "{}", text(&missing.stdout));
    let missing_json = json_value(&missing);
    assert_eq!(missing_json["error"]["code"], "not_found");
    assert!(missing_json["error"].get("exitCode").is_none());
    assert_eq!(
        missing_json["error"]["message"],
        "Repository 'no-such-ptm805' not found"
    );
    let prefix = run(
        &["show", "--repo", "github.com/acme", "main", "--json"],
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
        &["path", "-R", repo.repo.to_str().expect("repo"), "main"],
        &repo.home,
    );
    assert!(absolute.status.success(), "{}", text(&absolute.stderr));
    assert!(same_dir(&text(&absolute.stdout), &repo.repo));
    let relative = run(&["path", "--repo", "./repo", "main"], &repo.root);
    assert!(relative.status.success(), "{}", text(&relative.stderr));
    assert!(same_dir(&text(&relative.stdout), &repo.repo));
    let dotted = run(&["path", "--repo", ".", "main"], &sub);
    assert!(dotted.status.success(), "{}", text(&dotted.stderr));
    assert!(same_dir(&text(&dotted.stdout), &repo.repo));
    let tilde = repo
        .command(
            env!("CARGO_BIN_EXE_mabo"),
            &["path", "--repo", "~/repo", "main"],
        )
        .env("PATH", &path_env)
        .env("HOME", &repo.root)
        .current_dir(&repo.home)
        .output()
        .expect("tilde");
    assert!(tilde.status.success(), "{}", text(&tilde.stderr));
    assert!(same_dir(&text(&tilde.stdout), &repo.repo));

    let inside = run(
        &["list", "--json", "--repo", nested.to_str().expect("nested")],
        &repo.home,
    );
    assert!(
        inside.status.success(),
        "{}\n{}",
        text(&inside.stdout),
        text(&inside.stderr)
    );
    let inside_json = json_value(&inside);
    let worktrees = inside_json["data"]["workspaces"]
        .as_array()
        .expect("worktrees");
    let default_tree = worktrees
        .iter()
        .find(|worktree| worktree["kind"].as_str() == Some("primary"))
        .expect("primary checkout");
    assert!(same_dir(
        default_tree["path"].as_str().unwrap_or(""),
        &repo.repo
    ));
    let feature_tree = worktrees
        .iter()
        .find(|worktree| worktree["name"] == "feature")
        .expect("feature");
    assert_eq!(feature_tree["kind"], "workspace");
    let from_link = run(&["path", "--repo", ".", "main"], &worktree);
    assert!(from_link.status.success(), "{}", text(&from_link.stderr));
    assert!(same_dir(&text(&from_link.stdout), &repo.repo));
    let created_from_link = run(
        &[
            "create",
            "--repo",
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
            "--repo",
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
            "--repo",
            repo.home.to_str().expect("home"),
            "--json",
        ],
        &repo.home,
    );
    assert_eq!(outside.status.code(), Some(3), "{}", text(&outside.stdout));
    assert_eq!(json_value(&outside)["error"]["code"], "not_repository");
    let absent = run(
        &["show", "--repo", "/no/such/ptm805-path", "main", "--json"],
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
            "--repo",
            "acme/ptm805only",
            "--repo",
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
            "create",
            "--repo",
            repo.repo.to_str().expect("repo"),
            "--issue",
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
            "create",
            "--repo",
            "no-such-ptm805",
            "--issue",
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
    let set = repo.mabo(&[
        "config",
        "set",
        "clone-root",
        clones.to_str().expect("root"),
    ]);
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
    let created = run(&["create", "--repo", "acme/ptm805exec", "foo"]);
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
        "--repo",
        "acme/ptm805exec",
        "foo",
        "--",
        "pwd",
        "--repo",
        "y",
    ]);
    assert_eq!(passed.status.code(), Some(1), "{}", text(&passed.stderr));
    let stderr = text(&passed.stderr);
    assert!(
        stderr.contains("unrecognized option '--repo'"),
        "pwd should receive --repo y: {stderr}"
    );
    assert!(!stderr.contains("Unknown option"), "{stderr}");
    assert!(!stderr.contains("matches multiple"), "{stderr}");

    let printed = run(&[
        "exec",
        "--repo",
        "acme/ptm805exec",
        "foo",
        "--",
        "printf",
        "%s\n",
        "--repo",
        "y",
    ]);
    assert!(
        printed.status.success(),
        "{}\n{}",
        text(&printed.stdout),
        text(&printed.stderr)
    );
    assert_eq!(text(&printed.stdout), "--repo\ny");

    let missing = run(&[
        "exec",
        "--repo",
        "no-such-ptm805",
        "foo",
        "--",
        "pwd",
        "--repo",
        "y",
    ]);
    assert_eq!(missing.status.code(), Some(3), "{}", text(&missing.stderr));
    assert!(text(&missing.stderr).contains("Repository 'no-such-ptm805' not found"));
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
        let added = repo.mabo(&["repo", "add", path.to_str().expect("path"), "--json"]);
        assert!(added.status.success(), "{}", text(&added.stderr));
    }
    fs::write(repo.repo.join(".mabo.toml"), "not = [\n").expect("invalid config");

    let run = |args: &[&str]| {
        repo.command(env!("CARGO_BIN_EXE_mabo"), args)
            .env("PATH", &path_env)
            .output()
            .expect("mabo")
    };
    let listed = run(&["list", "-R", "tool"]);
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
    let located = run(&["path", "-R", "tool", "h1"]);
    assert!(located.status.success(), "{}", text(&located.stderr));
    assert!(same_dir(&text(&located.stdout), &feature));
    let created = run(&["create", "-R", "tool", "z1"]);
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

    let by_directory = run(&["path", "-R", "localname", "main"]);
    assert!(
        by_directory.status.success(),
        "{}",
        text(&by_directory.stderr)
    );
    assert!(same_dir(&text(&by_directory.stdout), &localname));
    let by_suffix = run(&["path", "--repo", "ptm805renamed", "main"]);
    assert!(by_suffix.status.success(), "{}", text(&by_suffix.stderr));
    assert!(same_dir(&text(&by_suffix.stdout), &localname));

    let option_value = run(&["list", "-R", "--json"]);
    assert_eq!(option_value.status.code(), Some(2));
    assert!(option_value.stdout.is_empty());
    assert!(text(&option_value.stderr).contains("looks like an option"));
    let option_json = run(&["list", "--json", "-R", "--json"]);
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
    let option_later = run(&["show", "--json", "-R", "--bogus", "main"]);
    assert_eq!(option_later.status.code(), Some(2));
    assert_eq!(json_value(&option_later)["error"]["code"], "usage");
    let option_human = run(&["path", "-R", "--nope", "main"]);
    assert_eq!(
        option_human.status.code(),
        Some(2),
        "{}",
        text(&option_human.stderr)
    );
    assert!(text(&option_human.stderr).contains("looks like an option"));
    assert!(!text(&option_human.stdout).contains("\"version\""));

    let help = run(&["exec", "--repo", "tool", "--help"]);
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
                "create", "-R",
                tool.to_str().expect("tool"),
                "--issue", "3",
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
        .command(env!("CARGO_BIN_EXE_mabo"), &["create", "--issue", "4"])
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
                "create",
                "-R",
                alias.to_str().expect("alias"),
                "--issue",
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
    fs::create_dir_all(&project).expect("repo");
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
    let added = repo.mabo(&["repo", "add", project.to_str().expect("path"), "--json"]);
    assert!(added.status.success(), "{}", text(&added.stderr));
    let listed = repo
        .command(env!("CARGO_BIN_EXE_mabo"), &["repo", "list", "--json"])
        .env("PATH", &path_env)
        .output()
        .expect("list");
    assert!(listed.status.success(), "{}", text(&listed.stderr));
    let catalog = json_value(&listed);
    let entry = catalog["data"]["repos"]
        .as_array()
        .expect("projects")
        .iter()
        .find(|project| project["name"] == "ptm805local")
        .expect("repo");
    assert_eq!(entry["canonicalName"], "ptm805local");
    assert!(!entry["canonicalName"]
        .as_str()
        .unwrap_or("")
        .contains("github.com"));
    let matched = repo
        .command(
            env!("CARGO_BIN_EXE_mabo"),
            &["show", "-R", "github.com/backups/widget", "main", "--json"],
        )
        .env("PATH", &path_env)
        .output()
        .expect("show");
    assert_eq!(matched.status.code(), Some(3), "{}", text(&matched.stdout));
    assert_eq!(json_value(&matched)["error"]["code"], "not_found");
    let by_name = repo
        .command(
            env!("CARGO_BIN_EXE_mabo"),
            &["path", "-R", "ptm805local", "main"],
        )
        .env("PATH", &path_env)
        .output()
        .expect("name");
    assert!(by_name.status.success(), "{}", text(&by_name.stderr));
    assert!(same_dir(&text(&by_name.stdout), &project));

    let git_dir = repo.mabo(&[
        "path",
        "-R",
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
        "path",
        "-R",
        repo.repo.join(".git/objects").to_str().expect("objects"),
        "main",
    ]);
    assert!(objects.status.success(), "{}", text(&objects.stderr));
    assert!(same_dir(&text(&objects.stdout), &repo.repo));
    assert!(!text(&objects.stderr).contains("must be run in a work tree"));
}

#[test]
fn workspace_intent_is_recorded_updated_and_removed() {
    let repo = Repo::new();
    let created = repo
        .command(
            env!("CARGO_BIN_EXE_mabo"),
            &["create", "feature", "--purpose", "fix the flake", "--json"],
        )
        .env("MABO_AGENT_ID", "ignored")
        .env("MABO_ACTOR", "also ignored")
        .output()
        .unwrap();
    assert!(created.status.success(), "{}", text(&created.stderr));
    assert!(repo
        .mabo(&["set", "feature", "--pr", "774"])
        .status
        .success());
    let created = json_value(&repo.mabo(&["show", "feature", "--json"]));
    let workspace = &created["data"]["workspace"];
    assert!(workspace.get("owner").is_none());
    assert!(workspace.get("ownerRelation").is_none());
    assert!(workspace.get("lastUsedAt").is_none());
    assert_eq!(workspace["purpose"], "fix the flake");
    assert_eq!(workspace["links"]["pr"]["number"], 774);
    assert_eq!(workspace["createdFrom"], workspace["head"]);
    assert!(text(&repo.mabo(&["list"]).stdout).contains("fix the flake"));
    let updated = repo.mabo(&[
        "set",
        "feature",
        "--purpose",
        "land the fix",
        "--issue",
        "12",
        "--json",
    ]);
    assert!(updated.status.success(), "{}", text(&updated.stderr));
    let updated = json_value(&updated);
    assert_eq!(updated["data"]["workspace"]["purpose"], "land the fix");
    assert_eq!(updated["data"]["workspace"]["links"]["pr"]["number"], 774);
    assert_eq!(updated["data"]["workspace"]["links"]["issue"]["number"], 12);
    assert_eq!(
        updated["data"]["workspace"]["createdAt"],
        workspace["createdAt"]
    );
    assert_eq!(
        updated["data"]["workspace"]["createdFrom"],
        workspace["createdFrom"]
    );
    assert_eq!(repo.mabo(&["set", "feature"]).status.code(), Some(2));
    assert_eq!(
        repo.mabo(&["set", "missing", "--purpose", "task"])
            .status
            .code(),
        Some(3)
    );
    assert_eq!(
        repo.mabo(&["set", "feature", "--pr", "invalid"])
            .status
            .code(),
        Some(2)
    );
    repo.git(&["branch", "side"]);
    let attached = repo.mabo(&[
        "create",
        "--branch",
        "side",
        "--purpose",
        "review",
        "--issue",
        "12",
        "--json",
    ]);
    assert!(attached.status.success());
    let attached = json_value(&attached);
    assert_eq!(attached["data"]["workspace"]["purpose"], "review");
    assert!(attached["data"]["workspace"].get("owner").is_none());
    assert!(attached["data"]["workspace"].get("lastUsedAt").is_none());
    let deleted = repo.mabo(&["remove", "feature", "--keep-branch", "--json"]);
    assert!(deleted.status.success());
    let deleted = json_value(&deleted);
    assert_eq!(
        deleted["data"]["items"][0]["workspace"]["purpose"],
        "land the fix"
    );
    assert!(deleted["data"]["items"][0]["workspace"]
        .get("owner")
        .is_none());
    assert!(deleted["data"]["items"][0]["workspace"]
        .get("lastUsedAt")
        .is_none());
    assert!(!text(&repo.mabo(&["list", "--names"]).stdout).contains("feature"));
}

#[test]
fn github_recheckout_keeps_the_original_intent() {
    let repo = Repo::new();
    // Bare links must belong to the repository returned by the gh fixture.
    repo.git(&[
        "remote",
        "add",
        "origin",
        "https://github.com/acme/demo.git",
    ]);
    let created = repo
        .command(
            env!("CARGO_BIN_EXE_mabo"),
            &["create", "topic", "--purpose", "original task", "--json"],
        )
        .output()
        .expect("create");
    assert!(created.status.success(), "{}", text(&created.stderr));
    let created_at = json_value(&created)["data"]["workspace"]["createdAt"]
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

    assert!(repo.mabo(&["set", "topic", "--pr", "7"]).status.success());
    let path = fake_gh_for_topic_pr(&repo);
    let again = repo
        .command(
            env!("CARGO_BIN_EXE_mabo"),
            &[
                "create",
                "--pr",
                "7",
                "--reuse",
                "--json",
                "--purpose",
                "stolen",
            ],
        )
        .env("PATH", &path)
        .env("MABO_AGENT_ID", "intruder")
        .output()
        .expect("checkout");
    assert!(again.status.success(), "{}", text(&again.stderr));
    let again_json = json_value(&again);
    assert_eq!(again_json["data"]["source"]["reused"], true);

    assert_eq!(again_json["data"]["workspace"]["purpose"], "original task");
    assert_eq!(again_json["data"]["workspace"]["createdAt"], created_at);
    assert!(again_json["data"]["workspace"].get("lastUsedAt").is_none());
    assert_eq!(again_json["data"]["workspace"]["links"]["pr"]["number"], 7);
    let listed = repo.mabo(&["list", "--json", "--kind", "workspace"]);
    assert_eq!(
        json_value(&listed)["data"]["workspaces"]
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
        .command(env!("CARGO_BIN_EXE_mabo"), &["create", "--pr", "7"])
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
            &["create", "--pr", "7", "--reuse", "--json"],
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
            &["create", "--pr", "7", "--reuse", "--json"],
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
    assert_eq!(checked_out_json["data"]["source"]["kind"], "pr");
    assert_eq!(checked_out_json["data"]["source"]["headRef"], "topic");
    assert_eq!(checked_out_json["data"]["source"]["reused"], false);
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
    let created = repo.mabo(&["create", "doomed", "--purpose", "creator", "--json"]);
    assert!(created.status.success(), "{}", text(&created.stderr));
    let metadata_dir = repo.repo.join(".git/maboroshi/workspaces");
    let store = records::read_to_string(&metadata_dir).expect("store");
    use std::os::unix::fs::PermissionsExt;
    let mut locked = fs::metadata(&metadata_dir).expect("meta").permissions();
    locked.set_mode(0o555);
    fs::set_permissions(&metadata_dir, locked).expect("chmod");
    let _restore = ModeReset(&metadata_dir);
    let deleted = repo.mabo(&["remove", "doomed", "--keep-branch", "--json"]);
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
    let created = repo.mabo(&["create", "feature", "--purpose", "old task", "--json"]);
    assert!(created.status.success(), "{}", text(&created.stderr));
    let created_at = json_value(&created)["data"]["workspace"]["createdAt"]
        .as_str()
        .expect("created")
        .to_string();
    let path = managed(&repo, "feature");
    repo.git(&["worktree", "remove", path.to_str().expect("path")]);
    repo.git(&["branch", "-D", "feature"]);
    let again = repo.mabo(&["create", "feature", "--purpose", "new task", "--json"]);
    assert!(again.status.success(), "{}", text(&again.stderr));
    let again_json = json_value(&again);

    assert_eq!(again_json["data"]["workspace"]["purpose"], "new task");
    assert_ne!(again_json["data"]["workspace"]["createdAt"], created_at);
    assert_eq!(again_json["data"]["metadata"]["ok"], true);
    let listed = repo.mabo(&["list", "--names", "--kind", "workspace"]);
    assert_eq!(text(&listed.stdout), "feature");
    assert_eq!(
        json_value(&repo.mabo(&["list", "--json", "--kind", "workspace"]))["data"]["workspaces"]
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
        "[hooks]\nsetup = [\"touch hook-ran\"]\n",
    )
    .expect("hooks");
    let created = repo
        .command(
            env!("CARGO_BIN_EXE_mabo"),
            &["create", "feature", "--purpose", "creator", "--json"],
        )
        .env("MABO_TEST_FAIL_METADATA_SAVE", "1")
        .output()
        .expect("create");
    assert_eq!(created.status.code(), Some(6), "{}", text(&created.stdout));
    let created_json = json_value(&created);
    assert!(created_json["error"]["code"] == "partial", "{created_json}");
    assert_eq!(created_json["data"]["workspace"]["name"], "feature");
    assert!(created_json["data"]["workspace"]["purpose"].is_null());
    assert_eq!(created_json["data"]["metadata"]["ok"], false);
    assert!(created_json["data"]["metadata"]["error"]
        .as_str()
        .unwrap_or("")
        .contains("injected"));
    assert_eq!(created_json["data"]["setup"]["ok"], true);
    assert!(created_json["data"]["copy"]["error"].is_null());
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
    let created = repo.mabo(&["create", "feature", "--purpose", "creator", "--json"]);
    assert!(created.status.success(), "{}", text(&created.stderr));
    let id = json_value(&created)["data"]["workspace"]["id"]
        .as_str()
        .expect("workspace id")
        .to_string();
    assert!(repo
        .mabo(&["create", "healthy", "--purpose", "reader"])
        .status
        .success());
    let file = repo
        .repo
        .join(".git/maboroshi/workspaces")
        .join(format!("{id}.json"));
    fs::write(&file, "{not json").expect("corrupt");

    let listed = repo.mabo(&["list", "--json", "--kind", "workspace"]);
    assert!(listed.status.success(), "{}", text(&listed.stderr));
    let listed_json = json_value(&listed);
    assert_eq!(listed_json["data"]["workspaces"][0]["name"], "feature");
    assert!(listed_json["data"]["workspaces"][0]["purpose"].is_null());
    assert!(text(&listed.stderr).contains("workspaces"));
    let healthy = listed_json["data"]["workspaces"]
        .as_array()
        .unwrap()
        .iter()
        .find(|tree| tree["name"] == "healthy")
        .unwrap();
    assert_eq!(healthy["purpose"], "reader");
    assert!(healthy["id"].as_str().unwrap().starts_with("ws_"));
    assert!(!listed_json["warnings"]
        .as_array()
        .expect("warnings")
        .is_empty());

    let located = repo.mabo(&["show", "feature", "--json"]);
    assert!(located.status.success(), "{}", text(&located.stderr));
    assert!(json_value(&located)["data"]["workspace"]["purpose"].is_null());
    assert!(text(&located.stderr).contains("invalid JSON"));
    let human = repo.mabo(&["path", "feature"]);
    assert!(human.status.success());
    assert!(text(&human.stdout).starts_with('/'));

    let ran = repo.mabo(&["exec", "feature", "--", "true"]);
    assert!(ran.status.success(), "{}", text(&ran.stderr));
    assert!(text(&ran.stderr).contains("invalid JSON"));

    assert_eq!(fs::read_to_string(&file).expect("kept"), "{not json");
}

#[test]
fn exec_command_json_flag_does_not_switch_mabo_to_json() {
    let repo = Repo::new();
    assert!(repo.mabo(&["create", "child"]).status.success());
    let out = repo.mabo(&["exec", "child", "--", "printf", "%s", "--json"]);
    assert!(out.status.success());
    assert_eq!(text(&out.stdout), "--json");
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
    test_git::write_config(&home);
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
    assert_worktree_object(&created_json["data"]["workspace"], "feature", &worktree);
    assert!(worktree.is_dir());
    assert!(!sep
        .join("maboroshi")
        .join("workspaces")
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
    test_git::write_config(&home);
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
        "config",
        "set",
        "workspace-root",
        worktrees.to_str().expect("worktrees"),
    ]);
    assert!(pref.status.success(), "{}", text(&pref.stderr));
    let created = mabo(&["create", "feature", "--purpose", "sep", "--json"]);
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
        .any(|record| record["purpose"] == "sep"));
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
        test_git::write_config(&home);
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
        "primary checkout lives under XDG data home"
    );
    assert!(!repo
        .git_dir
        .join("maboroshi")
        .join("workspaces")
        .join("linked")
        .exists());
    let deleted = repo.mabo(&linked, &["remove", "."]);
    let stdout = text(&deleted.stdout);
    let stderr = text(&deleted.stderr);
    assert!(
        deleted.status.success(),
        "delete --current from the linked workspace should remove it\n{stdout}\n{stderr}"
    );
    assert!(
        stdout.contains("Deleted workspace 'linked'"),
        "{stdout}\n{stderr}"
    );
    assert!(!linked.exists(), "linked workspace should be removed");
    assert!(
        repo.checkout.join("README.md").is_file(),
        "main checkout stays"
    );
    assert!(
        repo.checkout.join(".git").is_file(),
        "main checkout stays a gitfile, not the deleted workspace"
    );
    let branch = repo
        .command("git", &["branch", "--list", "linked"], &repo.checkout)
        .output()
        .expect("branch");
    assert!(branch.status.success(), "{}", text(&branch.stderr));
    assert!(
        text(&branch.stdout).is_empty(),
        "delete --current removes the workspace branch: {}",
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
        &["config", "set", "workspace-root", "../wt"],
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
        "relative workspace-root stays joined to the main checkout\n{stdout}\n{stderr}"
    );
    assert!(
        !repo
            .root
            .join("deep")
            .join("wt")
            .join("wt")
            .join("r2")
            .exists(),
        "must not nest under the linked workspace"
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
    test_git::write_config(&home);
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
    let deleted = mabo(&linked, &["remove", "."]);
    assert!(
        deleted.status.success(),
        "{}\n{}",
        text(&deleted.stdout),
        text(&deleted.stderr)
    );
    assert!(!linked.exists());
    assert!(checkout.join(".git").is_file(), "submodule checkout stays");
    let pref = mabo(&checkout, &["config", "set", "workspace-root", "../wt"]);
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
    test_git::write_config(&home);
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
        assert_eq!(main["kind"], "primary");
        let ran = mabo(checkout, &["exec", "main", "--", "pwd"]);
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
    assert_eq!(main["kind"], "primary");
    let ran = mabo(&linked, &["exec", "main", "--", "pwd"]);
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
    test_git::write_config(&home);
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
    test_git::write_config(&home);
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
    assert_eq!(main["kind"], "primary");

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
    assert_eq!(deep_main["kind"], "primary");
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
    test_git::write_config(&home);
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
        .join("workspaces")
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
            .any(|line| line.trim_start().starts_with("main  main")),
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
    assert_eq!(main["kind"], "primary");
    let hidden = mabo(&linked, &["list", "--kind", "workspace", "--json"]);
    assert!(hidden.status.success(), "{}", text(&hidden.stderr));
    let hidden_rows = json_value(&hidden)["data"]["workspaces"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    assert!(
        hidden_rows.iter().all(|row| row["kind"] != "primary"
            && !paths_match(row["path"].as_str().unwrap_or(""), &checkout)),
        "{hidden_rows:?}"
    );
    assert!(
        hidden_rows.iter().any(|row| row["name"] == "linked"),
        "{hidden_rows:?}"
    );
    let ran = mabo(&linked, &["exec", "main", "--", "pwd"]);
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
        assert!(error["data"]["workspaces"].is_null());
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
    let rows = document["data"]["workspaces"]
        .as_array()
        .expect("worktrees");
    assert!(
        rows.iter()
            .all(|row| !paths_match(row["path"].as_str().unwrap_or(""), git_dir)),
        "git dir is still a workspace path: {rows:?}"
    );
    let main = default_worktree(&document);
    assert!(
        paths_match(main["path"].as_str().unwrap_or(""), checkout),
        "{}",
        main["path"]
    );
    assert_eq!(main["kind"], "primary");
    let hidden = repo.mabo(linked, &["list", "--kind", "workspace"]);
    assert!(hidden.status.success(), "{}", text(&hidden.stderr));
    let hidden_text = text(&hidden.stdout);
    assert!(
        !hidden_text.lines().any(|line| line.starts_with("main ")),
        "--no-default still shows main\n{hidden_text}"
    );
    assert!(hidden_text.contains("linked"), "{hidden_text}");
    let ran = repo.mabo(linked, &["exec", "main", "--", "pwd"]);
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
    document["data"]["workspaces"]
        .as_array()
        .and_then(|rows| rows.iter().find(|row| row["kind"] == "primary"))
        .cloned()
        .unwrap_or_else(|| panic!("no primary checkout in {document}"))
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
        let mut args = vec!["repo", "add"];
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
        let mut args = vec!["set", "main", "--purpose", "new purpose"];
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
    let created = repo.mabo(&["create", "kept", "--purpose", "creator"]);
    assert!(created.status.success(), "{}", text(&created.stderr));
    repo.git(&["branch", "side"]);
    fs::remove_dir_all(repo.repo.join(".git/maboroshi/workspaces")).expect("remove records");
    let file = repo.repo.join(".git/maboroshi/worktrees.json");
    let body = "{\n  \"version\": 1,\n  \"worktrees\": [\n    {\"path\": \"/tmp/one\", \"owner\": \"a\"},\n    {\"path\": \"/tmp/one\", \"owner\": \"b\"}\n  ]\n}\n";
    records::write(&file, body).expect("duplicate");
    let before = records::read_to_string(&file).expect("snapshot");
    for args in [
        vec!["create", "other", "--json"],
        vec!["create", "--branch", "side", "--json"],
        vec!["remove", "kept", "--json"],
        vec!["set", "kept", "--purpose", "nope", "--json"],
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
    record["createdAt"] = serde_json::json!("2000-01-01T00:00:00.000Z");
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
        .mabo(&["create", "feature", "--purpose", "grok"])
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
    assert_eq!(document["data"]["items"][0]["name"], "feature");
    assert!(document["data"]["items"][0].get("owner").is_none());
    assert_eq!(
        document["data"]["items"][0]["reasons"],
        serde_json::json!(["merged"])
    );
    assert_eq!(document["data"]["items"][0]["action"], "wouldRemove");
    assert!(document["data"]["items"][0]["detail"].is_null());
    assert!(document["data"]["items"][0]["branchDeleted"].is_null());
    assert!(document["data"]["items"][0]["path"]
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
fn gc_skips_dirty_unpushed_and_current_workspaces() {
    let repo = Repo::new();
    assert!(repo.mabo(&["create", "dirty"]).status.success());
    land_branch(&repo, "dirty");
    fs::write(worktree_dir(&repo, "dirty").join("local.txt"), "x\n").expect("dirty");
    assert!(repo.mabo(&["create", "wip"]).status.success());
    commit_in_worktree(&repo, "wip");
    assert!(repo.mabo(&["create", "here"]).status.success());
    land_branch(&repo, "here");
    assert!(repo
        .mabo(&["create", "bob", "--purpose", "bob"])
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
    assert!(aged_text.contains("Nothing to clean up."), "{aged_text}");
    assert!(!aged_text.contains("would remove dirty"), "{aged_text}");

    let current = repo
        .command(env!("CARGO_BIN_EXE_mabo"), &["gc", "--apply"])
        .current_dir(worktree_dir(&repo, "here"))
        .output()
        .expect("gc");
    assert!(current.status.success(), "{}", text(&current.stderr));
    let current_text = text(&current.stdout);
    assert!(
        current_text.contains("skip here [merged] current workspace"),
        "{current_text}"
    );
    assert!(
        current_text.contains("skip dirty [merged] dirty"),
        "{current_text}"
    );
    assert!(worktree_dir(&repo, "here").is_dir());
    assert!(worktree_dir(&repo, "dirty").is_dir());

    let forced = repo.mabo(&["gc", "--apply"]);
    assert!(forced.status.success(), "{}", text(&forced.stderr));
    let forced_text = text(&forced.stdout);
    assert!(
        forced_text.contains("skip dirty [merged] dirty"),
        "{forced_text}"
    );
    assert!(
        forced_text.contains("removed here [merged]"),
        "{forced_text}"
    );
    assert!(worktree_dir(&repo, "dirty").is_dir());
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
    assert!(text.contains("removed local [orphaned]"), "{text}");
    assert!(!worktree_registered(&repo, "gone"));
    assert!(!worktree_registered(&repo, "local"));
    assert!(branch_listed(&repo, "gone"));
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
            format!("[hooks]\npre-remove = [\"{command}\"]\n"),
        )
        .unwrap();
        let out = repo.mabo(&["gc", "--apply", "--json"]);
        let doc = json_value(&out);
        assert!(branch_listed(&repo, "z-local"), "{change}: {doc}");
        assert!(worktree_registered(&repo, "z-local"), "{change}: {doc}");
        let item = doc["data"]["items"]
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
            let created = repo.create_recorded(&["create", &name, "--pr", &url]);
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
                &["gc", "--closed-pr", "--apply", "--apply", "--json"],
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
        let candidates = doc["data"]["items"].as_array().unwrap();
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
        .create_recorded(&[
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
pre-remove = ["echo '{{\"state\":\"OPEN\"}}' > '{}' "]
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
            &["gc", "--closed-pr", "--apply", "--json"],
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
    assert_eq!(doc["data"]["items"][0]["action"], "failed");
    assert!(doc["data"]["items"][0]["detail"]
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
        .create_recorded(&[
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
        .command(env!("CARGO_BIN_EXE_mabo"), &["gc", "--closed-pr", "--json"])
        .env("PATH", &path)
        .output()
        .expect("gc");
    assert!(plan.status.success(), "{}", text(&plan.stderr));
    let document = json_value(&plan);
    assert_eq!(
        document["data"]["items"][0]["reasons"],
        serde_json::json!(["pullRequest"])
    );
    assert_eq!(document["data"]["items"][0]["action"], "skipped");
    assert!(document["data"]["items"][0]["detail"]
        .as_str()
        .unwrap()
        .contains(" remove --delete-unpreserved-branch -- 'topic'"));
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
            &["gc", "--closed-pr", "--apply", "--json"],
        )
        .env("PATH", &path)
        .output()
        .expect("force");
    assert!(forced.status.success(), "{}", text(&forced.stderr));
    let removed = json_value(&forced);
    assert_eq!(removed["data"]["applied"], true);
    assert_eq!(removed["data"]["items"][0]["action"], "skipped");
    assert!(removed["data"]["items"][0]["branchDeleted"].is_null());
    assert!(worktree_dir(&repo, "topic").is_dir());
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
                let candidates = value["data"]["items"].as_array().expect("candidates");
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
        "[hooks]\npre-remove = [\"exit 42\"]\n",
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
        "[hooks]\npre-remove = [\"test \\\"$MABO_WORKSPACE\\\" != feature && touch \\\"$MABO_REPO_PATH/hooked\\\"\"]\n",
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
            || text(&applied.stderr).contains("pre-remove")
            || text(&applied.stderr).contains("Running")
    );
    let document = json_value(&applied);
    assert_eq!(document["error"]["code"], "partial");
    assert!(document["error"].get("exitCode").is_none());
    let failed = document["data"]["items"]
        .as_array()
        .expect("candidates")
        .iter()
        .find(|entry| entry["name"] == "feature")
        .expect("feature");
    assert_eq!(failed["action"], "failed");
    let removed = document["data"]["items"]
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
    let attached = repo.mabo(&["create", "--branch", "main"]);
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
    let head = json_value(&created)["data"]["workspace"]["head"]
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
        json_value(&created)["data"]["workspace"]["createdFrom"],
        head,
        "create records the base commit"
    );

    age_metadata(&repo, "fresh");
    let aged = repo.mabo(&["gc", "--older-than", "14d", "--apply"]);
    assert!(aged.status.success(), "{}", text(&aged.stderr));
    let aged_text = text(&aged.stdout);
    assert!(aged_text.contains("Nothing to clean up."), "{aged_text}");
    assert!(worktree_dir(&repo, "fresh").is_dir());
    assert!(branch_listed(&repo, "fresh"));
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
    let attached = repo.mabo(&["create", "--branch", "landed"]);
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
    let attached = repo.mabo(&["create", "--branch", "landed"]);
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
        .mabo(&["create", "theirs", "--purpose", "other"])
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
    assert!(aged_text.contains("Nothing to clean up."), "{aged_text}");
    assert!(worktree_dir(&repo, "fresh").is_dir());
    assert!(worktree_dir(&repo, "theirs").is_dir());
    assert!(branch_listed(&repo, "theirs"));
}

#[test]
fn gc_views_pull_requests_by_url_and_reports_an_unconfirmed_number() {
    let repo = Repo::new();
    assert!(repo
        .create_recorded(&[
            "create",
            "alpha",
            "--pr",
            "https://github.com/acme/alpha/pull/7",
        ])
        .status
        .success());
    assert!(repo
        .create_recorded(&[
            "create",
            "beta",
            "--pr",
            "https://github.com/acme/beta/pull/7",
        ])
        .status
        .success());
    assert!(repo
        .create_recorded(&["create", "local", "--pr", "4"])
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
            &["gc", "--closed-pr", "--apply", "--json"],
        )
        .env("PATH", &path)
        .output()
        .expect("gc");
    assert!(applied.status.success(), "{}", text(&applied.stderr));
    let document = json_value(&applied);
    let candidates = document["data"]["items"].as_array().expect("candidates");
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
            repo.mabo(&["remove", "feature/last", "--json"])
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
    "$MABO_BIN" remove last --json > "$DELETE_RESULT" || exit $?
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
        json_value(&created)["data"]["workspace"]["path"]
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

    let preference = repo.mabo(&["config", "set", "workspace-root", "../custom-wt"]);
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
    let removed = repo.mabo(&["remove", "custom"]);
    assert!(removed.status.success(), "{}", text(&removed.stderr));
    assert!(!custom_path.exists());
    assert!(
        custom_path.parent().expect("custom dir").is_dir(),
        "a preference directory stays when its last workspace is gone"
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
    let names = repo.mabo(&["list", "--names", "--kind", "workspace"]);
    assert!(names.status.success(), "{}", text(&names.stderr));
    let listed = text(&names.stdout);
    assert!(listed.lines().any(|line| line == "feature"), "{listed}");
    assert!(listed.lines().any(|line| line == "legacy"), "{listed}");
    let found = repo.mabo(&["path", "legacy"]);
    assert!(found.status.success(), "{}", text(&found.stderr));
    assert!(paths_match(text(&found.stdout).trim(), &legacy));
    let refused = repo.mabo(&["remove", "legacy", "--keep-branch"]);
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
                "--repo",
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
                "remove",
                "--repo",
                link.to_str().expect("link"),
                "from-real",
            ],
        )
        .output()
        .expect("remove");
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
            "config",
            "set",
            "workspace-root",
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
        .mabo(&["config", "unset", "workspace-root"])
        .status
        .success());
    let deleted = repo.mabo(&["remove", "feature/topic"]);
    assert!(
        deleted.status.success(),
        "{}\n{}",
        text(&deleted.stdout),
        text(&deleted.stderr)
    );
    assert!(!topic.exists());
    assert!(parent.is_dir(), "parents of a recorded workspace stay");
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
    let blocked = repo.mabo(&["remove", "elsewhere"]);
    assert!(!blocked.status.success(), "{}", text(&blocked.stdout));
    assert!(
        text(&blocked.stderr).contains("uncommitted"),
        "{}",
        text(&blocked.stderr)
    );
    assert!(elsewhere.is_dir());
    fs::remove_file(elsewhere.join("dirty.txt")).expect("clean");
    let removed = repo.mabo(&["remove", "elsewhere"]);
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
    let refused = repo.mabo(&["remove", "stray"]);
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
            "config",
            "set",
            "workspace-root",
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
        .mabo(&["config", "unset", "workspace-root"])
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
            "config",
            "set",
            "workspace-root",
            ".git/maboroshi/worktrees",
        ])
        .status
        .success());
    let detached = repo.mabo(&["create", "next", "--detach"]);
    assert!(
        detached.status.success(),
        "{}\n{}",
        text(&detached.stdout),
        text(&detached.stderr)
    );
    let nested = repo.mabo(&["create", "feature/topic", "--detach"]);
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
        .mabo(&["config", "unset", "workspace-root"])
        .status
        .success());

    let next = repo.repo.join(".git/maboroshi/worktrees/next");
    let topic = repo.repo.join(".git/maboroshi/worktrees/feature/topic");
    let kept = repo.repo.join(".git/maboroshi/worktrees/kept");
    // Give gc evidence of landed work rather than treating a fresh detached
    // checkout as merged. Its stored name must survive this HEAD change.
    fs::write(next.join("landed.txt"), "reviewed\n").unwrap();
    repo.git(&["-C", next.to_str().unwrap(), "add", "landed.txt"]);
    repo.git(&["-C", next.to_str().unwrap(), "commit", "-m", "reviewed"]);
    let head = repo
        .command("git", &["rev-parse", "--short=7", "HEAD"])
        .current_dir(&next)
        .output()
        .expect("short head");
    assert!(head.status.success(), "{}", text(&head.stderr));
    let sha = text(&head.stdout);
    repo.git(&["merge", "--ff-only", &sha]);

    let names = repo.mabo(&["list", "--names", "--kind", "workspace"]);
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

    let found = repo.mabo(&["path", "next"]);
    assert!(found.status.success(), "{}", text(&found.stderr));
    assert!(paths_match(text(&found.stdout).trim(), &next));
    let found_topic = repo.mabo(&["path", "feature/topic"]);
    assert!(
        found_topic.status.success(),
        "{}",
        text(&found_topic.stderr)
    );
    assert!(paths_match(text(&found_topic.stdout).trim(), &topic));
    let found_kept = repo.mabo(&["path", "kept"]);
    assert!(found_kept.status.success(), "{}", text(&found_kept.stderr));
    assert!(paths_match(text(&found_kept.stdout).trim(), &kept));

    let ran = repo.mabo(&["exec", "next", "--", "true"]);
    assert!(ran.status.success(), "{}", text(&ran.stderr));
    let marked = repo.mabo(&["set", "feature/topic", "--purpose", "review"]);
    assert!(marked.status.success(), "{}", text(&marked.stderr));
    let listed = text(
        &repo
            .mabo(&["list", "--names", "--kind", "workspace"])
            .stdout,
    );
    assert!(listed.lines().any(|name| name == "feature/topic"));
    assert!(text(&repo.mabo(&["list"]).stdout).contains("review"));

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
    let after_stray = text(
        &repo
            .mabo(&["list", "--names", "--kind", "workspace"])
            .stdout,
    );
    assert!(
        after_stray.lines().any(|line| line == stray_sha),
        "{after_stray}"
    );
    assert!(
        !after_stray.lines().any(|line| line == "stray-detached"),
        "{after_stray}"
    );

    let deleted = repo.mabo(&["remove", "kept", "--keep-branch"]);
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
            record["createdAt"] = serde_json::json!("2000-01-01T00:00:00.000Z");
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
    let candidates = json_value(&planned)["data"]["items"]
        .as_array()
        .expect("candidates")
        .clone();
    let next_row = candidates
        .iter()
        .find(|entry| entry["name"] == "next")
        .expect("gc names the detached workspace next");
    assert_eq!(next_row["action"], "wouldRemove");
    let applied = repo.mabo(&["gc", "--older-than", "1d", "--apply", "--json"]);
    assert!(
        applied.status.success(),
        "{}\n{}",
        text(&applied.stdout),
        text(&applied.stderr)
    );
    let removed = json_value(&applied)["data"]["items"]
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
    let deleted = repo.mabo(&["remove", "a", "b", "a"]);
    assert!(
        deleted.status.success(),
        "{}\n{}",
        text(&deleted.stdout),
        text(&deleted.stderr)
    );
    let stdout = text(&deleted.stdout);
    assert_eq!(
        stdout.matches("Deleted workspace 'a'").count(),
        1,
        "{stdout}"
    );
    assert_eq!(
        stdout.matches("Deleted workspace 'b'").count(),
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
    let once = repo.mabo(&["remove", "alias", "topic"]);
    assert!(
        once.status.success(),
        "{}\n{}",
        text(&once.stdout),
        text(&once.stderr)
    );
    let once_stdout = text(&once.stdout);
    assert_eq!(
        once_stdout.matches("Deleted workspace").count(),
        1,
        "{once_stdout}"
    );
    assert!(
        once_stdout.contains("Deleted workspace 'alias'"),
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
fn list_paths_are_absolute_from_an_unrelated_directory() {
    let repo = Repo::new();
    assert!(repo.mabo(&["create", "inside"]).status.success());
    let deep = repo.home.join("a/b/c");
    fs::create_dir_all(&deep).unwrap();
    let out = repo
        .command(
            env!("CARGO_BIN_EXE_mabo"),
            &[
                "list",
                "--repo",
                repo.repo.to_str().unwrap(),
                "--kind",
                "workspace",
                "--paths",
            ],
        )
        .current_dir(&deep)
        .output()
        .unwrap();
    assert!(out.status.success(), "{}", text(&out.stderr));
    assert_eq!(
        out.stdout,
        format!("{}\n", managed(&repo, "inside").display()).as_bytes()
    );
}

#[test]
fn symlink_spelling_keeps_metadata_and_preserves_the_project_directory() {
    let repo = Repo::new();
    let created = repo.mabo(&["create", "feature", "--purpose", "alice", "--json"]);
    assert!(
        created.status.success(),
        "{}\n{}",
        text(&created.stdout),
        text(&created.stderr)
    );
    let created_json = json_value(&created);
    let real = PathBuf::from(
        created_json["data"]["workspace"]["path"]
            .as_str()
            .expect("path"),
    );
    let created_from = created_json["data"]["workspace"]["createdFrom"]
        .as_str()
        .expect("createdFrom")
        .to_string();
    let created_at = created_json["data"]["workspace"]["createdAt"]
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
    std::os::unix::fs::symlink(real.parent().expect("repo"), &via).expect("symlink");
    let spelled = via.join("feature");
    let gitdir = repo.repo.join(".git/worktrees/feature/gitdir");
    fs::write(&gitdir, format!("{}\n", spelled.join(".git").display())).expect("gitdir");

    let listed = repo.mabo(&["list", "--json", "--kind", "workspace"]);
    assert!(listed.status.success(), "{}", text(&listed.stderr));
    let entry = &json_value(&listed)["data"]["workspaces"][0];
    assert_eq!(entry["purpose"], "alice");
    assert_eq!(entry["createdFrom"], created_from);
    assert_eq!(entry["createdAt"], created_at);
    let plan = repo.mabo(&["gc", "--json"]);
    assert!(plan.status.success(), "{}", text(&plan.stderr));
    let candidate = &json_value(&plan)["data"]["items"][0];
    assert!(candidate.get("owner").is_none());
    assert_eq!(candidate["name"], "feature");
    let deleted = repo.mabo(&["remove", "feature", "--json"]);
    assert!(
        deleted.status.success(),
        "{}\n{}",
        text(&deleted.stdout),
        text(&deleted.stderr)
    );
    let removed = &json_value(&deleted)["data"]["items"][0]["workspace"];
    assert_eq!(removed["purpose"], "alice");
    assert_eq!(removed["createdFrom"], created_from);
    assert_eq!(removed["createdAt"], created_at);
    assert!(!real.exists());
    assert!(
        managed_root(&repo)
            .join(maboroshi::paths::PROJECT_MARKER)
            .is_file(),
        "last workspace deletion should keep the project directory and marker"
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
    assert_eq!(created_json["data"]["workspace"]["name"], "a");
    assert!(created_json["data"]["metadata"]["ok"]
        .as_bool()
        .unwrap_or(false));
    let json_path = created_json["data"]["workspace"]["path"]
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
    let attached = run(&["create", "--branch", "attached", "--json"]);
    assert!(
        attached.status.success(),
        "{}\n{}",
        text(&attached.stdout),
        text(&attached.stderr)
    );
    let attached_json = json_value(&attached);
    assert!(attached_json["error"].is_null(), "{attached_json}");
    assert_eq!(attached_json["data"]["workspace"]["name"], "attached");

    let executed = run(&["create", "b", "--json"]);
    assert!(
        executed.status.success(),
        "{}\n{}",
        text(&executed.stdout),
        text(&executed.stderr)
    );
    let executed_json = json_value(&executed);
    assert!(executed_json["error"].is_null(), "{executed_json}");
    assert!(run(&["exec", "b", "--", "true"]).status.success());
    assert_eq!(executed_json["data"]["workspace"]["name"], "b");
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
        .join("workspaces")
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
    let deleted = with_logical_top(&["remove", "."]);
    assert!(
        deleted.status.success(),
        "{}\n{}",
        text(&deleted.stdout),
        text(&deleted.stderr)
    );
    assert!(
        text(&deleted.stdout).contains("Deleted workspace 'feature'"),
        "{}",
        text(&deleted.stdout)
    );
    assert!(!via_real.exists());
}

#[test]
fn recheckout_through_a_symlink_keeps_intent_and_creation_details() {
    let repo = Repo::new();
    // Bare links must belong to the repository returned by the gh fixture.
    repo.git(&[
        "remote",
        "add",
        "origin",
        "https://github.com/acme/demo.git",
    ]);
    let created = repo.mabo(&["create", "issues/7", "--purpose", "keep me", "--json"]);
    assert!(
        created.status.success(),
        "{}\n{}",
        text(&created.stdout),
        text(&created.stderr)
    );
    assert!(repo
        .mabo(&["set", "issues/7", "--issue", "7"])
        .status
        .success());
    let created_json = json_value(&created);
    let real = PathBuf::from(
        created_json["data"]["workspace"]["path"]
            .as_str()
            .expect("path"),
    );
    let created_at = created_json["data"]["workspace"]["createdAt"]
        .as_str()
        .expect("createdAt")
        .to_string();
    let created_from = created_json["data"]["workspace"]["createdFrom"]
        .as_str()
        .expect("createdFrom")
        .to_string();
    let via = repo.root.join("via-project");
    std::os::unix::fs::symlink(real.parent().expect("repo"), &via).expect("symlink");
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
                "create",
                "--issue",
                "7",
                "--reuse",
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
    assert_eq!(again_json["data"]["source"]["reused"], true);
    let worktree = &again_json["data"]["workspace"];

    assert_eq!(worktree["purpose"], "keep me");
    assert_eq!(worktree["createdAt"], created_at);
    assert_eq!(worktree["createdFrom"], created_from);
    assert!(worktree.get("lastUsedAt").is_none());
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
    let help = repo.mabo(&["remove", "--help"]);
    assert!(help.status.success(), "{}", text(&help.stderr));
    let help_text = text(&help.stdout);
    assert!(help_text.contains("unpreserved"), "{help_text}");
    assert!(repo.mabo(&["create", "u"]).status.success());
    let worktree = managed(&repo, "u");
    empty_commit(&repo, &worktree, "x");
    let out = repo.mabo(&["remove", "u", "--json"]);
    assert_eq!(out.status.code(), Some(0));
    let document = json_value(&out);
    assert_eq!(
        document["data"]["items"][0]["branchKeptReason"],
        "unpreserved"
    );
    assert_eq!(document["warnings"][0]["code"], "branch_kept_unpreserved");
    assert!(!worktree.exists());
    assert!(branch_listed(&repo, "u"));
    assert!(repo.mabo(&["create", "--branch", "u"]).status.success());

    assert!(repo.mabo(&["create", "kept"]).status.success());
    let kept_dir = managed(&repo, "kept");
    empty_commit(&repo, &kept_dir, "keep");
    let kept = repo.mabo(&["remove", "kept", "--keep-branch"]);
    assert!(
        kept.status.success(),
        "{}\n{}",
        text(&kept.stdout),
        text(&kept.stderr)
    );
    assert!(text(&kept.stdout).contains("kept its branch 'kept'"));
    assert!(!kept_dir.exists());
    assert!(branch_listed(&repo, "kept"));

    let forced = repo.mabo(&[
        "remove",
        "u",
        "--discard-changes",
        "--delete-unpreserved-branch",
    ]);
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
    let removed = repo.mabo(&["remove", "shipped"]);
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
    let behind_kept = repo.mabo(&["remove", "behind", "--json"]);
    assert_eq!(behind_kept.status.code(), Some(0));
    assert_eq!(
        json_value(&behind_kept)["data"]["items"][0]["branchKeptReason"],
        "unpreserved"
    );
    assert!(!behind.exists());
    assert!(branch_listed(&repo, "behind"));

    assert!(repo.mabo(&["create", "landed"]).status.success());
    commit_in_worktree(&repo, "landed");
    repo.git(&["merge", "--ff-only", "landed"]);
    repo.git(&["push", "origin", "main"]);
    let landed = repo.mabo(&["remove", "landed"]);
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
    let out = repo.mabo(&["remove", "mystery", "--json"]);
    assert_eq!(out.status.code(), Some(0));
    assert_eq!(
        json_value(&out)["data"]["items"][0]["branchKeptReason"],
        "unpreserved"
    );
    assert!(branch_listed(&repo, "mystery"));
    assert!(!managed(&repo, "mystery").exists());
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

    let deleted = repo.mabo(&["remove", "feature"]);
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

    let plan = repo.mabo(&["gc"]);
    assert!(plan.status.success(), "{}", text(&plan.stderr));
    let planned = text(&plan.stdout);
    assert!(!planned.contains("would remove feature"), "{planned}");
    assert!(worktree_dir(&repo, "feature").is_dir());
    assert!(branch_listed(&repo, "feature"));
    let removed = repo.mabo(&["remove", "feature", "--json"]);
    assert_eq!(removed.status.code(), Some(0));
    assert_eq!(
        json_value(&removed)["data"]["items"][0]["branchKeptReason"],
        "unpreserved"
    );
    assert!(!worktree_dir(&repo, "feature").exists());
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

    let deleted = repo.mabo(&["remove", "feature"]);
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
    let path = managed(&repo, "inside");
    fs::create_dir(path.join("sub")).unwrap();
    let out = repo
        .command(env!("CARGO_BIN_EXE_mabo"), &["remove", ".", "--json"])
        .current_dir(path.join("sub"))
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(0), "{}", text(&out.stdout));
    assert!(!path.exists());
    assert!(!branch_listed(&repo, "inside"));
}

#[test]
fn delete_and_gc_keep_a_branch_shadowed_by_a_tag() {
    let repo = Repo::new();
    assert!(repo.mabo(&["create", "v1"]).status.success());
    empty_commit(&repo, &managed(&repo, "v1"), "only on the branch");
    let commit = text(
        &repo
            .command("git", &["rev-parse", "refs/heads/v1"])
            .output()
            .unwrap()
            .stdout,
    );
    repo.git(&["tag", "v1", "main"]);
    let gc = repo.mabo(&["gc", "--merged", "--apply", "--json"]);
    assert_eq!(json_value(&gc)["data"]["items"], serde_json::json!([]));
    assert!(managed(&repo, "v1").exists());
    let out = repo.mabo(&["remove", "v1", "--json"]);
    assert_eq!(out.status.code(), Some(0));
    assert_eq!(
        json_value(&out)["data"]["items"][0]["branchKeptReason"],
        "unpreserved"
    );
    assert_eq!(
        text(
            &repo
                .command("git", &["rev-parse", "refs/heads/v1"])
                .output()
                .unwrap()
                .stdout
        ),
        commit
    );
}

#[test]
fn delete_refuses_a_detached_worktree_until_force() {
    let repo = Repo::new();
    assert!(repo.mabo(&["create", "dt", "--detach"]).status.success());
    let path = managed(&repo, "dt");
    empty_commit(&repo, &path, "unpreserved detached commit");
    for flags in [vec![], vec!["--keep-branch"], vec!["--discard-changes"]] {
        let mut args = vec!["remove", "dt", "--json"];
        args.extend(flags);
        let out = repo.mabo(&args);
        assert_eq!(out.status.code(), Some(4));
        assert_eq!(json_value(&out)["error"]["code"], "unpreserved");
        assert!(path.exists());
    }
    let out = repo.mabo(&["remove", "dt", "--delete-unpreserved-branch", "--json"]);
    assert_eq!(out.status.code(), Some(0));
    assert_eq!(json_value(&out)["data"]["items"][0]["branchDeleted"], false);
    assert!(!path.exists());
}

#[test]
fn delete_checks_every_name_before_removing_any() {
    let repo = Repo::new();
    let marker = repo.root.join("hook-ran");
    fs::write(
        repo.repo.join(".mabo.toml"),
        format!("[hooks]\npre-remove = [\"touch {}\"]\n", marker.display()),
    )
    .unwrap();
    for name in ["a", "b"] {
        assert!(repo.mabo(&["create", name]).status.success());
    }
    fs::write(managed(&repo, "b/dirty"), "changes").unwrap();
    let out = repo.mabo(&["remove", "a", "b", "--json"]);
    assert_eq!(out.status.code(), Some(4));
    let doc = json_value(&out);
    assert_eq!(doc["data"]["items"].as_array().unwrap().len(), 2);
    assert_eq!(doc["data"]["items"][1]["error"]["code"], "dirty");
    assert!(managed(&repo, "a").is_dir());
    assert!(managed(&repo, "b").is_dir());
    assert!(!marker.exists());
    let out = repo.mabo(&["remove", "a", "bad..name", "--json"]);
    assert_eq!(out.status.code(), Some(2));
    assert!(managed(&repo, "a").is_dir());
    assert!(!marker.exists());
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
        stdout.contains("skip here [merged] current workspace"),
        "{stdout}"
    );
    assert!(stdout.contains("removed gone [merged]"), "{stdout}");
    assert!(
        moved.join("here").is_dir(),
        "gc removed the workspace that contains the current directory"
    );
    assert!(
        parent.join("here").is_dir(),
        "gc removed the workspace reached through the symlink"
    );
    assert!(moved.is_dir(), "gc removed the current workspace's parent");
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
    let marked = repo.mabo(&["set", "zz", "--purpose", "a"]);
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
    let found = repo.mabo(&["path", "dup"]);
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
    let outside_where = repo.mabo(&["path", "zz"]);
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
    let names = text(
        &repo
            .mabo(&["list", "--names", "--kind", "workspace"])
            .stdout,
    );
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
    let detached = repo.mabo(&["set", &sha, "--purpose", "b"]);
    assert!(
        detached.status.success(),
        "{}\n{}",
        text(&detached.stdout),
        text(&detached.stderr)
    );
    let found_loose = repo.mabo(&["path", "loose"]);
    assert!(
        found_loose.status.success(),
        "{}",
        text(&found_loose.stderr)
    );
    assert!(paths_match(
        text(&found_loose.stdout).trim(),
        &managed(&repo, "loose")
    ));
    let found_sha = repo.mabo(&["path", &sha]);
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
    let names_after = text(
        &repo
            .mabo(&["list", "--names", "--kind", "workspace"])
            .stdout,
    );
    assert!(names_after.lines().any(|line| line == sha), "{names_after}");
    assert!(
        !names_after.lines().any(|line| line == later_sha),
        "{names_after}"
    );
    let still = repo.mabo(&["path", &sha]);
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
        let marked = repo.mabo(&["set", "shared", "--purpose", "a"]);
        assert!(marked.status.success(), "{}", text(&marked.stderr));
        let found = repo.mabo(&["path", "shared"]);
        assert!(found.status.success(), "{}", text(&found.stderr));
        assert!(paths_match(text(&found.stdout).trim(), &outside));
        let listed = repo.mabo(&["list", "--json", "--kind", "workspace"]);
        assert!(listed.status.success(), "{}", text(&listed.stderr));
        let document: serde_json::Value = serde_json::from_slice(&listed.stdout).expect("json");
        let worktrees = document["data"]["workspaces"]
            .as_array()
            .expect("worktrees");
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
    let marked = repo.mabo(&["set", "zz", "--purpose", "a"]);
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
    let found = repo.mabo(&["path", "dup"]);
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
    let names = text(
        &repo
            .mabo(&["list", "--names", "--kind", "workspace"])
            .stdout,
    );
    assert!(names.lines().any(|line| line == "next"), "{names}");
    assert!(!names.lines().any(|line| line == sha), "{names}");
    // Legacy records have no creation evidence. Exercise gc's name display via
    // orphan detection, retaining the checkout for the remaining selector tests.
    let parked = repo.root.join("parked-next");
    fs::rename(&next, &parked).unwrap();
    let plan = repo.mabo(&["gc", "--older-than", "14d"]);
    assert!(plan.status.success(), "{}", text(&plan.stderr));
    let planned = text(&plan.stdout);
    assert!(planned.contains("would remove next"), "{planned}");
    assert!(!planned.contains(&sha), "{planned}");
    fs::rename(&parked, &next).unwrap();
    let found = repo.mabo(&["path", "next"]);
    assert!(found.status.success(), "{}", text(&found.stderr));
    assert!(paths_match(text(&found.stdout).trim(), &next));
    let ran = repo.mabo(&["exec", "next", "--", "true"]);
    assert!(ran.status.success(), "{}", text(&ran.stderr));
    let marked = repo.mabo(&["set", "next", "--purpose", "ada"]);
    assert!(marked.status.success(), "{}", text(&marked.stderr));
    assert!(
        text(&marked.stdout).contains("next"),
        "{}",
        text(&marked.stdout)
    );
    let stored = records::read_to_string(&meta).expect("after set");
    assert!(!stored.contains("\"name\""), "{stored}");
    let still = repo.mabo(&["path", "next"]);
    assert!(still.status.success(), "{}", text(&still.stderr));
    assert!(paths_match(text(&still.stdout).trim(), &next));
    let deleted = repo.mabo(&["remove", "next"]);
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
        "Branch 'feature/teammate' already exists as a remote-tracking branch (origin). Run `mabo create --branch feature/teammate`."
    );
    let remote_json = repo.mabo(&["create", "feature/teammate", "--json"]);
    assert_eq!(remote_json.status.code(), Some(4));
    assert_eq!(json_value(&remote_json)["error"]["code"], "exists_remote");
    assert!(local_branch(&repo, "feature/teammate").is_empty());

    let attached = repo.mabo(&["create", "--branch", "feature/teammate"]);
    assert!(attached.status.success(), "{}", text(&attached.stderr));
    assert!(text(&attached.stdout).contains("Created workspace 'feature/teammate'"));
    assert_eq!(
        upstream_name(&repo, "feature/teammate"),
        "origin/feature/teammate"
    );
    assert!(managed(&repo, "feature/teammate")
        .join("README.md")
        .is_file());

    for command in ["create", "create --branch"] {
        let exists_json = repo.mabo(
            &command
                .split_whitespace()
                .chain(["feature/teammate", "--json"])
                .collect::<Vec<_>>(),
        );
        assert_eq!(exists_json.status.code(), Some(4));
        assert_eq!(json_value(&exists_json)["error"]["code"], "exists");
    }
    let again = repo.mabo(&["create", "--branch", "feature/teammate"]);
    assert_eq!(again.status.code(), Some(4));
    assert_eq!(
        text(&again.stderr),
        "Workspace 'feature/teammate' already exists"
    );
    let shadowed = repo.mabo(&["create", "feature/teammate"]);
    assert_eq!(shadowed.status.code(), Some(4));
    assert_eq!(
        text(&shadowed.stderr),
        "Workspace 'feature/teammate' already exists"
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
            "Branch 'feature/teammate' already exists as a remote-tracking branch (origin, upstream). Run `mabo create --branch origin/feature/teammate` or `mabo create --branch upstream/feature/teammate`."
        );
        assert!(local_branch(&repo, "feature/teammate").is_empty());
        assert!(!managed(&repo, "feature/teammate").exists());

        let qualified = format!("{remote}/feature/teammate");
        let command = message
            .split('`')
            .find(|command| *command == format!("mabo create --branch {qualified}"))
            .expect("suggested attach command");
        let args: Vec<_> = command.split_whitespace().skip(1).collect();
        let attached = repo.mabo(&args);
        assert!(attached.status.success(), "{}", text(&attached.stderr));
        assert!(text(&attached.stdout).contains("Created workspace 'feature/teammate'"));
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
    let attached = repo.mabo(&["create", "--branch", "origin/feature/teammate"]);
    assert!(attached.status.success(), "{}", text(&attached.stderr));
    assert!(text(&attached.stdout).contains("Created workspace 'feature/teammate'"));
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

    let ambiguous = repo.mabo(&["create", "--branch", "feature"]);
    assert_eq!(ambiguous.status.code(), Some(2));
    assert!(text(&ambiguous.stderr).contains("origin, user@host"));

    let attached = repo.mabo(&["create", "--branch", "user@host/feature"]);
    assert!(attached.status.success(), "{}", text(&attached.stderr));
    assert!(text(&attached.stdout).contains("Created workspace 'feature'"));
    assert_eq!(upstream_name(&repo, "feature"), "user@host/feature");
    assert!(managed(&repo, "feature").join("README.md").is_file());
    assert!(local_branch(&repo, "user@host/feature").is_empty());

    let invalid = repo.mabo(&["create", "--branch", "invalid@name"]);
    assert_eq!(invalid.status.code(), Some(2), "{}", text(&invalid.stderr));
    assert!(text(&invalid.stderr).contains("Workspace name can only contain"));
}

#[test]
fn attach_lists_every_remote_that_has_the_name() {
    let repo = Repo::new();
    repo.git(&["config", "branch.autoSetupMerge", "false"]);
    publish_tracking_branch(&repo, "origin", "solo");
    publish_tracking_branch(&repo, "upstream", "solo");
    let attached = repo.mabo(&["create", "--branch", "solo"]);
    assert_eq!(
        attached.status.code(),
        Some(2),
        "{}",
        text(&attached.stderr)
    );
    assert_eq!(
        text(&attached.stderr),
        "Branch 'solo' exists on more than one remote (origin, upstream). Run `mabo create --branch <remote>/solo`."
    );
    assert!(local_branch(&repo, "solo").is_empty());
    assert!(!managed(&repo, "solo").exists());

    let chosen = repo.mabo(&["create", "--branch", "upstream/solo"]);
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
    let attached = repo.mabo(&["create", "--branch", "feature/teammate"]);
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
    assert_eq!(created.status.code(), Some(4), "{}", text(&created.stderr));
    assert!(text(&created.stderr).contains("Branch 'lonely' already exists"));
    assert!(text(&created.stderr).contains("create --branch"));
}

#[test]
fn help_describes_remote_aware_attach_and_create() {
    let repo = Repo::new();
    let attach_help = repo.mabo(&["create", "--help"]);
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
    assert!(attach.contains("create --branch exits 2 and lists those remotes"));
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
    assert!(create.contains("mabo create --branch <name>"));
    assert!(create.contains("refused with exit 4"));
    let meta = repo.mabo(&["set", "--help"]);
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
    assert!(text(&created.stdout).contains("Created workspace 'calm-comet'"));
    assert!(local_branch(&repo, "bold-badger").is_empty());
    assert!(local_branch(&repo, "calm-comet").contains("calm-comet"));
    assert!(managed(&repo, "calm-comet").is_dir());
}

#[cfg(debug_assertions)]
#[test]
fn review4_nameless_create_skips_recorded_workspace_names() {
    assert_generated_name_skips_adopted_alias(false);
}

#[cfg(debug_assertions)]
#[test]
fn review4_nameless_detach_skips_recorded_workspace_names() {
    assert_generated_name_skips_adopted_alias(true);
}

#[cfg(debug_assertions)]
fn assert_generated_name_skips_adopted_alias(detach: bool) {
    for (inside_root, state) in [
        (true, "live"),
        (false, "live"),
        (false, "prunable"),
        (false, "orphaned"),
    ] {
        let repo = Repo::new();
        let path = if inside_root {
            let seed = repo.mabo(&["create", "seed", "--json"]);
            assert!(seed.status.success(), "{}", text(&seed.stdout));
            managed(&repo, "directory-name")
        } else {
            repo.root.join("outside")
        };
        repo.git(&[
            "worktree",
            "add",
            "-b",
            "topic",
            path.to_str().unwrap(),
            "main",
        ]);
        let adopted = repo.mabo(&[
            "adopt",
            path.to_str().unwrap(),
            "--name",
            "calm-comet",
            "--json",
        ]);
        assert!(adopted.status.success(), "{}", text(&adopted.stdout));
        match state {
            "prunable" => fs::remove_dir_all(&path).expect("remove checkout"),
            "orphaned" => repo.git(&["worktree", "remove", path.to_str().unwrap()]),
            _ => {}
        }
        let records_before = maboroshi::metadata::load_strict(&repo.repo).expect("records");
        let args = if detach {
            vec!["create", "--detach", "--json"]
        } else {
            vec!["create", "--json"]
        };
        let created = repo
            .command(env!("CARGO_BIN_EXE_mabo"), &args)
            .env("MABO_NAME_CANDIDATES", "calm-comet,bold-badger")
            .output()
            .expect("mabo");
        assert!(
            created.status.success(),
            "inside_root={inside_root}, state={state}: {}\n{}",
            text(&created.stdout),
            text(&created.stderr)
        );
        let doc = assert_envelope(&created, "create");
        assert_eq!(doc["data"]["workspace"]["name"], "bold-badger");
        assert_eq!(doc["data"]["workspace"]["detached"], detach);
        assert_eq!(
            doc["data"]["source"]["kind"],
            if detach { "detach" } else { "new" }
        );
        assert!(managed(&repo, "bold-badger").is_dir());
        assert!(!managed(&repo, "calm-comet").exists());
        assert!(local_branch(&repo, "calm-comet").is_empty());
        let records_after = maboroshi::metadata::load_strict(&repo.repo).expect("records");
        for (path, record) in records_before {
            assert_eq!(records_after.get(&path), Some(&record));
        }
    }
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
    assert!(managed(repo, branch).is_dir(), "{branch} workspace missing");
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
        "[hooks]\npre-remove = [\"exit 99\"]\n",
    )
    .expect("hooks");
    let listed = repo.mabo(&["list"]);
    assert!(listed.status.success(), "{}", text(&listed.stderr));
    assert!(text(&listed.stdout)
        .lines()
        .any(|line| line.trim_start().starts_with("gone  ") && line.ends_with("[orphaned]")));
    let listed = repo.mabo(&["list", "--json"]);
    assert!(listed.status.success(), "{}", text(&listed.stderr));
    let document = json_value(&listed);
    let entries = document["data"]["workspaces"]
        .as_array()
        .expect("worktrees");
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
            .find(|item| item["kind"] == "primary")
            .expect("default")["orphaned"],
        false
    );
    for command in ["path", "exec"] {
        let args = if command == "exec" {
            vec![command, "gone", "--", "pwd"]
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
    let deleted = repo.mabo(&["remove", "gone"]);
    assert_eq!(deleted.status.code(), Some(0), "{}", text(&deleted.stderr));
    assert!(text(&deleted.stdout).contains("already gone; removed only the stale record"));
    assert!(branch_listed(&repo, "gone"));
    let deleted = repo.mabo(&["remove", "json-gone", "--json"]);
    assert_eq!(deleted.status.code(), Some(0), "{}", text(&deleted.stderr));
    let document = json_value(&deleted);
    assert_eq!(document["data"]["items"][0]["workspace"]["orphaned"], true);
    assert_eq!(document["data"]["items"][0]["branchDeleted"], false);
    assert!(branch_listed(&repo, "json-gone"));
    let records: serde_json::Value = serde_json::from_slice(
        &records::read(repo.repo.join(".git/maboroshi/workspaces")).expect("records"),
    )
    .expect("json");
    assert_eq!(records["worktrees"], serde_json::json!([]));
    assert_eq!(repo.mabo(&["remove", "gone"]).status.code(), Some(3));
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
    let deleted = repo.mabo(&["remove", "shared"]);
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
    let deleted = repo.mabo(&["remove", "shared"]);
    assert!(!deleted.status.success());
    assert!(text(&deleted.stderr).contains("More than one workspace is named"));
    assert_eq!(records::read(records_path).expect("records"), original);
}

fn assert_workspace_vocabulary(value: &serde_json::Value) {
    match value {
        serde_json::Value::Object(object) => {
            assert!(
                !object.contains_key("worktree"),
                "legacy result key: {value}"
            );
            assert!(
                !object.contains_key("worktrees"),
                "legacy result key: {value}"
            );
            if object.contains_key("dirty") && object.contains_key("detached") {
                assert!(
                    matches!(value["kind"].as_str(), Some("primary" | "workspace")),
                    "{value}"
                );
                assert!(
                    !object.contains_key("default"),
                    "legacy workspace kind: {value}"
                );
            }
            for child in object.values() {
                assert_workspace_vocabulary(child);
            }
        }
        serde_json::Value::Array(items) => {
            for child in items {
                assert_workspace_vocabulary(child);
            }
        }
        _ => {}
    }
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
    assert_workspace_vocabulary(&value["data"]);
    assert_eq!(value["schema"], 2);
    assert_eq!(value["command"], command);
    assert_eq!(value["ok"], output.status.success());
    assert!(value["data"].is_object() || value["data"].is_null());
    if command != "--version" {
        assert!(value["data"].get("version").is_none());
    }
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
        assert!(out.stdout.is_empty());
        assert!(text(&out.stderr).contains("USAGE"));
    }
    for args in [vec!["--help"], vec!["list", "--help"]] {
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
        ("repo add", "--names"),
        ("repo add", "--paths"),
        ("frobnicate", "--names"),
        ("frobnicate", "--paths"),
        ("list", "--names=value"),
        ("repo list", "--paths=value"),
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

    assert!(repo.mabo(&["repo", "add"]).status.success());
    for flag in ["--names", "--paths"] {
        let out = repo
            .command(env!("CARGO_BIN_EXE_mabo"), &["repo", "list", flag])
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
        "create",
        "list",
        "show",
        "remove",
        "sync",
        "gc",
        "trust",
        "trust remove",
        "set",
        "clone",
        "repo add",
        "repo list",
        "repo forget",
        "create",
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
    assert!(text(&out.stdout).contains("main  main"));
    let out = run(&["list", "--names"], "json");
    assert!(out.status.success());
    assert_eq!(text(&out.stdout), "main");
    assert_envelope(&run(&["list", "--output=json"], "text"), "list");
    for args in [&["list"][..], &["list", "--output", "text"][..]] {
        assert_eq!(run(args, "invalid").status.code(), Some(2));
    }
    assert_eq!(run(&["--version"], "invalid").status.code(), Some(2));
    assert!(run(&["list", "--help"], "invalid").status.success());
    for flag in [vec!["--json"], vec!["--output", "json"]] {
        let mut args = vec!["exec"];
        args.extend(flag);
        args.extend(["main", "true"]);
        assert_eq!(run(&args, "json").status.code(), Some(2));
    }
    let out = run(&["exec", "main", "--", "printf", "%s", "--json"], "invalid");
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
        "[hooks]\nsetup = [\"if read ignored; then exit 94; fi; echo HOOK_EOF\"]\n",
    )
    .expect("hook");
    let mut child = repo
        .command(env!("CARGO_BIN_EXE_mabo"), &["create", "stdin", "--json"])
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
        (&["create", "topic", "--json"], "create", "workspace"),
        (
            &["create", "--branch", "existing", "--json"],
            "create",
            "workspace",
        ),
        (&["list", "--json"], "list", "workspaces"),
        (&["show", "topic", "--json"], "show", "workspace"),
        (
            &["set", "topic", "--purpose", "contract test", "--json"],
            "set",
            "workspace",
        ),
        (&["sync", "--json"], "sync", "workspaces"),
        (&["gc", "--json"], "gc", "items"),
        (&["trust", "add", "--json"], "trust add", "trustedAt"),
        (&["trust", "remove", "--json"], "trust remove", "removed"),
        (&["repo", "add", "--json"], "repo add", "repo"),
        (&["repo", "list", "--json"], "repo list", "repos"),
        (&["repo", "forget", "repo", "--json"], "repo forget", "repo"),
        (&["remove", "topic", "--json"], "remove", "items"),
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
            &["create", "--pr", "7", "--reuse", "--json"],
        )
        .env("PATH", &gh_path)
        .output()
        .expect("checkout");
    let value = assert_envelope(&out, "create");
    assert!(out.status.success(), "{value}");
    assert!(value["data"]["workspace"].is_object());
    let out = repo
        .command(
            env!("CARGO_BIN_EXE_mabo"),
            &["create", "--pr", "7", "--reuse", "--json"],
        )
        .env("PATH", &gh_path)
        .output()
        .expect("gh checkout");
    let value = assert_envelope(&out, "create");
    assert!(out.status.success(), "{value}");
    assert_eq!(value["data"]["workspace"]["kind"], "workspace");
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
        .command(env!("CARGO_BIN_EXE_mabo"), &["exec", "main", "--", "gh"])
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
    let out = repo.mabo(&["exec", "main", "--", "sh", "-c", "kill -TERM $$"]);
    assert_eq!(out.status.code(), Some(143));
}

#[test]
fn delete_partial_results_and_late_common_option_errors_keep_the_contract() {
    let repo = Repo::new();
    assert!(repo.mabo(&["create", "first"]).status.success());
    assert!(repo.mabo(&["create", "second"]).status.success());
    fs::write(
        repo.repo.join(".mabo.toml"),
        "[hooks]\npre-remove = [\"if [ \\\"$MABO_WORKSPACE\\\" = second ]; then exit 42; fi\"]\n",
    )
    .expect("hook");
    let out = repo.mabo(&["remove", "first", "second", "--json"]);
    assert_eq!(out.status.code(), Some(6));
    let value = assert_envelope(&out, "remove");
    assert_eq!(value["error"]["code"], "partial");
    assert_eq!(value["data"]["items"].as_array().expect("items").len(), 2);
    assert!(!managed(&repo, "first").exists());
    assert!(managed(&repo, "second").exists());
    let out = repo.mabo(&["remove", "second", "--json"]);
    assert_eq!(out.status.code(), Some(1));
    assert_eq!(assert_envelope(&out, "remove")["error"]["code"], "failed");
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
    assert_envelope(&repo.mabo(&["--json", "repo", "list"]), "repo list");
    let out = repo.mabo(&["--no-input", "exec", "main", "--", "printf", "%s", "--json"]);
    assert!(out.status.success());
    assert_eq!(text(&out.stdout), "--json");
}

#[test]
fn unsupported_exec_options_do_not_hide_json_usage_requests() {
    let repo = Repo::new();
    for command in ["list", "repo list", "frobnicate", "repo bogus"] {
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
            let key = if command == "repo bogus" {
                "repo"
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
        ("create --branch", "--bogus", "create"),
        ("list", "--bogus", "list"),
        ("show", "--bogus", "show"),
        ("remove", "--bogus", "remove"),
        ("sync", "--bogus", "sync"),
        ("gc", "--bogus", "gc"),
        ("trust", "--bogus", "trust"),
        ("repo", "--bogus", "repo"),
        ("clone", "--bogus", "clone"),
        ("set", "--bogus", "set"),
        ("repo add", "--bogus", "repo add"),
        ("repo list", "--bogus", "repo list"),
        ("repo forget", "--bogus", "repo forget"),
        ("create", "--bogus", "create"),
        ("create", "--bogus", "create"),
        ("repo", "bogus", "repo"),
        ("meta", "bogus", "meta"),
        ("config", "bogus", "config"),
        ("adopt", "--bogus", "adopt"),
        ("forget", "--bogus", "forget"),
        ("repo", "--bogus", "repo"),
        ("meta", "--bogus", "meta"),
        ("config", "--bogus", "config"),
        ("adopt", "--bogus", "adopt"),
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
        vec!["list", "--repo", "--json", "--output", "text"],
        vec!["list", "--json", "--output", "text", "--repo"],
        vec!["list", "--output=text", "--repo", "--json"],
        vec!["list", "--repo", "--json", "--output", "text"],
        vec!["list", "--json", "--output=text", "--repo"],
        vec!["repo", "bogus", "--json", "--output", "text"],
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
        "create",
        "repo list",
        "set",
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
        ("list", "--repo"),
        ("create", "--repo"),
        ("adopt", "--repo"),
        ("set", "--repo"),
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
        ("list", "--repo"),
        ("create", "--base"),
        ("create", "--branch"),
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
        vec!["repo", "list", "--bogus", "--json"],
        vec!["gc", "--closed-pr", "--json", "--bogus"], // --pr is a flag here.
    ] {
        let out = repo.mabo(&args);
        assert_eq!(out.status.code(), Some(2), "{args:?}");
        assert_eq!(json_value(&out)["error"]["code"], "usage");
    }
    for command in ["create", "attach"] {
        for exec in ["--exec", "-x"] {
            let out = repo.mabo(&[command, "--bogus", exec, "ignored", "--json", "--help"]);
            assert_eq!(out.status.code(), Some(2));
            assert_eq!(assert_envelope(&out, command)["error"]["code"], "usage");
        }
        for exec in ["--exec=ignored", "-xignored"] {
            let out = repo.mabo(&[command, "--bogus", exec, "--json"]);
            assert_eq!(out.status.code(), Some(2));
            assert_eq!(assert_envelope(&out, command)["error"]["code"], "usage");
        }
    }
    let out = repo.mabo(&["list", "--repo", "alice", "--", "--json", "--help"]);
    assert_eq!(out.status.code(), Some(2));
    assert!(out.stdout.is_empty());
    assert!(text(&out.stderr).contains("Unexpected argument"));
    let out = repo.mabo(&["create", "--purpose=--help", "--output=text"]);
    assert_eq!(out.status.code(), Some(2));
    assert!(out.stdout.is_empty());
    assert!(text(&out.stderr).contains("looks like an option"));
}

#[test]
fn json_dirty_refusal_keeps_its_specific_cause() {
    let repo = Repo::new();
    assert!(repo.mabo(&["create", "dirty"]).status.success());
    fs::write(managed(&repo, "dirty/local.txt"), "uncommitted").unwrap();
    let refused = repo.mabo(&["remove", "dirty", "--json"]);
    assert_eq!(refused.status.code(), Some(4));
    assert_eq!(json_value(&refused)["error"]["code"], "dirty");
    assert!(managed(&repo, "dirty").is_dir());
}

#[cfg(debug_assertions)]
#[test]
fn create_and_attach_setup_failures_report_text_and_json_without_duplicate_causes() {
    for command in ["create", "create --branch"] {
        for json in [false, true] {
            for cause in ["metadata", "copyFiles", "postCreate"] {
                let repo = Repo::new();
                if command == "create --branch" {
                    repo.git(&["branch", "topic"]);
                }
                if cause == "copyFiles" {
                    std::os::unix::fs::symlink("elsewhere", repo.repo.join(".worktreeinclude"))
                        .unwrap();
                }
                if cause == "postCreate" {
                    fs::write(
                        repo.repo.join(".mabo.toml"),
                        "[hooks]\nsetup = [\"exit 23\"]\n",
                    )
                    .unwrap();
                }
                let mut args = command
                    .split_whitespace()
                    .chain(["topic"])
                    .collect::<Vec<_>>();
                if json {
                    args.push("--json");
                }
                if cause == "exec" {
                    args.extend(["--exec", "exit 24"]);
                }
                let mut process = repo.command(env!("CARGO_BIN_EXE_mabo"), &args);
                if cause == "metadata" {
                    process.env("MABO_TEST_FAIL_METADATA_SAVE", "1");
                }
                let output = process.output().unwrap();
                let stderr = text(&output.stderr);
                assert_eq!(output.status.code(), Some(6), "{args:?}: {stderr}");
                assert!(managed(&repo, "topic/README.md").is_file());
                let diagnostic = match cause {
                    "metadata" => "Warning: Failed to save workspace metadata: injected failure",
                    "copyFiles" => "Warning: Failed to copy some files:",
                    "postCreate" => "Warning: Setup command",
                    _ => "failed with exit code 24",
                };
                if json {
                    let document = json_value(&output);
                    assert_eq!(document["error"]["code"], "partial");
                    if cause == "copyFiles" {
                        assert!(document["data"]["copy"]["error"].is_string());
                    } else {
                        assert_eq!(
                            document["data"][if cause == "postCreate" {
                                "setup"
                            } else {
                                cause
                            }]["ok"],
                            false
                        );
                    }
                    if cause == "exec" {
                        assert!(!stderr.contains(diagnostic), "{stderr}");
                    } else {
                        assert_eq!(stderr.matches(diagnostic).count(), 1, "{stderr}");
                    }
                } else {
                    assert_eq!(stderr.matches(diagnostic).count(), 1, "{stderr}");
                    let summary = if cause == "exec" {
                        diagnostic
                    } else {
                        "Workspace created but setup did not complete"
                    };
                    assert_eq!(stderr.matches(summary).count(), 1, "{stderr}");
                }
            }
        }
    }
}

#[test]
fn every_command_help_uses_workspace_vocabulary() {
    let repo = Repo::new();
    let data: serde_json::Value = serde_json::from_str(include_str!("../help-data.json")).unwrap();
    let mut commands = vec![String::new()];
    commands.extend(data["helps"].as_object().unwrap().keys().cloned());
    for command in commands {
        let mut args: Vec<_> = command.split_whitespace().collect();
        args.push("--help");
        let out = repo.mabo(&args);
        assert!(out.status.success(), "{command}: {}", text(&out.stderr));
        // These are retained interface and file names, not entity vocabulary.
        // No Git diagnostic wording is currently needed in help.
        let help = text(&out.stdout)
            .to_ascii_lowercase()
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
            .replace("worktrees-directory", "")
            .replace("worktrees.json", "")
            .replace(".worktreeinclude", "")
            .replace("git worktree", "git checkout")
            .replace("git worktrees", "git checkouts")
            .replace("linked worktree", "linked checkout");
        assert!(!help.contains("worktree"), "{command}: {help}");
    }
}

fn workspace_env_script(output: &Path) -> String {
    format!(
        "printf '%s\\n' \"$MABO\" \"$MABO_WORKSPACE\" \"$MABO_WORKSPACE_ID\" \"$MABO_WORKSPACE_PATH\" \"$MABO_REPO_PATH\" \"${{MABO_NAME+present}}\" \"${{MABO_PATH+present}}\" \"${{MABO_ROOT_PATH+present}}\" > '{}'",
        output.display()
    )
}

fn assert_workspace_env(output: &Path, repo: &Repo, name: &str, path: &Path, id: &str) {
    let values = fs::read_to_string(output).expect("environment capture");
    let expected = format!(
        "1\n{name}\n{id}\n{}\n{}\n\n\n\n",
        path.display(),
        repo.repo.display()
    );
    assert_eq!(values, expected);
}

#[test]
fn hooks_and_exec_export_workspace_identity_and_remove_inherited_legacy_variables() {
    let repo = Repo::new();
    assert!(repo.mabo(&["create", "source"]).status.success());
    let source = managed(&repo, "source");
    let post = repo.root.join("post-env");
    let pre = repo.root.join("pre-env");
    let exec = repo.root.join("exec-env");
    let hook_config = format!(
        "[hooks]\nsetup = [{}]\npre-remove = [{}]\n",
        serde_json::to_string(&workspace_env_script(&post)).unwrap(),
        serde_json::to_string(&workspace_env_script(&pre)).unwrap()
    );
    fs::write(source.join(".mabo.toml"), hook_config).unwrap();
    // A linked source must determine the hook config, while MABO_REPO_PATH
    // always identifies the primary checkout. All inherited context is stale.
    let run = |args: &[&str]| {
        repo.command(env!("CARGO_BIN_EXE_mabo"), args)
            .current_dir(&source)
            .env("MABO", "stale")
            .env("MABO_WORKSPACE", "stale")
            .env("MABO_WORKSPACE_ID", "stale")
            .env("MABO_WORKSPACE_PATH", "/stale")
            .env("MABO_REPO_PATH", "/stale")
            .env("MABO_NAME", "legacy")
            .env("MABO_PATH", "/legacy")
            .env("MABO_ROOT_PATH", "/legacy")
            .output()
            .unwrap()
    };
    let script = workspace_env_script(&exec);
    let out = run(&["create", "feature/env-contract", "--json"]);
    let value = assert_envelope(&out, "create");
    assert!(out.status.success(), "{value}");
    let id = value["data"]["workspace"]["id"].as_str().unwrap();
    assert!(id.starts_with("ws_"));
    let path = managed(&repo, "feature/env-contract");
    assert_workspace_env(&post, &repo, "feature/env-contract", &path, id);

    let out = run(&["exec", "feature/env-contract", "--", "sh", "-c", &script]);
    assert!(out.status.success(), "{}", text(&out.stderr));
    assert_workspace_env(&exec, &repo, "feature/env-contract", &path, id);
    let out = run(&["remove", "feature/env-contract", "--json"]);
    assert!(out.status.success(), "{}", text(&out.stdout));
    assert_workspace_env(&pre, &repo, "feature/env-contract", &path, id);
    assert!(!path.exists());
    // Unrecorded workspaces export an empty ID, including the primary checkout.
    let out = run(&["exec", "main", "--", "sh", "-c", &script]);
    assert!(out.status.success(), "{}", text(&out.stderr));
    assert_workspace_env(&exec, &repo, "main", &repo.repo, "");
}

#[test]
fn legacy_worktrees_directories_remain_usable_without_moving_workspaces() {
    for old_layout in ["xdg", "git"] {
        let repo = Repo::new();
        let common = maboroshi::git::canonical_common_dir(&repo.repo).unwrap();
        let project = maboroshi::paths::project_directory_name("repo", &common);
        let old_root = if old_layout == "xdg" {
            repo.root.join("xdg/maboroshi/worktrees").join(project)
        } else {
            repo.repo.join(".git/maboroshi/worktrees")
        };
        let set = repo.mabo(&[
            "config",
            "set",
            "workspace-root",
            old_root.to_str().unwrap(),
        ]);
        assert!(set.status.success(), "{}", text(&set.stderr));
        for name in ["feature/delete", "feature/gc"] {
            let out = repo.mabo(&["create", name, "--base", "main", "--json"]);
            let doc = assert_envelope(&out, "create");
            assert!(out.status.success(), "{doc}");
            assert_eq!(
                doc["data"]["workspace"]["path"],
                old_root.join(name).to_str().unwrap()
            );
        }
        assert!(repo
            .mabo(&["config", "unset", "workspace-root"])
            .status
            .success());
        let listed = assert_envelope(&repo.mabo(&["list", "--json"]), "list");
        for name in ["feature/delete", "feature/gc"] {
            let row = listed["data"]["workspaces"]
                .as_array()
                .unwrap()
                .iter()
                .find(|row| row["name"] == name)
                .expect("old workspace in list");
            assert_eq!(row["kind"], "workspace");
            assert_eq!(row["path"], old_root.join(name).to_str().unwrap());
            let located = assert_envelope(&repo.mabo(&["show", name, "--json"]), "show");
            assert_eq!(located["data"]["workspace"]["path"], row["path"]);
        }
        fs::write(repo.repo.join("updated"), "new base\n").unwrap();
        repo.git(&["add", "updated"]);
        repo.git(&["commit", "-m", "advance base"]);
        let sync = repo.mabo(&["sync", "--all", "--no-default", "--json"]);
        let doc = assert_envelope(&sync, "sync");
        assert!(sync.status.success(), "{doc}");
        assert_eq!(doc["data"]["workspaces"].as_array().unwrap().len(), 2);
        for name in ["feature/delete", "feature/gc"] {
            assert!(old_root.join(name).join("updated").is_file());
            assert!(
                !managed(&repo, name).exists(),
                "old workspace must not move"
            );
        }
        let out = repo.mabo(&["remove", "feature/delete", "--json"]);
        assert!(out.status.success(), "{}", text(&out.stdout));
        assert_envelope(&out, "remove");
        assert!(!old_root.join("feature/delete").exists());
        empty_commit(&repo, &old_root.join("feature/gc"), "retire this workspace");
        repo.git(&["merge", "--ff-only", "refs/heads/feature/gc"]);
        let dir = repo.repo.join(".git/maboroshi/workspaces");
        for entry in fs::read_dir(&dir).unwrap() {
            let file = entry.unwrap().path();
            let mut record: serde_json::Value =
                serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
            record["createdAt"] = serde_json::json!("2000-01-01T00:00:00.000Z");
            fs::write(file, serde_json::to_vec(&record).unwrap()).unwrap();
        }
        let out = repo.mabo(&["gc", "--apply", "--older-than", "1m", "--json"]);
        let doc = assert_envelope(&out, "gc");
        assert!(out.status.success(), "{doc}");
        assert!(
            doc["data"]["items"]
                .as_array()
                .unwrap()
                .iter()
                .any(|row| row["name"] == "feature/gc" && row["action"] == "removed"),
            "{doc}"
        );
        assert!(!old_root.join("feature/gc").exists());
        let out = repo.mabo(&["create", "fresh", "--json"]);
        let doc = assert_envelope(&out, "create");
        assert!(out.status.success(), "{doc}");
        assert!(
            Path::new(doc["data"]["workspace"]["path"].as_str().unwrap())
                .starts_with(repo.root.join("xdg/maboroshi/workspaces"))
        );
    }
}

#[test]
fn exec_leaves_legacy_metadata_unimported_and_exports_an_empty_id() {
    let repo = Repo::new();
    let old = repo.repo.join(".git/maboroshi/worktrees/feature/legacy");
    fs::create_dir_all(old.parent().unwrap()).unwrap();
    repo.git(&[
        "worktree",
        "add",
        "-b",
        "feature/legacy",
        old.to_str().unwrap(),
        "HEAD",
    ]);
    let legacy = repo.repo.join(".git/maboroshi/worktrees.json");
    fs::write(
        &legacy,
        serde_json::to_vec(&serde_json::json!({
            "version": 1,
            "worktrees": [{"path": old, "createdAt": "2000-01-01T00:00:00.000Z"}]
        }))
        .unwrap(),
    )
    .unwrap();
    let capture = repo.root.join("legacy-env");
    let script = workspace_env_script(&capture);
    let out = repo.mabo(&["exec", "feature/legacy", "--", "sh", "-c", &script]);
    assert!(out.status.success(), "{}", text(&out.stderr));
    let located = assert_envelope(&repo.mabo(&["show", "feature/legacy", "--json"]), "show");
    assert!(located["data"]["workspace"]["id"].is_null());
    assert_workspace_env(&capture, &repo, "feature/legacy", &old, "");
    assert!(legacy.is_file());
    assert!(!legacy.with_extension("json.imported").exists());
    assert!(!repo.repo.join(".git/maboroshi/workspaces").exists());
}

fn outer_run(
    repo: &Repo,
    args: &[&str],
    json: bool,
    command: &str,
    status: i32,
) -> serde_json::Value {
    let mut argv = args.to_vec();
    if json {
        argv.push("--json");
    }
    let out = repo.mabo(&argv);
    assert_eq!(
        out.status.code(),
        Some(status),
        "{argv:?}: {} {}",
        text(&out.stdout),
        text(&out.stderr)
    );
    if json {
        assert_envelope(&out, command)
    } else {
        assert!(
            serde_json::from_slice::<serde_json::Value>(&out.stdout).is_err()
                || out.stdout.is_empty(),
            "{argv:?}"
        );
        serde_json::Value::Null
    }
}

#[test]
fn outer_repo_commands_text_json_and_exit_codes() {
    for json in [false, true] {
        let repo = Repo::new();
        repo.git(&[
            "remote",
            "add",
            "origin",
            "https://github.com/acme/widget.git",
        ]);
        fs::write(
            repo.repo.join(".mabo.toml"),
            "[hooks]\nsetup = [\"true\"]\n",
        )
        .unwrap();
        let added = outer_run(&repo, &["repo", "add"], json, "repo add", 0);
        if json {
            assert_eq!(added["data"]["repo"]["name"], "repo");
            assert!(added["data"].get("project").is_none());
        }
        let shown = outer_run(
            &repo,
            &["repo", "show", "acme/widget"],
            json,
            "repo show",
            0,
        );
        if json {
            let item = &shown["data"]["repo"];
            assert_eq!(item["root"], canonical(&repo.repo).to_str().unwrap());
            assert_eq!(item["name"], "github.com/acme/widget");
            assert_eq!(item["defaultBranch"], "main");
            assert_eq!(item["configPresent"], true);
            assert_eq!(item["trusted"], true);
            assert_eq!(item["workspaceRoot"], managed_root(&repo).to_str().unwrap());
        }
        outer_run(&repo, &["repo", "show"], json, "repo show", 0);
        let listed = outer_run(
            &repo,
            &["repo", "list", "--registered"],
            json,
            "repo list",
            0,
        );
        if json {
            assert_eq!(listed["data"]["repos"].as_array().unwrap().len(), 1);
            let id = listed["data"]["repos"][0]["id"].as_str().unwrap();
            outer_run(&repo, &["repo", "show", id], true, "repo show", 0);
        }
        outer_run(
            &repo,
            &["repo", "forget", "github.com/acme/widget"],
            json,
            "repo forget",
            0,
        );
        assert!(repo.repo.join("README.md").is_file());
        assert!(repo.repo.join(".git").is_dir());
        for (args, command, status) in [
            (
                vec!["repo", "add", "/definitely/missing/mabo"],
                "repo add",
                3,
            ),
            (vec!["repo", "add", "a", "b"], "repo add", 2),
            (vec!["repo", "show", "unknown-repo"], "repo show", 3),
            (vec!["repo", "forget", "unknown-repo"], "repo forget", 3),
            (vec!["repo", "forget"], "repo forget", 2),
            (
                vec!["repo", "list", "--registered", "--discovered"],
                "repo list",
                2,
            ),
        ] {
            outer_run(&repo, &args, json, command, status);
        }
    }
}

#[test]
fn outer_repo_catalog_filters_registration_and_discovery() {
    let repo = Repo::new();
    let discovered = repo.home.join("ghq/example.com/acme/discovered");
    fs::create_dir_all(&discovered).unwrap();
    git_at(&repo, &discovered, &["init", "-b", "main"]);
    let ghq_path = silent_ghq_path(&repo);
    assert!(repo.mabo(&["repo", "add"]).status.success());
    for (filter, name) in [("--registered", "repo"), ("--discovered", "discovered")] {
        for mode in ["--names", "--paths", "--json"] {
            let out = repo
                .command(env!("CARGO_BIN_EXE_mabo"), &["repo", "list", filter, mode])
                .env("PATH", &ghq_path)
                .output()
                .unwrap();
            assert_eq!(out.status.code(), Some(0), "{}", text(&out.stderr));
            match mode {
                "--names" => assert_eq!(text(&out.stdout), name),
                "--paths" => assert!(same_dir(
                    &text(&out.stdout),
                    if name == "repo" {
                        &repo.repo
                    } else {
                        &discovered
                    }
                )),
                _ => {
                    let value = assert_envelope(&out, "repo list");
                    assert_eq!(value["data"]["repos"].as_array().unwrap().len(), 1);
                    assert_eq!(value["data"]["repos"][0]["name"], name);
                }
            }
        }
    }
    assert!(repo
        .mabo(&["config", "set", "discover-ghq", "false"])
        .status
        .success());
    let out = repo.mabo(&["repo", "list", "--discovered", "--json"]);
    assert_eq!(
        assert_envelope(&out, "repo list")["data"]["repos"],
        serde_json::json!([])
    );
}

#[test]
fn outer_config_commands_text_json_sources_and_exit_codes() {
    for json in [false, true] {
        let repo = Repo::new();
        let defaults = outer_run(
            &repo,
            &["config", "list", "--sources"],
            json,
            "config list",
            0,
        );
        if json {
            let config = &defaults["data"]["config"];
            assert_eq!(config["workspace-root"]["value"], serde_json::Value::Null);
            assert_eq!(config["discover-ghq"]["value"], true);
            assert!(config.get("keep-branch").is_none());
            for key in maboroshi::preferences::SUPPORTED_KEYS {
                assert_eq!(config[key]["source"], "default");
            }
        }
        outer_run(
            &repo,
            &["config", "set", "workspace-root", "../my spaces"],
            json,
            "config set",
            0,
        );
        let get = outer_run(
            &repo,
            &["config", "get", "workspace-root", "--sources"],
            json,
            "config get",
            0,
        );
        if json {
            assert_eq!(
                get["data"]["config"]["workspace-root"]["value"],
                "../my spaces"
            );
            assert_eq!(get["data"]["config"]["workspace-root"]["source"], "config");
        }
        outer_run(
            &repo,
            &["config", "get", "workspace-root"],
            json,
            "config get",
            0,
        );
        outer_run(&repo, &["config", "list"], json, "config list", 0);
        outer_run(
            &repo,
            &["config", "unset", "workspace-root"],
            json,
            "config unset",
            0,
        );
        for (args, command, status) in [
            (vec!["config", "get", "unknown"], "config get", 2),
            (vec!["config", "get"], "config get", 2),
            (
                vec!["config", "set", "discover-ghq", "yes"],
                "config set",
                2,
            ),
            (
                vec!["config", "set", "clone-root", "relative"],
                "config set",
                2,
            ),
            (vec!["config", "set", "workspace-root"], "config set", 2),
            (vec!["config", "unset", "workspace-root"], "config unset", 3),
            (vec!["config", "unset", "unknown"], "config unset", 2),
            (vec!["config", "list", "extra"], "config list", 2),
        ] {
            outer_run(&repo, &args, json, command, status);
        }
        let path = repo.home.join(".config/maboroshi/config.toml");
        fs::write(path, "bad = [\n").unwrap();
        outer_run(&repo, &["config", "list"], json, "config list", 1);
    }
}

#[test]
fn outer_clone_root_sources_match_the_existing_resolution_chain() {
    let repo = Repo::new();
    let get = |env_root: Option<&str>| {
        let mut command = repo.command(
            env!("CARGO_BIN_EXE_mabo"),
            &["config", "get", "clone-root", "--sources", "--json"],
        );
        if let Some(value) = env_root {
            command.env("GHQ_ROOT", value);
        }
        let out = command.output().unwrap();
        assert_eq!(out.status.code(), Some(0));
        assert_envelope(&out, "config get")["data"]["config"]["clone-root"].clone()
    };
    let value = get(None);
    assert_eq!(value["value"], repo.home.join("ghq").to_str().unwrap());
    assert_eq!(value["source"], "default");
    assert_eq!(value["detail"], "~/ghq");
    let value = get(Some("~/env"));
    assert_eq!(value["value"], repo.home.join("env").to_str().unwrap());
    assert_eq!(value["source"], "env");
    assert_eq!(value["detail"], "GHQ_ROOT");
    repo.git(&["config", "--global", "ghq.root", "~/git"]);
    let value = get(Some("~/env"));
    assert_eq!(value["value"], repo.home.join("git").to_str().unwrap());
    assert_eq!(value["source"], "default");
    assert_eq!(value["detail"], "ghq.root");
    assert!(repo
        .mabo(&["config", "set", "clone-root", "~/config"])
        .status
        .success());
    let value = get(Some("~/env"));
    assert_eq!(value["value"], repo.home.join("config").to_str().unwrap());
    assert_eq!(value["source"], "config");
}

#[test]
fn outer_legacy_config_warnings_appear_once_per_invocation() {
    let repo = Repo::new();
    assert!(repo.mabo(&["repo", "add"]).status.success());
    let path = repo.home.join(".config/maboroshi/config.toml");
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    let path_env = silent_ghq_path(&repo);
    let warnings = [
        ("config_key_removed", "config key 'keep-branch'"),
        ("config_key_renamed", "config key 'worktrees-directory'"),
        ("config_key_renamed", "config key 'root'"),
        ("config_key_renamed", "config key 'ghq-discovery'"),
        (
            "config_key_removed",
            "config key 'directory-name-separator'",
        ),
    ];
    for discovery in [false, true] {
        for (args, command) in [
            (vec!["repo", "list"], "repo list"),
            (vec!["config", "list", "--sources"], "config list"),
            (vec!["config", "list", "--repo", "repo"], "config list"),
            (
                vec!["config", "get", "clone-root", "-R", "repo"],
                "config get",
            ),
            (vec!["repo", "show", "repo"], "repo show"),
            (vec!["list", "-R", "repo"], "list"),
            (
                vec!["config", "set", "discover-ghq", "false", "-R", "repo"],
                "config set",
            ),
            (
                vec!["config", "unset", "discover-ghq", "-R", "repo"],
                "config unset",
            ),
        ] {
            for json in [false, true] {
                let legacy = format!("worktrees-directory = \"../spaces\"\nroot = \"~/clones\"\nghq-discovery = {discovery}\ndirectory-name-separator = \"-\"\nkeep-branch = true\n");
                fs::write(&path, &legacy).unwrap();
                let mut argv = args.clone();
                if json {
                    argv.push("--json");
                }
                let out = repo
                    .command(env!("CARGO_BIN_EXE_mabo"), &argv)
                    .env("PATH", &path_env)
                    .output()
                    .unwrap();
                assert!(out.status.success(), "{argv:?}: {out:?}");
                let stderr = text(&out.stderr);
                for (code, message) in warnings {
                    assert_eq!(stderr.matches(message).count(), 1, "{argv:?}: {stderr}");
                    if json {
                        let value = assert_envelope(&out, command);
                        let recorded = value["warnings"].as_array().unwrap();
                        assert_eq!(recorded.len(), warnings.len(), "{argv:?}: {value}");
                        assert_eq!(
                            recorded
                                .iter()
                                .filter(|warning| warning["code"] == code
                                    && warning["message"].as_str().unwrap().contains(message))
                                .count(),
                            1,
                            "{argv:?}: {value}"
                        );
                    }
                }
                if !matches!(command, "config set" | "config unset") {
                    assert_eq!(fs::read_to_string(&path).unwrap(), legacy);
                }
            }
        }
    }
}

#[test]
fn outer_legacy_config_warns_takes_effect_and_rewrites_on_set_or_unset() {
    for mutation in ["set", "unset"] {
        let repo = Repo::new();
        let path = repo.home.join(".config/maboroshi/config.toml");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let legacy = "# retain this\nworktrees-directory = \"../legacy-spaces\" # location\nroot = \"~/legacy-clones\"\nghq-discovery = false\ndirectory-name-separator = [\"ignored regardless of type\"]\nkeep-branch = true\n";
        fs::write(&path, legacy).unwrap();
        let out = repo.mabo(&["config", "list", "--sources", "--json"]);
        let value = assert_envelope(&out, "config list");
        assert_eq!(out.status.code(), Some(0));
        let warnings = value["warnings"].as_array().unwrap();
        assert_eq!(
            warnings
                .iter()
                .filter(|w| w["code"] == "config_key_renamed")
                .count(),
            3
        );
        assert_eq!(
            warnings
                .iter()
                .filter(|w| w["code"] == "config_key_removed")
                .count(),
            2
        );
        assert!(warnings
            .iter()
            .all(|w| w["message"].as_str().unwrap().contains("config")));
        let config = &value["data"]["config"];
        assert_eq!(config["workspace-root"]["value"], "../legacy-spaces");
        assert_eq!(
            config["clone-root"]["value"],
            repo.home.join("legacy-clones").to_str().unwrap()
        );
        assert_eq!(config["discover-ghq"]["value"], false);
        assert_eq!(fs::read_to_string(&path).unwrap(), legacy);
        let created = outer_run(&repo, &["create", "feature/nested"], true, "create", 0);
        assert_eq!(
            created["data"]["workspace"]["path"],
            repo.root
                .join("legacy-spaces/feature/nested")
                .to_str()
                .unwrap()
        );
        let out = if mutation == "set" {
            repo.mabo(&["config", "set", "clone-root", "~/new-clones", "--json"])
        } else {
            repo.mabo(&["config", "unset", "discover-ghq", "--json"])
        };
        assert_eq!(out.status.code(), Some(0));
        assert_envelope(&out, &format!("config {mutation}"));
        let rewritten = fs::read_to_string(&path).unwrap();
        for old in [
            "worktrees-directory",
            "\nroot =",
            "ghq-discovery",
            "directory-name-separator",
            "keep-branch",
        ] {
            assert!(!rewritten.contains(old), "{rewritten}");
        }
        for key in [
            "workspace-root",
            "clone-root",
            "# retain this",
            "# location",
        ] {
            assert!(rewritten.contains(key), "{rewritten}");
        }
        let out = repo.mabo(&["config", "list", "--json"]);
        assert_eq!(
            assert_envelope(&out, "config list")["warnings"],
            serde_json::json!([])
        );
    }
    let repo = Repo::new();
    let path = repo.home.join(".config/maboroshi/config.toml");
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(&path, "worktrees-directory = \"../old\"\nworkspace-root = \"~/new\"\nghq-discovery = false\ndiscover-ghq = true\n").unwrap();
    let out = repo.mabo(&["config", "list", "--json"]);
    let value = assert_envelope(&out, "config list");
    assert_eq!(value["data"]["config"]["workspace-root"], "~/new");
    assert_eq!(value["data"]["config"]["discover-ghq"], true);
    let created = outer_run(&repo, &["create", "tilde"], true, "create", 0);
    assert_eq!(
        created["data"]["workspace"]["path"],
        repo.home.join("new/tilde").to_str().unwrap()
    );
}

#[test]
fn outer_trust_commands_text_json_and_exit_codes() {
    for json in [false, true] {
        let repo = Repo::new();
        fs::write(
            repo.repo.join(".mabo.toml"),
            "[hooks]\nsetup = [\"echo hook-visible\"]\n",
        )
        .unwrap();
        assert!(repo.mabo(&["repo", "add"]).status.success());
        let run = |args: &[&str], command: &str, status: i32| {
            let mut argv = args.to_vec();
            if json {
                argv.push("--json");
            }
            let out = repo
                .command(env!("CARGO_BIN_EXE_mabo"), &argv)
                .env_remove("MABO_TRUST_ALL")
                .output()
                .unwrap();
            assert_eq!(
                out.status.code(),
                Some(status),
                "{argv:?}: {} {}",
                text(&out.stdout),
                text(&out.stderr)
            );
            if json {
                assert_envelope(&out, command);
            }
            out
        };
        let untrusted = run(&["create", "refused"], "create", 4);
        assert!(!managed(&repo, "refused").exists());
        assert!(
            format!("{} {}", text(&untrusted.stdout), text(&untrusted.stderr))
                .contains("mabo trust add")
        );
        let add = run(&["trust", "add", "repo"], "trust add", 0);
        assert!(text(&add.stderr).contains("echo hook-visible"));
        assert!(!text(&add.stderr).contains("[y/N]"));
        let list = run(&["trust", "list"], "trust list", 0);
        if json {
            assert_eq!(
                json_value(&list)["data"]["repos"].as_array().unwrap().len(),
                1
            );
        }
        let show = run(&["repo", "show"], "repo show", 0);
        if json {
            assert_eq!(json_value(&show)["data"]["repo"]["trusted"], true);
        }
        run(&["trust", "remove", "repo"], "trust remove", 0);
        let show = run(&["repo", "show"], "repo show", 0);
        if json {
            assert_eq!(json_value(&show)["data"]["repo"]["trusted"], false);
        }
        run(&["trust", "remove"], "trust remove", 0);
        run(&["trust", "list"], "trust list", 0);
        for (args, command, status) in [
            (vec!["trust", "add", "unknown-repo"], "trust add", 3),
            (vec!["trust", "remove", "unknown-repo"], "trust remove", 3),
            (vec!["trust", "add", "a", "b"], "trust add", 2),
            (vec!["trust", "remove", "a", "b"], "trust remove", 2),
            (vec!["trust", "list", "extra"], "trust list", 2),
        ] {
            run(&args, command, status);
        }
    }
}

#[test]
#[cfg(unix)]
fn outer_trust_output_escapes_repository_control_characters() {
    let mut failures = Vec::new();
    for json in [false, true] {
        let mut repo = Repo::new();
        let name = "repo\u{1b}[31m\nforged";
        let renamed = repo.root.join(name);
        fs::rename(&repo.repo, &renamed).unwrap();
        repo.repo = renamed;
        fs::write(
            repo.repo.join(".mabo.toml"),
            "[hooks]\nsetup = [\"echo hook-visible\"]\n",
        )
        .unwrap();
        let root = canonical(&repo.repo).to_string_lossy().into_owned();
        let key = format!("{root}/.git");
        let visible_root = root.replace('\u{1b}', "\\u{1b}").replace('\n', "\\u{a}");
        let visible_key = format!("{visible_root}/.git");
        for (args, command, expected) in [
            (vec!["trust", "add"], "trust add", "Trusted "),
            (vec!["trust", "list"], "trust list", ""),
            (
                vec!["trust", "remove"],
                "trust remove",
                "Removed trust for ",
            ),
            (vec!["trust", "remove"], "trust remove", "Not trusted: "),
        ] {
            let mut argv = args;
            if json {
                argv.push("--json");
            }
            let out = repo
                .command(env!("CARGO_BIN_EXE_mabo"), &argv)
                .env_remove("MABO_TRUST_ALL")
                .output()
                .unwrap();
            assert!(out.status.success(), "{argv:?}: {out:?}");
            let stderr = text(&out.stderr);
            if command == "trust add" {
                if !stderr.starts_with(&format!("{visible_root}\n")) {
                    failures.push(format!("{argv:?} stderr: {stderr:?}"));
                }
                assert!(stderr.contains("echo hook-visible"));
            }
            if stderr.contains('\u{1b}') || stderr.contains(name) {
                failures.push(format!("{argv:?} unsafe stderr: {stderr:?}"));
            }
            if json {
                let envelope = assert_envelope(&out, command);
                let data = &envelope["data"];
                let path = if command == "trust list" {
                    &data["repos"][0]["path"]
                } else {
                    &data["path"]
                };
                assert_eq!(path, &key);
            } else {
                let stdout = text(&out.stdout);
                if !stdout.starts_with(&format!("{expected}{visible_key}")) {
                    failures.push(format!("{argv:?} stdout: {stdout:?}"));
                }
            }
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[test]
#[cfg(unix)]
fn outer_repo_output_escapes_repository_control_characters() {
    let mut repo = Repo::new();
    let name = "repo\u{1b}[31m\nforged";
    let visible_name = "repo\\u{1b}[31m\\u{a}forged";
    let renamed = repo.root.join(name);
    fs::rename(&repo.repo, &renamed).unwrap();
    repo.repo = renamed;
    let root = canonical(&repo.repo).to_string_lossy().into_owned();
    let visible_root = root.replace(name, visible_name);
    let mut failures = Vec::new();
    for (args, expected) in [
        (
            vec!["repo", "add"],
            format!("'{visible_name}' ({visible_root})"),
        ),
        (
            vec!["repo", "add"],
            format!("'{visible_name}' is already registered ({visible_root})"),
        ),
        (
            vec!["repo", "list", "--registered"],
            format!("{visible_name} ({visible_root})"),
        ),
        (
            vec!["repo", "list", "--registered", "--names"],
            visible_name.into(),
        ),
        (
            vec!["repo", "list", "--registered", "--paths"],
            visible_root.clone(),
        ),
        (
            vec!["repo", "show"],
            format!("{visible_name}\nPrimary checkout: {visible_root}\n"),
        ),
        (
            vec!["repo", "forget", &root],
            format!("'{visible_name}' ({visible_root})"),
        ),
    ] {
        let out = repo.mabo(&args);
        assert!(out.status.success(), "{args:?}: {out:?}");
        let stdout = text(&out.stdout);
        if !stdout.contains(&expected) || stdout.contains(name) || stdout.contains('\u{1b}') {
            failures.push(format!("{args:?}: {stdout:?}"));
        }
        if args == ["repo", "show"] {
            let shown = repo.mabo(&["repo", "show", "--json"]);
            let envelope = assert_envelope(&shown, "repo show");
            assert_eq!(envelope["data"]["repo"]["root"], root);
            assert_eq!(envelope["data"]["repo"]["name"], name);
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[test]
#[cfg(unix)]
fn outer_discovery_and_ambiguity_escape_repository_paths() {
    let mut repo = Repo::new();
    let clone_root = repo.root.join("clones\u{1b}[31m\nforged");
    let checkout = clone_root.join("github.com/example/widget");
    fs::create_dir_all(checkout.parent().unwrap()).unwrap();
    fs::rename(&repo.repo, &checkout).unwrap();
    repo.repo = checkout.clone();
    assert!(repo
        .mabo(&["config", "set", "clone-root", clone_root.to_str().unwrap()])
        .status
        .success());
    let raw = checkout.to_str().unwrap();
    let visible = raw.replace('\u{1b}', "\\u{1b}").replace('\n', "\\u{a}");
    for (args, expected) in [
        (
            vec!["repo", "list", "--discovered"],
            format!("widget ({visible}) [ghq]"),
        ),
        (
            vec!["repo", "list", "--discovered", "--paths"],
            visible.clone(),
        ),
        (
            vec!["repo", "list", "--discovered", "--names"],
            "widget".into(),
        ),
    ] {
        let out = repo.mabo(&args);
        assert!(out.status.success(), "{args:?}: {out:?}");
        assert_eq!(text(&out.stdout), expected, "{args:?}");
        assert!(!text(&out.stderr).contains('\u{1b}'), "{args:?}: {out:?}");
    }
    let out = repo.mabo(&["repo", "add", "--json"]);
    assert!(out.status.success(), "{out:?}");
    assert_eq!(
        assert_envelope(&out, "repo add")["data"]["repo"]["rootPath"],
        raw
    );

    let other = clone_root.join("other/widget");
    fs::create_dir_all(other.parent().unwrap()).unwrap();
    repo.git(&[
        "clone",
        repo.repo.to_str().unwrap(),
        other.to_str().unwrap(),
    ]);
    assert!(repo
        .mabo(&["repo", "add", other.to_str().unwrap()])
        .status
        .success());
    for (args, command, lines) in [
        (vec!["repo", "show", "widget"], "repo show", 3),
        (vec!["repo", "forget", "widget"], "repo forget", 1),
    ] {
        let out = repo.mabo(&args);
        assert_eq!(out.status.code(), Some(2), "{args:?}: {out:?}");
        let stderr = text(&out.stderr);
        assert!(!stderr.contains('\u{1b}'), "{args:?}: {stderr:?}");
        assert_eq!(stderr.lines().count(), lines, "{args:?}: {stderr:?}");
        if command == "repo show" {
            assert!(stderr.contains(&visible), "{stderr:?}");
        }
        let mut args = args;
        args.push("--json");
        let out = repo.mabo(&args);
        assert_eq!(out.status.code(), Some(2));
        let value = assert_envelope(&out, command);
        assert_eq!(value["error"]["code"], "ambiguous");
        if command == "repo show" {
            assert!(value["error"]["message"].as_str().unwrap().contains(raw));
        }
    }
}

#[test]
#[cfg(unix)]
fn outer_config_output_escapes_paths_in_values_and_sources() {
    let repo = Repo::new();
    let directory = repo.root.join("config\u{1b}[31m\nforged");
    fs::create_dir_all(&directory).unwrap();
    let raw = directory.to_str().unwrap();
    let visible = raw.replace('\u{1b}', "\\u{1b}").replace('\n', "\\u{a}");
    for args in [
        vec!["config", "set", "workspace-root", raw],
        vec!["config", "get", "workspace-root"],
        vec!["config", "get", "workspace-root", "--sources"],
        vec!["config", "list"],
        vec!["config", "list", "--sources"],
        vec!["repo", "show"],
        vec!["config", "unset", "workspace-root"],
    ] {
        let out = repo
            .command(env!("CARGO_BIN_EXE_mabo"), &args)
            .env("XDG_CONFIG_HOME", &directory)
            .output()
            .unwrap();
        assert!(out.status.success(), "{args:?}: {out:?}");
        let stdout = text(&out.stdout);
        assert!(stdout.contains(&visible), "{args:?}: {stdout:?}");
        assert!(!stdout.contains(raw), "{args:?}: {stdout:?}");
        assert!(!stdout.contains('\u{1b}'), "{args:?}: {stdout:?}");
    }
}

#[test]
#[cfg(unix)]
fn outer_diagnostics_escape_repository_names_and_paths() {
    let repo = Repo::new();
    let directory = repo.root.join("repo\u{1b}[31m\nforged");
    fs::create_dir_all(&directory).unwrap();
    let missing = directory.join("missing");
    let path = missing.to_str().unwrap();
    let name = "missing\u{1b}[31m\nforged";
    for (args, command, reference) in [
        (vec!["repo", "show", name], "repo show", name),
        (vec!["repo", "forget", name], "repo forget", name),
        (vec!["repo", "add", path], "repo add", path),
        (vec!["trust", "add", path], "trust add", path),
        (vec!["trust", "remove", path], "trust remove", path),
    ] {
        let out = repo.mabo(&args);
        assert_eq!(out.status.code(), Some(3), "{args:?}: {out:?}");
        let stderr = text(&out.stderr);
        let visible = reference
            .replace('\u{1b}', "\\u{1b}")
            .replace('\n', "\\u{a}");
        assert!(stderr.contains(&visible), "{args:?}: {stderr:?}");
        assert_eq!(stderr.lines().count(), 1, "{args:?}: {stderr:?}");
        assert!(!stderr.contains('\u{1b}'), "{args:?}: {stderr:?}");
        let mut json_args = args;
        json_args.push("--json");
        let out = repo.mabo(&json_args);
        assert_eq!(out.status.code(), Some(3));
        let value = assert_envelope(&out, command);
        assert!(value["error"]["message"]
            .as_str()
            .unwrap()
            .contains(reference));
        assert!(out.stderr.is_empty());
    }

    // Discovery diagnostics are printed to stderr even in JSON mode.
    let path = silent_ghq_path(&repo);
    fs::write(
        repo.root.join("bin/ghq"),
        "#!/bin/sh\nprintf '%s\\n' \"$MABO_TEST_DIAGNOSTIC\" >&2\nexit 17\n",
    )
    .unwrap();
    for json in [false, true] {
        let mut args = vec!["repo", "list"];
        if json {
            args.push("--json");
        }
        let out = repo
            .command(env!("CARGO_BIN_EXE_mabo"), &args)
            .env("PATH", &path)
            .env("MABO_TEST_DIAGNOSTIC", &directory)
            .output()
            .unwrap();
        assert!(out.status.success(), "{args:?}: {out:?}");
        let stderr = text(&out.stderr);
        assert!(!stderr.contains('\u{1b}'), "{args:?}: {stderr:?}");
        assert!(
            stderr.contains("repo\\u{1b}[31m\\u{a}forged"),
            "{args:?}: {stderr:?}"
        );
        if json {
            let value = assert_envelope(&out, "repo list");
            assert!(value["warnings"][0]["message"]
                .as_str()
                .unwrap()
                .contains(directory.to_str().unwrap()));
        }
    }
}

#[test]
fn outer_removed_trust_flags_only_hint_for_trust_commands() {
    let repo = Repo::new();
    for (args, command) in [
        (vec!["list"], "list"),
        (vec!["gc"], "gc"),
        (vec!["repo", "list"], "repo list"),
        (vec!["config", "list"], "config list"),
        (vec!["trust"], "trust"),
        (vec!["trust", "add"], "trust add"),
        (vec!["trust", "remove"], "trust remove"),
        (vec!["trust", "list"], "trust list"),
    ] {
        for flag in ["--yes", "-y", "--list"] {
            for json in [false, true] {
                let mut argv = args.clone();
                argv.push(flag);
                if json {
                    argv.push("--json");
                }
                let out = repo.mabo(&argv);
                assert_eq!(out.status.code(), Some(2), "{argv:?}: {out:?}");
                let message = if json {
                    let value = assert_envelope(&out, command);
                    assert_eq!(value["error"]["code"], "usage");
                    value["error"]["message"].as_str().unwrap().to_owned()
                } else {
                    assert!(out.stdout.is_empty(), "{argv:?}: {out:?}");
                    text(&out.stderr)
                };
                if command.starts_with("trust") {
                    assert!(message.contains("mabo trust add"), "{argv:?}: {message}");
                    assert!(message.contains("mabo trust list"), "{argv:?}: {message}");
                } else {
                    assert!(
                        message.starts_with(&format!("Unknown option '{flag}'.")),
                        "{argv:?}: {message}"
                    );
                    assert!(!message.contains("trust"), "{argv:?}: {message}");
                    assert!(!text(&out.stderr).contains("trust"), "{argv:?}: {out:?}");
                }
            }
        }
    }
}

#[test]
fn outer_removed_flags_take_precedence_over_child_help() {
    let repo = Repo::new();
    for child in ["add", "remove", "list"] {
        let command = format!("trust {child}");
        for flag in [
            "--yes",
            "-y",
            "--list",
            "--project=repo",
            "-prepo",
            "--project",
            "-p",
        ] {
            for help in ["--help", "-h"] {
                for json in [false, true] {
                    let mut args = vec!["trust", child, flag];
                    if matches!(flag, "--project" | "-p") {
                        args.push("repo");
                    }
                    args.push(help);
                    if json {
                        args.push("--json");
                    }
                    let out = repo.mabo(&args);
                    assert_eq!(out.status.code(), Some(2), "{args:?}: {out:?}");
                    let hint = if matches!(flag, "--yes" | "-y" | "--list") {
                        "mabo trust"
                    } else {
                        "-R/--repo"
                    };
                    if json {
                        let value = assert_envelope(&out, &command);
                        assert_eq!(value["error"]["code"], "usage");
                        assert!(value["error"]["message"].as_str().unwrap().contains(hint));
                    } else {
                        assert!(out.stdout.is_empty(), "{args:?}: {out:?}");
                        let stderr = text(&out.stderr);
                        assert_eq!(stderr.lines().count(), 1, "{args:?}: {stderr:?}");
                        assert!(stderr.contains(hint), "{args:?}: {stderr:?}");
                    }
                }
            }
        }
    }
}

#[test]
fn outer_removed_commands_and_flags_fail_with_migration_hints() {
    let repo = Repo::new();
    for (args, command, hint) in [
        (vec!["project", "list"], "project", "mabo repo"),
        (
            vec!["preferences", "get", "root"],
            "preferences",
            "mabo config",
        ),
        (vec!["untrust"], "untrust", "mabo trust remove"),
        (vec!["version"], "version", "mabo --version"),
        (vec!["trust", "--yes"], "trust", "mabo trust add"),
        (vec!["trust", "--list"], "trust", "mabo trust list"),
        (vec!["trust", "-y"], "trust", "mabo trust add"),
        (vec!["trust", "."], "trust", "mabo trust add"),
        (vec!["list", "--project", "repo"], "list", "-R/--repo"),
        (vec!["list", "--project=repo"], "list", "-R/--repo"),
        (vec!["list", "-p", "repo"], "list", "-R/--repo"),
        (vec!["list", "-prepo"], "list", "-R/--repo"),
        (vec!["-p", "repo", "list"], "list", "-R/--repo"),
        (vec!["--project", "repo", "list"], "list", "-R/--repo"),
        (vec!["--project=repo"], "", "-R/--repo"),
        (vec!["-prepo"], "-prepo", "-R/--repo"),
        (vec!["help", "project"], "help", "mabo repo"),
    ] {
        for json in [false, true] {
            let mut argv = args.clone();
            if json {
                argv.push("--json");
            }
            let out = repo.mabo(&argv);
            assert_eq!(
                out.status.code(),
                Some(2),
                "{argv:?}: {}",
                text(&out.stdout)
            );
            let message = if json {
                let value = assert_envelope(&out, command);
                assert_eq!(value["error"]["code"], "usage");
                value["error"]["message"].as_str().unwrap().to_string()
            } else {
                assert!(out.stdout.is_empty(), "{argv:?}: {}", text(&out.stdout));
                assert_eq!(
                    text(&out.stderr).lines().count(),
                    1,
                    "{argv:?}: {}",
                    text(&out.stderr)
                );
                text(&out.stderr)
            };
            assert!(message.contains(hint), "{argv:?}: {message}");
            assert!(
                !text(&out.stderr).contains("COMMANDS"),
                "{argv:?}: {}",
                text(&out.stderr)
            );
        }
    }
    // Help cannot revive removed commands or flags.
    for args in [
        vec!["version", "--help"],
        vec!["project", "--help"],
        vec!["list", "-p", "repo", "--help"],
        vec!["trust", "--yes", "--help"],
    ] {
        let out = repo.mabo(&args);
        assert_eq!(out.status.code(), Some(2), "{args:?}");
        assert!(out.stdout.is_empty(), "{args:?}: {}", text(&out.stdout));
        let stderr = text(&out.stderr);
        assert_eq!(stderr.lines().count(), 1, "{args:?}: {stderr}");
        assert!(!stderr.contains("COMMANDS"), "{args:?}: {stderr}");
    }
}

#[test]
fn outer_global_repo_selection_works_before_commands_and_preserves_child_arguments() {
    let repo = Repo::new();
    assert!(repo.mabo(&["repo", "add"]).status.success());
    for args in [
        vec!["-R", "repo", "list", "--json"],
        vec!["--repo=repo", "list", "--json"],
        vec!["-Rrepo", "list", "--json"],
        vec!["--json", "-R", "repo", "list"],
        vec!["list", "-R", "repo", "--json"],
    ] {
        let out = repo
            .command(env!("CARGO_BIN_EXE_mabo"), &args)
            .current_dir(&repo.home)
            .output()
            .unwrap();
        assert_eq!(
            out.status.code(),
            Some(0),
            "{args:?}: {}",
            text(&out.stderr)
        );
        assert_eq!(
            assert_envelope(&out, "list")["data"]["workspaces"][0]["kind"],
            "primary"
        );
    }
    let out = repo
        .command(env!("CARGO_BIN_EXE_mabo"), &["-R", "repo", "list"])
        .current_dir(&repo.home)
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(0));
    assert!(text(&out.stdout).contains("main  main"));
    outer_run(&repo, &["-R", "repo", "repo", "show"], true, "repo show", 0);
    outer_run(&repo, &["-R", "repo", "trust", "add"], true, "trust add", 0);
    outer_run(
        &repo,
        &["-R", "repo", "trust", "remove"],
        true,
        "trust remove",
        0,
    );
    for json in [false, true] {
        outer_run(&repo, &["-R", "unknown-repo", "list"], json, "list", 3);
        outer_run(
            &repo,
            &["-R", "repo", "list", "--repo", "repo"],
            json,
            "list",
            2,
        );
        outer_run(&repo, &["list", "--repo="], json, "list", 2);
    }
    let out = repo.mabo(&[
        "-R",
        "repo",
        "exec",
        "main",
        "--",
        "printf",
        "%s",
        "--project",
    ]);
    assert_eq!(out.status.code(), Some(0));
    assert_eq!(text(&out.stdout), "--project");
}

#[test]
fn outer_parent_commands_require_subcommands_in_json_and_show_text_help() {
    let repo = Repo::new();
    for (command, key) in [("trust", "trust"), ("repo", "repo"), ("config", "config")] {
        let help = repo.mabo(&[command, "--help"]);
        assert_eq!(help.status.code(), Some(0));
        assert!(help.stderr.is_empty());
        assert!(text(&help.stdout).contains("USAGE"));
        for args in [vec![command], vec![command, "--output", "text"]] {
            let out = repo
                .command(env!("CARGO_BIN_EXE_mabo"), &args)
                .env("MABO_OUTPUT", if args.len() == 1 { "text" } else { "json" })
                .output()
                .expect("mabo");
            assert_eq!(out.status.code(), Some(0), "{args:?}");
            assert_eq!(out.stdout, help.stdout, "{args:?}");
            assert!(out.stderr.is_empty(), "{args:?}");
        }
        for (args, mode) in [
            (vec![command, "--json"], "text"),
            (vec!["--json", command], "text"),
            (vec![command, "--output", "json"], "text"),
            (vec![command], "json"),
            (vec![command, "--no-input"], "json"),
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
            let value = assert_envelope(&out, key);
            assert_eq!(value["error"]["code"], "usage");
            assert!(value["error"]["message"]
                .as_str()
                .unwrap()
                .contains("subcommand"));
            assert!(value["data"].is_null());
            assert!(out.stderr.is_empty(), "{args:?}");
        }
    }
}

#[test]
fn outer_help_flags_ignore_output_environment() {
    let repo = Repo::new();
    let expected = repo.mabo(&["help", "help"]);
    assert_eq!(expected.status.code(), Some(0));
    assert!(text(&expected.stdout).contains("USAGE"));
    for mode in ["json", "invalid"] {
        for args in [
            vec!["help", "--help"],
            vec!["help", "-h"],
            vec!["help", "--help", "--json"],
            vec!["--json", "help", "--help"],
        ] {
            let out = repo
                .command(env!("CARGO_BIN_EXE_mabo"), &args)
                .env("MABO_OUTPUT", mode)
                .output()
                .expect("mabo");
            assert_eq!(
                out.status.code(),
                Some(0),
                "{args:?}, {mode}: {}",
                text(&out.stderr)
            );
            assert!(out.stdout == expected.stdout, "{args:?}, {mode}");
            assert!(out.stderr.is_empty(), "{args:?}, {mode}");
        }
    }
}

#[test]
fn outer_help_and_version_contracts_text_json_and_exit_codes() {
    let repo = Repo::new();
    let expected: serde_json::Value =
        serde_json::from_str(include_str!("../help-data.json")).unwrap();
    let out = repo.mabo(&["help", "--json"]);
    assert_eq!(out.status.code(), Some(0));
    let value = assert_envelope(&out, "help");
    assert_eq!(value["data"], expected);
    assert_eq!(expected["schemaVersion"], 2);
    assert_eq!(expected["exitCodes"].as_object().unwrap().len(), 7);
    for (code, exit) in expected["errorCodes"].as_object().unwrap() {
        assert_eq!(
            maboroshi::error::exit_for_code(code),
            exit.as_i64().unwrap() as i32
        );
    }
    for command in [
        "create",
        "create",
        "remove",
        "show",
        "list",
        "sync",
        "gc",
        "exec",
        "set",
        "adopt",
        "adopt",
        "forget",
        "create",
        "clone",
        "repo",
        "repo add",
        "repo list",
        "repo show",
        "repo forget",
        "config",
        "config get",
        "config set",
        "config unset",
        "config list",
        "trust",
        "trust add",
        "trust remove",
        "trust list",
        "help",
        "--version",
    ] {
        let entry = &expected["helps"][command];
        assert!(entry.is_object(), "{command}");
        let mut help_args = vec!["help"];
        help_args.extend(command.split_whitespace());
        // --version is a flag, so select its help entry after the separator.
        if command == "--version" {
            help_args = vec!["help", "--", "--version"];
        }
        let text_help = repo.mabo(&help_args);
        let mut flag_args: Vec<_> = command.split_whitespace().collect();
        flag_args.push("--help");
        let flag_help = repo.mabo(&flag_args);
        assert_eq!(
            text_help.status.code(),
            Some(0),
            "{command}: {}",
            text(&text_help.stderr)
        );
        assert_eq!(
            text(&text_help.stdout),
            text(&flag_help.stdout),
            "{command}"
        );
        assert!(
            entry["options"]
                .as_array()
                .unwrap()
                .iter()
                .any(|option| option["name"] == "repo" && option["short"] == "R"),
            "{command}"
        );
    }
    let out = repo.mabo(&["help", "repo", "show", "--json"]);
    assert_eq!(
        assert_envelope(&out, "help")["data"]["selected"],
        expected["helps"]["repo show"]
    );
    assert_eq!(
        text(&repo.mabo(&["help"]).stdout),
        text(&repo.mabo(&["--help"]).stdout)
    );
    for args in [
        vec!["--version", "--json"],
        vec!["-v", "--json"],
        vec!["--json", "--version"],
    ] {
        let out = repo.mabo(&args);
        assert_eq!(out.status.code(), Some(0));
        let value = assert_envelope(&out, "--version");
        assert_eq!(value["data"]["version"], env!("CARGO_PKG_VERSION"));
        assert_eq!(
            value["data"]["display"],
            text(&repo.mabo(&["--version"]).stdout)
        );
    }
    for json in [false, true] {
        outer_run(&repo, &["help", "unknown-command"], json, "help", 2);
        outer_run(&repo, &["--version", "extra"], json, "--version", 2);
    }
}

#[test]
fn outer_repo_forget_ambiguous_canonical_suffix_is_usage_and_keeps_registrations() {
    let repo = Repo::new();
    repo.git(&[
        "remote",
        "add",
        "origin",
        "https://github.com/one/widget.git",
    ]);
    let second = repo.root.join("second");
    fs::create_dir_all(&second).unwrap();
    git_at(&repo, &second, &["init", "-b", "main"]);
    git_at(
        &repo,
        &second,
        &[
            "remote",
            "add",
            "origin",
            "https://github.com/two/widget.git",
        ],
    );
    assert!(repo.mabo(&["repo", "add"]).status.success());
    assert!(repo
        .mabo(&["repo", "add", second.to_str().unwrap()])
        .status
        .success());
    for json in [false, true] {
        let value = outer_run(&repo, &["repo", "forget", "widget"], json, "repo forget", 2);
        if json {
            assert_eq!(value["error"]["code"], "ambiguous");
        }
    }
    let value = outer_run(
        &repo,
        &["repo", "list", "--registered"],
        true,
        "repo list",
        0,
    );
    assert_eq!(value["data"]["repos"].as_array().unwrap().len(), 2);
}

#[test]
fn removed_identity_flags_are_usage_errors_with_migration_hints() {
    let repo = Repo::new();
    for command in [
        "create", "create", "--branch", "create", "create", "set", "list", "gc", "sync",
    ] {
        let flag = if command == "sync" {
            "--mine"
        } else {
            "--owner"
        };
        let expected = if command == "sync" {
            "explicit workspace names or --all"
        } else {
            "Ownership was removed"
        };
        for form in ["bare", "separate", "inline"] {
            let option = if form == "inline" {
                format!("{flag}=old-agent")
            } else {
                flag.into()
            };
            for output in [None, Some("--json"), Some("--output=json")] {
                let mut args = command.split_whitespace().collect::<Vec<_>>();
                args.push(&option);
                if form == "separate" && flag == "--owner" {
                    args.push("old-agent");
                }
                if let Some(output) = output {
                    args.push(output);
                }
                let out = repo.mabo(&args);
                assert_eq!(out.status.code(), Some(2), "{args:?}");
                let message = if output.is_some() {
                    assert!(out.stderr.is_empty(), "{args:?}: {}", text(&out.stderr));
                    let doc = assert_envelope(
                        &out,
                        if command == "create" {
                            "create"
                        } else {
                            command
                        },
                    );
                    assert_eq!(doc["error"]["code"], "usage");
                    assert!(doc["data"].is_null());
                    doc["error"]["message"].as_str().unwrap().to_string()
                } else {
                    assert!(out.stdout.is_empty(), "{args:?}: {}", text(&out.stdout));
                    text(&out.stderr)
                };
                assert!(message.contains(expected), "{args:?}: {message}");
                if flag == "--owner" {
                    for hint in ["--purpose", "PR links", "workspace names"] {
                        assert!(message.contains(hint), "{message}");
                    }
                }
            }
        }
    }
    // Removed options in a child command retain their original meaning.
    let out = repo.mabo(&["create", "child"]);
    assert!(out.status.success());
    let out = repo.mabo(&["exec", "child", "--", "printf", "%s", "--owner"]);
    assert!(out.status.success(), "{}", text(&out.stderr));
    let out = repo.mabo(&["exec", "child", "--", "printf", "%s", "--mine"]);
    assert!(out.status.success());
    assert_eq!(text(&out.stdout), "--mine");
}

#[test]
fn inspection_list_and_exec_leave_legacy_and_schema2_record_bytes_and_mtime_unchanged() {
    for legacy in [false, true] {
        let repo = Repo::new();
        let created = json_value(&repo.mabo(&["create", "feature", "--purpose", "task", "--json"]));
        let dir = repo.repo.join(".git/maboroshi/workspaces");
        let file = dir.join(format!(
            "{}.json",
            created["data"]["workspace"]["id"].as_str().unwrap()
        ));
        let mut record: serde_json::Value =
            serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
        record["owner"] = serde_json::json!("previous-agent");
        record["lastUsedAt"] = serde_json::json!("2000-01-01T00:00:00.000Z");
        let file = if legacy {
            record.as_object_mut().unwrap().remove("id");
            record.as_object_mut().unwrap().remove("schema");
            fs::remove_dir_all(&dir).unwrap();
            let file = repo.repo.join(".git/maboroshi/worktrees.json");
            fs::write(
                &file,
                serde_json::to_vec(&serde_json::json!({"version": 1, "worktrees": [record]}))
                    .unwrap(),
            )
            .unwrap();
            file
        } else {
            fs::write(&file, serde_json::to_vec(&record).unwrap()).unwrap();
            file
        };
        let sentinel = std::time::UNIX_EPOCH + std::time::Duration::from_secs(946684800);
        fs::File::options()
            .write(true)
            .open(&file)
            .unwrap()
            .set_modified(sentinel)
            .unwrap();
        let before = fs::read(&file).unwrap();
        let modified = fs::metadata(&file).unwrap().modified().unwrap();
        for args in [
            vec!["path", "feature"],
            vec!["path", "feature", "--json"],
            vec!["show", "feature"],
            vec!["show", "feature", "--json"],
            vec!["list"],
            vec!["list", "--json"],
            vec!["list", "--names"],
            vec!["list", "--paths"],
            vec!["exec", "feature", "--", "true"],
            vec!["exec", "feature", "--", "sh", "-c", "exit 17"],
        ] {
            let out = repo.mabo(&args);
            assert_eq!(
                out.status.code(),
                Some(if args.last() == Some(&"exit 17") {
                    17
                } else {
                    0
                }),
                "{args:?}: {}",
                text(&out.stderr)
            );
            if args.contains(&"--json") {
                let doc = json_value(&out);
                let workspace = &doc["data"]["workspace"];
                assert!(workspace.get("owner").is_none());
                assert!(workspace.get("lastUsedAt").is_none());
            }
            assert_eq!(fs::read(&file).unwrap(), before, "{args:?}");
            assert_eq!(
                fs::metadata(&file).unwrap().modified().unwrap(),
                modified,
                "{args:?}"
            );
            if legacy {
                assert!(!dir.exists(), "read-only command imported legacy state");
            }
        }
        let updated = repo.mabo(&["set", "feature", "--purpose", "task", "--json"]);
        assert!(updated.status.success(), "{}", text(&updated.stderr));
        let updated = json_value(&updated);
        let rewritten = dir.join(format!(
            "{}.json",
            updated["data"]["workspace"]["id"].as_str().unwrap()
        ));
        let rewritten: serde_json::Value =
            serde_json::from_slice(&fs::read(rewritten).unwrap()).unwrap();
        assert!(rewritten.get("owner").is_none());
        assert!(rewritten.get("lastUsedAt").is_none());
        assert_eq!(rewritten["purpose"], "task");
        assert_eq!(rewritten["schema"], 2);
        if legacy {
            assert_eq!(
                fs::read(file.with_extension("json.imported")).unwrap(),
                before
            );
        }
    }
}

#[test]
fn gc_age_selection_ignores_legacy_owner_and_last_used() {
    let repo = Repo::new();
    assert!(repo.mabo(&["create", "old"]).status.success());
    land_branch(&repo, "old");
    let dir = repo.repo.join(".git/maboroshi/workspaces");
    let mut record =
        serde_json::from_slice::<serde_json::Value>(&records::read(&dir).unwrap()).unwrap();
    record["worktrees"][0]["owner"] = serde_json::json!("another-agent");
    record["worktrees"][0]["createdAt"] = serde_json::json!("2000-01-01T00:00:00.000Z");
    record["worktrees"][0]["lastUsedAt"] = serde_json::json!("2099-01-01T00:00:00.000Z");
    records::write(&dir, serde_json::to_vec(&record).unwrap()).unwrap();
    for agent in [None, Some("different-agent")] {
        let mut command = repo.command(
            env!("CARGO_BIN_EXE_mabo"),
            &["gc", "--older-than", "14d", "--json"],
        );
        if let Some(agent) = agent {
            command.env("MABO_AGENT_ID", agent);
        }
        let out = command.output().unwrap();
        assert!(out.status.success(), "{}", text(&out.stderr));
        let doc = json_value(&out);
        let candidates = doc["data"]["items"].as_array().unwrap();
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0]["action"], "wouldRemove");
        assert!(candidates[0].get("owner").is_none());
        assert!(candidates[0].get("lastUsedAt").is_none());
    }
}

#[test]
fn selectors_resolve_linked_workspaces_across_inspection_and_mutations() {
    for selector in [
        "feature/select",
        ".",
        "pr:42",
        "issue:73",
        "https://github.com/acme/demo/pull/42",
        "https://github.com/acme/demo/issues/73",
    ] {
        let repo = Repo::new();
        let created = repo.create_recorded(&[
            "create",
            "feature/select",
            "--pr",
            "https://github.com/acme/demo/pull/42",
            "--issue",
            "https://github.com/acme/demo/issues/73",
            "--json",
        ]);
        assert!(created.status.success(), "{}", text(&created.stderr));
        let path = managed(&repo, "feature/select");
        let cwd = path.join("nested");
        fs::create_dir_all(&cwd).unwrap();
        let run = |args: &[&str]| {
            repo.command(env!("CARGO_BIN_EXE_mabo"), args)
                .current_dir(&cwd)
                .output()
                .unwrap()
        };
        for command in ["show", "path", "set", "exec", "sync"] {
            let mut args = vec![command, selector];
            match command {
                "set" => args.extend(["--purpose", "selected", "--json"]),
                "exec" => args.extend(["--", "pwd"]),
                "sync" => args.extend(["--no-default", "--json"]),
                _ => args.push("--json"),
            }
            let out = run(&args);
            assert_eq!(
                out.status.code(),
                Some(0),
                "{args:?}: {} {}",
                text(&out.stdout),
                text(&out.stderr)
            );
            if command == "exec" {
                assert!(same_dir(&text(&out.stdout), &path));
            } else {
                let value = assert_envelope(&out, command);
                if command == "path" {
                    assert_eq!(value["data"], serde_json::json!({"path": path}));
                }
                if matches!(command, "show" | "set") {
                    assert_eq!(value["data"]["workspace"]["name"], "feature/select");
                    assert_eq!(value["data"]["workspace"]["current"], true);
                }
            }
        }
        let out = run(&[
            "remove",
            selector,
            "--discard-changes",
            "--delete-unpreserved-branch",
            "--no-hooks",
            "--json",
        ]);
        assert_eq!(
            out.status.code(),
            Some(0),
            "{selector}: {} {}",
            text(&out.stdout),
            text(&out.stderr)
        );
        assert!(!path.exists());
    }
}

#[test]
fn selectors_fail_before_side_effects_for_missing_ambiguous_and_foreign_dot() {
    let repo = Repo::new();
    for name in ["one", "two"] {
        assert!(repo
            .create_recorded(&["create", name, "--pr", "42"])
            .status
            .success());
    }
    let other = repo.root.join("other");
    fs::create_dir(&other).unwrap();
    assert!(repo
        .command("git", &["init", "-b", "main", other.to_str().unwrap()])
        .output()
        .unwrap()
        .status
        .success());
    let records = repo.repo.join(".git/maboroshi/workspaces");
    let before = records::read(&records).unwrap();
    for command in ["show", "path", "set", "exec", "sync", "remove"] {
        for (selector, code, error) in [
            ("missing", 3, "not_found"),
            ("pr:999", 3, "not_found"),
            ("pr:42", 2, "ambiguous"),
            (".", 2, "usage"),
        ] {
            let mut args = vec![command];
            if selector == "." {
                args.extend(["-R", other.to_str().unwrap()]);
            }
            args.push(selector);
            match command {
                "set" => args.extend(["--purpose", "should not change"]),
                "exec" => args.extend(["--", "touch", "should-not-exist"]),
                "remove" => {}
                _ => {}
            }
            if command != "exec" {
                args.push("--json");
            }
            let out = repo.mabo(&args);
            assert_eq!(
                out.status.code(),
                Some(code),
                "{args:?}: {} {}",
                text(&out.stdout),
                text(&out.stderr)
            );
            if command != "exec" {
                if code == 0 {
                    assert_eq!(json_value(&out)["data"]["items"][0]["alreadyGone"], true);
                } else {
                    assert_eq!(assert_envelope(&out, command)["error"]["code"], error);
                }
            } else {
                assert!(out.stdout.is_empty());
            }
            assert_eq!(records::read(&records).unwrap(), before);
        }
        let mut args = vec![command, "."];
        if command == "set" {
            args.extend(["--purpose", "missing"]);
        }
        if command == "exec" {
            args.extend(["--", "true"]);
        } else {
            args.push("--json");
        }
        let out = repo
            .command(env!("CARGO_BIN_EXE_mabo"), &args)
            .current_dir(&repo.home)
            .output()
            .unwrap();
        assert_eq!(
            out.status.code(),
            Some(3),
            "{args:?}: {}",
            text(&out.stderr)
        );
    }
    assert!(!repo.repo.join("should-not-exist").exists());
}

#[test]
fn primary_and_unmanaged_checkout_inspection_and_default_exec() {
    let repo = Repo::new();
    let unmanaged = repo.root.join("unmanaged");
    repo.git(&[
        "worktree",
        "add",
        "-b",
        "plain",
        unmanaged.to_str().unwrap(),
    ]);
    for (cwd, kind) in [(&repo.repo, "primary"), (&unmanaged, "workspace")] {
        let run = |args: &[&str]| {
            repo.command(env!("CARGO_BIN_EXE_mabo"), args)
                .current_dir(cwd)
                .output()
                .unwrap()
        };
        for selector in [vec![], vec!["."]] {
            let mut args = vec!["show"];
            args.extend(selector.clone());
            args.push("--json");
            let out = run(&args);
            assert!(out.status.success(), "{}", text(&out.stderr));
            let object = &assert_envelope(&out, "show")["data"]["workspace"];
            assert_eq!(object["managed"], false);
            assert_eq!(object["kind"], kind);
            assert_eq!(object["current"], true);
            assert_eq!(object["repo"]["root"], repo.repo.to_str().unwrap());
            for field in [
                "id",
                "purpose",
                "createdAt",
                "updatedAt",
                "createdFrom",
                "base",
                "upstream",
            ] {
                assert!(object[field].is_null(), "{field}: {object}");
            }
            let mut args = vec!["path"];
            args.extend(selector);
            let out = run(&args);
            assert_eq!(out.stdout, format!("{}\n", cwd.display()).as_bytes());
        }
        let out = run(&["exec", "--", "pwd"]);
        assert_eq!(out.status.code(), Some(0));
        assert!(same_dir(&text(&out.stdout), cwd));
        let out = run(&["exec", "--", "sh", "-c", "exit 37"]);
        assert_eq!(out.status.code(), Some(37));
    }
}

#[test]
fn set_unset_takes_one_field_and_preserves_the_following_selector() {
    let repo = Repo::new();
    assert!(repo.mabo(&["create", "feature/auth"]).status.success());
    for args in [
        vec!["set", "--unset", "purpose", "feature/auth", "--json"],
        vec!["set", "--unset=purpose", "feature/auth", "--json"],
        vec![
            "set",
            "--unset",
            "purpose",
            "--unset",
            "base",
            "feature/auth",
            "--json",
        ],
        vec![
            "set",
            "--unset",
            "purpose",
            "feature/auth",
            "--unset",
            "base",
            "--json",
        ],
    ] {
        assert!(repo
            .mabo(&[
                "set",
                "feature/auth",
                "--purpose",
                "task",
                "--base",
                "main",
                "--pr",
                "42"
            ])
            .status
            .success());
        let out = repo.mabo(&args);
        assert_eq!(
            out.status.code(),
            Some(0),
            "{args:?}: {}",
            text(&out.stdout)
        );
        let value = assert_envelope(&out, "set");
        let workspace = &value["data"]["workspace"];
        assert_eq!(workspace["name"], "feature/auth");
        assert!(workspace["purpose"].is_null());
        if args.contains(&"base") {
            assert!(workspace["base"].is_null());
        } else {
            assert_eq!(workspace["base"], "refs/heads/main");
        }
        assert_eq!(workspace["links"]["pr"]["number"], 42);
        let primary = assert_envelope(&repo.mabo(&["show", "--json"]), "show");
        assert!(primary["data"]["workspace"]["id"].is_null());
    }
}

#[test]
fn set_updates_and_unsets_every_intent_field_atomically() {
    let repo = Repo::new();
    let created = json_value(&repo.mabo(&["create", "intent", "--json"]));
    let run = |args: &[&str]| {
        repo.command(env!("CARGO_BIN_EXE_mabo"), args)
            .current_dir(managed(&repo, "intent"))
            .output()
            .unwrap()
    };
    let out = run(&[
        "set",
        "--purpose",
        "new task",
        "--base",
        "main",
        "--pr",
        "42",
        "--issue",
        "https://github.com/acme/demo/issues/73",
        "--json",
    ]);
    assert!(out.status.success(), "{}", text(&out.stderr));
    let value = assert_envelope(&out, "set");
    let workspace = &value["data"]["workspace"];
    assert_eq!(workspace["purpose"], "new task");
    assert_eq!(workspace["base"], "refs/heads/main");
    assert_eq!(workspace["links"]["pr"]["number"], 42);
    assert_eq!(workspace["links"]["issue"]["number"], 73);
    assert_eq!(workspace["id"], created["data"]["workspace"]["id"]);
    assert_eq!(
        workspace["createdAt"],
        created["data"]["workspace"]["createdAt"]
    );
    assert!(workspace["updatedAt"].is_string());
    let records = repo.repo.join(".git/maboroshi/workspaces");
    for args in [
        vec!["set", "--unset", "unknown", "--json"],
        vec!["set", "--base", "does-not-exist", "--json"],
        vec!["set", "--purpose", "x", "--unset", "purpose", "--json"],
    ] {
        let before = records::read(&records).unwrap();
        let out = run(&args);
        assert_eq!(
            out.status.code(),
            Some(2),
            "{args:?}: {}",
            text(&out.stdout)
        );
        assert_eq!(assert_envelope(&out, "set")["error"]["code"], "usage");
        assert_eq!(records::read(&records).unwrap(), before);
    }
    for field in ["purpose", "base", "pr", "issue"] {
        let out = run(&["set", "--unset", field, "--json"]);
        assert!(out.status.success(), "{}", text(&out.stderr));
        let value = assert_envelope(&out, "set");
        let object = &value["data"]["workspace"];
        assert!(if matches!(field, "pr" | "issue") {
            &object["links"][field]
        } else {
            &object[field]
        }
        .is_null());
    }
    let out = run(&[
        "set", "--unset", "purpose", "--unset", "base", "--unset", "pr", "--unset", "issue",
        "--json",
    ]);
    assert_eq!(out.status.code(), Some(0), "{}", text(&out.stderr));
}

#[test]
fn removed_inspection_interfaces_and_usage_keep_stdout_clean() {
    let repo = Repo::new();
    for (args, hint) in [
        (
            vec!["where", "main"],
            "`mabo path [SEL]` or `mabo show [SEL] --json`",
        ),
        (vec!["meta"], "`mabo set [SEL]` or `mabo show [SEL]`"),
        (vec!["meta", "set", "main"], "show"),
        (vec!["list", "--no-default"], "--kind workspace"),
    ] {
        for json in [false, true] {
            let mut args = args.clone();
            if json {
                args.push("--json");
            }
            let out = repo.mabo(&args);
            assert_eq!(out.status.code(), Some(2), "{args:?}");
            let message = if json {
                let document = json_value(&out);
                assert_eq!(document["error"]["code"], "usage");
                document["error"]["message"].as_str().unwrap().to_owned()
            } else {
                assert!(out.stdout.is_empty());
                text(&out.stderr)
            };
            assert!(message.contains(hint), "{args:?}: {message}");
        }
    }
    for args in [
        vec!["nonsense"],
        vec!["nonsense", "--help"],
        vec!["show", "--bogus"],
        vec!["show", "a", "b"],
        vec!["path", "--bogus"],
        vec!["set", "--unset", "bogus"],
        vec!["list", "--kind", "bogus"],
        vec!["exec", "main", "true"],
    ] {
        let out = repo.mabo(&args);
        assert_eq!(out.status.code(), Some(2), "{args:?}");
        assert!(out.stdout.is_empty(), "{args:?}: {}", text(&out.stdout));
        if args[0] == "exec" {
            assert!(text(&out.stderr).contains("exec [SEL] --"));
        }
    }
    // Exec ignores the output default even for a rejected old invocation.
    let out = repo
        .command(env!("CARGO_BIN_EXE_mabo"), &["exec", "main", "true"])
        .env("MABO_OUTPUT", "json")
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(2));
    assert!(out.stdout.is_empty());
    assert!(text(&out.stderr).contains("exec [SEL] --"));
}

#[test]
fn inspection_leaves_orphaned_checkout_observations_null() {
    let repo = Repo::new();
    let created = repo.mabo(&["create", "gone", "--base", "main"]);
    assert!(created.status.success(), "{}", text(&created.stderr));
    repo.git(&["branch", "--set-upstream-to=main", "gone"]);
    let path = managed(&repo, "gone");
    repo.git(&["worktree", "remove", path.to_str().unwrap()]);
    let trace = repo.root.join("git-trace.json");
    for command in ["show", "list"] {
        let args = if command == "show" {
            vec!["show", "gone", "--json"]
        } else {
            vec!["list", "--json"]
        };
        fs::write(&trace, "").unwrap();
        let out = repo
            .command(env!("CARGO_BIN_EXE_mabo"), &args)
            .env("GIT_TRACE2_EVENT", &trace)
            .output()
            .unwrap();
        assert!(out.status.success(), "{}", text(&out.stderr));
        let value = assert_envelope(&out, command);
        let workspace = if command == "show" {
            &value["data"]["workspace"]
        } else {
            value["data"]["workspaces"]
                .as_array()
                .unwrap()
                .iter()
                .find(|entry| entry["name"] == "gone")
                .unwrap()
        };
        assert_eq!(workspace["orphaned"], true);
        for field in ["upstream", "branch", "head", "dirty", "detached"] {
            assert!(workspace[field].is_null(), "{command}: {field}");
        }
        let events = fs::read_to_string(&trace).unwrap();
        for line in events.lines() {
            let event: serde_json::Value = serde_json::from_str(line).unwrap();
            if let Some(argv) = event["argv"].as_array() {
                assert!(
                    !argv
                        .iter()
                        .any(|arg| arg == "refs/heads/gone" || arg == path.to_str().unwrap()),
                    "{line}"
                );
            }
            assert_ne!(event["worktree"], path.to_string_lossy().as_ref(), "{line}");
        }
    }
}

#[test]
fn inspection_uses_worktree_config_for_upstream() {
    assert_inspection_uses_checkout_config(false);
}

#[test]
fn inspection_uses_gitdir_include_for_upstream() {
    assert_inspection_uses_checkout_config(true);
}

fn assert_inspection_uses_checkout_config(include: bool) {
    let repo = Repo::new();
    repo.git(&[
        "remote",
        "add",
        "origin",
        "https://example.invalid/repo.git",
    ]);
    repo.git(&["update-ref", "refs/remotes/origin/main", "HEAD"]);
    repo.git(&[
        "update-ref",
        "refs/remotes/origin/checkout-upstream",
        "HEAD",
    ]);
    let created = repo.mabo(&["create", "local", "--base", "main", "--json"]);
    assert!(created.status.success(), "{}", text(&created.stderr));
    let path = managed(&repo, "local");
    repo.git(&["config", "branch.local.remote", "origin"]);
    repo.git(&[
        "config",
        "branch.local.merge",
        "refs/heads/checkout-upstream",
    ]);
    repo.git(&["config", "branch.main.remote", "origin"]);
    repo.git(&["config", "branch.main.merge", "refs/heads/main"]);
    let git = |args: &[&str]| {
        let out = repo
            .command("git", args)
            .current_dir(&path)
            .output()
            .unwrap();
        assert!(out.status.success(), "{}", text(&out.stderr));
        text(&out.stdout)
    };
    fs::write(path.join("local"), "local\n").unwrap();
    git(&["add", "local"]);
    git(&["commit", "-m", "local change"]);
    let head = git(&["rev-parse", "HEAD"]);
    fs::write(repo.repo.join("primary"), "primary\n").unwrap();
    repo.git(&["add", "primary"]);
    repo.git(&["commit", "-m", "primary change"]);
    repo.git(&["branch", "checkout-upstream", "main"]);
    if include {
        let config = repo.root.join("checkout.gitconfig");
        fs::write(
            &config,
            "[branch \"local\"]\nremote = .\nmerge = refs/heads/checkout-upstream\n[status]\nshowUntrackedFiles = no\n",
        ).unwrap();
        let git_dir = git(&["rev-parse", "--absolute-git-dir"]);
        repo.git(&[
            "config",
            &format!("includeIf.gitdir:{git_dir}.path"),
            config.to_str().unwrap(),
        ]);
    } else {
        repo.git(&["config", "extensions.worktreeConfig", "true"]);
        git(&["config", "--worktree", "branch.local.remote", "."]);
        git(&[
            "config",
            "--worktree",
            "branch.local.merge",
            "refs/heads/checkout-upstream",
        ]);
        git(&["config", "--worktree", "status.showUntrackedFiles", "no"]);
    }
    fs::write(
        path.join("untracked"),
        "ignored by checkout status config\n",
    )
    .unwrap();
    assert_eq!(
        git(&["rev-parse", "--symbolic-full-name", "local@{upstream}"]),
        "refs/heads/checkout-upstream"
    );
    assert_eq!(upstream_name(&repo, "local"), "origin/checkout-upstream");
    let store = repo.repo.join(".git/maboroshi/workspaces");
    let before = records::read(&store).unwrap();
    for gone in [false, true] {
        if gone {
            repo.git(&["branch", "-D", "checkout-upstream"]);
        }
        for cwd in [&repo.repo, &path] {
            for command in ["show", "list"] {
                let args = if command == "show" {
                    vec!["show", "local", "--json"]
                } else {
                    vec!["list", "--json"]
                };
                let out = repo
                    .command(env!("CARGO_BIN_EXE_mabo"), &args)
                    .current_dir(cwd)
                    .output()
                    .unwrap();
                assert!(out.status.success(), "{}", text(&out.stderr));
                let value = assert_envelope(&out, command);
                let workspace = if command == "show" {
                    &value["data"]["workspace"]
                } else {
                    let entries = value["data"]["workspaces"].as_array().unwrap();
                    let primary = entries
                        .iter()
                        .find(|entry| entry["kind"] == "primary")
                        .unwrap();
                    assert_eq!(
                        primary["upstream"],
                        serde_json::json!({"ref":"refs/remotes/origin/main", "ahead":1, "behind":0, "gone":false})
                    );
                    entries
                        .iter()
                        .find(|entry| entry["name"] == "local")
                        .unwrap()
                };
                let expected = if gone {
                    serde_json::json!({"ref":"refs/heads/checkout-upstream", "ahead":null, "behind":null, "gone":true})
                } else {
                    serde_json::json!({"ref":"refs/heads/checkout-upstream", "ahead":1, "behind":1, "gone":false})
                };
                assert_eq!(
                    workspace["upstream"], expected,
                    "{command}, include={include}, gone={gone}, cwd={cwd:?}"
                );
                assert_eq!(workspace["branch"], "local");
                assert_eq!(workspace["head"], head);
                assert_eq!(workspace["dirty"], false);
                assert_eq!(workspace["detached"], false);
            }
        }
    }
    assert_eq!(records::read(&store).unwrap(), before);
}

#[test]
fn list_filters_current_links_upstream_and_all_known_repositories() {
    let repo = Repo::new();
    let second = repo.root.join("second");
    fs::create_dir(&second).unwrap();
    assert!(repo
        .command("git", &["init", "-b", "main", second.to_str().unwrap()])
        .output()
        .unwrap()
        .status
        .success());
    for path in [&repo.repo, &second] {
        assert!(repo
            .mabo(&["repo", "add", path.to_str().unwrap()])
            .status
            .success());
    }
    assert!(repo
        .create_recorded(&[
            "create",
            "listed",
            "--purpose",
            "inspect me",
            "--pr",
            "42",
            "--issue",
            "73"
        ])
        .status
        .success());
    repo.git(&["branch", "--set-upstream-to=main", "listed"]);
    let path = managed(&repo, "listed");
    fs::write(path.join("ahead"), "ahead").unwrap();
    let git = |args: &[&str]| {
        let out = repo
            .command("git", args)
            .current_dir(&path)
            .output()
            .unwrap();
        assert!(out.status.success(), "{}", text(&out.stderr));
    };
    git(&["add", "ahead"]);
    git(&["commit", "-m", "ahead"]);
    fs::write(repo.repo.join("behind"), "behind").unwrap();
    repo.git(&["add", "behind"]);
    repo.git(&["commit", "-m", "behind"]);
    let run = |args: &[&str]| {
        repo.command(env!("CARGO_BIN_EXE_mabo"), args)
            .current_dir(&path)
            .output()
            .unwrap()
    };
    let out = run(&["list", "--kind", "workspace", "--json"]);
    let value = assert_envelope(&out, "list");
    assert_eq!(value["data"]["workspaces"].as_array().unwrap().len(), 1);
    let workspace = &value["data"]["workspaces"][0];
    assert_eq!(workspace["current"], true);
    assert_eq!(
        workspace["upstream"],
        serde_json::json!({"ref":"refs/heads/main", "ahead":1, "behind":1, "gone":false})
    );
    assert_eq!(workspace["links"]["pr"]["number"], 42);
    for (flag, expected) in [
        ("--names", "listed".to_owned()),
        ("--paths", path.to_string_lossy().into_owned()),
    ] {
        let out = repo
            .command(
                env!("CARGO_BIN_EXE_mabo"),
                &["list", "--kind", "workspace", flag],
            )
            .env("MABO_OUTPUT", "json")
            .output()
            .unwrap();
        assert_eq!(text(&out.stdout), expected);
    }
    let out = run(&["list", "--kind", "primary", "--json"]);
    let value = assert_envelope(&out, "list");
    assert_eq!(value["data"]["workspaces"].as_array().unwrap().len(), 1);
    assert_eq!(value["data"]["workspaces"][0]["kind"], "primary");
    let out = run(&["list"]);
    let display = text(&out.stdout);
    for expected in [
        "primary:",
        "* listed",
        "↑1 ↓1",
        "#42",
        "issue #73",
        "inspect me",
    ] {
        assert!(display.contains(expected), "{display}");
    }
    repo.git(&["branch", "upstream-gone", "main"]);
    repo.git(&["branch", "--set-upstream-to=upstream-gone", "listed"]);
    repo.git(&["branch", "-D", "upstream-gone"]);
    let out = run(&["show", "listed", "--json"]);
    let value = assert_envelope(&out, "show");
    assert_eq!(
        value["data"]["workspace"]["upstream"],
        serde_json::json!({"ref":"refs/heads/upstream-gone", "ahead":null, "behind":null, "gone":true})
    );
    assert!(text(&run(&["list"]).stdout).contains("upstream:gone"));
    let out = run(&["list", "--all-repos", "--json"]);
    assert!(out.status.success(), "{}", text(&out.stderr));
    let value = assert_envelope(&out, "list");
    assert_eq!(value["data"]["repos"].as_array().unwrap().len(), 2);
    assert_eq!(value["data"]["workspaces"].as_array().unwrap().len(), 3);
    let out = run(&["list", "--all-repos"]);
    assert!(out.status.success());
    assert_eq!(text(&out.stdout).matches("(primary:").count(), 2);
    assert!(text(&out.stdout).contains("* listed"));
}

#[test]
fn linked_urls_respect_repository_identity_and_url_navigation() {
    let repo = Repo::new();
    repo.git(&["remote", "add", "origin", "git@github.com:acme/demo.git"]);
    assert!(repo
        .create_recorded(&["create", "linked", "--base", "main", "--pr", "42", "--issue", "73"])
        .status
        .success());
    for selector in [
        "https://github.com/acme/demo/pull/42",
        "https://github.com/acme/demo/issues/73?plain=1#details",
    ] {
        let out = repo.mabo(&["show", selector, "--json"]);
        assert_eq!(out.status.code(), Some(0), "{}", text(&out.stderr));
        assert_eq!(
            json_value(&out)["data"]["workspace"]["repo"]["name"],
            "github.com/acme/demo"
        );
    }
    for selector in [
        "https://github.com/other/demo/pull/42",
        "https://github.com/acme/demo/issues/42",
    ] {
        let out = repo.mabo(&["show", selector, "--json"]);
        assert_eq!(out.status.code(), Some(3));
        assert_eq!(json_value(&out)["error"]["code"], "not_found");
    }
    for selector in [
        "pr:0",
        "issue:nope",
        "pr:https://github.com/acme/demo/pull/42",
        "https://github.com/acme/demo/tree/42",
    ] {
        assert_eq!(
            repo.mabo(&["show", selector, "--json"]).status.code(),
            Some(2),
            "{selector}"
        );
    }
    assert!(repo
        .mabo(&[
            "set",
            "linked",
            "--pr",
            "https://github.com/acme/demo/pull/42"
        ])
        .status
        .success());
    assert_eq!(
        repo.mabo(&[
            "show",
            "https://github.com/acme/demo/pull/42?diff=split#discussion",
            "--json"
        ])
        .status
        .code(),
        Some(0)
    );
}

#[test]
fn dot_primary_can_be_set_and_synced_and_is_protected_from_deletion() {
    let repo = Repo::new();
    let out = repo.mabo(&["set", "--purpose", "primary context", "--json"]);
    assert_eq!(out.status.code(), Some(0), "{}", text(&out.stderr));
    let value = assert_envelope(&out, "set");
    assert_eq!(value["data"]["workspace"]["kind"], "primary");
    assert_eq!(value["data"]["workspace"]["managed"], false);
    assert_eq!(value["data"]["workspace"]["purpose"], "primary context");
    let out = repo.mabo(&["sync", ".", "--json"]);
    assert_eq!(out.status.code(), Some(0), "{}", text(&out.stdout));
    let out = repo.mabo(&[
        "remove",
        ".",
        "--discard-changes",
        "--delete-unpreserved-branch",
        "--json",
    ]);
    assert_eq!(out.status.code(), Some(4));
    assert_eq!(assert_envelope(&out, "remove")["error"]["code"], "primary");
    assert!(repo.repo.is_dir());
}

#[test]
fn all_repos_uses_enabled_discovery_without_importing_workspace_records() {
    let repo = Repo::new();
    let clones = repo.root.join("clones");
    let discovered = clones.join("github.com/acme/discovered");
    fs::create_dir_all(&discovered).unwrap();
    assert!(repo
        .command("git", &["init", "-b", "main", discovered.to_str().unwrap()])
        .output()
        .unwrap()
        .status
        .success());
    assert!(repo.mabo(&["repo", "add"]).status.success());
    assert!(repo
        .mabo(&["config", "set", "clone-root", clones.to_str().unwrap()])
        .status
        .success());
    let out = repo.mabo(&["list", "--all-repos", "--json"]);
    assert_eq!(out.status.code(), Some(0), "{}", text(&out.stderr));
    let value = assert_envelope(&out, "list");
    assert_eq!(value["data"]["repos"].as_array().unwrap().len(), 2);
    assert!(value["data"]["repos"]
        .as_array()
        .unwrap()
        .iter()
        .any(|r| r["name"] == "github.com/acme/discovered"));
    assert!(!discovered.join(".git/maboroshi").exists());
    assert!(repo
        .mabo(&["config", "set", "discover-ghq", "false"])
        .status
        .success());
    let out = repo.mabo(&["list", "--all-repos", "--json"]);
    assert_eq!(
        json_value(&out)["data"]["repos"].as_array().unwrap().len(),
        1
    );
    for args in [
        vec!["list", "--all-repos", "-R", repo.repo.to_str().unwrap()],
        vec!["list", "--names", "--paths"],
        vec!["list", "--paths", "--json"],
    ] {
        let out = repo.mabo(&args);
        assert_eq!(out.status.code(), Some(2));
    }
}

#[test]
fn delete_link_selector_cannot_change_paths_after_a_hook_relinks_it() {
    let repo = Repo::new();
    for (name, pr) in [("one", "42"), ("two", "43")] {
        assert!(repo
            .create_recorded(&["create", name, "--pr", pr])
            .status
            .success());
    }
    let second = managed(&repo, "two");
    let out = repo
        .command("git", &["checkout", "--ignore-other-worktrees", "one"])
        .current_dir(&second)
        .output()
        .unwrap();
    assert!(out.status.success(), "{}", text(&out.stderr));
    let script = format!(
        "test \"$MABO_WORKSPACE\" = one && '{}' set one --unset pr && '{}' set two --pr 42",
        env!("CARGO_BIN_EXE_mabo"),
        env!("CARGO_BIN_EXE_mabo")
    );
    let config = format!(
        "[hooks]\npre-remove = [{}, \"printf '%s\\n' \\\"$MABO_WORKSPACE_PATH\\\" > hook-target\"]\n",
        serde_json::to_string(&script).unwrap()
    );
    fs::write(repo.repo.join(".mabo.toml"), config).unwrap();
    let out = repo.mabo(&[
        "remove",
        "pr:42",
        "--discard-changes",
        "--delete-unpreserved-branch",
        "--keep-branch",
        "--json",
    ]);
    assert_ne!(out.status.code(), Some(0), "{}", text(&out.stdout));
    assert!(managed(&repo, "one").is_dir());
    assert!(second.is_dir());
    assert_eq!(
        fs::read_to_string(managed(&repo, "one").join("hook-target"))
            .unwrap()
            .trim(),
        managed(&repo, "one").to_str().unwrap()
    );
    assert!(!second.join("hook-target").exists());
    assert_eq!(
        json_value(&repo.mabo(&["show", "pr:42", "--json"]))["data"]["workspace"]["name"],
        "two"
    );
}

#[test]
fn set_invalid_base_reports_a_clear_error_without_git_stderr() {
    let repo = Repo::new();
    assert!(repo.mabo(&["create", "topic"]).status.success());
    for json in [false, true] {
        let mut args = vec!["set", "topic", "--base", "does-not-exist"];
        if json {
            args.push("--json");
        }
        let out = repo.mabo(&args);
        assert_eq!(out.status.code(), Some(2));
        let message = if json {
            let doc = assert_envelope(&out, "set");
            assert_eq!(doc["error"]["code"], "usage");
            assert!(out.stderr.is_empty(), "{}", text(&out.stderr));
            doc["error"]["message"].as_str().unwrap().to_owned()
        } else {
            assert!(out.stdout.is_empty());
            text(&out.stderr)
        };
        assert!(
            message.contains("Base 'does-not-exist' is not a valid ref"),
            "{message}"
        );
        assert!(!message.contains("fatal:"), "{message}");
    }
}

#[test]
fn delete_stops_before_next_hook_when_checkout_directory_is_replaced() {
    let repo = Repo::new();
    assert!(repo.mabo(&["create", "topic"]).status.success());
    let path = managed(&repo, "topic");
    let replace = "mv \"$MABO_WORKSPACE_PATH\" \"$MABO_WORKSPACE_PATH.old\" && mkdir \"$MABO_WORKSPACE_PATH\" && cp \"$MABO_WORKSPACE_PATH.old/.git\" \"$MABO_WORKSPACE_PATH/.git\"";
    fs::write(
        repo.repo.join(".mabo.toml"),
        format!(
            "[hooks]\npre-remove = [{}, \"touch second-hook-ran\"]\n",
            serde_json::to_string(replace).unwrap()
        ),
    )
    .unwrap();
    let out = repo.mabo(&[
        "remove",
        "topic",
        "--discard-changes",
        "--delete-unpreserved-branch",
        "--keep-branch",
        "--json",
    ]);
    assert_ne!(out.status.code(), Some(0));
    assert!(
        text(&out.stdout).contains("Workspace changed before running hook command"),
        "{}",
        text(&out.stdout)
    );
    assert!(path.is_dir());
    assert!(!path.join("second-hook-ran").exists());
}

#[test]
fn delete_legacy_workspaces_with_hooks_survives_id_migration() {
    assert_legacy_delete_with_hooks(false);
}

#[test]
fn delete_legacy_workspaces_survives_id_migration_inside_hook() {
    assert_legacy_delete_with_hooks(true);
}

fn assert_legacy_delete_with_hooks(migrate_in_hook: bool) {
    let repo = Repo::new();
    let paths = [managed(&repo, "one"), managed(&repo, "two")];
    for (name, path) in ["one", "two"].iter().zip(&paths) {
        repo.git(&["worktree", "add", "-b", name, path.to_str().unwrap()]);
    }
    let legacy = repo.repo.join(".git/maboroshi/worktrees.json");
    fs::create_dir_all(legacy.parent().unwrap()).unwrap();
    let fixture = serde_json::to_vec(&serde_json::json!({
        "version": 1, "worktrees": [{"path": paths[0]}, {"path": paths[1]}]
    }))
    .unwrap();
    fs::write(&legacy, &fixture).unwrap();
    let first = if migrate_in_hook {
        format!("'{}' set . --purpose migrated", env!("CARGO_BIN_EXE_mabo"))
    } else {
        "true".to_owned()
    };
    let commands = [
        first,
        "printf '%s\\n' \"$MABO_WORKSPACE\" >> \"$MABO_REPO_PATH/hooks-ran\"".to_owned(),
    ];
    fs::write(
        repo.repo.join(".mabo.toml"),
        format!(
            "[hooks]\npre-remove = {}\n",
            serde_json::to_string(&commands).unwrap()
        ),
    )
    .unwrap();
    // Exercise persisted trust rather than the test helper's trust-all override.
    assert!(repo.mabo(&["trust", "add"]).status.success());
    let out = repo
        .command(
            env!("CARGO_BIN_EXE_mabo"),
            &[
                "remove",
                "one",
                "two",
                "--discard-changes",
                "--delete-unpreserved-branch",
                "--keep-branch",
                "--json",
            ],
        )
        .env_remove("MABO_TRUST_ALL")
        .output()
        .unwrap();
    assert_eq!(
        out.status.code(),
        Some(0),
        "migrate_in_hook={migrate_in_hook}: {} {}",
        text(&out.stdout),
        text(&out.stderr)
    );
    assert_eq!(
        fs::read_to_string(repo.repo.join("hooks-ran")).unwrap(),
        "one\ntwo\n"
    );
    assert!(paths.iter().all(|path| !path.exists()));
    assert!(!legacy.exists());
    assert_eq!(
        fs::read(legacy.with_extension("json.imported")).unwrap(),
        fixture
    );
    let records = records::read(repo.repo.join(".git/maboroshi/workspaces")).unwrap();
    let records: serde_json::Value = serde_json::from_slice(&records).unwrap();
    assert!(records["worktrees"].as_array().unwrap().is_empty());
}

#[test]
fn delete_stops_when_a_migrated_record_is_replaced_between_hooks() {
    let repo = Repo::new();
    let path = managed(&repo, "topic");
    repo.git(&["worktree", "add", "-b", "topic", path.to_str().unwrap()]);
    let legacy = repo.repo.join(".git/maboroshi/worktrees.json");
    fs::create_dir_all(legacy.parent().unwrap()).unwrap();
    fs::write(
        &legacy,
        serde_json::to_vec(&serde_json::json!({"version": 1, "worktrees": [{"path": path}]}))
            .unwrap(),
    )
    .unwrap();
    let bin = env!("CARGO_BIN_EXE_mabo");
    let commands = [
        format!("'{bin}' set . --purpose migrated"),
        format!("rm \"$MABO_REPO_PATH/.git/maboroshi/workspaces/$MABO_WORKSPACE_ID.json\" && '{bin}' set . --purpose replacement"),
        "touch third-hook-ran".to_owned(),
    ];
    fs::write(
        repo.repo.join(".mabo.toml"),
        format!(
            "[hooks]\npre-remove = {}\n",
            serde_json::to_string(&commands).unwrap()
        ),
    )
    .unwrap();
    let out = repo.mabo(&[
        "remove",
        "topic",
        "--discard-changes",
        "--delete-unpreserved-branch",
        "--keep-branch",
        "--json",
    ]);
    assert_ne!(out.status.code(), Some(0));
    assert!(
        text(&out.stdout).contains("Workspace changed before running hook command"),
        "{}",
        text(&out.stdout)
    );
    assert!(path.is_dir());
    assert!(!path.join("third-hook-ran").exists());
    let out = repo.mabo(&["show", "topic", "--json"]);
    assert_eq!(
        assert_envelope(&out, "show")["data"]["workspace"]["purpose"],
        "replacement"
    );
}

#[test]
fn selector_urls_strip_the_final_link_suffix_for_reserved_repository_names() {
    for (repo_name, kind, flag, number) in [
        ("issues", "issues", "--issue", "73"),
        ("pull", "pull", "--pr", "5"),
        ("issue", "issue", "--issue", "73"),
        ("pulls", "pulls", "--pr", "5"),
    ] {
        for url_link in [false, true] {
            let repo = Repo::new();
            repo.git(&[
                "remote",
                "add",
                "origin",
                &format!("git@github.com:acme/{repo_name}.git"),
            ]);
            let url = format!("https://github.com/acme/{repo_name}/{kind}/{number}");
            let link = if url_link { &url } else { number };
            assert!(repo
                .create_recorded(&["create", "linked", "--base", "main", flag, link])
                .status
                .success());
            for selector in [url.clone(), format!("{url}/?plain=1#details")] {
                let out = repo.mabo(&["show", &selector, "--json"]);
                assert_eq!(
                    out.status.code(),
                    Some(0),
                    "{selector}, url_link={url_link}: {} {}",
                    text(&out.stdout),
                    text(&out.stderr)
                );
                assert_eq!(
                    assert_envelope(&out, "show")["data"]["workspace"]["name"],
                    "linked"
                );
            }
            let foreign = format!("https://github.com/other/{repo_name}/{kind}/{number}");
            let out = repo.mabo(&["show", &foreign, "--json"]);
            assert_eq!(out.status.code(), Some(3));
            assert_eq!(assert_envelope(&out, "show")["error"]["code"], "not_found");
        }
    }
}

#[test]
fn selector_urls_use_the_terminal_pair_for_selection_and_deletion() {
    for (kind, flag) in [
        ("pull", "--pr"),
        ("pulls", "--pr"),
        ("issues", "--issue"),
        ("issue", "--issue"),
    ] {
        for url_link in [false, true] {
            let repo = Repo::new();
            repo.git(&[
                "remote",
                "add",
                "origin",
                "git@git.example.com:pull/123.git",
            ]);
            let url = format!("https://git.example.com/pull/123/{kind}/42");
            assert!(repo
                .create_recorded(&["create", "earlier", "--base", "main", flag, "123"])
                .status
                .success());
            assert!(repo
                .create_recorded(&[
                    "create",
                    "terminal",
                    "--base",
                    "main",
                    flag,
                    if url_link { &url } else { "42" }
                ])
                .status
                .success());
            for selector in [url.clone(), format!("{url}/?plain=1#details")] {
                let out = repo.mabo(&["show", &selector, "--json"]);
                assert_eq!(
                    out.status.code(),
                    Some(0),
                    "{} {}",
                    text(&out.stdout),
                    text(&out.stderr)
                );
                assert_eq!(
                    assert_envelope(&out, "show")["data"]["workspace"]["name"],
                    "terminal",
                    "{selector}, url_link={url_link}"
                );
            }
            let out = repo.mabo(&[
                "remove",
                &url,
                "--discard-changes",
                "--delete-unpreserved-branch",
                "--keep-branch",
                "--json",
            ]);
            assert_eq!(
                out.status.code(),
                Some(0),
                "{} {}",
                text(&out.stdout),
                text(&out.stderr)
            );
            assert_eq!(
                assert_envelope(&out, "remove")["data"]["items"][0]["workspace"]["name"],
                "terminal"
            );
            assert!(managed(&repo, "earlier").is_dir());
            assert!(!managed(&repo, "terminal").exists());
        }
    }
}

#[test]
fn create_and_set_save_link_numbers_from_the_terminal_pair() {
    for (kind, flag, field) in [
        ("pull", "--pr", "pr"),
        ("pulls", "--pr", "pr"),
        ("issues", "--issue", "issue"),
        ("issue", "--issue", "issue"),
    ] {
        let repo = Repo::new();
        for (command, number) in [("create", 42), ("set", 43)] {
            let url = format!("https://git.example.com/pull/123/{kind}/{number}/?plain=1#details");
            let out = if command == "create" {
                repo.create_recorded(&[command, "linked", flag, &url, "--json"])
            } else {
                repo.mabo(&[command, "linked", flag, &url, "--json"])
            };
            assert_eq!(
                out.status.code(),
                Some(0),
                "{} {}",
                text(&out.stdout),
                text(&out.stderr)
            );
            let workspace =
                &assert_envelope(&out, if command == "create" { "show" } else { command })["data"]
                    ["workspace"];
            assert_eq!(workspace["links"][field]["number"], number);
            assert_eq!(workspace["links"][field]["url"], url);
            let out = repo.mabo(&["show", "linked", "--json"]);
            assert_eq!(
                assert_envelope(&out, "show")["data"]["workspace"]["links"][field]["number"],
                number
            );
        }
    }
}

#[test]
fn delete_current_does_not_revalidate_the_resolved_branch_name() {
    let repo = Repo::new();
    let tree = managed(&repo, "topic+fix");
    repo.git(&[
        "worktree",
        "add",
        "-b",
        "topic+fix",
        tree.to_str().unwrap(),
        "main",
    ]);
    fs::write(tree.join("dirty"), "local changes\n").unwrap();
    let refused = repo
        .command(env!("CARGO_BIN_EXE_mabo"), &["remove", "."])
        .current_dir(&tree)
        .output()
        .unwrap();
    assert_eq!(refused.status.code(), Some(4));
    assert!(text(&refused.stderr).contains("topic+fix"));
    fs::remove_file(tree.join("dirty")).unwrap();
    let out = repo
        .command(env!("CARGO_BIN_EXE_mabo"), &["remove", ".", "--json"])
        .current_dir(&tree)
        .output()
        .unwrap();
    assert_eq!(
        out.status.code(),
        Some(0),
        "{} {}",
        text(&out.stdout),
        text(&out.stderr)
    );
    assert_eq!(
        assert_envelope(&out, "remove")["data"]["items"][0]["workspace"]["branch"],
        "topic+fix"
    );
    assert!(!tree.exists());
    assert!(!branch_listed(&repo, "topic+fix"));
}

#[test]
fn github_rechecks_out_a_pull_request_after_git_worktree_remove() {
    assert_github_recreates_orphaned_checkout(false);
}

#[test]
fn github_recreates_an_issue_checkout_after_its_worktree_and_branch_are_removed() {
    assert_github_recreates_orphaned_checkout(true);
}

fn assert_github_recreates_orphaned_checkout(issue: bool) {
    let repo = Repo::new();
    publish_pr_topic(&repo);
    let path = fake_gh_for_topic_pr(&repo);
    let branch = if issue { "issues/7" } else { "topic" };
    let link = if issue { "issue" } else { "pr" };
    if issue {
        let gh = repo.root.join("bin/gh");
        let script = fs::read_to_string(&gh).expect("gh script");
        fs::write(
            &gh,
            script.replace("\"pull_request\":{}", "\"title\":\"issue\""),
        )
        .expect("issue");
    }
    let checkout = || {
        repo.command(
            env!("CARGO_BIN_EXE_mabo"),
            &[
                "create",
                if issue { "--issue" } else { "--pr" },
                "7",
                "--json",
            ],
        )
        .env("PATH", &path)
        .output()
        .expect("checkout")
    };
    let first = checkout();
    assert!(first.status.success(), "{}", text(&first.stdout));
    let first = assert_envelope(&first, "create");
    assert_eq!(first["data"]["source"]["reused"], false);
    let directory = managed(&repo, branch);
    repo.git(&["worktree", "remove", directory.to_str().expect("path")]);
    assert!(!directory.exists());
    assert!(branch_listed(&repo, branch));
    // Issue checkout creates a new branch, so keep its existing branch-conflict policy.
    if issue {
        repo.git(&["branch", "-D", branch]);
    }
    let stale = repo.mabo(&["show", branch, "--json"]);
    assert!(stale.status.success(), "{}", text(&stale.stdout));
    assert_eq!(json_value(&stale)["data"]["workspace"]["orphaned"], true);

    let again = checkout();
    assert!(
        again.status.success(),
        "{}\n{}",
        text(&again.stdout),
        text(&again.stderr)
    );
    let again = assert_envelope(&again, "create");
    assert_eq!(again["data"]["source"]["reused"], false);
    assert_eq!(again["data"]["workspace"]["orphaned"], false);
    assert_eq!(again["data"]["workspace"]["branch"], branch);
    assert_eq!(again["data"]["workspace"]["links"][link]["number"], 7);
    assert_eq!(again["data"]["metadata"]["ok"], true);
    assert!(directory.join(".git").is_file());
    if !issue {
        assert!(directory.join("topic.txt").is_file());
        assert_eq!(upstream_name(&repo, branch), "origin/topic");
    }
    let listed = repo.mabo(&["list", "--kind", "workspace", "--json"]);
    assert!(listed.status.success(), "{}", text(&listed.stdout));
    let listed = json_value(&listed);
    assert_eq!(
        listed["data"]["workspaces"]
            .as_array()
            .expect("workspaces")
            .len(),
        1
    );
    assert_eq!(listed["data"]["workspaces"][0]["orphaned"], false);
}

#[test]
fn github_reuse_propagates_orphan_ambiguity_and_git_read_errors() {
    for issue in [false, true] {
        for read_error in [false, true] {
            let repo = Repo::new();
            let path = fake_gh_for_topic_pr(&repo);
            let name = if issue { "issues/7" } else { "topic" };
            if issue {
                let gh = repo.root.join("bin/gh");
                let script = fs::read_to_string(&gh).expect("gh script");
                fs::write(
                    &gh,
                    script.replace("\"pull_request\":{}", "\"title\":\"issue\""),
                )
                .expect("issue");
            }
            let file = repo.repo.join(".git/maboroshi/workspaces");
            let body = serde_json::json!({"worktrees": [
                {"path": repo.root.join("missing-one"), "name": name},
                {"path": repo.root.join("missing-two"), "name": name}
            ]})
            .to_string();
            records::write(&file, body).expect("records");
            let before = records::read(&file).expect("records");
            let real_git = repo
                .command("sh", &["-c", "command -v git"])
                .output()
                .expect("git path");
            assert!(real_git.status.success());
            if read_error {
                let shim = repo.root.join("bin/git");
                fs::write(
                    &shim,
                    r#"#!/bin/sh
if [ "$1" = "worktree" ] && [ "$2" = "list" ]; then
  echo 'injected worktree list failure' >&2
  exit 1
fi
exec "$REAL_GIT" "$@"
"#,
                )
                .expect("git shim");
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&shim, fs::Permissions::from_mode(0o755)).expect("chmod");
            }
            fs::write(
                repo.repo.join(".mabo.toml"),
                "[hooks]\nsetup = [\"touch should-not-run\"]\n",
            )
            .expect("hooks");
            let result = repo
                .command(
                    env!("CARGO_BIN_EXE_mabo"),
                    &[
                        "create",
                        if issue { "--issue" } else { "--pr" },
                        "7",
                        "--reuse",
                        "--json",
                    ],
                )
                .env("PATH", &path)
                .env("REAL_GIT", text(&real_git.stdout))
                .env_remove("MABO_TRUST_ALL")
                .output()
                .expect("checkout");
            assert_eq!(
                result.status.code(),
                Some(if read_error { 1 } else { 2 }),
                "{}",
                text(&result.stdout)
            );
            let value = assert_envelope(&result, "create");
            assert_eq!(
                value["error"]["code"],
                if read_error { "failed" } else { "ambiguous" }
            );
            if read_error {
                assert!(value["error"]["message"]
                    .as_str()
                    .expect("message")
                    .contains("injected worktree list failure"));
            }
            assert_eq!(records::read(&file).expect("unchanged records"), before);
            assert!(!managed(&repo, name).exists());
            assert!(!branch_listed(&repo, name));
        }
    }
}

#[test]
fn github_reuses_plain_git_checkout_with_a_git_only_branch_name() {
    let repo = Repo::new();
    let path = fake_gh_for_topic_pr(&repo);
    let gh = repo.root.join("bin/gh");
    let script = fs::read_to_string(&gh).expect("gh script");
    fs::write(&gh, script.replace("\"topic\"", "\"topic+fix\"")).expect("PR head");
    let checkout = repo.root.join("plain-checkout");
    repo.git(&[
        "worktree",
        "add",
        "-b",
        "topic+fix",
        checkout.to_str().expect("path"),
        "HEAD",
    ]);
    fs::write(
        repo.repo.join(".mabo.toml"),
        "[hooks]\nsetup = [\"touch should-not-run\"]\n",
    )
    .expect("hooks");
    let before = repo
        .command("git", &["worktree", "list", "--porcelain"])
        .output()
        .expect("list");
    let result = repo
        .command(
            env!("CARGO_BIN_EXE_mabo"),
            &["create", "--pr", "7", "--reuse", "--json"],
        )
        .env("PATH", &path)
        .env_remove("MABO_TRUST_ALL")
        .output()
        .expect("checkout");
    assert!(
        result.status.success(),
        "{}\n{}",
        text(&result.stdout),
        text(&result.stderr)
    );
    let value = json_value(&result);
    assert_eq!(value["schema"], 2);
    assert_eq!(value["data"]["source"]["reused"], true);
    assert_eq!(value["data"]["workspace"]["branch"], "topic+fix");
    assert!(paths_match(
        value["data"]["workspace"]["path"].as_str().expect("path"),
        &checkout
    ));
    assert_eq!(value["data"]["workspace"]["links"]["pr"]["number"], 7);
    assert_eq!(value["data"]["setup"]["ran"], false);
    assert!(!checkout.join("should-not-run").exists());
    let after = repo
        .command("git", &["worktree", "list", "--porcelain"])
        .output()
        .expect("list");
    assert_eq!(before.stdout, after.stdout);
    assert!(!managed(&repo, "topic+fix").exists());
    let linked = repo.mabo(&["path", "pr:7"]);
    assert!(linked.status.success(), "{}", text(&linked.stderr));
    assert!(paths_match(&text(&linked.stdout), &checkout));
}

#[test]
fn github_propagates_ambiguous_internal_lookups() {
    for issue in [false, true] {
        let repo = Repo::new();
        let path = fake_gh_for_topic_pr(&repo);
        let branch = if issue { "issues/7" } else { "topic" };
        if issue {
            let gh = repo.root.join("bin/gh");
            let script = fs::read_to_string(&gh).expect("gh script");
            fs::write(
                &gh,
                script.replace("\"pull_request\":{}", "\"title\":\"issue\""),
            )
            .expect("issue");
        }
        repo.git(&["branch", branch]);
        for directory in ["first", "second"] {
            let checkout = repo.root.join(directory);
            repo.git(&[
                "worktree",
                "add",
                "--force",
                checkout.to_str().expect("path"),
                branch,
            ]);
        }
        fs::write(
            repo.repo.join(".mabo.toml"),
            "[hooks]\nsetup = [\"touch should-not-run\"]\n",
        )
        .expect("hooks");
        let result = repo
            .command(
                env!("CARGO_BIN_EXE_mabo"),
                &[
                    "create",
                    if issue { "--issue" } else { "--pr" },
                    "7",
                    "--reuse",
                    "--json",
                ],
            )
            .env("PATH", &path)
            .env_remove("MABO_TRUST_ALL")
            .output()
            .expect("checkout");
        assert_eq!(
            result.status.code(),
            Some(2),
            "{}\n{}",
            text(&result.stdout),
            text(&result.stderr)
        );
        assert_eq!(json_value(&result)["error"]["code"], "ambiguous");
        assert!(!repo.repo.join(".git/maboroshi").exists());
    }
}

#[test]
fn gc_removes_a_recorded_git_only_branch_name() {
    let repo = Repo::new();
    let checkout = managed(&repo, "topic+fix");
    repo.git(&[
        "worktree",
        "add",
        "-b",
        "topic+fix",
        checkout.to_str().expect("path"),
        "HEAD",
    ]);
    let recorded = repo
        .command(
            env!("CARGO_BIN_EXE_mabo"),
            &["set", "--purpose", "internal lookup"],
        )
        .current_dir(&checkout)
        .output()
        .expect("record");
    assert!(recorded.status.success(), "{}", text(&recorded.stderr));
    land_branch(&repo, "topic+fix");
    let result = repo.mabo(&["gc", "--apply"]);
    assert!(
        result.status.success(),
        "{}\n{}",
        text(&result.stdout),
        text(&result.stderr)
    );
    assert!(
        text(&result.stdout).contains("removed topic+fix [merged]"),
        "{}",
        text(&result.stdout)
    );
    assert!(!checkout.exists());
    assert!(!branch_listed(&repo, "topic+fix"));
}

#[test]
fn user_selectors_still_reject_git_only_branch_names() {
    let repo = Repo::new();
    for args in [
        vec!["create", "topic+fix", "--json"],
        vec!["create", "--branch", "topic+fix", "--json"],
        vec!["show", "topic+fix", "--json"],
        vec!["path", "topic+fix", "--json"],
        vec!["set", "topic+fix", "--purpose", "task", "--json"],
        vec!["sync", "topic+fix", "--json"],
        vec!["remove", "topic+fix", "--json"],
        vec!["exec", "topic+fix", "--", "true"],
    ] {
        let result = repo.mabo(&args);
        assert_eq!(
            result.status.code(),
            Some(2),
            "{args:?}: {}\n{}",
            text(&result.stdout),
            text(&result.stderr)
        );
        if args.contains(&"--json") {
            assert_eq!(json_value(&result)["error"]["code"], "usage", "{args:?}");
        } else {
            assert!(text(&result.stderr).contains("Workspace name can only contain"));
        }
    }
}

#[test]
fn github_attaches_a_git_only_head_branch_without_user_name_validation() {
    let repo = Repo::new();
    publish_pr_topic(&repo);
    repo.git(&[
        "push",
        "origin",
        "refs/remotes/origin/topic:refs/heads/topic+fix",
    ]);
    let path = fake_gh_for_topic_pr(&repo);
    let gh = repo.root.join("bin/gh");
    let script = fs::read_to_string(&gh).expect("gh script");
    fs::write(&gh, script.replace("\"topic\"", "\"topic+fix\"")).expect("PR head");
    let result = repo
        .command(
            env!("CARGO_BIN_EXE_mabo"),
            &["create", "--pr", "7", "--reuse", "--json"],
        )
        .env("PATH", &path)
        .output()
        .expect("checkout");
    assert!(
        result.status.success(),
        "{}\n{}",
        text(&result.stdout),
        text(&result.stderr)
    );
    let value = json_value(&result);
    assert_eq!(value["data"]["source"]["reused"], false);
    assert_eq!(value["data"]["workspace"]["branch"], "topic+fix");
    assert!(managed(&repo, "topic+fix").join("topic.txt").is_file());
    assert_eq!(upstream_name(&repo, "topic+fix"), "origin/topic+fix");
}

#[test]
fn unified_create_reuse_is_idempotent_and_never_repeats_setup() {
    let repo = Repo::new();
    fs::write(repo.repo.join(".gitignore"), "secret\n").unwrap();
    fs::write(repo.repo.join("secret"), "first").unwrap();
    fs::write(
        repo.repo.join(".mabo.toml"),
        "[hooks]\nsetup = [\"echo setup >> calls; exit 21\"]\n",
    )
    .unwrap();
    let first = repo.mabo(&[
        "create",
        "retry",
        "--base",
        "main",
        "--copy-file",
        "secret",
        "--json",
    ]);
    assert_eq!(first.status.code(), Some(6));
    let first = assert_envelope(&first, "create");
    assert_eq!(first["data"]["source"]["kind"], "new");
    assert_eq!(first["data"]["source"]["base"], "refs/heads/main");
    assert_eq!(first["data"]["setup"]["exitCode"], 21);
    assert_eq!(
        first["data"]["copy"]["copied"],
        serde_json::json!(["secret"])
    );
    let records = records::read(repo.repo.join(".git/maboroshi/workspaces")).unwrap();
    fs::write(repo.repo.join("secret"), "changed").unwrap();
    for _ in 0..2 {
        let out = repo
            .command(
                env!("CARGO_BIN_EXE_mabo"),
                &[
                    "create",
                    "retry",
                    "--base",
                    "main",
                    "--copy-file",
                    "secret",
                    "--reuse",
                    "--json",
                ],
            )
            .env_remove("MABO_TRUST_ALL")
            .output()
            .unwrap();
        assert!(out.status.success(), "{}", text(&out.stdout));
        let doc = assert_envelope(&out, "create");
        assert_eq!(doc["data"]["source"]["reused"], true);
        assert_eq!(doc["data"]["setup"]["ran"], false);
        assert_eq!(doc["data"]["copy"]["copied"], serde_json::json!([]));
        assert_eq!(
            doc["data"]["workspace"]["id"],
            first["data"]["workspace"]["id"]
        );
    }
    assert_eq!(
        fs::read_to_string(managed(&repo, "retry/calls")).unwrap(),
        "setup\n"
    );
    assert_eq!(
        fs::read_to_string(managed(&repo, "retry/secret")).unwrap(),
        "first"
    );
    assert_eq!(
        records::read(repo.repo.join(".git/maboroshi/workspaces")).unwrap(),
        records
    );
    repo.git(&["branch", "another"]);
    for args in [
        vec!["create", "retry", "--base", "another", "--reuse", "--json"],
        vec![
            "create", "retry", "--branch", "another", "--reuse", "--json",
        ],
        vec!["create", "retry", "--detach", "--reuse", "--json"],
        vec!["create", "retry", "--json"],
    ] {
        let out = repo.mabo(&args);
        assert_eq!(out.status.code(), Some(4), "{}", text(&out.stdout));
        assert_eq!(json_value(&out)["error"]["code"], "exists");
    }
}

#[test]
fn unified_create_uses_the_default_base_and_supports_named_branch_and_detach() {
    let repo = Repo::new();
    repo.git(&["remote", "add", "origin", repo.repo.to_str().unwrap()]);
    repo.git(&["fetch", "origin"]);
    repo.git(&[
        "symbolic-ref",
        "refs/remotes/origin/HEAD",
        "refs/remotes/origin/main",
    ]);
    empty_commit(&repo, &repo.repo, "local only");
    let default_head = text(
        &repo
            .command("git", &["rev-parse", "refs/remotes/origin/main"])
            .output()
            .unwrap()
            .stdout,
    );
    let out = repo.mabo(&["create", "from-default", "--json"]);
    assert!(out.status.success(), "{}", text(&out.stdout));
    let doc = json_value(&out);
    assert_eq!(doc["data"]["workspace"]["head"], default_head);
    assert_eq!(doc["data"]["workspace"]["base"], "refs/remotes/origin/main");
    for _ in 0..2 {
        let out = repo.mabo(&[
            "create", "snapshot", "--detach", "--base", "main", "--reuse", "--json",
        ]);
        assert!(out.status.success(), "{}", text(&out.stdout));
        let doc = json_value(&out);
        assert_eq!(doc["data"]["source"]["kind"], "detach");
        assert_eq!(doc["data"]["workspace"]["branch"], serde_json::Value::Null);
        assert_eq!(doc["data"]["workspace"]["detached"], true);
        assert_eq!(doc["data"]["workspace"]["base"], "refs/heads/main");
    }
    repo.git(&["branch", "existing"]);
    for _ in 0..2 {
        let out = repo.mabo(&[
            "create", "review", "--branch", "existing", "--issue", "12", "--reuse", "--json",
        ]);
        assert!(out.status.success(), "{}", text(&out.stdout));
        let doc = json_value(&out);
        assert_eq!(doc["data"]["source"]["kind"], "branch");
        assert_eq!(doc["data"]["source"]["branch"], "existing");
        assert_eq!(doc["data"]["workspace"]["name"], "review");
        assert_eq!(doc["data"]["workspace"]["links"]["issue"]["number"], 12);
    }
}

#[test]
fn review10_create_pr_accepts_repository_url_case_variants() {
    assert_review10_source_url_case_variants(true);
}

#[test]
fn review10_create_issue_accepts_repository_url_case_variants() {
    assert_review10_source_url_case_variants(false);
}

fn assert_review10_source_url_case_variants(pr: bool) {
    let repo = Repo::new();
    let path = fake_gh_for_topic_pr(&repo);
    let gh = repo.root.join("bin/gh");
    let script = fs::read_to_string(&gh)
        .unwrap()
        .replace("acme/demo", "Acme/Demo")
        .replace("\"login\":\"acme\"", "\"login\":\"Acme\"")
        .replace("\"name\":\"demo\"", "\"name\":\"Demo\"");
    if pr {
        publish_pr_topic(&repo);
        fs::write(&gh, script).unwrap();
    } else {
        fs::write(
            &gh,
            script.replace("\"pull_request\":{}", "\"title\":\"Fix issue\""),
        )
        .unwrap();
    }
    let kind = if pr { "pull" } else { "issues" };
    let link_key = if pr { "pr" } else { "issue" };
    let canonical_url = format!("https://github.com/Acme/Demo/{kind}/7");
    let mut workspace_id = None;
    for (index, (repository, suffix)) in [
        ("github.com/Acme/demo", ""),
        ("github.com/acme/Demo", ""),
        ("GitHub.com/Acme/Demo", ""),
        ("GitHub.com/aCmE/dEmO", "/?plain=1#details"),
        ("github.com/Acme/Demo", "#details"),
    ]
    .into_iter()
    .enumerate()
    {
        let url = format!("https://{repository}/{kind}/7{suffix}");
        let out = repo
            .command(
                env!("CARGO_BIN_EXE_mabo"),
                &[
                    "create",
                    "review",
                    if pr { "--pr" } else { "--issue" },
                    &url,
                    "--reuse",
                    "--no-setup",
                    "--json",
                ],
            )
            .env("PATH", &path)
            .output()
            .unwrap();
        assert!(out.status.success(), "{url}: {}", text(&out.stdout));
        let doc = assert_envelope(&out, "create");
        assert_eq!(doc["data"]["source"]["kind"], link_key);
        assert_eq!(doc["data"]["source"]["number"], 7);
        assert_eq!(doc["data"]["source"]["reused"], index > 0);
        let workspace = &doc["data"]["workspace"];
        assert_eq!(workspace["links"][link_key]["url"], canonical_url);
        assert_eq!(workspace["links"][link_key]["number"], 7);
        if let Some(id) = &workspace_id {
            assert_eq!(&workspace["id"], id);
        } else {
            workspace_id = Some(workspace["id"].clone());
        }
    }
}

#[test]
fn review10_create_rejects_foreign_repository_host_and_source_kind_urls() {
    let repo = Repo::new();
    let path = fake_gh_for_topic_pr(&repo);
    let gh = repo.root.join("bin/gh");
    let script = fs::read_to_string(&gh).unwrap();
    fs::write(
        &gh,
        script.replace(
            "#!/bin/sh\n",
            "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$MABO_REVIEW10_GH_LOG\"\n",
        ),
    )
    .unwrap();
    let log = repo.root.join("gh.log");
    for pr in [true, false] {
        let kind = if pr { "pull" } else { "issues" };
        let wrong_kind = if pr { "issues" } else { "pull" };
        for url in [
            format!("https://github.com/other/demo/{kind}/7"),
            format!("https://github.com/acme/other/{kind}/7"),
            format!("https://other.example/acme/demo/{kind}/7"),
            format!("https://github.com/acme/demo/{wrong_kind}/7"),
            format!(
                "https://github.com/acme/demo/{}/7",
                if pr { "pulls" } else { "issue" }
            ),
            format!("http://github.com/acme/demo/{kind}/7"),
        ] {
            fs::write(&log, "").unwrap();
            let out = repo
                .command(
                    env!("CARGO_BIN_EXE_mabo"),
                    &[
                        "create",
                        "review",
                        if pr { "--pr" } else { "--issue" },
                        &url,
                        "--json",
                    ],
                )
                .env("PATH", &path)
                .env("MABO_REVIEW10_GH_LOG", &log)
                .output()
                .unwrap();
            assert_eq!(out.status.code(), Some(2), "{url}: {}", text(&out.stdout));
            assert_eq!(assert_envelope(&out, "create")["error"]["code"], "usage");
            assert_eq!(
                fs::read_to_string(&log).unwrap(),
                "repo view --json url,owner,name\n"
            );
            assert!(!managed(&repo, "review").exists());
            assert!(!repo.repo.join(".git/maboroshi/workspaces").exists());
        }
    }
}

#[test]
fn unified_create_issue_defaults_and_pr_issue_links() {
    let repo = Repo::new();
    let path = fake_gh_for_topic_pr(&repo);
    let gh = repo.root.join("bin/gh");
    let script = fs::read_to_string(&gh).unwrap();
    fs::write(
        &gh,
        script.replace("\"pull_request\":{}", "\"title\":\"Fix issue\""),
    )
    .unwrap();
    let run = |args: &[&str]| {
        repo.command(env!("CARGO_BIN_EXE_mabo"), args)
            .env("PATH", &path)
            .output()
            .unwrap()
    };
    for _ in 0..2 {
        let out = run(&[
            "create",
            "--issue",
            "https://github.com/acme/demo/issues/7",
            "--base",
            "main",
            "--reuse",
            "--json",
        ]);
        assert!(out.status.success(), "{}", text(&out.stdout));
        let doc = json_value(&out);
        assert_eq!(doc["data"]["source"]["kind"], "issue");
        assert_eq!(doc["data"]["source"]["number"], 7);
        assert_eq!(doc["data"]["workspace"]["name"], "issues/7");
        assert_eq!(doc["data"]["workspace"]["purpose"], "Fix issue");
    }
    fs::write(&gh, script).unwrap();
    publish_pr_topic(&repo);
    for _ in 0..2 {
        let out = run(&[
            "create",
            "review-pr",
            "--pr",
            "https://github.com/acme/demo/pull/7",
            "--issue",
            "12",
            "--reuse",
            "--json",
        ]);
        assert!(out.status.success(), "{}", text(&out.stdout));
        let doc = json_value(&out);
        assert_eq!(doc["data"]["source"]["kind"], "pr");
        assert_eq!(doc["data"]["source"]["number"], 7);
        assert_eq!(doc["data"]["source"]["headRef"], "topic");
        assert_eq!(doc["data"]["workspace"]["links"]["issue"]["number"], 12);
    }
    let conflict = run(&[
        "create",
        "review-pr",
        "--pr",
        "7",
        "--issue",
        "13",
        "--reuse",
        "--json",
    ]);
    assert_eq!(conflict.status.code(), Some(4));
    assert_eq!(json_value(&conflict)["error"]["code"], "exists");
}

#[test]
fn adopt_and_forget_preserve_git_and_skip_setup() {
    let repo = Repo::new();
    let outside = repo.root.join("plain");
    repo.git(&[
        "worktree",
        "add",
        "-b",
        "topic+fix",
        outside.to_str().unwrap(),
        "main",
    ]);
    fs::write(outside.join("local"), "keep").unwrap();
    fs::write(
        repo.repo.join(".mabo.toml"),
        "[hooks]\nsetup = [\"touch setup-ran\"]\npre-remove = [\"exit 23\"]\n",
    )
    .unwrap();
    let adopt = repo
        .command(
            env!("CARGO_BIN_EXE_mabo"),
            &[
                "adopt",
                outside.to_str().unwrap(),
                "--name",
                "adopted",
                "--base",
                "main",
                "--purpose",
                "existing work",
                "--pr",
                "12",
                "--issue",
                "34",
                "--json",
            ],
        )
        .env_remove("MABO_TRUST_ALL")
        .output()
        .unwrap();
    assert!(adopt.status.success(), "{}", text(&adopt.stdout));
    let doc = assert_envelope(&adopt, "adopt");
    assert_eq!(doc["data"]["workspace"]["name"], "adopted");
    assert_eq!(doc["data"]["workspace"]["managed"], true);
    assert_eq!(
        doc["data"]["workspace"]["createdAt"],
        serde_json::Value::Null
    );
    assert_eq!(
        doc["data"]["workspace"]["createdFrom"],
        serde_json::Value::Null
    );
    assert_eq!(doc["data"]["workspace"]["base"], "refs/heads/main");
    assert!(!outside.join("setup-ran").exists());
    let again = repo.mabo(&["adopt", outside.to_str().unwrap(), "--json"]);
    assert_eq!(again.status.code(), Some(4));
    assert_eq!(json_value(&again)["error"]["code"], "exists");
    assert!(repo
        .mabo(&["set", "main", "--issue", "99"])
        .status
        .success());
    let before = repo
        .command("git", &["worktree", "list", "--porcelain"])
        .output()
        .unwrap()
        .stdout;
    let forgotten = repo.mabo(&["forget", "pr:12", "issue:34", ".", "--json"]);
    assert!(forgotten.status.success(), "{}", text(&forgotten.stdout));
    let doc = assert_envelope(&forgotten, "forget");
    let items = doc["data"]["items"].as_array().unwrap();
    assert_eq!(items.len(), 3);
    assert!(items.iter().all(|item| item["ok"] == true));
    assert_eq!(
        repo.command("git", &["worktree", "list", "--porcelain"])
            .output()
            .unwrap()
            .stdout,
        before
    );
    assert_eq!(fs::read_to_string(outside.join("local")).unwrap(), "keep");
    assert!(branch_listed(&repo, "topic+fix"));
    assert!(
        records::read_to_string(repo.repo.join(".git/maboroshi/workspaces"))
            .unwrap()
            .contains("\"worktrees\": []")
    );
    let show = repo.mabo(&["show", ".", "--json"]);
    assert_eq!(
        json_value(&show)["data"]["workspace"]["purpose"],
        serde_json::Value::Null
    );
}

#[test]
fn adopt_rejects_foreign_primary_subdirectories_missing_paths_and_name_collisions() {
    let repo = Repo::new();
    let foreign = Repo::new();
    let plain = repo.root.join("plain");
    repo.git(&[
        "worktree",
        "add",
        "-b",
        "existing",
        plain.to_str().unwrap(),
        "main",
    ]);
    fs::create_dir_all(plain.join("subdir")).unwrap();
    for path in [
        &repo.repo,
        &foreign.repo,
        &plain.join("subdir"),
        &repo.root.join("missing"),
    ] {
        let out = repo.mabo(&["adopt", path.to_str().unwrap(), "--base", "main", "--json"]);
        assert_eq!(out.status.code(), Some(3), "{}", text(&out.stdout));
        assert_eq!(json_value(&out)["error"]["code"], "not_found");
    }
    assert!(repo.mabo(&["create", "taken"]).status.success());
    let out = repo.mabo(&[
        "adopt",
        plain.to_str().unwrap(),
        "--name",
        "taken",
        "--json",
    ]);
    assert_eq!(out.status.code(), Some(4));
    let out = repo.mabo(&[
        "adopt",
        plain.to_str().unwrap(),
        "--base",
        "missing",
        "--json",
    ]);
    assert_eq!(out.status.code(), Some(2));
    assert!(repo
        .mabo(&["adopt", plain.to_str().unwrap()])
        .status
        .success());
    assert!(repo.mabo(&["forget", "existing"]).status.success());
    assert!(plain.exists());
    assert!(branch_listed(&repo, "existing"));
}

#[test]
fn unified_create_rejects_removed_commands_and_conflicting_sources_in_text_and_json() {
    let repo = Repo::new();
    for (args, hint) in [
        (vec!["attach", "feature"], "create --branch"),
        (vec!["github", "checkout", "7"], "create --pr"),
        (vec!["gh", "checkout", "7"], "create --issue"),
        (
            vec!["create", "feature", "--exec", "true"],
            "exec SEL -- COMMAND",
        ),
        (vec!["create", "feature", "-xtrue"], "exec SEL -- COMMAND"),
    ] {
        for json in [false, true] {
            let mut args = args.clone();
            if json {
                args.push("--json");
            }
            let out = repo.mabo(&args);
            assert_eq!(out.status.code(), Some(2));
            let message = if json {
                let doc = json_value(&out);
                assert_eq!(doc["error"]["code"], "usage");
                doc["error"]["message"].as_str().unwrap().to_owned()
            } else {
                text(&out.stderr)
            };
            assert!(message.contains(hint), "{message}");
            assert!(!managed(&repo, "feature").exists());
        }
    }
    for args in [
        vec!["--base", "main", "--branch", "existing"],
        vec!["--base", "main", "--pr", "7"],
        vec!["--branch", "existing", "--pr", "7"],
        vec!["--detach", "--branch", "existing"],
        vec!["--detach", "--pr", "7"],
    ] {
        let args = [vec!["create", "feature", "--json"], args].concat();
        let out = repo.mabo(&args);
        assert_eq!(out.status.code(), Some(2), "{}", text(&out.stdout));
        assert_eq!(json_value(&out)["error"]["code"], "usage");
    }
}

#[test]
fn unified_create_branch_accepts_git_only_names_with_an_explicit_workspace_name() {
    let repo = Repo::new();
    repo.git(&["branch", "topic+fix"]);
    let out = repo.mabo(&["create", "review", "--branch", "topic+fix", "--json"]);
    assert!(out.status.success(), "{}", text(&out.stdout));
    let doc = json_value(&out);
    assert_eq!(doc["data"]["workspace"]["name"], "review");
    assert_eq!(doc["data"]["workspace"]["branch"], "topic+fix");
    let out = repo.mabo(&[
        "create",
        "review",
        "--branch",
        "topic+fix",
        "--reuse",
        "--json",
    ]);
    assert!(out.status.success());
    assert_eq!(json_value(&out)["data"]["source"]["reused"], true);
}

#[test]
fn create_reuse_and_adopt_do_not_treat_a_missing_directory_as_a_live_workspace() {
    let repo = Repo::new();
    repo.git(&["branch", "existing"]);
    let out = repo.mabo(&["create", "--branch", "existing", "--json"]);
    assert!(out.status.success());
    let directory = managed(&repo, "existing");
    fs::remove_dir_all(&directory).unwrap();
    fs::write(
        repo.repo.join(".mabo.toml"),
        "[hooks]\nsetup = [\"true\"]\n",
    )
    .unwrap();
    let out = repo
        .command(
            env!("CARGO_BIN_EXE_mabo"),
            &["create", "--branch", "existing", "--reuse", "--json"],
        )
        .env_remove("MABO_TRUST_ALL")
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(4));
    assert_eq!(json_value(&out)["error"]["code"], "untrusted");
    let out = repo.mabo(&["adopt", directory.to_str().unwrap(), "--json"]);
    assert_eq!(out.status.code(), Some(3));
    assert_eq!(json_value(&out)["error"]["code"], "not_found");
}

#[test]
fn adopt_forget_and_create_escape_control_characters_in_paths() {
    let repo = Repo::new();
    let outside = repo.root.join("existing\n\u{1b}[31m");
    repo.git(&[
        "worktree",
        "add",
        "-b",
        "plain",
        outside.to_str().unwrap(),
        "main",
    ]);
    let out = repo.mabo(&["adopt", outside.to_str().unwrap(), "--name", "review"]);
    assert!(out.status.success(), "{}", text(&out.stderr));
    assert!(text(&out.stdout).contains("existing\\u{a}\\u{1b}[31m"));
    assert!(!text(&out.stdout).contains('\u{1b}'));
    let out = repo.mabo(&["forget", "review"]);
    assert!(out.status.success());
    assert_eq!(text(&out.stdout), "Forgot workspace 'review'");
    let root = repo.root.join("new\n\u{1b}[31m");
    assert!(repo
        .mabo(&["config", "set", "workspace-root", root.to_str().unwrap()])
        .status
        .success());
    let out = repo.mabo(&["create", "escaped"]);
    assert!(out.status.success(), "{}", text(&out.stderr));
    assert!(text(&out.stdout).contains("new\\u{a}\\u{1b}[31m"));
    assert!(!text(&out.stdout).contains('\u{1b}'));
}

#[test]
fn create_reuse_propagates_corrupt_record_errors() {
    let repo = Repo::new();
    repo.git(&["branch", "existing"]);
    let created = repo.mabo(&["create", "--branch", "existing", "--json"]);
    assert!(created.status.success());
    let id = json_value(&created)["data"]["workspace"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let file = repo
        .repo
        .join(format!(".git/maboroshi/workspaces/{id}.json"));
    fs::write(&file, "{invalid").unwrap();
    let out = repo.mabo(&["create", "--branch", "existing", "--reuse", "--json"]);
    assert_eq!(out.status.code(), Some(1));
    assert_eq!(json_value(&out)["error"]["code"], "failed");
    assert_eq!(fs::read_to_string(file).unwrap(), "{invalid");
    assert!(managed(&repo, "existing").exists());
}

#[test]
fn review2_branch_usage_compares_branches_when_workspace_names_cross() {
    for reuse in [false, true] {
        let repo = Repo::new();
        repo.git(&["branch", "feature"]);
        repo.git(&["branch", "review"]);
        let first = repo.mabo(&["create", "review", "--branch", "feature", "--json"]);
        assert!(first.status.success(), "{}", text(&first.stdout));
        let mut args = vec!["create", "second", "--branch", "review", "--json"];
        if reuse {
            args.push("--reuse");
        }
        let second = repo.mabo(&args);
        assert!(second.status.success(), "{}", text(&second.stdout));
        let doc = assert_envelope(&second, "create");
        assert_eq!(doc["data"]["workspace"]["name"], "second");
        assert_eq!(doc["data"]["workspace"]["branch"], "review");
        assert_eq!(doc["data"]["source"]["reused"], false);
        for branch in ["feature", "review", "main"] {
            let out = repo.mabo(&["create", "third", "--branch", branch, "--json"]);
            assert_eq!(out.status.code(), Some(4), "{}", text(&out.stdout));
            assert_eq!(json_value(&out)["error"]["code"], "exists");
        }
        assert!(!managed(&repo, "third").exists());
    }
}

#[test]
fn review2_pr_usage_compares_branches_when_workspace_names_cross() {
    for reuse in [false, true] {
        let repo = Repo::new();
        let path = fake_gh_for_topic_pr(&repo);
        publish_pr_topic(&repo);
        repo.git(&["branch", "feature"]);
        let first = repo.mabo(&["create", "topic", "--branch", "feature", "--json"]);
        assert!(first.status.success(), "{}", text(&first.stdout));
        let mut args = vec!["create", "second", "--pr", "7", "--json"];
        if reuse {
            args.push("--reuse");
        }
        let run = |args: &[&str]| {
            repo.command(env!("CARGO_BIN_EXE_mabo"), args)
                .env("PATH", &path)
                .output()
                .expect("mabo")
        };
        let second = run(&args);
        assert!(second.status.success(), "{}", text(&second.stdout));
        let doc = assert_envelope(&second, "create");
        assert_eq!(doc["data"]["workspace"]["name"], "second");
        assert_eq!(doc["data"]["workspace"]["branch"], "topic");
        assert_eq!(doc["data"]["source"]["reused"], false);
        assert!(managed(&repo, "second/topic.txt").is_file());
        let out = run(&["create", "third", "--pr", "7", "--json"]);
        assert_eq!(out.status.code(), Some(4), "{}", text(&out.stdout));
        assert_eq!(json_value(&out)["error"]["code"], "exists");
        assert!(!managed(&repo, "third").exists());
    }
}

#[test]
fn review2_reuse_with_an_explicit_name_does_not_reuse_a_branch_alias() {
    for pr in [false, true] {
        let repo = Repo::new();
        let path = fake_gh_for_topic_pr(&repo);
        publish_pr_topic(&repo);
        let first = repo.mabo(&["create", "review", "--branch", "origin/topic", "--json"]);
        assert!(first.status.success(), "{}", text(&first.stdout));
        let out = repo
            .command(
                env!("CARGO_BIN_EXE_mabo"),
                &[
                    "create",
                    "topic",
                    if pr { "--pr" } else { "--branch" },
                    if pr { "7" } else { "topic" },
                    "--reuse",
                    "--json",
                ],
            )
            .env("PATH", &path)
            .output()
            .expect("mabo");
        assert_eq!(out.status.code(), Some(4), "{}", text(&out.stdout));
        assert_eq!(json_value(&out)["error"]["code"], "exists");
        assert!(!managed(&repo, "topic").exists());
        let reused = repo.mabo(&["create", "review", "--branch", "topic", "--reuse", "--json"]);
        assert!(reused.status.success(), "{}", text(&reused.stdout));
        assert_eq!(json_value(&reused)["data"]["source"]["reused"], true);
    }
}

#[test]
fn review2_explicit_detached_name_can_match_another_workspaces_branch() {
    let repo = Repo::new();
    repo.git(&["branch", "feature"]);
    let first = repo.mabo(&["create", "review", "--branch", "feature", "--json"]);
    assert!(first.status.success(), "{}", text(&first.stdout));
    let new = repo.mabo(&["create", "feature", "--json"]);
    assert_eq!(new.status.code(), Some(4));
    assert_eq!(json_value(&new)["error"]["code"], "exists_remote");
    for reused in [false, true] {
        let out = repo.mabo(&["create", "feature", "--detach", "--reuse", "--json"]);
        assert!(out.status.success(), "{}", text(&out.stdout));
        let doc = assert_envelope(&out, "create");
        assert_eq!(doc["data"]["workspace"]["name"], "feature");
        assert_eq!(doc["data"]["workspace"]["detached"], true);
        assert_eq!(doc["data"]["source"]["reused"], reused);
    }
}

#[test]
fn review1_create_rejects_names_outside_the_workspace_root_for_every_source() {
    for source in [
        vec![],
        vec!["--detach"],
        vec!["--branch", "existing"],
        vec!["--pr", "7"],
        vec!["--issue", "7"],
    ] {
        for spelling in ["absolute", "parent", "nested-parent"] {
            let repo = Repo::new();
            publish_pr_topic(&repo);
            repo.git(&["branch", "existing"]);
            let path = fake_gh_for_topic_pr(&repo);
            if source == ["--issue", "7"] {
                let gh = repo.root.join("bin/gh");
                let script = fs::read_to_string(&gh).unwrap();
                fs::write(
                    gh,
                    script.replace("\"pull_request\":{}", "\"title\":\"Issue\""),
                )
                .unwrap();
            }
            let outside = repo.root.join("escaped");
            let name = match spelling {
                "absolute" => outside.to_str().unwrap(),
                "parent" => "../escaped",
                _ => "nested/../../escaped",
            };
            let before = repo
                .command("git", &["worktree", "list", "--porcelain"])
                .output()
                .unwrap()
                .stdout;
            let args = [
                vec!["create", name],
                source.clone(),
                vec!["--no-setup", "--json"],
            ]
            .concat();
            let out = repo
                .command(env!("CARGO_BIN_EXE_mabo"), &args)
                .env("PATH", &path)
                .output()
                .unwrap();
            assert_eq!(
                out.status.code(),
                Some(2),
                "{args:?}: {}",
                text(&out.stdout)
            );
            assert_eq!(json_value(&out)["error"]["code"], "usage");
            assert!(!outside.exists());
            assert_eq!(
                repo.command("git", &["worktree", "list", "--porcelain"])
                    .output()
                    .unwrap()
                    .stdout,
                before
            );
        }
    }
}

#[test]
fn review1_create_rejects_destination_escaping_through_a_parent_symlink() {
    use std::os::unix::fs::symlink;
    for source in [
        vec![],
        vec!["--detach"],
        vec!["--branch", "existing"],
        vec!["--pr", "7"],
        vec!["--issue", "7"],
    ] {
        let repo = Repo::new();
        publish_pr_topic(&repo);
        repo.git(&["branch", "existing"]);
        let gh_path = fake_gh_for_topic_pr(&repo);
        if source == ["--issue", "7"] {
            let gh = repo.root.join("bin/gh");
            let script = fs::read_to_string(&gh).unwrap();
            fs::write(
                gh,
                script.replace("\"pull_request\":{}", "\"title\":\"Issue\""),
            )
            .unwrap();
        }
        let root = repo.root.join("workspaces");
        let outside = repo.root.join("outside");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&outside).unwrap();
        symlink(&outside, root.join("escape")).unwrap();
        assert!(repo
            .mabo(&["config", "set", "workspace-root", root.to_str().unwrap()])
            .status
            .success());
        let args = [
            vec!["create", "escape/missing/review"],
            source,
            vec!["--no-setup", "--json"],
        ]
        .concat();
        let out = repo
            .command(env!("CARGO_BIN_EXE_mabo"), &args)
            .env("PATH", gh_path)
            .output()
            .unwrap();
        assert_eq!(
            out.status.code(),
            Some(2),
            "{args:?}: {}",
            text(&out.stdout)
        );
        assert_eq!(json_value(&out)["error"]["code"], "usage");
        assert!(!outside.join("missing").exists());
    }
}

#[test]
fn review1_reuse_links_resolve_bare_numbers_in_the_selected_repository() {
    let repo = Repo::new();
    repo.git(&[
        "remote",
        "add",
        "origin",
        "https://github.com/acme/demo.git",
    ]);
    repo.git(&["branch", "existing"]);
    let run = |issue: &str| {
        repo.mabo(&[
            "create", "review", "--branch", "existing", "--issue", issue, "--reuse", "--json",
        ])
    };
    assert!(run("12").status.success());
    for url in [
        "https://github.com/other/demo/issues/12",
        "https://github.com/acme/other/issues/12",
        "https://other.example/acme/demo/issues/12",
    ] {
        let out = run(url);
        assert_eq!(out.status.code(), Some(4), "{url}: {}", text(&out.stdout));
        assert_eq!(json_value(&out)["error"]["code"], "exists");
    }
    for reference in [
        "#12",
        "https://github.com/acme/demo/issues/12",
        "https://github.com/acme/demo/issues/12/?plain=1#details",
    ] {
        let out = run(reference);
        assert!(out.status.success(), "{reference}: {}", text(&out.stdout));
    }
    assert!(repo
        .mabo(&[
            "set",
            "review",
            "--issue",
            "https://github.com/other/demo/issues/12"
        ])
        .status
        .success());
    let out = run("12");
    assert_eq!(out.status.code(), Some(4), "{}", text(&out.stdout));
}

#[test]
fn review1_reuse_links_share_terminal_url_normalization_with_selectors() {
    let repo = Repo::new();
    repo.git(&["branch", "existing"]);
    // The earlier /pull/123 belongs to owner/repo, not the subject number.
    let url = "https://git.example.com/pull/123/issues/42";
    let out = repo.mabo(&[
        "create", "review", "--branch", "existing", "--issue", url, "--json",
    ]);
    assert!(out.status.success(), "{}", text(&out.stdout));
    for url in [
        "https://git.example.com/pull/123/issues/42/?plain=1#details",
        "https://git.example.com/pull/123/issue/42#details",
    ] {
        let show = repo.mabo(&["show", url, "--json"]);
        assert!(show.status.success(), "{}", text(&show.stdout));
        let out = repo.mabo(&[
            "create", "review", "--branch", "existing", "--issue", url, "--reuse", "--json",
        ]);
        assert!(out.status.success(), "{}", text(&out.stdout));
        assert_eq!(json_value(&out)["data"]["source"]["reused"], true);
    }
}

#[test]
fn review1_adopt_name_is_used_inside_the_workspace_root() {
    let repo = Repo::new();
    let tree = managed(&repo, "directory-name");
    repo.git(&[
        "worktree",
        "add",
        "-b",
        "topic",
        tree.to_str().unwrap(),
        "main",
    ]);
    let out = repo.mabo(&[
        "adopt",
        tree.to_str().unwrap(),
        "--name",
        "review",
        "--json",
    ]);
    assert!(out.status.success(), "{}", text(&out.stdout));
    assert_eq!(json_value(&out)["data"]["workspace"]["name"], "review");
    for command in ["show", "path", "forget"] {
        let out = repo.mabo(&[command, "review", "--json"]);
        assert!(out.status.success(), "{command}: {}", text(&out.stdout));
    }
    assert!(tree.is_dir());
}

#[test]
fn review1_existing_branch_creation_does_not_require_a_default_or_source_head() {
    let repo = Repo::new();
    repo.git(&["branch", "-m", "develop"]);
    repo.git(&["checkout", "--orphan", "unborn"]);
    let out = repo.mabo(&["create", "review", "--branch", "develop", "--json"]);
    assert!(out.status.success(), "{}", text(&out.stdout));
    let doc = json_value(&out);
    assert_eq!(doc["data"]["workspace"]["branch"], "develop");
    assert_eq!(doc["data"]["source"]["base"], "refs/heads/develop");
    assert_eq!(doc["data"]["workspace"]["base"], serde_json::Value::Null);
}

#[test]
fn review9_pr_unknown_base_stays_unknown_after_default_returns() {
    let repo = Repo::new();
    publish_pr_topic(&repo);
    let path = fake_gh_for_topic_pr(&repo);
    repo.git(&["checkout", "--orphan", "unborn"]);
    repo.git(&["branch", "-D", "main"]);
    repo.git(&["update-ref", "-d", "refs/remotes/origin/main"]);
    let out = repo
        .command(
            env!("CARGO_BIN_EXE_mabo"),
            &["create", "--pr", "7", "--json"],
        )
        .env("PATH", path)
        .output()
        .unwrap();
    assert!(out.status.success(), "{}", text(&out.stdout));
    let doc = json_value(&out);
    assert!(doc["data"]["source"]["base"].is_null());
    let tree = PathBuf::from(doc["data"]["workspace"]["path"].as_str().unwrap());
    let head = || {
        let out = repo
            .command("git", &["rev-parse", "HEAD"])
            .current_dir(&tree)
            .output()
            .unwrap();
        assert!(out.status.success());
        text(&out.stdout)
    };
    let head_before = head();
    repo.git(&["checkout", "-b", "main", "topic"]);
    fs::write(repo.repo.join("new-default"), "new default\n").unwrap();
    repo.git(&["add", "new-default"]);
    repo.git(&["commit", "-m", "advance default"]);
    // Keep sync local so the PR's former remote default cannot hide the fallback.
    repo.git(&["remote", "remove", "origin"]);
    let store = repo.repo.join(".git/maboroshi/workspaces");
    let record_before = records::read(&store).unwrap();
    for selector in ["topic", "--all"] {
        let out = repo.mabo(&["sync", selector, "--no-default", "--json"]);
        assert!(out.status.success(), "{}", text(&out.stdout));
        let doc = json_value(&out);
        assert_eq!(
            doc["data"]["workspaces"][0]["status"], "base-unknown",
            "{doc}"
        );
        assert_eq!(head(), head_before);
        assert_eq!(records::read(&store).unwrap(), record_before);
    }
    let record: serde_json::Value = serde_json::from_slice(&record_before).unwrap();
    assert_eq!(record["worktrees"][0]["baseCleared"], true);
}

#[test]
fn review1_pr_creation_does_not_require_a_default_or_source_head() {
    let repo = Repo::new();
    publish_pr_topic(&repo);
    let path = fake_gh_for_topic_pr(&repo);
    repo.git(&["checkout", "--orphan", "unborn"]);
    repo.git(&["branch", "-D", "main"]);
    repo.git(&["update-ref", "-d", "refs/remotes/origin/main"]);
    let out = repo
        .command(
            env!("CARGO_BIN_EXE_mabo"),
            &["create", "--pr", "7", "--json"],
        )
        .env("PATH", path)
        .output()
        .unwrap();
    assert!(out.status.success(), "{}", text(&out.stdout));
    assert_eq!(json_value(&out)["data"]["workspace"]["branch"], "topic");
    assert_eq!(
        json_value(&out)["data"]["source"]["base"],
        serde_json::Value::Null
    );
    assert_eq!(
        json_value(&out)["data"]["workspace"]["base"],
        serde_json::Value::Null
    );
}

#[test]
fn review3_reuse_rejects_a_prunable_checkout_with_a_missing_git_file() {
    for source in ["branch", "new", "detach"] {
        let repo = Repo::new();
        let mut create = vec!["create", "review", "--json"];
        if source == "branch" {
            repo.git(&["branch", "topic"]);
            create.extend(["--branch", "topic"]);
        } else if source == "detach" {
            create.push("--detach");
        }
        let out = repo.mabo(&create);
        assert!(out.status.success(), "{}", text(&out.stdout));
        let directory = managed(&repo, "review");
        fs::remove_file(directory.join(".git")).unwrap();
        assert!(directory.is_dir());
        let listed = repo
            .command("git", &["worktree", "list", "--porcelain"])
            .output()
            .unwrap();
        assert!(text(&listed.stdout).contains("prunable"));
        let records_before =
            records::read_to_string(repo.repo.join(".git/maboroshi/workspaces")).unwrap();
        create.push("--reuse");
        let out = repo.mabo(&create);
        assert_eq!(out.status.code(), Some(1), "{}", text(&out.stdout));
        let doc = assert_envelope(&out, "create");
        assert_eq!(doc["error"]["code"], "failed");
        let message = doc["error"]["message"].as_str().unwrap();
        assert!(
            message.contains("Cannot reuse workspace 'review'"),
            "{message}"
        );
        assert!(message.contains(".git"), "{message}");
        assert_eq!(
            records::read_to_string(repo.repo.join(".git/maboroshi/workspaces")).unwrap(),
            records_before
        );
        assert!(directory.is_dir());
        assert!(!directory.join(".git").exists());
    }
}

#[test]
fn review3_reuse_rejects_git_discovery_falling_back_to_the_parent_checkout() {
    let repo = Repo::new();
    assert!(repo
        .mabo(&["config", "set", "workspace-root", "workspaces"])
        .status
        .success());
    assert!(repo.mabo(&["create", "review"]).status.success());
    let directory = repo.repo.join("workspaces/review");
    fs::remove_file(directory.join(".git")).unwrap();
    let observed = repo
        .command("git", &["rev-parse", "--show-toplevel"])
        .current_dir(&directory)
        .output()
        .unwrap();
    assert!(observed.status.success());
    assert_eq!(Path::new(&text(&observed.stdout)), repo.repo);
    let out = repo.mabo(&["create", "review", "--reuse", "--json"]);
    assert_eq!(out.status.code(), Some(1), "{}", text(&out.stdout));
    assert_eq!(assert_envelope(&out, "create")["error"]["code"], "failed");
}

#[test]
fn review3_reuse_rejects_a_checkout_pointing_to_a_foreign_common_directory() {
    let repo = Repo::new();
    let foreign = Repo::new();
    assert!(repo.mabo(&["create", "review"]).status.success());
    assert!(foreign.mabo(&["create", "other"]).status.success());
    let directory = managed(&repo, "review");
    fs::copy(
        managed(&foreign, "other").join(".git"),
        directory.join(".git"),
    )
    .unwrap();
    let observed = repo
        .command("git", &["rev-parse", "--show-toplevel"])
        .current_dir(&directory)
        .output()
        .unwrap();
    assert!(observed.status.success());
    assert_eq!(Path::new(&text(&observed.stdout)), directory);
    let out = repo.mabo(&["create", "review", "--reuse", "--json"]);
    assert_eq!(out.status.code(), Some(1), "{}", text(&out.stdout));
    assert_eq!(assert_envelope(&out, "create")["error"]["code"], "failed");
}

fn assert_reuse_rejects_swapped_git_dir(primary: bool) {
    let repo = Repo::new();
    assert!(repo.mabo(&["create", "review"]).status.success());
    let directory = managed(&repo, "review");
    if primary {
        fs::write(
            directory.join(".git"),
            format!("gitdir: {}\n", repo.repo.join(".git").display()),
        )
        .unwrap();
    } else {
        assert!(repo.mabo(&["create", "other"]).status.success());
        fs::copy(managed(&repo, "other").join(".git"), directory.join(".git")).unwrap();
    }
    let observed = repo
        .command("git", &["rev-parse", "--show-toplevel"])
        .current_dir(&directory)
        .output()
        .unwrap();
    assert!(observed.status.success());
    assert_eq!(Path::new(&text(&observed.stdout)), directory);
    let actual_branch = repo
        .command("git", &["branch", "--show-current"])
        .current_dir(&directory)
        .output()
        .unwrap();
    assert!(actual_branch.status.success());
    assert_eq!(
        text(&actual_branch.stdout),
        if primary { "main" } else { "other" }
    );
    let records_before = records::read(repo.repo.join(".git/maboroshi/workspaces")).unwrap();
    let gitfile_before = fs::read(directory.join(".git")).unwrap();
    for source in [vec![], vec!["--branch", "review"]] {
        let mut args = vec!["create", "review", "--reuse", "--json"];
        args.extend(source);
        let out = repo.mabo(&args);
        assert_eq!(out.status.code(), Some(1), "{}", text(&out.stdout));
        let doc = assert_envelope(&out, "create");
        assert_eq!(doc["error"]["code"], "failed");
        assert!(doc["error"]["message"].as_str().unwrap().contains(".git"));
        assert_eq!(
            records::read(repo.repo.join(".git/maboroshi/workspaces")).unwrap(),
            records_before
        );
        assert_eq!(fs::read(directory.join(".git")).unwrap(), gitfile_before);
    }
}

#[test]
fn review5_reuse_rejects_a_git_file_pointing_to_primary() {
    assert_reuse_rejects_swapped_git_dir(true);
}

#[test]
fn review5_reuse_rejects_a_git_file_pointing_to_another_workspace() {
    assert_reuse_rejects_swapped_git_dir(false);
}

#[test]
fn review5_user_names_reject_reserved_selectors_without_records() {
    for command in ["adopt", "create"] {
        for name in [
            ".",
            "pr:7",
            "pr:topic",
            "issue:12",
            "issue:topic",
            "https://github.com/owner/repo/pull/7",
            "http://github.com/owner/repo/issues/12",
        ] {
            let repo = Repo::new();
            let directory = repo.root.join("directory-name");
            repo.git(&[
                "worktree",
                "add",
                "-b",
                "topic",
                directory.to_str().unwrap(),
            ]);
            let args = if command == "adopt" {
                vec![
                    "adopt",
                    directory.to_str().unwrap(),
                    "--name",
                    name,
                    "--json",
                ]
            } else {
                vec!["create", name, "--detach", "--json"]
            };
            let out = repo.mabo(&args);
            assert_eq!(
                out.status.code(),
                Some(2),
                "{command} {name}: {}",
                text(&out.stdout)
            );
            assert_eq!(assert_envelope(&out, command)["error"]["code"], "usage");
            assert!(!repo.repo.join(".git/maboroshi/workspaces").exists());
            assert!(directory.join(".git").is_file());
        }
    }
}

#[test]
fn review3_forget_matches_show_and_list_after_record_removal() {
    for location in [
        "inside",
        "outside",
        "primary",
        "inside-alias",
        "outside-alias",
    ] {
        let repo = Repo::new();
        let (selector, after_selector, expected_managed) = match location {
            "inside" => {
                assert!(repo.mabo(&["create", "review"]).status.success());
                ("review", "review", true)
            }
            "outside" => {
                let outside = repo.root.join("plain");
                repo.git(&["worktree", "add", "-b", "review", outside.to_str().unwrap()]);
                assert!(repo
                    .mabo(&["adopt", outside.to_str().unwrap()])
                    .status
                    .success());
                ("review", "review", false)
            }
            "inside-alias" | "outside-alias" => {
                let inside = location == "inside-alias";
                let directory = if inside {
                    managed(&repo, "directory-name")
                } else {
                    repo.root.join("directory-name")
                };
                repo.git(&[
                    "worktree",
                    "add",
                    "-b",
                    "topic",
                    directory.to_str().unwrap(),
                ]);
                assert!(repo
                    .mabo(&["adopt", directory.to_str().unwrap(), "--name", "review"])
                    .status
                    .success());
                (
                    "review",
                    if inside { "directory-name" } else { "topic" },
                    inside,
                )
            }
            _ => (".", ".", false),
        };
        assert!(repo
            .mabo(&[
                "set",
                selector,
                "--purpose",
                "work",
                "--base",
                "main",
                "--pr",
                "34",
                "--issue",
                "12"
            ])
            .status
            .success());
        let out = repo.mabo(&["forget", selector, "issue:12", "--json"]);
        assert!(out.status.success(), "{}", text(&out.stdout));
        let forgotten = assert_envelope(&out, "forget");
        let show = repo.mabo(&["show", after_selector, "--json"]);
        assert!(show.status.success(), "{}", text(&show.stdout));
        let shown = assert_envelope(&show, "show");
        let list = repo.mabo(&["list", "--json"]);
        assert!(list.status.success(), "{}", text(&list.stdout));
        let listed = assert_envelope(&list, "list");
        let tree = &shown["data"]["workspace"];
        assert_eq!(tree["managed"], expected_managed);
        for item in forgotten["data"]["items"].as_array().unwrap() {
            assert_eq!(item["ok"], true);
            assert_eq!(&item["workspace"], tree, "{location}");
        }
        assert!(listed["data"]["workspaces"]
            .as_array()
            .unwrap()
            .contains(tree));
        for field in [
            "id",
            "base",
            "purpose",
            "createdAt",
            "createdFrom",
            "updatedAt",
            "setup",
        ] {
            assert_eq!(tree[field], serde_json::Value::Null, "{field}: {tree}");
        }
        assert_eq!(tree["links"]["pr"], serde_json::Value::Null);
        assert_eq!(tree["links"]["issue"], serde_json::Value::Null);
    }
}

#[test]
fn review1_forget_returns_the_workspace_after_removing_its_record() {
    let repo = Repo::new();
    let out = repo.create_recorded(&[
        "create",
        "review",
        "--base",
        "main",
        "--purpose",
        "work",
        "--issue",
        "12",
        "--pr",
        "34",
        "--json",
    ]);
    assert!(out.status.success());
    let out = repo.mabo(&["forget", "review", "issue:12", "--json"]);
    assert!(out.status.success(), "{}", text(&out.stdout));
    let doc = json_value(&out);
    for item in doc["data"]["items"].as_array().unwrap() {
        assert_eq!(item["ok"], true);
        let tree = &item["workspace"];
        let shown = repo.mabo(&["show", "review", "--json"]);
        assert!(shown.status.success());
        assert_eq!(tree, &json_value(&shown)["data"]["workspace"]);
        for field in [
            "id",
            "base",
            "purpose",
            "createdAt",
            "createdFrom",
            "updatedAt",
        ] {
            assert_eq!(tree[field], serde_json::Value::Null, "{field}: {tree}");
        }
        assert_eq!(tree["links"]["pr"], serde_json::Value::Null);
        assert_eq!(tree["links"]["issue"], serde_json::Value::Null);
        assert_eq!(tree["branch"], "review");
        assert!(tree["head"].is_string());
        assert!(Path::new(tree["path"].as_str().unwrap()).is_dir());
    }
}

fn assert_adopt_rejects_swapped_git_dir(primary: bool) {
    let repo = Repo::new();
    let directory = repo.root.join("review");
    repo.git(&[
        "worktree",
        "add",
        "-b",
        "topic",
        directory.to_str().unwrap(),
    ]);
    if primary {
        fs::write(
            directory.join(".git"),
            format!("gitdir: {}\n", repo.repo.join(".git").display()),
        )
        .unwrap();
    } else {
        let other = repo.root.join("other");
        repo.git(&["worktree", "add", "-b", "other", other.to_str().unwrap()]);
        fs::copy(other.join(".git"), directory.join(".git")).unwrap();
    }
    // Both pre-existing checks pass, despite Git operating on the wrong branch.
    let observed = repo
        .command("git", &["rev-parse", "--show-toplevel"])
        .current_dir(&directory)
        .output()
        .unwrap();
    assert!(observed.status.success());
    assert_eq!(Path::new(&text(&observed.stdout)), directory);
    assert_eq!(
        maboroshi::git::canonical_common_dir(&directory).unwrap(),
        repo.repo.join(".git")
    );
    let branch = repo
        .command("git", &["branch", "--show-current"])
        .current_dir(&directory)
        .output()
        .unwrap();
    assert!(branch.status.success());
    assert_eq!(text(&branch.stdout), if primary { "main" } else { "other" });
    let gitfile = fs::read(directory.join(".git")).unwrap();
    let out = repo.mabo(&[
        "adopt",
        directory.to_str().unwrap(),
        "--name",
        "review",
        "--json",
    ]);
    assert!(!out.status.success(), "{}", text(&out.stdout));
    assert_eq!(assert_envelope(&out, "adopt")["error"]["code"], "not_found");
    assert!(!repo.repo.join(".git/maboroshi/workspaces").exists());
    assert_eq!(fs::read(directory.join(".git")).unwrap(), gitfile);
}

#[test]
fn review6_adopt_rejects_a_git_file_pointing_to_primary() {
    assert_adopt_rejects_swapped_git_dir(true);
}

#[test]
fn review6_adopt_rejects_a_git_file_pointing_to_another_workspace() {
    assert_adopt_rejects_swapped_git_dir(false);
}

#[test]
fn review11_branch_reuse_refuses_primary_checkout() {
    assert_review11_primary_refused(false, false);
}

#[test]
fn review11_named_branch_reuse_refuses_primary_checkout() {
    assert_review11_primary_refused(false, true);
}

#[test]
fn review11_pr_reuse_refuses_primary_checkout() {
    assert_review11_primary_refused(true, false);
}

#[test]
fn review11_named_pr_reuse_refuses_primary_checkout() {
    assert_review11_primary_refused(true, true);
}

fn assert_review11_primary_refused(pr: bool, named: bool) {
    for recorded in [false, true] {
        let repo = Repo::new();
        let path = fake_gh_for_topic_pr(&repo);
        if pr {
            publish_pr_topic(&repo);
            repo.git(&["checkout", "-b", "topic", "origin/topic"]);
        }
        if recorded {
            let out = repo.mabo(&["set", ".", "--purpose", "Primary intent", "--json"]);
            assert!(out.status.success(), "{}", text(&out.stdout));
        }
        let before = json_value(&repo.mabo(&["show", ".", "--json"]));
        let primary_name = before["data"]["workspace"]["name"].as_str().unwrap();
        let record_path = repo.repo.join(".git/maboroshi/workspaces");
        let records_before = records::read(&record_path).ok();
        let mut args = vec!["create"];
        if named {
            args.push(primary_name);
        }
        args.extend([
            if pr { "--pr" } else { "--branch" },
            if pr { "7" } else { "main" },
            "--json",
        ]);
        let run = |args: &[&str]| {
            repo.command(env!("CARGO_BIN_EXE_mabo"), args)
                .env("PATH", &path)
                .output()
                .unwrap()
        };
        let refused = run(&args);
        assert_eq!(refused.status.code(), Some(4), "{}", text(&refused.stdout));
        let refused_doc = assert_envelope(&refused, "create");
        assert_eq!(refused_doc["error"]["code"], "exists");
        args.push("--reuse");
        let reuse = run(&args);
        assert_eq!(
            records::read(&record_path).ok(),
            records_before,
            "Primary metadata changed: {}",
            text(&reuse.stdout)
        );
        assert_eq!(
            reuse.status.code(),
            refused.status.code(),
            "{}",
            text(&reuse.stdout)
        );
        assert_eq!(
            assert_envelope(&reuse, "create")["error"],
            refused_doc["error"]
        );
        assert_eq!(json_value(&repo.mabo(&["show", ".", "--json"])), before);
        assert!(!managed(&repo, primary_name).exists());
    }
}

#[test]
fn review11_adopt_skips_worktree_lock_files() {
    assert_review11_stale_registration_skipped(true, false);
}

#[test]
fn review11_reuse_skips_worktree_lock_files() {
    assert_review11_stale_registration_skipped(false, false);
}

#[test]
fn review11_adopt_skips_admin_directories_without_gitdir() {
    assert_review11_stale_registration_skipped(true, true);
}

#[test]
fn review11_reuse_skips_admin_directories_without_gitdir() {
    assert_review11_stale_registration_skipped(false, true);
}

fn assert_review11_stale_registration_skipped(adopt: bool, directory: bool) {
    let repo = Repo::new();
    let registrations = repo.repo.join(".git/worktrees");
    fs::create_dir_all(&registrations).unwrap();
    let stale = registrations.join(if directory { "broken" } else { "pending.lock" });
    if directory {
        fs::create_dir(&stale).unwrap();
    } else {
        fs::write(&stale, "").unwrap();
    }
    let checkout = repo.root.join("review");
    repo.git(&["worktree", "add", "-b", "topic", checkout.to_str().unwrap()]);
    let gitfile = fs::read(checkout.join(".git")).unwrap();
    let args = if adopt {
        vec![
            "adopt",
            checkout.to_str().unwrap(),
            "--name",
            "review",
            "--json",
        ]
    } else {
        vec!["create", "--branch", "topic", "--reuse", "--json"]
    };
    let out = repo.mabo(&args);
    assert!(out.status.success(), "{}", text(&out.stdout));
    let doc = assert_envelope(&out, if adopt { "adopt" } else { "create" });
    let tree = &doc["data"]["workspace"];
    assert_eq!(tree["path"], checkout.to_str().unwrap());
    assert_eq!(tree["branch"], "topic");
    if adopt {
        assert!(tree["id"].is_string());
        assert_eq!(tree["name"], "review");
        assert_eq!(tree["createdAt"], serde_json::Value::Null);
    } else {
        assert_eq!(doc["data"]["source"]["reused"], true);
        assert!(!repo.repo.join(".git/maboroshi/workspaces").exists());
    }
    assert_eq!(fs::read(checkout.join(".git")).unwrap(), gitfile);
    assert!(stale.exists());
}

#[test]
fn setup_no_hooks_rejects_symlink_to_another_registered_workspace() {
    assert_rejects_symlink_to_registered_workspace("setup-no-hooks");
}

#[test]
fn setup_rejects_symlink_to_another_registered_workspace() {
    assert_rejects_symlink_to_registered_workspace("setup");
}

#[test]
fn create_reuse_rejects_symlink_to_another_registered_workspace() {
    assert_rejects_symlink_to_registered_workspace("create");
}

#[test]
fn adopt_rejects_symlink_to_another_registered_workspace() {
    assert_rejects_symlink_to_registered_workspace("adopt");
}

#[test]
fn preparation_rejects_git_file_symlink_to_another_registered_workspace() {
    for command in ["setup-no-hooks", "setup", "create"] {
        assert_rejects_symlink_to_registered_workspace_entry(command, true);
    }
}

fn assert_rejects_symlink_to_registered_workspace(command: &str) {
    assert_rejects_symlink_to_registered_workspace_entry(command, false);
}

fn assert_rejects_symlink_to_registered_workspace_entry(command: &str, gitfile: bool) {
    for recorded in [false, true] {
        let repo = Repo::new();
        for name in ["b", "a"] {
            assert!(repo.mabo(&["create", name, "--no-setup"]).status.success());
        }
        if !recorded || command == "adopt" {
            assert!(repo.mabo(&["forget", "a"]).status.success());
        }
        if command == "adopt" && !recorded {
            assert!(repo.mabo(&["forget", "b"]).status.success());
        }
        let a = managed(&repo, "a");
        let b = managed(&repo, "b");
        // Make the vulnerable registration scan find b first regardless of readdir order.
        let admins: Vec<_> = fs::read_dir(repo.repo.join(".git/worktrees"))
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .collect();
        assert_eq!(admins.len(), 2);
        for (admin, (name, checkout)) in admins.iter().zip([("b", &b), ("a", &a)]) {
            fs::write(
                admin.join("gitdir"),
                format!("{}\n", checkout.join(".git").display()),
            )
            .unwrap();
            fs::write(admin.join("HEAD"), format!("ref: refs/heads/{name}\n")).unwrap();
            fs::write(
                checkout.join(".git"),
                format!("gitdir: {}\n", admin.display()),
            )
            .unwrap();
        }
        fs::write(repo.repo.join(".gitignore"), "*.env\n").unwrap();
        fs::write(repo.repo.join(".worktreeinclude"), "*.env\n").unwrap();
        fs::write(repo.repo.join("secret.env"), "primary secret").unwrap();
        fs::write(repo.repo.join("existing.env"), "primary value").unwrap();
        fs::write(b.join("existing.env"), "keep b value").unwrap();
        fs::write(
            repo.repo.join(".mabo.toml"),
            "[hooks]\nsetup = ['touch hook-ran']\n",
        )
        .unwrap();
        let replaced = if gitfile {
            let gitfile = a.join(".git");
            fs::remove_file(&gitfile).unwrap();
            std::os::unix::fs::symlink(b.join(".git"), &gitfile).unwrap();
            gitfile
        } else {
            fs::remove_dir_all(&a).unwrap();
            std::os::unix::fs::symlink(&b, &a).unwrap();
            a.clone()
        };
        let snapshot = |directory: &Path| {
            let mut files: Vec<_> = fs::read_dir(directory)
                .unwrap()
                .map(|entry| {
                    let path = entry.unwrap().path();
                    (
                        path.file_name().unwrap().to_owned(),
                        fs::read(&path).unwrap(),
                    )
                })
                .collect();
            files.sort();
            files
        };
        let a_before = snapshot(&a);
        let b_before = snapshot(&b);
        let records_path = repo.repo.join(".git/maboroshi/workspaces");
        let records_before = snapshot(&records_path);
        let args = match command {
            "setup-no-hooks" => vec!["setup", "a", "--no-hooks", "--json"],
            "setup" => vec!["setup", "a", "--json"],
            "create" => vec!["create", "--branch", "a", "--reuse", "--json"],
            "adopt" => vec!["adopt", a.to_str().unwrap(), "--name", "adopted", "--json"],
            _ => panic!("Unknown command"),
        };
        let out = repo.mabo(&args);
        let unchanged = snapshot(&b) == b_before && snapshot(&records_path) == records_before;
        assert_eq!(
            out.status.code(),
            Some(1),
            "{command}, recorded={recorded}, unchanged={unchanged}: {}",
            text(&out.stdout)
        );
        let doc = assert_envelope(&out, args[0]);
        assert_eq!(doc["error"]["code"], "failed");
        let message = doc["error"]["message"].as_str().unwrap();
        assert!(
            message.contains(".git") && message.contains("repair"),
            "{message}"
        );
        assert_eq!(snapshot(&a), a_before);
        assert_eq!(snapshot(&b), b_before);
        assert_eq!(snapshot(&records_path), records_before);
        assert!(replaced
            .symlink_metadata()
            .unwrap()
            .file_type()
            .is_symlink());
    }
}

#[test]
fn setup_reuse_and_adopt_allow_symlinked_parent_directories() {
    let repo = Repo::new();
    let real = repo.root.join("real-workspaces");
    let via = repo.root.join("via-workspaces");
    fs::create_dir(&real).unwrap();
    std::os::unix::fs::symlink(&real, &via).unwrap();
    assert!(repo
        .mabo(&["config", "set", "workspace-root", via.to_str().unwrap()])
        .status
        .success());
    assert!(repo.mabo(&["create", "a", "--no-setup"]).status.success());
    // Preserve a symlink spelling in Git's independent registration, too.
    fs::write(
        repo.repo.join(".git/worktrees/a/gitdir"),
        format!("{}\n", via.join("a/.git").display()),
    )
    .unwrap();
    let primary_alias = repo.root.join("via-primary");
    std::os::unix::fs::symlink(&repo.repo, &primary_alias).unwrap();
    fs::write(repo.repo.join(".gitignore"), "*.env\n").unwrap();
    fs::write(repo.repo.join(".worktreeinclude"), "*.env\n").unwrap();
    fs::write(repo.repo.join("secret.env"), "primary secret").unwrap();
    let via_a = via.join("a");
    for args in [
        vec!["setup", "a", "--no-hooks", "--json"],
        vec!["setup", "a", "--json"],
        vec!["create", "a", "--reuse", "--json"],
        vec!["forget", "a", "--json"],
        vec!["adopt", via_a.to_str().unwrap(), "--json"],
    ] {
        let out = repo
            .command(env!("CARGO_BIN_EXE_mabo"), &args)
            .current_dir(&primary_alias)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "{args:?}: {} {}",
            text(&out.stdout),
            text(&out.stderr)
        );
    }
    assert_eq!(
        fs::read_to_string(real.join("a/secret.env")).unwrap(),
        "primary secret"
    );
}

#[test]
fn setup_rejects_checkout_replaced_by_foreign_repository() {
    assert_setup_rejects_replaced_checkout("foreign");
}

#[test]
fn setup_rejects_checkout_replaced_by_symlink() {
    assert_setup_rejects_replaced_checkout("symlink");
}

#[test]
fn setup_rejects_git_file_pointing_to_primary() {
    assert_setup_rejects_replaced_checkout("primary-admin");
}

#[test]
fn setup_rejects_git_discovery_falling_back_to_parent() {
    assert_setup_rejects_replaced_checkout("parent");
}

fn assert_setup_rejects_replaced_checkout(replacement: &str) {
    for recorded in [true, false] {
        for no_hooks in [true, false] {
            let repo = Repo::new();
            let foreign = Repo::new();
            assert!(repo
                .mabo(&["config", "set", "workspace-root", "workspaces"])
                .status
                .success());
            assert!(repo
                .mabo(&["create", "target", "--no-setup"])
                .status
                .success());
            if !recorded {
                assert!(repo.mabo(&["forget", "target"]).status.success());
            }
            fs::write(repo.repo.join(".gitignore"), "*.env\n").unwrap();
            fs::write(repo.repo.join(".worktreeinclude"), "*.env\n").unwrap();
            fs::write(repo.repo.join("secret.env"), "primary secret").unwrap();
            fs::write(
                repo.repo.join(".mabo.toml"),
                "[hooks]\nsetup = ['git add README.md; touch hook-ran']\n",
            )
            .unwrap();
            let target = repo.repo.join("workspaces/target");
            match replacement {
                "foreign" => {
                    fs::remove_dir_all(&target).unwrap();
                    fs::rename(&foreign.repo, &target).unwrap();
                }
                "symlink" => {
                    fs::remove_dir_all(&target).unwrap();
                    std::os::unix::fs::symlink(&foreign.repo, &target).unwrap();
                }
                "primary-admin" => fs::write(
                    target.join(".git"),
                    format!("gitdir: {}\n", repo.repo.join(".git").display()),
                )
                .unwrap(),
                "parent" => fs::remove_file(target.join(".git")).unwrap(),
                _ => panic!("Unknown replacement"),
            }
            fs::write(target.join("README.md"), "changed in target\n").unwrap();
            let records_path = repo.repo.join(".git/maboroshi/workspaces");
            let records_before = records::read(&records_path).unwrap();
            let head_before = fs::read(repo.repo.join(".git/HEAD")).unwrap();
            let index_before = fs::read(repo.repo.join(".git/index")).unwrap();
            let gitfile_before = fs::read(target.join(".git")).ok();
            let mut args = vec!["setup", "target", "--json"];
            if no_hooks {
                args.push("--no-hooks");
            }
            let out = repo.mabo(&args);
            assert_eq!(
                out.status.code(),
                Some(1),
                "{replacement}, recorded={recorded}, no_hooks={no_hooks}: {}",
                text(&out.stdout)
            );
            let doc = assert_envelope(&out, "setup");
            assert_eq!(doc["error"]["code"], "failed");
            let message = doc["error"]["message"].as_str().unwrap();
            assert!(message.contains(".git"), "{message}");
            assert!(message.contains("repair"), "{message}");
            assert!(!target.join("secret.env").exists());
            assert!(!target.join("hook-ran").exists());
            assert_eq!(records::read(&records_path).unwrap(), records_before);
            assert_eq!(fs::read(repo.repo.join(".git/HEAD")).unwrap(), head_before);
            assert_eq!(
                fs::read(repo.repo.join(".git/index")).unwrap(),
                index_before
            );
            assert_eq!(fs::read(target.join(".git")).ok(), gitfile_before);
        }
    }
}

#[test]
fn setup_and_create_escape_copy_failure_diagnostics() {
    for command in ["setup", "create"] {
        for json in [false, true] {
            let repo = Repo::new();
            let directory = "private\u{1b}[31m\t";
            let filename = "secret\u{7}.env";
            let outside = repo.root.join("outside");
            fs::create_dir(&outside).unwrap();
            std::os::unix::fs::symlink(&outside, repo.repo.join(directory)).unwrap();
            fs::write(repo.repo.join(".gitignore"), "*.env\n").unwrap();
            fs::write(repo.repo.join(".worktreeinclude"), "*.env\n").unwrap();
            repo.git(&["add", ".gitignore", ".worktreeinclude", directory]);
            repo.git(&["commit", "-m", "copy failure fixture"]);
            fs::remove_file(repo.repo.join(directory)).unwrap();
            fs::create_dir(repo.repo.join(directory)).unwrap();
            fs::write(repo.repo.join(directory).join(filename), "secret").unwrap();
            if command == "setup" {
                assert!(repo
                    .mabo(&["create", "target", "--no-setup"])
                    .status
                    .success());
            }
            let mut args = vec![command, "target"];
            if json {
                args.push("--json");
            }
            let out = repo.mabo(&args);
            assert_eq!(
                out.status.code(),
                Some(if command == "setup" { 1 } else { 6 })
            );
            let stderr = text(&out.stderr);
            assert!(!stderr.contains(['\u{1b}', '\t', '\u{7}']), "{stderr:?}");
            assert!(
                stderr.contains("private\\u{1b}[31m\\u{9}/secret\\u{7}.env"),
                "{stderr:?}"
            );
            if command == "setup" && !json {
                assert!(stderr
                    .lines()
                    .any(|line| line.starts_with("Failed to copy ")));
            }
            if json {
                let doc = assert_envelope(&out, command);
                assert!(doc["data"]["copy"]["error"]
                    .as_str()
                    .unwrap()
                    .contains(&format!("{directory}/{filename}")));
            }
            assert!(!outside.join(filename).exists());
        }
    }
}

#[test]
fn setup_source_checkout_rejects_another_repository_before_changes() {
    let repo = Repo::new();
    let other = Repo::new();
    assert!(repo
        .mabo(&["create", "target", "--no-setup"])
        .status
        .success());
    let before = records::read(repo.repo.join(".git/maboroshi/workspaces")).unwrap();
    fs::write(repo.repo.join(".gitignore"), "*.env\n").unwrap();
    fs::write(repo.repo.join("secret.env"), "secret").unwrap();
    fs::write(
        other.repo.join(".mabo.toml"),
        "[hooks]\nsetup = ['touch wrong-hook']\n",
    )
    .unwrap();
    let out = repo.mabo(&[
        "setup",
        "target",
        "--source-checkout",
        other.repo.to_str().unwrap(),
        "--copy-file",
        "*.env",
        "--json",
    ]);
    assert_eq!(out.status.code(), Some(2), "{}", text(&out.stderr));
    assert!(json_value(&out)["error"]["message"]
        .as_str()
        .unwrap()
        .contains("selected repository"));
    assert_eq!(
        records::read(repo.repo.join(".git/maboroshi/workspaces")).unwrap(),
        before
    );
    assert!(!managed(&repo, "target/secret.env").exists());
    assert!(!managed(&repo, "target/wrong-hook").exists());
}

#[test]
fn setup_retry_hint_preserves_linked_source_hooks() {
    for json in [false, true] {
        for mode in 0..4 {
            if mode == 2 && !cfg!(debug_assertions) {
                continue;
            }
            let fallback = mode != 0;
            let repo = Repo::new();
            assert!(repo
                .mabo(&["create", "source", "--no-setup"])
                .status
                .success());
            let source = managed(&repo, "source");
            let gh_path = fallback.then(|| {
                let path = fake_gh_for_topic_pr(&repo);
                publish_pr_topic(&repo);
                let gh = repo.root.join("bin/gh");
                let script = fs::read_to_string(&gh).unwrap();
                fs::write(&gh, script.replace("\"topic\"", "\"topic+fix\"")).unwrap();
                if mode == 1 {
                    assert!(repo
                        .create_recorded(&["create", "duplicate", "--pr", "7", "--no-setup"])
                        .status
                        .success());
                }
                path
            });
            fs::write(
                repo.repo.join(".mabo.toml"),
                "[hooks]\nsetup = ['touch primary-hook']\n",
            )
            .unwrap();
            fs::write(
                source.join(".mabo.toml"),
                "[hooks]\nsetup = ['test -f ready && touch source-hook']\n",
            )
            .unwrap();
            let mut args = if fallback {
                vec!["create", "--pr", "7"]
            } else {
                vec!["create", "target"]
            };
            if json {
                args.push("--json");
            }
            let mut command = repo.command(env!("CARGO_BIN_EXE_mabo"), &args);
            command.current_dir(&source);
            if mode == 2 {
                command.env("MABO_TEST_FAIL_METADATA_SAVE", "1");
            }
            if let Some(path) = gh_path {
                command.env("PATH", path);
            }
            let created = command.output().unwrap();
            assert_eq!(created.status.code(), Some(6), "{}", text(&created.stderr));
            let target = managed(&repo, if fallback { "topic+fix" } else { "target" });
            let hint = setup_retry_hint(&created, json);
            assert!(!hint.chars().any(char::is_control), "{hint:?}");
            fs::write(target.join("ready"), "").unwrap();
            let retried = run_setup_retry_hint(&repo, &repo.root, &hint);
            assert!(
                retried.status.success(),
                "{hint}: {}",
                text(&retried.stderr)
            );
            assert!(target.join("source-hook").is_file(), "{hint}");
            assert!(!target.join("primary-hook").exists(), "{hint}");
            let shown = repo
                .command(env!("CARGO_BIN_EXE_mabo"), &["show", ".", "--json"])
                .current_dir(&target)
                .output()
                .unwrap();
            assert_eq!(
                json_value(&shown)["data"]["workspace"]["setup"]["state"],
                "ok"
            );
            assert!(!source.join("source-hook").exists());
        }
    }
}

#[test]
fn setup_retry_hint_preserves_copy_patterns_after_copy_failure() {
    for json in [false, true] {
        for fallback in [false, true] {
            let repo = Repo::new();
            let directory = "private's $data `literal`\t";
            let outside = repo.root.join("outside");
            fs::create_dir(&outside).unwrap();
            std::os::unix::fs::symlink(&outside, repo.repo.join(directory)).unwrap();
            fs::write(repo.repo.join(".gitignore"), "*.env\n").unwrap();
            repo.git(&["add", ".gitignore", directory]);
            repo.git(&["commit", "-m", "copy retry fixture"]);
            let gh_path = fallback.then(|| {
                let path = fake_gh_for_topic_pr(&repo);
                publish_pr_topic(&repo);
                let gh = repo.root.join("bin/gh");
                let script = fs::read_to_string(&gh).unwrap();
                fs::write(&gh, script.replace("\"topic\"", "\"topic+fix\"")).unwrap();
                assert!(repo
                    .create_recorded(&["create", "duplicate", "--pr", "7", "--no-setup"])
                    .status
                    .success());
                path
            });
            fs::remove_file(repo.repo.join(directory)).unwrap();
            fs::create_dir(repo.repo.join(directory)).unwrap();
            fs::write(repo.repo.join(directory).join("secret.env"), "secret").unwrap();
            fs::write(repo.repo.join(".env"), "environment").unwrap();
            fs::write(repo.repo.join("extra.env"), "extra").unwrap();
            assert!(!repo.repo.join(".worktreeinclude").exists());
            let name = if fallback { "topic+fix" } else { "copy-retry" };
            let mut args = if fallback {
                vec!["create", "--pr", "7"]
            } else {
                vec!["create", name]
            };
            let pattern = format!("{directory}/*.env");
            args.extend(["--copy-file", ".env", "--copy-file", &pattern]);
            args.extend(["--copy-file", "extra.env"]);
            if json {
                args.push("--json");
            }
            let mut command = repo.command(env!("CARGO_BIN_EXE_mabo"), &args);
            if let Some(path) = gh_path {
                command.env("PATH", path);
            }
            let created = command.output().unwrap();
            assert_eq!(created.status.code(), Some(6), "{}", text(&created.stderr));
            let target = managed(&repo, name);
            let shown = repo
                .command(env!("CARGO_BIN_EXE_mabo"), &["show", "--json"])
                .current_dir(&target)
                .output()
                .unwrap();
            let shown = json_value(&shown);
            assert_eq!(shown["data"]["workspace"]["setup"]["state"], "failed");
            assert!(!target.join(directory).join("secret.env").exists());
            assert!(!outside.join("secret.env").exists());
            // Fix the destination obstruction, then execute the displayed hint verbatim.
            fs::remove_file(target.join(directory)).unwrap();
            let hint = setup_retry_hint(&created, json);
            let retried = run_setup_retry_hint(&repo, &repo.root, &hint);
            assert!(
                retried.status.success(),
                "{hint}: {} {}",
                text(&retried.stdout),
                text(&retried.stderr)
            );
            assert_eq!(
                fs::read_to_string(target.join(directory).join("secret.env")).unwrap(),
                "secret",
                "{hint}"
            );
            assert_eq!(
                fs::read_to_string(target.join(".env")).unwrap(),
                "environment"
            );
            assert_eq!(
                fs::read_to_string(target.join("extra.env")).unwrap(),
                "extra"
            );
            assert_eq!(hint.starts_with("(cd "), fallback, "{hint}");
            assert_eq!(hint.matches(" --copy-file ").count(), 3, "{hint}");
            let shown = repo
                .command(env!("CARGO_BIN_EXE_mabo"), &["show", "--json"])
                .current_dir(&target)
                .output()
                .unwrap();
            let shown = json_value(&shown);
            assert_eq!(shown["data"]["workspace"]["setup"]["state"], "ok");
        }
    }
}

#[test]
fn setup_retry_hint_escapes_copy_patterns_in_text_and_json() {
    let mut hints = Vec::new();
    for json in [false, true] {
        let repo = Repo::new();
        fs::write(
            repo.repo.join(".mabo.toml"),
            "[hooks]\nsetup = ['exit 1']\n",
        )
        .unwrap();
        let mut args = vec![
            "create",
            "copy-retry",
            "--copy-file",
            "private's $data `literal`/*.env",
            "--copy-file",
            "control\u{1b}[31m\t\n\u{202e}*.env",
        ];
        if json {
            args.push("--json");
        }
        let created = repo.mabo(&args);
        assert_eq!(created.status.code(), Some(6), "{}", text(&created.stderr));
        let hint = setup_retry_hint(&created, json);
        assert!(!hint.chars().any(char::is_control), "{hint:?}");
        assert!(
            hint.ends_with(
                " --copy-file 'private'\\''s $data `literal`/*.env' --copy-file $'control\\x1b[31m\\t\\n\\xe2\\x80\\xae*.env'"
            ),
            "{hint}"
        );
        hints.push(hint.replace(repo.repo.to_str().unwrap(), "PRIMARY"));
    }
    assert_eq!(hints[0], hints[1]);
}

#[test]
fn setup_retry_hint_resolves_pr_names_and_ambiguous_links() {
    for json in [false, true] {
        for ambiguous in [false, true] {
            let repo = Repo::new();
            let path = fake_gh_for_topic_pr(&repo);
            publish_pr_topic(&repo);
            let gh = repo.root.join("bin/gh");
            let script = fs::read_to_string(&gh).unwrap();
            fs::write(&gh, script.replace("\"topic\"", "\"topic+fix\"")).unwrap();
            if ambiguous {
                assert!(repo
                    .create_recorded(&["create", "duplicate", "--pr", "7", "--no-setup"])
                    .status
                    .success());
            }
            fs::write(
                repo.repo.join(".mabo.toml"),
                "[hooks]\nsetup = [\"test -f ready && touch hook-ran\"]\n",
            )
            .unwrap();
            let mut args = vec!["create", "--pr", "7"];
            if json {
                args.push("--json");
            }
            let created = repo
                .command(env!("CARGO_BIN_EXE_mabo"), &args)
                .env("PATH", &path)
                .output()
                .unwrap();
            assert_eq!(created.status.code(), Some(6), "{}", text(&created.stderr));
            let hint = setup_retry_hint(&created, json);
            let target = managed(&repo, "topic+fix");
            fs::write(target.join("ready"), "").unwrap();
            let retried = run_setup_retry_hint(&repo, &repo.repo, &hint);
            assert!(
                retried.status.success(),
                "{hint}: {} {}",
                text(&retried.stdout),
                text(&retried.stderr)
            );
            assert!(target.join("hook-ran").is_file());
            if ambiguous {
                assert!(hint.starts_with("(cd "), "{hint}");
            } else {
                assert!(hint.ends_with("setup 'pr:7'"), "{hint}");
            }
            let listed = json_value(&repo.mabo(&["list", "--json"]));
            let workspace = listed["data"]["workspaces"]
                .as_array()
                .unwrap()
                .iter()
                .find(|tree| tree["name"] == "topic+fix")
                .unwrap();
            assert_eq!(workspace["setup"]["state"], "ok");
            if ambiguous {
                assert!(!managed(&repo, "duplicate/hook-ran").exists());
            }
        }
    }
}

fn setup_retry_hint(out: &std::process::Output, json: bool) -> String {
    let message = if json {
        json_value(out)["error"]["message"]
            .as_str()
            .unwrap()
            .to_owned()
    } else {
        text(&out.stderr)
    };
    message
        .split_once("Retry with `")
        .expect("retry hint")
        .1
        .strip_suffix("`.")
        .expect("end of retry hint")
        .to_owned()
}

fn run_setup_retry_hint(repo: &Repo, cwd: &Path, hint: &str) -> std::process::Output {
    let binary_dir = Path::new(env!("CARGO_BIN_EXE_mabo")).parent().unwrap();
    repo.command("bash", &["-c", hint])
        .current_dir(cwd)
        .env("MABO_TRUST_ALL", "1")
        .env(
            "PATH",
            format!(
                "{}:{}",
                binary_dir.display(),
                std::env::var("PATH").unwrap()
            ),
        )
        .output()
        .unwrap()
}

#[test]
fn setup_retry_hint_preserves_selected_repository_from_any_directory() {
    for json in [false, true] {
        for from_other_repo in [false, true] {
            for directory in [
                "primary's $repo `literal` with spaces",
                "primary's $repo `literal`\u{1b}[31m\t\nend",
            ] {
                let mut repo = Repo::new();
                let renamed = repo.root.join(directory);
                fs::rename(&repo.repo, &renamed).unwrap();
                repo.repo = renamed;
                let other = Repo::new();
                let outside = repo.root.join("outside");
                fs::create_dir(&outside).unwrap();
                let decoy = repo.mabo(&[
                    "-R",
                    other.repo.to_str().unwrap(),
                    "create",
                    "lifecycle",
                    "--no-setup",
                ]);
                assert!(decoy.status.success(), "{}", text(&decoy.stderr));
                let other_records = other.repo.join(".git/maboroshi/workspaces");
                let before = records::read(&other_records).unwrap();
                fs::write(
                    other.repo.join(".mabo.toml"),
                    "[hooks]\nsetup = [\"touch wrong-target\"]\n",
                )
                .unwrap();
                fs::write(
                    repo.repo.join(".mabo.toml"),
                    "[hooks]\nsetup = [\"test -f ready && touch hook-ran\"]\n",
                )
                .unwrap();
                let mut args = vec!["-R", repo.repo.to_str().unwrap(), "create", "lifecycle"];
                if json {
                    args.push("--json");
                }
                let created = repo
                    .command(env!("CARGO_BIN_EXE_mabo"), &args)
                    .current_dir(&outside)
                    .output()
                    .unwrap();
                assert_eq!(created.status.code(), Some(6), "{}", text(&created.stderr));
                let hint = setup_retry_hint(&created, json);
                assert!(!hint.chars().any(char::is_control), "{hint:?}");
                assert!(hint.starts_with("cd "), "{hint}");
                assert!(hint.ends_with("setup 'lifecycle'"), "{hint}");
                fs::write(managed(&repo, "lifecycle/ready"), "").unwrap();
                let cwd = if from_other_repo {
                    &other.repo
                } else {
                    &outside
                };
                let retried = run_setup_retry_hint(&repo, cwd, &hint);
                assert!(
                    retried.status.success(),
                    "{hint}: {} {}",
                    text(&retried.stdout),
                    text(&retried.stderr)
                );
                assert!(managed(&repo, "lifecycle/hook-ran").is_file());
                let shown = repo.mabo(&["show", "lifecycle", "--json"]);
                assert_eq!(
                    json_value(&shown)["data"]["workspace"]["setup"]["state"],
                    "ok"
                );
                assert_eq!(records::read(&other_records).unwrap(), before);
                let decoy_path =
                    managed_directory(&other.repo, &repo.root.join("xdg")).join("lifecycle");
                assert!(!decoy_path.join("wrong-target").exists());
            }
        }
    }
}

#[cfg(debug_assertions)]
#[test]
fn setup_retry_hint_works_without_saved_links() {
    for json in [false, true] {
        let repo = Repo::new();
        let path = fake_gh_for_topic_pr(&repo);
        publish_pr_topic(&repo);
        let gh = repo.root.join("bin/gh");
        let script = fs::read_to_string(&gh).unwrap();
        fs::write(&gh, script.replace("\"topic\"", "\"topic+fix\"")).unwrap();
        fs::write(
            repo.repo.join(".mabo.toml"),
            "[hooks]\nsetup = [\"test -f ready && touch hook-ran\"]\n",
        )
        .unwrap();
        let mut args = vec!["create", "--pr", "7"];
        if json {
            args.push("--json");
        }
        let created = repo
            .command(env!("CARGO_BIN_EXE_mabo"), &args)
            .env("PATH", &path)
            .env("MABO_TEST_FAIL_METADATA_SAVE", "1")
            .output()
            .unwrap();
        assert_eq!(created.status.code(), Some(6), "{}", text(&created.stderr));
        if json {
            let doc = json_value(&created);
            assert_eq!(doc["data"]["metadata"]["ok"], false);
            assert!(doc["data"]["workspace"]["links"]["pr"].is_null());
        }
        let hint = setup_retry_hint(&created, json);
        fs::write(managed(&repo, "topic+fix/ready"), "").unwrap();
        let retried = run_setup_retry_hint(&repo, &repo.root, &hint);
        assert!(
            retried.status.success(),
            "{hint}: {} {}",
            text(&retried.stdout),
            text(&retried.stderr)
        );
        assert!(hint.starts_with("(cd "), "{hint}");
        assert!(managed(&repo, "topic+fix/hook-ran").is_file());
        let shown = repo
            .command(env!("CARGO_BIN_EXE_mabo"), &["show", "--json"])
            .current_dir(managed(&repo, "topic+fix"))
            .output()
            .unwrap();
        assert_eq!(
            json_value(&shown)["data"]["workspace"]["setup"]["state"],
            "ok"
        );
    }
}

#[test]
fn setup_lifecycle_failure_retry_and_shared_state() {
    let repo = Repo::new();
    fs::write(
        repo.repo.join(".mabo.toml"),
        "[hooks]\nsetup = [\"test -f ready\"]\n",
    )
    .unwrap();
    let out = repo.mabo(&["create", "lifecycle", "--json"]);
    assert_eq!(out.status.code(), Some(6), "{}", text(&out.stderr));
    let doc: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(doc["data"]["workspace"]["setup"]["state"], "failed");
    assert_eq!(doc["data"]["setup"]["exitCode"], 1);
    assert_eq!(
        setup_retry_hint(&out, true),
        format!("cd '{}' && mabo setup 'lifecycle'", repo.repo.display())
    );
    let path = managed(&repo, "lifecycle");
    assert!(text(&repo.mabo(&["list"]).stdout).contains("setup:failed"));
    let records = repo.repo.join(".git/maboroshi/workspaces");
    let before = records::read(&records).unwrap();
    let reused = repo.mabo(&["create", "lifecycle", "--reuse", "--json"]);
    assert!(reused.status.success(), "{}", text(&reused.stderr));
    assert_eq!(
        json_value(&reused)["data"]["workspace"]["setup"]["state"],
        "failed"
    );
    assert_eq!(records::read(&records).unwrap(), before);
    fs::write(path.join("ready"), "").unwrap();
    let retry = repo.mabo(&["setup", "lifecycle", "--json"]);
    assert!(retry.status.success(), "{}", text(&retry.stderr));
    let doc: serde_json::Value = serde_json::from_slice(&retry.stdout).unwrap();
    assert_eq!(doc["data"]["setup"]["state"], "ok");
    for args in [
        vec!["show", "lifecycle", "--json"],
        vec!["set", "lifecycle", "--purpose", "done", "--json"],
    ] {
        let out = repo.mabo(&args);
        assert!(out.status.success(), "{}", text(&out.stderr));
        let doc: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
        assert_eq!(doc["data"]["workspace"]["setup"]["state"], "ok");
        assert!(doc["data"]["workspace"]["setup"]["error"].is_null());
    }
}

#[test]
fn setup_lifecycle_skip_and_removed_create_flag() {
    let repo = Repo::new();
    fs::write(repo.repo.join(".gitignore"), "*.env\n").unwrap();
    fs::write(repo.repo.join(".worktreeinclude"), "*.env\n").unwrap();
    fs::write(repo.repo.join("secret.env"), "secret").unwrap();
    fs::write(
        repo.repo.join(".mabo.toml"),
        "[hooks]\nsetup = [\"touch hook-ran\"]\n",
    )
    .unwrap();
    for args in [
        vec!["create", "bad", "--no-hooks", "--json"],
        vec![
            "create",
            "bad",
            "--no-setup",
            "--copy-file",
            "*.env",
            "--json",
        ],
    ] {
        let out = repo.mabo(&args);
        assert_eq!(out.status.code(), Some(2), "{}", text(&out.stderr));
        assert!(text(&out.stdout).contains("--no-setup"));
        assert!(!managed(&repo, "bad").exists());
    }
    let out = repo.mabo(&["create", "skip", "--no-setup", "--json"]);
    assert!(out.status.success(), "{}", text(&out.stderr));
    let doc: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(doc["data"]["workspace"]["setup"]["state"], "skipped");
    assert_eq!(doc["data"]["setup"]["state"], "skipped");
    assert!(!managed(&repo, "skip").join("secret.env").exists());
    assert!(!managed(&repo, "skip").join("hook-ran").exists());
    let out = repo
        .command(
            env!("CARGO_BIN_EXE_mabo"),
            &["setup", "skip", "--no-hooks", "--json"],
        )
        .env_remove("MABO_TRUST_ALL")
        .output()
        .unwrap();
    assert!(out.status.success(), "{}", text(&out.stderr));
    assert!(managed(&repo, "skip").join("secret.env").exists());
    assert!(!managed(&repo, "skip").join("hook-ran").exists());
}

#[test]
fn setup_lifecycle_trust_refusal_and_primary_are_read_only() {
    let repo = Repo::new();
    assert!(repo.mabo(&["create", "target", "--json"]).status.success());
    fs::write(repo.repo.join(".gitignore"), "*.env\n").unwrap();
    fs::write(repo.repo.join(".worktreeinclude"), "*.env\n").unwrap();
    fs::write(repo.repo.join("secret.env"), "secret").unwrap();
    fs::write(
        repo.repo.join(".mabo.toml"),
        "[hooks]\nsetup = [\"touch hook-ran\"]\n",
    )
    .unwrap();
    let records = repo.repo.join(".git/maboroshi/workspaces");
    let before: Vec<_> = fs::read_dir(&records)
        .unwrap()
        .map(|e| fs::read(e.unwrap().path()).unwrap())
        .collect();
    let out = repo
        .command(
            env!("CARGO_BIN_EXE_mabo"),
            &["setup", "target", "--no-input", "--json"],
        )
        .env_remove("MABO_TRUST_ALL")
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(4), "{}", text(&out.stderr));
    let doc: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(doc["error"]["code"], "untrusted");
    let after: Vec<_> = fs::read_dir(&records)
        .unwrap()
        .map(|e| fs::read(e.unwrap().path()).unwrap())
        .collect();
    assert_eq!(before, after);
    assert!(!managed(&repo, "target").join("secret.env").exists());
    assert!(!managed(&repo, "target").join("hook-ran").exists());
    let out = repo.mabo(&["setup", "--json"]);
    assert_eq!(out.status.code(), Some(4));
    let doc: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(doc["error"]["code"], "primary");
    assert_eq!(
        repo.mabo(&["setup", "missing", "--json"]).status.code(),
        Some(3)
    );
}

#[test]
fn setup_lifecycle_rejects_legacy_hook_keys() {
    let repo = Repo::new();
    for (old, new) in [("post-create", "setup"), ("pre-delete", "pre-remove")] {
        fs::write(
            repo.repo.join(".mabo.toml"),
            format!("[hooks]\n{old} = []\n"),
        )
        .unwrap();
        for args in [
            vec!["create", "target", "--json"],
            vec!["setup", "target", "--json"],
            vec!["trust", "add", "--json"],
            vec!["remove", "target", "--json"],
            vec!["gc", "--json"],
        ] {
            let out = repo.mabo(&args);
            assert_eq!(
                out.status.code(),
                Some(1),
                "{args:?}: {}",
                text(&out.stderr)
            );
            let doc: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
            assert_eq!(doc["error"]["code"], "failed");
            assert!(doc["error"]["message"].as_str().unwrap().contains(new));
        }
    }
}

#[test]
fn setup_lifecycle_copies_from_primary_from_other_checkout_and_subdirectory() {
    let repo = Repo::new();
    fs::write(repo.repo.join(".gitignore"), "*.env\n*.extra\n").unwrap();
    fs::write(repo.repo.join(".worktreeinclude"), "*.env\n").unwrap();
    repo.git(&["add", ".gitignore", ".worktreeinclude"]);
    repo.git(&["commit", "-m", "copy rules"]);
    fs::write(repo.repo.join("secret.env"), "primary").unwrap();
    fs::write(repo.repo.join("secret.extra"), "extra").unwrap();
    assert!(repo
        .mabo(&["create", "caller", "--no-setup"])
        .status
        .success());
    let caller = managed(&repo, "caller");
    fs::write(caller.join("secret.env"), "caller").unwrap();
    fs::write(caller.join(".worktreeinclude"), "nothing\n").unwrap();
    fs::create_dir(caller.join("sub")).unwrap();
    let out = repo
        .command(
            env!("CARGO_BIN_EXE_mabo"),
            &["create", "target", "--copy-file", "*.extra", "--json"],
        )
        .current_dir(caller.join("sub"))
        .output()
        .unwrap();
    assert!(out.status.success(), "{}", text(&out.stderr));
    let target = managed(&repo, "target");
    assert_eq!(
        fs::read_to_string(target.join("secret.env")).unwrap(),
        "primary"
    );
    assert_eq!(
        fs::read_to_string(target.join("secret.extra")).unwrap(),
        "extra"
    );
    fs::write(target.join("secret.env"), "keep").unwrap();
    fs::remove_file(target.join("secret.extra")).unwrap();
    let out = repo
        .command(
            env!("CARGO_BIN_EXE_mabo"),
            &[
                "setup",
                "target",
                "--copy-file",
                "*.extra",
                "--no-hooks",
                "--json",
            ],
        )
        .current_dir(caller.join("sub"))
        .output()
        .unwrap();
    assert!(out.status.success(), "{}", text(&out.stderr));
    assert_eq!(
        fs::read_to_string(target.join("secret.env")).unwrap(),
        "keep"
    );
    assert_eq!(
        fs::read_to_string(target.join("secret.extra")).unwrap(),
        "extra"
    );
}

#[test]
fn setup_lifecycle_interrupted_is_display_only() {
    let repo = Repo::new();
    assert!(repo
        .mabo(&["create", "interrupted", "--json"])
        .status
        .success());
    let record = fs::read_dir(repo.repo.join(".git/maboroshi/workspaces"))
        .unwrap()
        .map(|e| e.unwrap().path())
        .find(|p| p.extension().is_some_and(|e| e == "json"))
        .unwrap();
    let host = test_git::command("uname").arg("-n").output().unwrap();
    let mut doc: serde_json::Value = serde_json::from_slice(&fs::read(&record).unwrap()).unwrap();
    doc["setup"] = serde_json::json!({"state":"running", "at":"2026-10-21T00:00:00Z", "error":null, "pid":unused_pid(), "host":text(&host.stdout)});
    fs::write(&record, serde_json::to_vec(&doc).unwrap()).unwrap();
    let before = fs::read(&record).unwrap();
    let out = repo.mabo(&["show", "interrupted", "--json"]);
    assert!(out.status.success());
    let doc: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(doc["data"]["workspace"]["setup"]["state"], "interrupted");
    assert_eq!(before, fs::read(&record).unwrap());
    let out = repo.mabo(&["list"]);
    assert!(text(&out.stdout).contains("setup:interrupted"));
    assert_eq!(before, fs::read(&record).unwrap());
    assert!(repo
        .mabo(&["setup", "interrupted", "--json"])
        .status
        .success());
    let doc: serde_json::Value = serde_json::from_slice(&fs::read(&record).unwrap()).unwrap();
    assert_eq!(doc["setup"]["state"], "ok");
}

#[test]
fn setup_lifecycle_running_is_saved_before_hooks_and_process_fields_stay_internal() {
    let repo = Repo::new();
    fs::write(
        repo.repo.join(".mabo.toml"),
        r#"[hooks]
setup = ['cat "$MABO_REPO_PATH/.git/maboroshi/workspaces/$MABO_WORKSPACE_ID.json" > observed.json']
"#,
    )
    .unwrap();
    let out = repo.mabo(&["create", "observe", "--json"]);
    assert!(out.status.success(), "{}", text(&out.stderr));
    let observed: serde_json::Value =
        serde_json::from_slice(&fs::read(managed(&repo, "observe/observed.json")).unwrap())
            .unwrap();
    assert_eq!(observed["setup"]["state"], "running");
    assert!(observed["setup"]["pid"].as_u64().is_some_and(|pid| pid > 0));
    assert!(observed["setup"]["host"].is_string());
    let out = json_value(&out);
    assert!(out["data"]["workspace"]["setup"].get("pid").is_none());
    assert!(out["data"]["workspace"]["setup"].get("host").is_none());
}

#[test]
fn setup_lifecycle_copy_failure_stops_hooks_and_is_retryable() {
    let repo = Repo::new();
    assert!(repo
        .mabo(&["create", "copy-retry", "--no-setup"])
        .status
        .success());
    fs::write(
        repo.repo.join(".mabo.toml"),
        "[hooks]\nsetup = [\"touch hook-ran\"]\n",
    )
    .unwrap();
    std::os::unix::fs::symlink("missing", repo.repo.join(".worktreeinclude")).unwrap();
    let out = repo.mabo(&["setup", "copy-retry", "--json"]);
    assert_eq!(out.status.code(), Some(1), "{}", text(&out.stderr));
    let doc = json_value(&out);
    assert_eq!(doc["data"]["workspace"]["setup"]["state"], "failed");
    assert_eq!(doc["data"]["setup"]["ran"], false);
    assert!(doc["data"]["copy"]["error"].is_string());
    assert!(!managed(&repo, "copy-retry/hook-ran").exists());
    fs::remove_file(repo.repo.join(".worktreeinclude")).unwrap();
    let out = repo.mabo(&["setup", "copy-retry", "--json"]);
    assert!(out.status.success(), "{}", text(&out.stderr));
    assert_eq!(json_value(&out)["data"]["setup"]["state"], "ok");
    assert!(managed(&repo, "copy-retry/hook-ran").is_file());
    fs::write(
        repo.repo.join(".mabo.toml"),
        "[hooks]\nsetup = [\"exit 42\"]\n",
    )
    .unwrap();
    let out = repo.mabo(&["setup", "copy-retry", "--json"]);
    assert_eq!(out.status.code(), Some(1));
    assert_eq!(json_value(&out)["data"]["setup"]["exitCode"], 42);
}

#[test]
fn setup_lifecycle_unknown_legacy_adopt_and_null_after_forget() {
    let repo = Repo::new();
    let external = repo.root.join("external");
    repo.git(&[
        "worktree",
        "add",
        "-b",
        "external",
        external.to_str().unwrap(),
    ]);
    let out = repo.mabo(&["adopt", external.to_str().unwrap(), "--json"]);
    assert!(out.status.success(), "{}", text(&out.stderr));
    assert_eq!(
        json_value(&out)["data"]["workspace"]["setup"],
        serde_json::json!({"state":"unknown", "at":null, "error":null})
    );
    // A pre-P6 individual record has no setup field.
    let record = fs::read_dir(repo.repo.join(".git/maboroshi/workspaces"))
        .unwrap()
        .map(|e| e.unwrap().path())
        .find(|p| p.extension().is_some_and(|e| e == "json"))
        .unwrap();
    let mut doc: serde_json::Value = serde_json::from_slice(&fs::read(&record).unwrap()).unwrap();
    doc.as_object_mut().unwrap().remove("setup");
    fs::write(&record, serde_json::to_vec(&doc).unwrap()).unwrap();
    let before = fs::read(&record).unwrap();
    let out = repo.mabo(&["show", "external", "--json"]);
    assert_eq!(
        json_value(&out)["data"]["workspace"]["setup"]["state"],
        "unknown"
    );
    assert_eq!(before, fs::read(&record).unwrap());
    let out = repo.mabo(&["forget", "external", "--json"]);
    assert!(out.status.success());
    assert!(json_value(&out)["data"]["items"][0]["workspace"]["setup"].is_null());
}

#[test]
fn setup_lifecycle_default_dot_and_selectors_match_inspection() {
    let repo = Repo::new();
    assert!(repo
        .mabo(&["create", "target", "--no-setup"])
        .status
        .success());
    assert!(repo.mabo(&["set", "target", "--pr", "7"]).status.success());
    let path = managed(&repo, "target/sub");
    fs::create_dir(&path).unwrap();
    let out = repo
        .command(
            env!("CARGO_BIN_EXE_mabo"),
            &["setup", "--no-hooks", "--json"],
        )
        .current_dir(&path)
        .output()
        .unwrap();
    assert!(out.status.success(), "{}", text(&out.stderr));
    assert_eq!(json_value(&out)["data"]["workspace"]["name"], "target");
    let out = repo.mabo(&["setup", "pr:7", "--json"]);
    assert!(out.status.success(), "{}", text(&out.stderr));
    assert_eq!(
        json_value(&out)["data"]["workspace"]["setup"]["state"],
        "ok"
    );
    let listed = repo.mabo(&["list", "--json"]);
    let doc = json_value(&listed);
    let target = doc["data"]["workspaces"]
        .as_array()
        .unwrap()
        .iter()
        .find(|w| w["name"] == "target")
        .unwrap();
    assert_eq!(target["setup"]["state"], "ok");
}

#[test]
fn setup_lifecycle_pre_remove_runs_for_delete_and_gc() {
    for command in ["remove", "gc"] {
        let repo = Repo::new();
        assert!(repo.mabo(&["create", "target"]).status.success());
        land_branch(&repo, "target");
        let marker = repo.root.join("pre-remove-ran");
        fs::write(
            repo.repo.join(".mabo.toml"),
            format!("[hooks]\npre-remove = ['touch {}']\n", marker.display()),
        )
        .unwrap();
        let args = if command == "remove" {
            vec!["remove", "target", "--json"]
        } else {
            vec!["gc", "--apply", "--merged", "--json"]
        };
        let out = repo.mabo(&args);
        assert!(out.status.success(), "{}", text(&out.stderr));
        assert!(marker.is_file(), "{command}: {}", text(&out.stdout));
        assert!(!managed(&repo, "target").exists());
    }
}

#[test]
fn setup_lifecycle_legacy_import_keeps_setup_unknown_until_explicit_run() {
    let repo = Repo::new();
    let external = repo.root.join("external");
    repo.git(&[
        "worktree",
        "add",
        "-b",
        "external",
        external.to_str().unwrap(),
    ]);
    let legacy = repo.repo.join(".git/maboroshi/worktrees.json");
    fs::create_dir_all(legacy.parent().unwrap()).unwrap();
    let bytes = serde_json::to_vec(
        &serde_json::json!({"version":1,"worktrees":[{"path":external,"purpose":"legacy"}]}),
    )
    .unwrap();
    fs::write(&legacy, &bytes).unwrap();
    let out = repo.mabo(&["show", "external", "--json"]);
    assert!(out.status.success(), "{}", text(&out.stderr));
    assert_eq!(
        json_value(&out)["data"]["workspace"]["setup"]["state"],
        "unknown"
    );
    assert_eq!(fs::read(&legacy).unwrap(), bytes);
    assert!(!legacy.parent().unwrap().join("workspaces").exists());
    // A metadata edit imports the record without claiming setup was run.
    let out = repo.mabo(&["set", "external", "--purpose", "imported", "--json"]);
    assert!(out.status.success(), "{}", text(&out.stderr));
    assert_eq!(
        json_value(&out)["data"]["workspace"]["setup"]["state"],
        "unknown"
    );
    assert!(legacy.with_extension("json.imported").is_file());
    let out = repo.mabo(&["setup", "external", "--json"]);
    assert!(out.status.success(), "{}", text(&out.stderr));
    assert_eq!(
        json_value(&out)["data"]["workspace"]["setup"]["state"],
        "ok"
    );
}

#[test]
fn retirement_remove_keeps_unpreserved_branch_but_branch_alone_is_not_a_workspace() {
    let repo = Repo::new();
    assert!(repo
        .mabo(&["create", "local", "--no-setup"])
        .status
        .success());
    let path = managed_root(&repo).join("local");
    fs::write(path.join("local.txt"), "local\n").expect("file");
    repo.command("git", &["add", "."])
        .current_dir(&path)
        .output()
        .expect("add");
    assert!(repo
        .command("git", &["commit", "-m", "local"])
        .current_dir(&path)
        .output()
        .expect("commit")
        .status
        .success());
    let out = repo.mabo(&["remove", "local", "--json"]);
    assert_eq!(out.status.code(), Some(0), "{}", text(&out.stderr));
    let value = assert_envelope(&out, "remove");
    assert_eq!(value["data"]["items"][0]["removed"], true);
    assert_eq!(value["data"]["items"][0]["branchKeptReason"], "unpreserved");
    assert_eq!(value["warnings"][0]["code"], "branch_kept_unpreserved");
    assert!(branch_listed(&repo, "local"));
    let retry = repo.mabo(&["remove", "local", "--json"]);
    assert_eq!(retry.status.code(), Some(3));
    assert_eq!(json_value(&retry)["error"]["code"], "not_found");
}

#[test]
fn retirement_dry_run_and_ignored_content_are_safe() {
    let repo = Repo::new();
    assert!(repo
        .mabo(&["create", "safe", "--no-setup"])
        .status
        .success());
    let path = managed_root(&repo).join("safe");
    fs::create_dir_all(repo.repo.join(".git/info")).expect("info");
    fs::write(repo.repo.join(".git/info/exclude"), "secret\n").expect("ignore");
    fs::write(path.join("secret"), "keep me").expect("secret");
    let out = repo.mabo(&["remove", "safe", "--json"]);
    assert_eq!(out.status.code(), Some(4));
    assert_eq!(json_value(&out)["error"]["code"], "dirty");
    let out = repo.mabo(&["remove", "safe", "--discard-changes", "--dry-run", "--json"]);
    assert_eq!(out.status.code(), Some(0), "{}", text(&out.stderr));
    assert_eq!(json_value(&out)["data"]["plan"], true);
    assert_eq!(json_value(&out)["data"]["items"][0]["removed"], false);
    assert!(path.join("secret").exists());
    assert!(branch_listed(&repo, "safe"));
}

#[test]
fn retirement_removed_interfaces_have_migration_hints() {
    let repo = Repo::new();
    for args in [
        vec!["delete", "old"],
        vec!["delete", "--current"],
        vec!["delete", "old", "-f"],
        vec!["remove", "old", "--force"],
        vec!["remove", "--current"],
        vec!["gc", "--force"],
        vec!["gc", "-f"],
        vec!["gc", "--pr"],
    ] {
        let mut args = args;
        args.push("--json");
        let out = repo.mabo(&args);
        assert_eq!(
            out.status.code(),
            Some(2),
            "{args:?}: {}",
            text(&out.stdout)
        );
        assert!(
            json_value(&out)["error"]["message"]
                .as_str()
                .expect("message")
                .contains("Use"),
            "{}",
            text(&out.stdout)
        );
    }
}

#[test]
fn retirement_review6_remove_keeps_unpreserved_branch_when_hook_removes_directory() {
    assert_retirement_hook_loses_directory(false, false);
}

#[test]
fn retirement_review6_remove_honors_keep_branch_when_hook_removes_directory() {
    assert_retirement_hook_loses_directory(false, true);
}

#[test]
fn retirement_review6_gc_stops_when_hook_removes_directory() {
    assert_retirement_hook_loses_directory(true, false);
    assert_retirement_hook_loses_directory(true, true);
}

fn assert_retirement_hook_loses_directory(gc: bool, keep_branch: bool) {
    for move_directory in [false, true] {
        let repo = Repo::new();
        assert!(repo
            .mabo(&["create", "topic", "--no-setup"])
            .status
            .success());
        commit_in_worktree(&repo, "topic");
        // GC needs integrated work; remove must also protect an unpreserved tip.
        if gc || keep_branch {
            repo.git(&["merge", "--ff-only", "refs/heads/topic"]);
        }
        let path = managed(&repo, "topic");
        let head = retirement_head_at(&repo, &path);
        let records = maboroshi::metadata::load_strict(&repo.repo).unwrap();
        let command = if move_directory {
            r#"cd "$MABO_REPO_PATH" && mv -- "$MABO_WORKSPACE_PATH" "$MABO_WORKSPACE_PATH.moved""#
        } else {
            r#"cd "$MABO_REPO_PATH" && rm -rf -- "$MABO_WORKSPACE_PATH""#
        };
        fs::write(
            repo.repo.join(".mabo.toml"),
            format!(
                "[hooks]\npre-remove = [{}]\n",
                serde_json::to_string(command).unwrap()
            ),
        )
        .unwrap();
        let mut args = if gc {
            vec!["gc", "--merged", "--apply", "--json"]
        } else {
            vec!["remove", "topic", "--json"]
        };
        if keep_branch {
            args.push("--keep-branch");
        }
        let out = repo.mabo(&args);
        assert!(!path.exists(), "hook must remove or move the directory");
        assert!(branch_listed(&repo, "topic"), "{}", text(&out.stdout));
        let tip = repo
            .command("git", &["rev-parse", "refs/heads/topic"])
            .output()
            .unwrap();
        assert_eq!(text(&tip.stdout), head);
        assert!(!out.status.success(), "{}", text(&out.stdout));
        assert!(worktree_registered(&repo, "topic"));
        assert_eq!(
            serde_json::to_value(maboroshi::metadata::load_strict(&repo.repo).unwrap()).unwrap(),
            serde_json::to_value(&records).unwrap(),
        );
        if move_directory {
            assert!(PathBuf::from(format!("{}.moved", path.display()))
                .join("topic.txt")
                .is_file());
        }
    }
}

#[test]
fn retirement_remove_rejects_missing_path_after_resolved_name() {
    assert_retirement_missing_remove_path(true);
}

#[test]
fn retirement_remove_rejects_missing_path_before_resolved_name() {
    assert_retirement_missing_remove_path(false);
}

fn assert_retirement_missing_remove_path(name_first: bool) {
    let repo = Repo::new();
    assert!(repo
        .mabo(&["create", "topic", "--no-setup"])
        .status
        .success());
    let path = managed(&repo, "topic");
    fs::write(path.join("precious"), "keep this\n").unwrap();
    let marker = repo.root.join("hook-ran");
    fs::write(
        repo.repo.join(".mabo.toml"),
        format!("[hooks]\npre-remove = ['touch {}']\n", marker.display()),
    )
    .unwrap();
    let records = records::read(repo.repo.join(".git/maboroshi/workspaces")).unwrap();
    let missing_path = repo.root.join("missing");
    for dry_run in [true, false] {
        for json in [false, true] {
            let selectors = if name_first {
                ["topic", missing_path.to_str().unwrap()]
            } else {
                [missing_path.to_str().unwrap(), "topic"]
            };
            let mut args = vec![
                "remove",
                selectors[0],
                selectors[1],
                selectors[1],
                "--discard-changes",
            ];
            if dry_run {
                args.push("--dry-run");
            }
            if json {
                args.push("--json");
            }
            let out = repo.mabo(&args);
            assert_eq!(
                out.status.code(),
                Some(3),
                "{args:?}: {} {}",
                text(&out.stdout),
                text(&out.stderr)
            );
            assert_eq!(
                fs::read_to_string(path.join("precious")).unwrap(),
                "keep this\n"
            );
            assert!(worktree_registered(&repo, "topic"));
            assert!(branch_listed(&repo, "topic"));
            assert!(!marker.exists());
            assert_eq!(
                records::read(repo.repo.join(".git/maboroshi/workspaces")).unwrap(),
                records
            );
            if json {
                let doc = json_value(&out);
                assert_eq!(doc["data"]["items"].as_array().unwrap().len(), 2);
                assert!(doc["data"]["items"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|item| !item["error"].is_null()));
            }
        }
    }
}

#[test]
fn retirement_review6_gc_keeps_fresh_branch_with_same_named_tag() {
    assert_retirement_creation_with_tag(false, false);
}

#[test]
fn retirement_review6_gc_keeps_fresh_branch_with_same_named_tag_using_reflog() {
    assert_retirement_creation_with_tag(true, false);
}

#[test]
fn retirement_review6_gc_keeps_synced_branch_with_same_named_tag_using_reflog() {
    assert_retirement_creation_with_tag(true, true);
}

fn assert_retirement_creation_with_tag(clear_creation: bool, synced: bool) {
    let repo = Repo::new();
    assert!(repo
        .mabo(&["create", "topic", "--no-setup"])
        .status
        .success());
    repo.git(&["checkout", "-b", "tag-source"]);
    repo.git(&["commit", "--allow-empty", "-m", "outside base"]);
    repo.git(&["tag", "topic", "refs/heads/tag-source"]);
    repo.git(&["checkout", "main"]);
    if synced {
        repo.git(&["commit", "--allow-empty", "-m", "base advance"]);
        let out = repo
            .command("git", &["merge", "--ff-only", "refs/heads/main"])
            .current_dir(managed(&repo, "topic"))
            .env(
                "GIT_REFLOG_ACTION",
                "mabo sync: fast-forward to refs/heads/main",
            )
            .output()
            .unwrap();
        assert!(out.status.success(), "{}", text(&out.stderr));
    }
    if clear_creation {
        clear_created_from(&repo, "topic");
    }
    let records = records::read(repo.repo.join(".git/maboroshi/workspaces")).unwrap();
    for apply in [false, true] {
        let mut args = vec!["gc", "--merged", "--json"];
        if apply {
            args.push("--apply");
        }
        let out = repo.mabo(&args);
        assert_eq!(out.status.code(), Some(0), "{}", text(&out.stderr));
        assert_eq!(
            json_value(&out)["data"]["items"],
            serde_json::json!([]),
            "{}",
            text(&out.stdout)
        );
        assert!(managed(&repo, "topic").is_dir());
        assert!(worktree_registered(&repo, "topic"));
        assert!(branch_listed(&repo, "topic"));
        assert_eq!(
            records::read(repo.repo.join(".git/maboroshi/workspaces")).unwrap(),
            records
        );
    }
}

#[test]
fn retirement_review6_existing_branch_creation_uses_full_reflog_ref() {
    let repo = Repo::new();
    let creation = retirement_head_at(&repo, &repo.repo);
    repo.git(&["branch", "topic", "refs/heads/main"]);
    repo.git(&["tag", "topic", "refs/heads/main"]);
    let out = repo.mabo(&["create", "--branch", "topic", "--no-setup", "--json"]);
    assert!(out.status.success(), "{}", text(&out.stderr));
    assert_eq!(
        json_value(&out)["data"]["workspace"]["createdFrom"],
        creation
    );
}

#[test]
fn retirement_review6_gc_default_uses_full_remote_ref_with_same_named_tag() {
    for ambiguous_refs in ["false", "true"] {
        let repo = Repo::new();
        assert!(repo
            .mabo(&["create", "topic", "--no-setup"])
            .status
            .success());
        land_branch(&repo, "topic");
        publish_branch(&repo, "topic");
        repo.git(&[
            "symbolic-ref",
            "refs/remotes/origin/HEAD",
            "refs/remotes/origin/main",
        ]);
        repo.git(&["checkout", "-b", "tag-source"]);
        repo.git(&["commit", "--allow-empty", "-m", "outside default"]);
        repo.git(&["tag", "origin/main", "refs/heads/tag-source"]);
        repo.git(&["checkout", "refs/heads/main"]);
        repo.git(&["config", "core.warnAmbiguousRefs", ambiguous_refs]);
        let shown = repo.mabo(&["repo", "show", "--json"]);
        assert!(shown.status.success(), "{}", text(&shown.stderr));
        assert_eq!(
            json_value(&shown)["data"]["repo"]["defaultBranch"],
            "origin/main"
        );
        let out = repo.mabo(&["gc", "--merged", "--apply", "--json"]);
        assert!(out.status.success(), "{}", text(&out.stderr));
        assert_eq!(
            json_value(&out)["data"]["items"][0]["action"],
            "removed",
            "{}",
            text(&out.stdout)
        );
        assert!(!managed(&repo, "topic").exists());
        assert!(!branch_listed(&repo, "topic"));
        assert!(branch_listed(&repo, "main"));
    }
}

#[test]
fn retirement_review7_keeps_reapplied_branch_without_distinct_evidence() {
    assert_retirement_reapplication(false, false);
}

#[test]
fn retirement_review7_keeps_reapplied_detached_without_distinct_evidence() {
    assert_retirement_reapplication(true, false);
}

#[test]
fn retirement_review7_accepts_reapplication_with_distinct_ordered_evidence() {
    assert_retirement_reapplication(false, true);
    assert_retirement_reapplication(true, true);
}

fn assert_retirement_reapplication(detached: bool, preserved: bool) {
    let repo = Repo::new();
    let path = retirement_replay_workspace(&repo, detached);
    for (directory, reapply, message) in [(&path, true, "topic"), (&repo.repo, preserved, "base")] {
        retirement_replay_file(&repo, directory, "a", Some("a\n"), message);
        retirement_replay_file(&repo, directory, "a", None, message);
        if reapply {
            retirement_replay_file(&repo, directory, "a", Some("a\n"), message);
        }
        retirement_replay_file(&repo, directory, "b", Some("b\n"), message);
    }
    // All base commits have different SHAs; exact ancestry cannot prove this.
    let head = retirement_head_at(&repo, &path);
    let ancestor = repo
        .command(
            "git",
            &["merge-base", "--is-ancestor", &head, "refs/heads/main"],
        )
        .output()
        .unwrap();
    assert_eq!(ancestor.status.code(), Some(1));
    if preserved {
        // Keep the existing contract: ordered rebase evidence survives later
        // base edits, even when the complete squash and base-tip checks fail.
        retirement_replay_file(&repo, &repo.repo, "a", Some("later\n"), "later edit");
        let plan = repo.mabo(&["gc", "--merged", "--json"]);
        assert!(plan.status.success(), "{}", text(&plan.stdout));
        assert_eq!(
            json_value(&plan)["data"]["items"][0]["action"],
            "wouldRemove"
        );
        let removed = repo.mabo(&["remove", "replay", "--json"]);
        assert!(removed.status.success(), "{}", text(&removed.stdout));
        assert!(!path.exists());
        assert!(!worktree_registered(&repo, "replay"));
        assert!(!branch_listed(&repo, "replay"));
    } else {
        assert_retirement_replay_is_unpreserved(&repo, detached);
    }
}

#[test]
fn retirement_review7_keeps_commits_landed_in_different_order() {
    for detached in [false, true] {
        let repo = Repo::new();
        let path = retirement_replay_workspace(&repo, detached);
        retirement_replay_file(&repo, &path, "a", Some("a\n"), "topic a");
        retirement_replay_file(&repo, &path, "b", Some("b\n"), "topic b");
        retirement_replay_file(&repo, &repo.repo, "b", Some("b\n"), "base b");
        retirement_replay_file(&repo, &repo.repo, "a", Some("a\n"), "base a");
        retirement_replay_file(&repo, &repo.repo, "a", None, "base removes a");
        assert_retirement_replay_is_unpreserved(&repo, detached);
    }
}

#[test]
fn retirement_review7_keeps_evidence_from_discarded_side_history() {
    for detached in [false, true] {
        let repo = Repo::new();
        let path = retirement_replay_workspace(&repo, detached);
        let ancestor = retirement_head_at(&repo, &repo.repo);
        retirement_replay_file(&repo, &path, "a", Some("a\n"), "topic a");
        retirement_replay_file(&repo, &path, "b", Some("b\n"), "topic b");
        retirement_replay_file(&repo, &repo.repo, "a", Some("a\n"), "base a");
        repo.git(&["checkout", "-b", "side", &ancestor]);
        retirement_replay_file(&repo, &repo.repo, "b", Some("b\n"), "side b");
        repo.git(&["checkout", "main"]);
        repo.git(&[
            "merge",
            "--no-ff",
            "-s",
            "ours",
            "side",
            "-m",
            "discard side tree",
        ]);
        assert!(!repo.repo.join("b").exists());
        assert_retirement_replay_is_unpreserved(&repo, detached);
    }
}

fn retirement_replay_workspace(repo: &Repo, detached: bool) -> PathBuf {
    let mut args = vec!["create", "replay", "--no-setup"];
    if detached {
        args.push("--detach");
    }
    let created = repo.mabo(&args);
    assert!(created.status.success(), "{}", text(&created.stderr));
    managed(repo, "replay")
}

fn retirement_replay_file(
    repo: &Repo,
    directory: &Path,
    file: &str,
    body: Option<&str>,
    message: &str,
) {
    if let Some(body) = body {
        fs::write(directory.join(file), body).unwrap();
        git_at(repo, directory, &["add", "--", file]);
    } else {
        git_at(repo, directory, &["rm", "--", file]);
    }
    git_at(repo, directory, &["commit", "-m", message]);
}

fn assert_retirement_replay_is_unpreserved(repo: &Repo, detached: bool) {
    let head = retirement_head_at(repo, &managed(repo, "replay"));
    let records = records::read(repo.repo.join(".git/maboroshi/workspaces")).unwrap();
    for apply in [false, true] {
        let mut args = vec!["gc", "--merged", "--json"];
        if apply {
            args.push("--apply");
        }
        let out = repo.mabo(&args);
        assert!(out.status.success(), "{}", text(&out.stdout));
        assert_eq!(json_value(&out)["data"]["items"], serde_json::json!([]));
        assert!(worktree_registered(repo, "replay"));
        assert_eq!(retirement_head_at(repo, &managed(repo, "replay")), head);
        assert_eq!(
            records::read(repo.repo.join(".git/maboroshi/workspaces")).unwrap(),
            records
        );
    }
    assert_retirement_review3_keeps_workspace(repo, "replay", detached);
    if !detached {
        let tip = repo
            .command("git", &["rev-parse", "refs/heads/replay"])
            .output()
            .unwrap();
        assert!(tip.status.success());
        assert_eq!(text(&tip.stdout), head);
    }
}

#[test]
fn retirement_review5_remove_batches_long_base_history() {
    assert_retirement_batches_long_history(false);
}

#[test]
fn retirement_review5_gc_reuses_integration_observation() {
    assert_retirement_batches_long_history(true);
}

fn assert_retirement_batches_long_history(gc: bool) {
    let repo = Repo::new();
    for name in ["local", "other", "rebased"] {
        assert!(repo.mabo(&["create", name, "--no-setup"]).status.success());
        commit_file(&repo, name, &format!("{name}.txt"), "first\n");
    }
    let first = retirement_head_at(&repo, &managed(&repo, "rebased"));
    commit_file(&repo, "rebased", "second.txt", "second\n");
    fs::write(repo.repo.join("base.txt"), "divergence\n").unwrap();
    repo.git(&["add", "."]);
    repo.git(&["commit", "-m", "divergence"]);
    repo.git(&["cherry-pick", &first]);
    repo.git(&["cherry-pick", "refs/heads/rebased"]);
    // Require the per-commit fallback, including evidence before later edits.
    fs::write(repo.repo.join("rebased.txt"), "later base edit\n").unwrap();
    repo.git(&["add", "."]);
    repo.git(&["commit", "-m", "later edit"]);
    let trace = repo.root.join("history-trace.json");
    let mut counts = Vec::new();
    let mut tree_counts = Vec::new();
    let mut advanced = 0;
    for extra_commits in [1, 50] {
        for index in advanced..extra_commits {
            // Include both empty and nonempty commits in the batched output.
            if index % 2 == 0 {
                fs::write(repo.repo.join("base.txt"), format!("base {index}\n")).unwrap();
                repo.git(&["add", "."]);
            }
            repo.git(&["commit", "--allow-empty", "-m", "advance base"]);
        }
        advanced = extra_commits;
        fs::write(&trace, "").unwrap();
        let args = if gc {
            vec!["gc", "--merged", "--json"]
        } else {
            vec!["remove", "local", "other", "rebased", "--dry-run", "--json"]
        };
        let out = repo
            .command(env!("CARGO_BIN_EXE_mabo"), &args)
            .env("GIT_TRACE2_EVENT", &trace)
            .output()
            .unwrap();
        assert!(out.status.success(), "{}", text(&out.stdout));
        let doc = json_value(&out);
        let items = doc["data"]["items"].as_array().unwrap();
        if gc {
            assert_eq!(items.len(), 1, "{doc}");
            assert_eq!(items[0]["workspace"]["name"], "rebased");
            assert_eq!(items[0]["action"], "wouldRemove");
        } else {
            assert_eq!(items.len(), 3, "{doc}");
            for item in items {
                assert_eq!(item["removed"], false);
                if item["workspace"]["name"] == "rebased" {
                    assert!(item["branchKeptReason"].is_null(), "{item}");
                } else {
                    assert_eq!(item["branchKeptReason"], "unpreserved");
                }
            }
        }
        let starts: Vec<Vec<String>> = fs::read_to_string(&trace)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str::<serde_json::Value>(line).unwrap())
            .filter(|event| event["event"] == "start")
            .map(|event| serde_json::from_value(event["argv"].clone()).unwrap())
            .collect();
        let tree_processes = starts
            .iter()
            .filter(|args| {
                args.iter().any(|arg| arg == "diff-tree")
                    || (args.iter().any(|arg| arg == "log")
                        && args.iter().any(|arg| arg == "--raw"))
            })
            .count();
        // Three workspaces, each with one aggregate diff and two history reads.
        // GC must reuse its integrated result when checking preservation.
        tree_counts.push(tree_processes);
        counts.push(starts.len());
        for name in ["local", "other", "rebased"] {
            assert!(managed(&repo, name).is_dir());
            assert!(branch_listed(&repo, name));
        }
    }
    assert_eq!(tree_counts, [9, 9], "1 and 50 extra base commits");
    assert_eq!(counts[0], counts[1], "all Git starts must stay constant");
}

#[test]
fn retirement_tree_entries_preserve_rebased_work_after_later_base_edits() {
    let repo = Repo::new();
    assert!(repo
        .mabo(&["create", "rebased", "--no-setup"])
        .status
        .success());
    commit_file(&repo, "rebased", "patch.txt", "first\n");
    let patch = text(
        &repo
            .command("git", &["rev-parse", "refs/heads/rebased"])
            .output()
            .unwrap()
            .stdout,
    );
    commit_file(&repo, "rebased", "second.txt", "second commit\n");
    fs::write(repo.repo.join("other.txt"), "base divergence\n").unwrap();
    repo.git(&["add", "."]);
    repo.git(&["commit", "-m", "base divergence"]);
    repo.git(&["cherry-pick", &patch]);
    repo.git(&["cherry-pick", "refs/heads/rebased"]);
    fs::write(repo.repo.join("patch.txt"), "later base edit\n").unwrap();
    repo.git(&["add", "."]);
    repo.git(&["commit", "-m", "later edit"]);
    let out = repo.mabo(&["gc", "--merged", "--json"]);
    assert_eq!(out.status.code(), Some(0));
    assert_eq!(
        json_value(&out)["data"]["items"][0]["action"],
        "wouldRemove"
    );
    let out = repo.mabo(&["remove", "rebased", "--json"]);
    assert_eq!(out.status.code(), Some(0));
    assert_eq!(json_value(&out)["data"]["items"][0]["branchDeleted"], true);
}

#[test]
fn retirement_dry_run_preserves_git_and_legacy_metadata_bytes() {
    let repo = Repo::new();
    assert!(repo
        .mabo(&["create", "squash", "--no-setup"])
        .status
        .success());
    commit_in_worktree(&repo, "squash");
    squash_onto_main(&repo, "squash");
    let metadata = repo.repo.join(".git/maboroshi/workspaces");
    let mut legacy: serde_json::Value =
        serde_json::from_slice(&records::read(&metadata).unwrap()).unwrap();
    legacy["version"] = serde_json::json!(1);
    let legacy = serde_json::to_vec(&legacy).unwrap();
    fs::remove_dir_all(&metadata).unwrap();
    fs::write(repo.repo.join(".git/maboroshi/worktrees.json"), legacy).unwrap();
    let marker = repo.root.join("dry-run-hook");
    fs::write(
        repo.repo.join(".mabo.toml"),
        format!("[hooks]\npre-remove = [\"touch {}\"]\n", marker.display()),
    )
    .unwrap();
    fn snapshot(
        path: &Path,
    ) -> std::collections::BTreeMap<PathBuf, (Vec<u8>, std::time::SystemTime)> {
        fn visit(
            root: &Path,
            path: &Path,
            result: &mut std::collections::BTreeMap<PathBuf, (Vec<u8>, std::time::SystemTime)>,
        ) {
            for entry in fs::read_dir(path).unwrap() {
                let entry = entry.unwrap();
                let file = entry.path();
                if entry.file_type().unwrap().is_dir() {
                    visit(root, &file, result);
                } else {
                    result.insert(
                        file.strip_prefix(root).unwrap().to_path_buf(),
                        (
                            fs::read(&file).unwrap(),
                            fs::metadata(&file).unwrap().modified().unwrap(),
                        ),
                    );
                }
            }
        }
        let mut result = std::collections::BTreeMap::new();
        visit(path, path, &mut result);
        result
    }
    let before = snapshot(&repo.repo.join(".git"));
    for args in [
        vec!["remove", "squash", "--dry-run", "--json"],
        vec!["gc", "--merged", "--json"],
    ] {
        let out = repo.mabo(&args);
        assert_eq!(out.status.code(), Some(0), "{}", text(&out.stdout));
        assert_eq!(json_value(&out)["data"]["plan"], true);
        let after = snapshot(&repo.repo.join(".git"));
        let differences: Vec<_> = before
            .keys()
            .chain(after.keys())
            .filter(|key| before.get(*key) != after.get(*key))
            .collect();
        assert!(
            differences.is_empty(),
            "{args:?} changed Git state: {differences:?}"
        );
        assert!(!marker.exists());
        assert!(worktree_dir(&repo, "squash").exists());
    }
}

#[test]
fn retirement_gc_age_filters_evidence_and_excludes_unknown_creation_time() {
    let repo = Repo::new();
    for name in ["old", "recent", "unknown", "age-only"] {
        assert!(repo.mabo(&["create", name, "--no-setup"]).status.success());
        if name != "age-only" {
            land_branch(&repo, name);
        }
    }
    let dir = repo.repo.join(".git/maboroshi/workspaces");
    for entry in fs::read_dir(&dir).unwrap() {
        let file = entry.unwrap().path();
        let mut record: serde_json::Value =
            serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
        match record["name"].as_str().unwrap() {
            "unknown" => record["createdAt"] = serde_json::Value::Null,
            "old" | "age-only" => record["createdAt"] = serde_json::json!("2000-01-01T00:00:00Z"),
            _ => {}
        }
        fs::write(file, serde_json::to_vec(&record).unwrap()).unwrap();
    }
    for flags in [
        vec!["--older-than", "14d"],
        vec!["--merged", "--older-than", "14d"],
    ] {
        let mut args = vec!["gc", "--json"];
        args.extend(flags);
        let out = repo.mabo(&args);
        assert_eq!(out.status.code(), Some(0));
        let doc = json_value(&out);
        let items = doc["data"]["items"].as_array().unwrap();
        assert_eq!(items.len(), 1, "{doc}");
        assert_eq!(items[0]["workspace"]["name"], "old");
        assert_eq!(items[0]["reasons"], serde_json::json!(["merged"]));
    }
}

#[test]
fn retirement_remove_partial_result_retries_only_unfinished_targets() {
    let repo = Repo::new();
    for name in ["one", "two", "three"] {
        assert!(repo.mabo(&["create", name, "--no-setup"]).status.success());
    }
    fs::write(
        repo.repo.join(".mabo.toml"),
        "[hooks]\npre-remove = [\"test \\\"$MABO_WORKSPACE\\\" != two\"]\n",
    )
    .unwrap();
    let args = ["remove", "one", "two", "three", "--json"];
    let out = repo.mabo(&args);
    assert_eq!(out.status.code(), Some(6), "{}", text(&out.stdout));
    let doc = json_value(&out);
    assert_eq!(doc["data"]["items"].as_array().unwrap().len(), 3);
    assert_eq!(doc["data"]["items"][0]["removed"], true);
    assert_eq!(doc["data"]["items"][1]["error"]["code"], "failed");
    assert_eq!(doc["data"]["items"][2]["error"]["code"], "not_attempted");
    assert!(managed(&repo, "three").exists());
    let hint = doc["error"]["details"]["retryCommand"]
        .as_str()
        .expect("retry command");
    assert!(!hint.contains("'one'"));
    fs::remove_file(repo.repo.join(".mabo.toml")).unwrap();
    let out = repo.mabo(&args);
    assert_eq!(out.status.code(), Some(3), "{}", text(&out.stdout));
    assert!(managed(&repo, "two").exists());
    let out = run_setup_retry_hint(&repo, &repo.home, hint);
    assert_eq!(
        out.status.code(),
        Some(0),
        "{} {}",
        text(&out.stdout),
        text(&out.stderr)
    );
    let doc = json_value(&out);
    assert_eq!(doc["data"]["items"].as_array().unwrap().len(), 2);
    assert_eq!(doc["data"]["items"][0]["removed"], true);
    assert_eq!(doc["data"]["items"][1]["removed"], true);
}

#[test]
fn retirement_gc_closed_pr_and_missing_gh_report_separate_skip_hints() {
    let repo = Repo::new();
    for name in ["dirty-pr", "unpreserved-pr"] {
        assert!(repo
            .create_recorded(&[
                "create",
                name,
                "--pr",
                "https://github.com/acme/demo/pull/7"
            ])
            .status
            .success());
        if name == "dirty-pr" {
            land_branch(&repo, name);
            fs::write(managed(&repo, "dirty-pr/dirty"), "changes").unwrap();
        } else {
            commit_in_worktree(&repo, name);
        }
    }
    let fake = gh_path(
        &repo,
        "#!/bin/sh\nprintf '%s\\n' '{\"state\":\"CLOSED\"}'\n",
    );
    let out = repo
        .command(
            env!("CARGO_BIN_EXE_mabo"),
            &["gc", "--closed-pr", "--apply", "--json"],
        )
        .env("PATH", &fake)
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(0), "{}", text(&out.stdout));
    let doc = json_value(&out);
    let items = doc["data"]["items"].as_array().unwrap();
    assert_eq!(items.len(), 2);
    for item in items {
        assert_eq!(item["action"], "skipped");
        assert_eq!(item["reasons"], serde_json::json!(["pullRequest"]));
        let hint = item["detail"].as_str().unwrap();
        if item["workspace"]["name"] == "dirty-pr" {
            assert!(hint.contains(" remove --discard-changes -- 'dirty-pr'"));
            assert!(!hint.contains("--delete-unpreserved-branch"));
        } else {
            assert!(hint.contains(" remove --delete-unpreserved-branch -- 'unpreserved-pr'"));
            assert!(!hint.contains("--discard-changes"));
        }
    }
    let bin = repo.root.join("without-gh");
    fs::create_dir(&bin).unwrap();
    let git = repo
        .command("sh", &["-c", "command -v git"])
        .output()
        .unwrap();
    std::os::unix::fs::symlink(text(&git.stdout), bin.join("git")).unwrap();
    let out = repo
        .command(env!("CARGO_BIN_EXE_mabo"), &["gc", "--closed-pr", "--json"])
        .env("PATH", bin)
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(0));
    let doc = json_value(&out);
    assert!(doc["data"]["items"]
        .as_array()
        .unwrap()
        .iter()
        .all(|item| item["detail"].as_str().unwrap().contains("unavailable")));
}

#[test]
fn retirement_bugbot_gc_keeps_live_unregistered_records() {
    let repo = Repo::new();
    assert!(repo
        .mabo(&["create", "unregistered", "--no-setup"])
        .status
        .success());
    let pr = "https://github.com/acme/demo/pull/7";
    assert!(repo
        .mabo(&["set", "unregistered", "--pr", pr])
        .status
        .success());
    let fake = gh_path(
        &repo,
        "#!/bin/sh\nprintf '%s\\n' '{\"state\":\"CLOSED\"}'\n",
    );
    let path = managed(&repo, "unregistered");
    fs::write(path.join("precious"), "keep this\n").unwrap();
    let admin = text(
        &repo
            .command("git", &["rev-parse", "--absolute-git-dir"])
            .current_dir(&path)
            .output()
            .unwrap()
            .stdout,
    );
    fs::remove_dir_all(admin).unwrap();
    let record_dir = repo.repo.join(".git/maboroshi/workspaces");
    let before = records::read(&record_dir).unwrap();
    let listed = repo.mabo(&["list", "--json"]);
    assert!(listed.status.success());
    assert!(!json_value(&listed)["data"]["workspaces"]
        .as_array()
        .unwrap()
        .iter()
        .any(|item| item["name"] == "unregistered"));
    for apply in [false, true] {
        for criterion in [None, Some("--orphaned"), Some("--closed-pr")] {
            let mut args = vec!["gc", "--json"];
            if let Some(criterion) = criterion {
                args.push(criterion);
            }
            if apply {
                args.push("--apply");
            }
            let out = repo
                .command(env!("CARGO_BIN_EXE_mabo"), &args)
                .env("PATH", &fake)
                .output()
                .unwrap();
            assert_eq!(out.status.code(), Some(0), "{}", text(&out.stdout));
            assert_eq!(json_value(&out)["data"]["items"], serde_json::json!([]));
            assert_eq!(records::read(&record_dir).unwrap(), before);
            assert_eq!(
                fs::read_to_string(path.join("precious")).unwrap(),
                "keep this\n"
            );
            assert!(branch_listed(&repo, "unregistered"));
        }
        for selector in ["unregistered", "pr:7", pr] {
            let mut args = vec!["remove", selector, "--json"];
            if !apply {
                args.push("--dry-run");
            }
            let out = repo.mabo(&args);
            assert_eq!(out.status.code(), Some(0), "{}", text(&out.stdout));
            assert_eq!(json_value(&out)["data"]["items"][0]["alreadyGone"], true);
            assert_eq!(json_value(&out)["data"]["items"][0]["removed"], false);
            assert_eq!(records::read(&record_dir).unwrap(), before);
            assert_eq!(
                fs::read_to_string(path.join("precious")).unwrap(),
                "keep this\n"
            );
            assert!(branch_listed(&repo, "unregistered"));
        }
    }
    // The same record becomes orphaned only after its directory is truly gone.
    fs::remove_dir_all(&path).unwrap();
    let plan = repo.mabo(&["gc", "--orphaned", "--json"]);
    assert_eq!(plan.status.code(), Some(0));
    assert_eq!(
        json_value(&plan)["data"]["items"][0]["action"],
        "wouldRemove"
    );
    assert_eq!(records::read(&record_dir).unwrap(), before);
    let out = repo.mabo(&["gc", "--orphaned", "--apply", "--json"]);
    assert_eq!(out.status.code(), Some(0));
    assert_eq!(json_value(&out)["data"]["items"][0]["action"], "removed");
    assert!(branch_listed(&repo, "unregistered"));
    assert!(maboroshi::metadata::load_strict(&repo.repo)
        .unwrap()
        .is_empty());
}

#[test]
fn retirement_bugbot_remove_reports_all_preflight_refusals() {
    let repo = Repo::new();
    for name in ["clean", "dirty-one", "dirty-two"] {
        assert!(repo.mabo(&["create", name, "--no-setup"]).status.success());
    }
    for name in ["dirty-one", "dirty-two"] {
        fs::write(managed(&repo, name).join("precious"), "keep this\n").unwrap();
    }
    assert!(repo
        .mabo(&["create", "detached", "--detach", "--no-setup"])
        .status
        .success());
    commit_file(&repo, "detached", "committed", "unpreserved\n");
    let head = retirement_head_at(&repo, &managed(&repo, "detached"));
    let marker = repo.root.join("hook-ran");
    fs::write(
        repo.repo.join(".mabo.toml"),
        format!("[hooks]\npre-remove = ['touch {}']\n", marker.display()),
    )
    .unwrap();
    let record_dir = repo.repo.join(".git/maboroshi/workspaces");
    let before = records::read(&record_dir).unwrap();
    for invalid_first in [false, true] {
        for dry_run in [false, true] {
            for json in [false, true] {
                let mut args = vec![
                    "remove",
                    "clean",
                    "dirty-one",
                    "dirty-two",
                    "detached",
                    ".",
                    "dirty-one",
                ];
                if invalid_first {
                    args.insert(1, "bad+selector");
                } else {
                    args.push("bad+selector");
                }
                if dry_run {
                    args.push("--dry-run");
                }
                if json {
                    args.push("--json");
                }
                let out = repo.mabo(&args);
                assert_eq!(
                    out.status.code(),
                    Some(if invalid_first { 2 } else { 4 }),
                    "{args:?}: {} {}",
                    text(&out.stdout),
                    text(&out.stderr)
                );
                if json {
                    let doc = json_value(&out);
                    assert_eq!(
                        doc["error"]["code"],
                        if invalid_first { "usage" } else { "dirty" }
                    );
                    let items = doc["data"]["items"].as_array().unwrap();
                    assert_eq!(items.len(), 6, "{doc}");
                    for (name, code) in [
                        ("dirty-one", "dirty"),
                        ("dirty-two", "dirty"),
                        ("detached", "unpreserved"),
                        ("main", "primary"),
                        ("bad+selector", "usage"),
                    ] {
                        assert!(
                            items.iter().any(|item| item["workspace"]["name"] == name
                                && item["error"]["code"] == code),
                            "{doc}"
                        );
                    }
                    assert!(items.iter().all(|item| item["removed"] == false));
                } else {
                    let stderr = text(&out.stderr);
                    for reason in [
                        "dirty-one",
                        "dirty-two",
                        "unpreserved detached commits",
                        "primary checkout",
                        "Workspace name can only contain",
                    ] {
                        assert_eq!(stderr.matches(reason).count(), 1, "{args:?}: {stderr}");
                    }
                }
                assert!(!marker.exists());
                assert_eq!(records::read(&record_dir).unwrap(), before);
                assert_eq!(retirement_head_at(&repo, &managed(&repo, "detached")), head);
                for name in ["clean", "dirty-one", "dirty-two", "detached"] {
                    assert!(managed(&repo, name).is_dir());
                    assert!(worktree_registered(&repo, name));
                }
                for name in ["clean", "dirty-one", "dirty-two"] {
                    assert!(branch_listed(&repo, name));
                }
                for name in ["dirty-one", "dirty-two"] {
                    assert_eq!(
                        fs::read_to_string(managed(&repo, name).join("precious")).unwrap(),
                        "keep this\n"
                    );
                }
            }
        }
    }
}

#[test]
fn retirement_tree_comparison_keeps_distinct_non_utf8_changes() {
    let repo = Repo::new();
    assert!(repo
        .mabo(&["create", "bytes", "--no-setup"])
        .status
        .success());
    let path = managed(&repo, "bytes");
    fs::write(path.join("bytes.txt"), [0x80, b'\n']).unwrap();
    git_at(&repo, &path, &["add", "."]);
    git_at(&repo, &path, &["commit", "-m", "first bytes"]);
    fs::write(repo.repo.join("bytes.txt"), [0x81, b'\n']).unwrap();
    repo.git(&["add", "."]);
    repo.git(&["commit", "-m", "different bytes"]);
    let out = repo.mabo(&["remove", "bytes", "--json"]);
    assert_eq!(out.status.code(), Some(0));
    assert_eq!(json_value(&out)["data"]["items"][0]["branchDeleted"], false);
    assert_eq!(
        json_value(&out)["data"]["items"][0]["branchKeptReason"],
        "unpreserved"
    );
    assert!(branch_listed(&repo, "bytes"));
}

#[test]
fn retirement_gc_skips_dirty_content_created_by_pre_remove_hook() {
    let repo = Repo::new();
    assert!(repo
        .mabo(&["create", "hook-dirty", "--no-setup"])
        .status
        .success());
    land_branch(&repo, "hook-dirty");
    fs::write(
        repo.repo.join(".mabo.toml"),
        "[hooks]\npre-remove = [\"printf precious > dirty\"]\n",
    )
    .unwrap();
    let out = repo.mabo(&["gc", "--merged", "--apply", "--json"]);
    assert_eq!(out.status.code(), Some(0), "{}", text(&out.stdout));
    let doc = json_value(&out);
    assert_eq!(doc["data"]["items"][0]["action"], "skipped");
    assert!(doc["data"]["items"][0]["detail"]
        .as_str()
        .unwrap()
        .contains(" remove --discard-changes -- 'hook-dirty'"));
    assert_eq!(
        fs::read_to_string(managed(&repo, "hook-dirty/dirty")).unwrap(),
        "precious"
    );
}

#[test]
fn retirement_primary_is_refused_with_every_destructive_permission() {
    let repo = Repo::new();
    for selector in [".", "main"] {
        let out = repo.mabo(&[
            "remove",
            selector,
            "--discard-changes",
            "--delete-unpreserved-branch",
            "--json",
        ]);
        assert_eq!(out.status.code(), Some(4), "{}", text(&out.stdout));
        assert_eq!(json_value(&out)["error"]["code"], "primary");
        assert!(repo.repo.join(".git").exists());
    }
}

#[test]
fn retirement_removed_flags_take_precedence_over_help() {
    let repo = Repo::new();
    for args in [
        vec!["remove", "x", "--force"],
        vec!["remove", "--current"],
        vec!["gc", "--pr"],
        vec!["gc", "-f"],
    ] {
        for json in [false, true] {
            let mut args = args.clone();
            args.push("--help");
            if json {
                args.push("--json");
            }
            let out = repo.mabo(&args);
            assert_eq!(
                out.status.code(),
                Some(2),
                "{args:?}: {}",
                text(&out.stdout)
            );
            if json {
                assert_eq!(json_value(&out)["error"]["code"], "usage");
            } else {
                assert!(out.stdout.is_empty());
                assert!(text(&out.stderr).contains("Use"));
            }
        }
    }
}

#[test]
fn retirement_review_keeps_unique_merge_conflict_resolution() {
    let repo = Repo::new();
    fs::write(repo.repo.join("conflict.txt"), "initial\n").unwrap();
    repo.git(&["add", "."]);
    repo.git(&["commit", "-m", "common conflict file"]);
    repo.git(&["branch", "side"]);
    assert!(repo
        .mabo(&["create", "merge", "--no-setup"])
        .status
        .success());
    commit_file(&repo, "merge", "conflict.txt", "left\n");
    repo.git(&["checkout", "side"]);
    fs::write(repo.repo.join("conflict.txt"), "right\n").unwrap();
    repo.git(&["commit", "-am", "right"]);
    repo.git(&["checkout", "main"]);
    let path = managed(&repo, "merge");
    let conflict = repo
        .command("git", &["merge", "side"])
        .current_dir(&path)
        .output()
        .unwrap();
    assert!(!conflict.status.success());
    fs::write(path.join("conflict.txt"), "unique resolution\n").unwrap();
    git_at(&repo, &path, &["add", "."]);
    git_at(&repo, &path, &["commit", "-m", "unique resolution"]);
    empty_commit(&repo, &repo.repo, "base divergence");
    repo.git(&["cherry-pick", "merge^1"]);
    repo.git(&["revert", "--no-edit", "HEAD"]);
    repo.git(&["cherry-pick", "side"]);
    let cherry = repo
        .command("git", &["cherry", "main", "merge"])
        .output()
        .unwrap();
    assert!(cherry.status.success());
    assert_eq!(text(&cherry.stdout).lines().count(), 2);
    assert!(text(&cherry.stdout)
        .lines()
        .all(|line| line.starts_with("- ")));
    let gc = repo.mabo(&["gc", "--merged", "--apply", "--json"]);
    assert!(gc.status.success(), "{}", text(&gc.stdout));
    assert!(path.exists(), "{}", text(&gc.stdout));
    let removed = repo.mabo(&["remove", "merge", "--json"]);
    assert!(removed.status.success());
    assert_eq!(
        json_value(&removed)["data"]["items"][0]["branchKeptReason"],
        "unpreserved"
    );
    assert!(branch_listed(&repo, "merge"));
}

#[test]
fn retirement_review3_keeps_other_block_in_squash() {
    assert_retirement_keeps_other_block(false, false);
}

#[test]
fn retirement_review3_keeps_other_block_in_rebased_history() {
    assert_retirement_keeps_other_block(true, false);
}

#[test]
fn retirement_review3_keeps_detached_other_block_in_squash() {
    assert_retirement_keeps_other_block(false, true);
}

#[test]
fn retirement_review3_keeps_detached_other_block_in_rebased_history() {
    assert_retirement_keeps_other_block(true, true);
}

fn assert_retirement_keeps_other_block(rebased: bool, detached: bool) {
    let repo = Repo::new();
    let block: String = (0..16).map(|line| format!("line {line}\n")).collect();
    let original = block.repeat(3);
    fs::write(repo.repo.join("blocks.txt"), &original).unwrap();
    repo.git(&["add", "."]);
    repo.git(&["commit", "-m", "repeated contexts"]);
    let mut args = vec!["create", "blocks", "--no-setup"];
    if detached {
        args.push("--detach");
    }
    assert!(repo.mabo(&args).status.success());
    let changed_block = block.replace("line 8\n", "changed\n");
    commit_file(
        &repo,
        "blocks",
        "blocks.txt",
        &format!("{block}{changed_block}{block}"),
    );
    fs::write(
        repo.repo.join("blocks.txt"),
        format!("{block}{block}{changed_block}"),
    )
    .unwrap();
    repo.git(&["commit", "-am", "different occurrence"]);
    if rebased {
        // Prevent complete-squash matching, so the per-commit fallback is tested too.
        commit_file(&repo, "blocks", "extra.txt", "shared extra change\n");
        let tip = retirement_head_at(&repo, &managed(&repo, "blocks"));
        repo.git(&["cherry-pick", tip.trim()]);
    }
    assert_retirement_review3_keeps_workspace(&repo, "blocks", detached);
}

#[test]
fn retirement_review3_keeps_gitlink_with_ignore_submodules_all() {
    assert_retirement_keeps_gitlink("diff.ignoreSubmodules", "all");
}

#[test]
fn retirement_review3_keeps_gitlink_with_submodule_log() {
    assert_retirement_keeps_gitlink("diff.submodule", "log");
}

#[test]
fn retirement_review3_accepts_exact_trees_despite_diff_settings() {
    let repo = Repo::new();
    let marker = repo.root.join("unexpected-diff-command");
    let command = format!("touch '{}'", marker.display());
    for (key, value) in [
        ("diff.external", command.as_str()),
        ("diff.check.textconv", command.as_str()),
        ("diff.relative", "true"),
        ("diff.renames", "copies"),
        ("diff.ignoreSubmodules", "all"),
        ("diff.submodule", "log"),
        ("color.ui", "always"),
        ("core.abbrev", "4"),
    ] {
        repo.git(&["config", key, value]);
    }
    fs::create_dir_all(repo.repo.join(".git/info")).unwrap();
    fs::write(repo.repo.join(".git/info/attributes"), "* diff=check\n").unwrap();
    let order = repo.root.join("diff-order");
    fs::write(&order, "z*\na*\n").unwrap();
    repo.git(&["config", "diff.orderFile", order.to_str().unwrap()]);
    assert!(repo
        .mabo(&["create", "exact", "--no-setup"])
        .status
        .success());
    let old = full_head(&repo);
    // An uninitialized gitlink still records a real commit ID in the tree.
    fs::create_dir(managed(&repo, "exact/module")).unwrap();
    git_at(
        &repo,
        &managed(&repo, "exact"),
        &[
            "update-index",
            "--add",
            "--cacheinfo",
            "160000",
            &old,
            "module",
        ],
    );
    commit_file(&repo, "exact", "z-file.txt", "first\n");
    commit_file(&repo, "exact", "a-file.txt", "second\n");
    squash_onto_main(&repo, "exact");
    // A subsequent base merge must not hide the earlier squash evidence.
    repo.git(&["branch", "side", &old]);
    repo.git(&["checkout", "side"]);
    empty_commit(&repo, &repo.repo, "side divergence");
    repo.git(&["checkout", "main"]);
    repo.git(&["merge", "--no-ff", "side", "-m", "base merge"]);
    let plan = repo.mabo(&["gc", "--merged", "--json"]);
    assert!(plan.status.success(), "{}", text(&plan.stdout));
    assert_eq!(
        json_value(&plan)["data"]["items"][0]["action"],
        "wouldRemove"
    );
    let removed = repo.mabo(&["remove", "exact", "--json"]);
    assert!(removed.status.success(), "{}", text(&removed.stdout));
    assert_eq!(
        json_value(&removed)["data"]["items"][0]["branchDeleted"],
        true
    );
    assert!(!marker.exists(), "external diff or textconv executed");
}

fn assert_retirement_keeps_gitlink(key: &str, value: &str) {
    for rebased in [false, true] {
        for detached in [false, true] {
            let repo = Repo::new();
            let old = retirement_head_at(&repo, &repo.repo);
            empty_commit(&repo, &repo.repo, "new gitlink target");
            let new = retirement_head_at(&repo, &repo.repo);
            fs::create_dir(repo.repo.join("module")).unwrap();
            repo.git(&[
                "update-index",
                "--add",
                "--cacheinfo",
                "160000",
                old.trim(),
                "module",
            ]);
            repo.git(&["commit", "-m", "initial gitlink"]);
            let mut args = vec!["create", "gitlink", "--no-setup"];
            if detached {
                args.push("--detach");
            }
            assert!(repo.mabo(&args).status.success());
            let path = managed(&repo, "gitlink");
            git_at(
                &repo,
                &path,
                &[
                    "update-index",
                    "--cacheinfo",
                    "160000",
                    new.trim(),
                    "module",
                ],
            );
            commit_file(&repo, "gitlink", "ordinary.txt", "saved regular file\n");
            fs::write(repo.repo.join("ordinary.txt"), "saved regular file\n").unwrap();
            repo.git(&["add", "ordinary.txt"]);
            repo.git(&["commit", "-m", "regular file only"]);
            if rebased {
                commit_file(&repo, "gitlink", "extra.txt", "shared extra change\n");
                let tip = retirement_head_at(&repo, &path);
                repo.git(&["cherry-pick", tip.trim()]);
            }
            repo.git(&["config", key, value]);
            assert_retirement_review3_keeps_workspace(&repo, "gitlink", detached);
        }
    }
}

fn retirement_head_at(repo: &Repo, path: &Path) -> String {
    let output = repo
        .command("git", &["rev-parse", "HEAD"])
        .current_dir(path)
        .output()
        .unwrap();
    assert!(output.status.success(), "{}", text(&output.stderr));
    text(&output.stdout)
}

fn assert_retirement_review3_keeps_workspace(repo: &Repo, name: &str, detached: bool) {
    let path = managed(repo, name);
    let head = retirement_head_at(repo, &path);
    let dry_run = repo.mabo(&["remove", name, "--dry-run", "--json"]);
    if detached {
        assert_eq!(dry_run.status.code(), Some(4), "{}", text(&dry_run.stdout));
        assert_eq!(json_value(&dry_run)["error"]["code"], "unpreserved");
    } else {
        assert!(dry_run.status.success(), "{}", text(&dry_run.stdout));
        assert_eq!(
            json_value(&dry_run)["data"]["items"][0]["branchKeptReason"],
            "unpreserved"
        );
    }
    let gc = repo.mabo(&["gc", "--merged", "--apply", "--json"]);
    assert!(gc.status.success(), "{}", text(&gc.stdout));
    assert!(path.is_dir(), "{}", text(&gc.stdout));
    assert_eq!(retirement_head_at(repo, &path), head);
    let removed = repo.mabo(&["remove", name, "--json"]);
    if detached {
        assert_eq!(removed.status.code(), Some(4), "{}", text(&removed.stdout));
        assert_eq!(json_value(&removed)["error"]["code"], "unpreserved");
        assert_eq!(retirement_head_at(repo, &path), head);
    } else {
        assert!(removed.status.success(), "{}", text(&removed.stdout));
        assert_eq!(
            json_value(&removed)["data"]["items"][0]["branchDeleted"],
            false
        );
        assert_eq!(
            json_value(&removed)["data"]["items"][0]["branchKeptReason"],
            "unpreserved"
        );
        assert!(branch_listed(repo, name));
    }
}

#[test]
fn retirement_review_keeps_meaningful_whitespace_in_squash() {
    assert_retirement_preserves_whitespace(false);
}

#[test]
fn retirement_review_keeps_meaningful_whitespace_in_cherry() {
    assert_retirement_preserves_whitespace(true);
}

fn assert_retirement_preserves_whitespace(cherry_only: bool) {
    let repo = Repo::new();
    assert!(repo
        .mabo(&["create", "whitespace", "--no-setup"])
        .status
        .success());
    commit_file(
        &repo,
        "whitespace",
        "task.py",
        "if ready:\n    task_a()\n    task_b()\n",
    );
    if cherry_only {
        commit_file(&repo, "whitespace", "extra.txt", "same patch\n");
    }
    fs::write(
        repo.repo.join("task.py"),
        "if ready:\n    task_a()\ntask_b()\n",
    )
    .unwrap();
    repo.git(&["add", "."]);
    repo.git(&["commit", "-m", "different semantics"]);
    if cherry_only {
        repo.git(&["cherry-pick", "whitespace"]);
    }
    let gc = repo.mabo(&["gc", "--merged", "--apply", "--json"]);
    assert!(gc.status.success(), "{}", text(&gc.stdout));
    assert!(
        managed(&repo, "whitespace").exists(),
        "cherry_only={cherry_only}: {}",
        text(&gc.stdout)
    );
    let removed = repo.mabo(&["remove", "whitespace", "--json"]);
    assert!(removed.status.success());
    assert_eq!(
        json_value(&removed)["data"]["items"][0]["branchKeptReason"],
        "unpreserved"
    );
    assert!(branch_listed(&repo, "whitespace"));
}

#[test]
fn retirement_review_remove_keeps_missing_detached_registration_and_head() {
    assert_retirement_keeps_missing_detached("remove");
}

#[test]
fn retirement_review_gc_keeps_missing_detached_registration_and_head() {
    assert_retirement_keeps_missing_detached("gc");
}

fn assert_retirement_keeps_missing_detached(command: &str) {
    let repo = Repo::new();
    assert!(repo
        .mabo(&["create", "detached", "--detach", "--no-setup"])
        .status
        .success());
    let path = managed(&repo, "detached");
    fs::write(path.join("precious.txt"), "unpreserved\n").unwrap();
    git_at(&repo, &path, &["add", "."]);
    git_at(&repo, &path, &["commit", "-m", "unpreserved detached work"]);
    let admin = repo
        .command("git", &["rev-parse", "--absolute-git-dir"])
        .current_dir(&path)
        .output()
        .unwrap();
    let admin = PathBuf::from(text(&admin.stdout));
    let head = fs::read(admin.join("HEAD")).unwrap();
    let reflog = fs::read(admin.join("logs/HEAD")).unwrap();
    let record_dir = repo.repo.join(".git/maboroshi/workspaces");
    let records_before = records::read(&record_dir).unwrap();
    fs::remove_dir_all(&path).unwrap();
    if command == "remove" {
        for dry_run in [true, false] {
            let mut args = vec!["remove", "detached", "--json"];
            if dry_run {
                args.push("--dry-run");
            }
            let out = repo.mabo(&args);
            assert_eq!(out.status.code(), Some(4), "{}", text(&out.stdout));
            assert_eq!(json_value(&out)["error"]["code"], "unpreserved");
        }
    } else {
        for apply in [false, true] {
            let mut args = vec!["gc", "--orphaned", "--json"];
            if apply {
                args.push("--apply");
            }
            let out = repo.mabo(&args);
            assert!(out.status.success(), "{}", text(&out.stdout));
            assert_eq!(json_value(&out)["data"]["items"][0]["action"], "skipped");
            assert!(json_value(&out)["data"]["items"][0]["detail"]
                .as_str()
                .unwrap()
                .contains("--delete-unpreserved-branch"));
        }
    }
    assert_eq!(fs::read(admin.join("HEAD")).unwrap(), head);
    assert_eq!(fs::read(admin.join("logs/HEAD")).unwrap(), reflog);
    assert_eq!(records::read(&record_dir).unwrap(), records_before);
    let permitted = repo.mabo(&[
        "remove",
        "detached",
        "--delete-unpreserved-branch",
        "--json",
    ]);
    assert!(permitted.status.success(), "{}", text(&permitted.stdout));
    assert!(!admin.exists());
}

fn retirement_review_gc_hint(out: &std::process::Output, json: bool) -> String {
    assert!(
        out.status.success(),
        "{} {}",
        text(&out.stdout),
        text(&out.stderr)
    );
    let detail = if json {
        json_value(out)["data"]["items"][0]["detail"]
            .as_str()
            .unwrap()
            .to_owned()
    } else {
        text(&out.stdout)
    };
    detail
        .split_once("; use ")
        .expect("targeted hint")
        .1
        .lines()
        .next()
        .unwrap()
        .trim()
        .to_owned()
}

#[test]
fn retirement_review_gc_hint_pins_selected_repository() {
    for json in [false, true] {
        let mut repo = Repo::new();
        let renamed = repo.root.join("primary's $repo `literal` with spaces");
        fs::rename(&repo.repo, &renamed).unwrap();
        repo.repo = renamed;
        let other = Repo::new();
        for root in [&repo.repo, &other.repo] {
            let created =
                repo.mabo(&["-R", root.to_str().unwrap(), "create", "same", "--no-setup"]);
            assert!(created.status.success(), "{}", text(&created.stderr));
        }
        land_branch(&repo, "same");
        fs::write(managed(&repo, "same/dirty"), "target\n").unwrap();
        let decoy = managed_directory(&other.repo, &repo.root.join("xdg")).join("same");
        fs::write(decoy.join("dirty"), "keep decoy\n").unwrap();
        let mut args = vec![
            "-R",
            repo.repo.to_str().unwrap(),
            "gc",
            "--merged",
            "--apply",
        ];
        if json {
            args.push("--json");
        }
        let out = repo
            .command(env!("CARGO_BIN_EXE_mabo"), &args)
            .current_dir(&other.repo)
            .output()
            .unwrap();
        let hint = retirement_review_gc_hint(&out, json);
        assert!(hint.contains("--discard-changes"), "{hint}");
        assert!(!hint.contains("--delete-unpreserved-branch"), "{hint}");
        let removed = run_setup_retry_hint(&repo, &other.repo, &hint);
        assert!(
            removed.status.success(),
            "{hint}: {} {}",
            text(&removed.stdout),
            text(&removed.stderr)
        );
        assert!(!managed(&repo, "same").exists(), "{hint}");
        assert_eq!(
            fs::read_to_string(decoy.join("dirty")).unwrap(),
            "keep decoy\n"
        );
    }
}

#[test]
fn retirement_review_gc_hint_resolves_git_only_name() {
    for json in [false, true] {
        let repo = Repo::new();
        let path = managed(&repo, "topic+fix");
        repo.git(&[
            "worktree",
            "add",
            "-b",
            "topic+fix",
            path.to_str().unwrap(),
            "HEAD",
        ]);
        let adopted = repo.mabo(&["adopt", path.to_str().unwrap()]);
        assert!(adopted.status.success(), "{}", text(&adopted.stderr));
        land_branch(&repo, "topic+fix");
        fs::write(path.join("dirty"), "target\n").unwrap();
        let mut args = vec!["gc", "--merged", "--apply"];
        if json {
            args.push("--json");
        }
        let hint = retirement_review_gc_hint(&repo.mabo(&args), json);
        let removed = run_setup_retry_hint(&repo, &repo.repo, &hint);
        assert!(
            removed.status.success(),
            "{hint}: {} {}",
            text(&removed.stdout),
            text(&removed.stderr)
        );
        assert!(!path.exists());
    }
}

#[test]
fn retirement_review_already_gone_is_visible_in_text_only() {
    let repo = Repo::new();
    assert!(repo
        .mabo(&["create", "missing", "--no-setup"])
        .status
        .success());
    let path = managed(&repo, "missing");
    let admin = repo
        .command("git", &["rev-parse", "--absolute-git-dir"])
        .current_dir(&path)
        .output()
        .unwrap();
    fs::remove_dir_all(text(&admin.stdout)).unwrap();
    let record_dir = repo.repo.join(".git/maboroshi/workspaces");
    let before = records::read(&record_dir).unwrap();
    for args in [
        vec!["remove", "missing"],
        vec!["remove", "missing", "--dry-run"],
    ] {
        let out = repo.mabo(&args);
        assert_eq!(out.status.code(), Some(0));
        assert_eq!(text(&out.stdout), "Workspace 'missing' is already gone");
        assert!(out.stderr.is_empty());
    }
    let json = repo.mabo(&["remove", "missing", "--json"]);
    assert_eq!(json.status.code(), Some(0));
    let item = &json_value(&json)["data"]["items"][0];
    assert_eq!(item["alreadyGone"], true);
    assert_eq!(item["removed"], false);
    assert!(item["error"].is_null());
    for field in ["branch", "dirty", "detached", "upstream"] {
        assert!(item["workspace"][field].is_null(), "{field}: {item}");
    }
    assert!(path.is_dir());
    assert_eq!(records::read(&record_dir).unwrap(), before);
}

#[test]
fn retirement_review2_remove_dry_run_suppresses_git_hooks() {
    assert_retirement_plan_suppresses_fsmonitor(false);
}

#[test]
fn retirement_review2_gc_plan_suppresses_git_hooks() {
    assert_retirement_plan_suppresses_fsmonitor(true);
}

fn assert_retirement_plan_suppresses_fsmonitor(gc: bool) {
    use std::os::unix::fs::PermissionsExt;
    let repo = Repo::new();
    assert!(repo
        .mabo(&["create", "landed", "--no-setup"])
        .status
        .success());
    land_branch(&repo, "landed");
    assert!(repo
        .mabo(&["create", "dirty", "--no-setup"])
        .status
        .success());
    land_branch(&repo, "dirty");
    fs::write(managed(&repo, "dirty/precious"), "keep\n").unwrap();
    let marker = repo.root.join("fsmonitor-writes");
    let hook = repo.root.join("fsmonitor-hook");
    fs::write(
        &hook,
        "#!/bin/sh\nprintf invoked >> \"$MABO_TEST_FSMONITOR_MARKER\"\nprintf 'token\\0'\n",
    )
    .unwrap();
    fs::set_permissions(&hook, fs::Permissions::from_mode(0o755)).unwrap();
    repo.git(&["config", "core.fsmonitor", hook.to_str().unwrap()]);
    // Prove that this fixture actually runs and writes through the hook.
    let status = repo
        .command("git", &["--no-optional-locks", "status", "--porcelain"])
        .env("MABO_TEST_FSMONITOR_MARKER", &marker)
        .output()
        .unwrap();
    assert!(status.status.success());
    assert!(!fs::read(&marker).unwrap().is_empty());
    fs::write(&marker, "unchanged").unwrap();
    for json in [false, true] {
        let cases = if gc {
            vec![
                (vec!["gc"], 0),
                (vec!["gc", "--merged"], 0),
                (vec!["gc", "--orphaned"], 0),
            ]
        } else {
            vec![
                (vec!["remove", "missing", "--dry-run"], 3),
                (vec!["remove", "landed", "--dry-run"], 0),
                (vec!["remove", "dirty", "--dry-run"], 4),
                (vec!["remove", "dirty", "--discard-changes", "--dry-run"], 0),
                (vec!["remove", ".", "--dry-run"], 4),
            ]
        };
        for (mut args, exit) in cases {
            if json {
                args.push("--json");
            }
            let out = repo
                .command(env!("CARGO_BIN_EXE_mabo"), &args)
                .env("MABO_TEST_FSMONITOR_MARKER", &marker)
                .output()
                .unwrap();
            assert_eq!(
                out.status.code(),
                Some(exit),
                "{args:?}: {} {}",
                text(&out.stdout),
                text(&out.stderr)
            );
            assert_eq!(
                fs::read_to_string(&marker).unwrap(),
                "unchanged",
                "{args:?} ran fsmonitor"
            );
            assert!(managed(&repo, "landed").exists());
            assert_eq!(
                fs::read_to_string(managed(&repo, "dirty/precious")).unwrap(),
                "keep\n"
            );
        }
    }
}

#[test]
fn retirement_review2_gc_keeps_fresh_detached_workspace() {
    for unknown_creation in [false, true] {
        let repo = Repo::new();
        assert!(repo
            .mabo(&["create", "review", "--detach", "--no-setup"])
            .status
            .success());
        if unknown_creation {
            clear_created_from(&repo, "review");
        }
        let record_dir = repo.repo.join(".git/maboroshi/workspaces");
        let before = records::read(&record_dir).unwrap();
        for args in [
            vec!["gc", "--merged", "--json"],
            vec!["gc", "--json"],
            vec!["gc", "--apply", "--json"],
        ] {
            let out = repo.mabo(&args);
            assert!(out.status.success(), "{}", text(&out.stdout));
            assert_eq!(
                json_value(&out)["data"]["items"],
                serde_json::json!([]),
                "unknown_creation={unknown_creation}: {}",
                text(&out.stdout)
            );
            assert!(managed(&repo, "review").exists());
            assert_eq!(records::read(&record_dir).unwrap(), before);
        }
    }
}

#[test]
fn retirement_review2_gc_keeps_landed_detached_with_unknown_creation() {
    for creation in ["missing", "invalid", "unrecorded"] {
        let repo = Repo::new();
        assert!(repo
            .mabo(&["create", "review", "--detach", "--no-setup"])
            .status
            .success());
        commit_in_worktree(&repo, "review");
        let head = repo
            .command("git", &["rev-parse", "HEAD"])
            .current_dir(managed(&repo, "review"))
            .output()
            .unwrap();
        assert!(head.status.success());
        repo.git(&["merge", "--ff-only", &text(&head.stdout)]);
        if creation == "unrecorded" {
            assert!(repo.mabo(&["forget", "review"]).status.success());
        } else if creation == "missing" {
            clear_created_from(&repo, "review");
        } else {
            let store = repo.repo.join(".git/maboroshi/workspaces");
            let mut document: serde_json::Value =
                serde_json::from_slice(&records::read(&store).unwrap()).unwrap();
            document["worktrees"][0]["createdFrom"] =
                serde_json::json!("unresolvable-creation-commit");
            records::write(&store, serde_json::to_vec(&document).unwrap()).unwrap();
        }
        for args in [
            vec!["gc", "--merged", "--json"],
            vec!["gc", "--apply", "--json"],
        ] {
            let out = repo.mabo(&args);
            assert!(out.status.success(), "{}", text(&out.stdout));
            assert_eq!(
                json_value(&out)["data"]["items"],
                serde_json::json!([]),
                "{creation}: {}",
                text(&out.stdout)
            );
            assert!(managed(&repo, "review").exists());
            assert!(worktree_registered(&repo, "review"));
        }
    }
}

#[test]
fn retirement_review2_gc_removes_detached_only_after_known_work_lands() {
    let repo = Repo::new();
    assert!(repo
        .mabo(&["create", "review", "--detach", "--no-setup"])
        .status
        .success());
    commit_in_worktree(&repo, "review");
    let plan = repo.mabo(&["gc", "--merged", "--json"]);
    assert!(plan.status.success());
    assert_eq!(json_value(&plan)["data"]["items"], serde_json::json!([]));
    let head = repo
        .command("git", &["rev-parse", "HEAD"])
        .current_dir(managed(&repo, "review"))
        .output()
        .unwrap();
    assert!(head.status.success());
    repo.git(&["merge", "--ff-only", &text(&head.stdout)]);
    let plan = repo.mabo(&["gc", "--merged", "--json"]);
    assert!(plan.status.success());
    let doc = json_value(&plan);
    assert_eq!(doc["data"]["items"][0]["action"], "wouldRemove");
    assert_eq!(
        doc["data"]["items"][0]["reasons"],
        serde_json::json!(["merged"])
    );
    let applied = repo.mabo(&["gc", "--merged", "--apply", "--json"]);
    assert!(applied.status.success(), "{}", text(&applied.stdout));
    assert_eq!(
        json_value(&applied)["data"]["items"][0]["action"],
        "removed"
    );
    assert!(!managed(&repo, "review").exists());
    assert!(!worktree_registered(&repo, "review"));
}

#[test]
fn retirement_review2_gc_hint_accepts_leading_hyphen_alias() {
    for unpreserved in [false, true] {
        for apply in [false, true] {
            for json in [false, true] {
                let repo = Repo::new();
                let path = managed(&repo, "topic");
                if unpreserved {
                    repo.git(&[
                        "worktree",
                        "add",
                        "--detach",
                        path.to_str().unwrap(),
                        "HEAD",
                    ]);
                } else {
                    repo.git(&[
                        "worktree",
                        "add",
                        "-b",
                        "topic",
                        path.to_str().unwrap(),
                        "HEAD",
                    ]);
                }
                let adopted = repo.mabo(&["adopt", path.to_str().unwrap()]);
                assert!(adopted.status.success(), "{}", text(&adopted.stderr));
                persist_retirement_hyphen_alias(&repo);
                assert!(repo.mabo(&["show", "--", "-alias"]).status.success());
                if unpreserved {
                    commit_in_worktree(&repo, "topic");
                    fs::remove_dir_all(&path).unwrap();
                } else {
                    land_branch(&repo, "topic");
                    fs::write(path.join("dirty"), "target\n").unwrap();
                }
                let mut args = vec![
                    "gc",
                    if unpreserved {
                        "--orphaned"
                    } else {
                        "--merged"
                    },
                ];
                if apply {
                    args.push("--apply");
                }
                if json {
                    args.push("--json");
                }
                let hint = retirement_review_gc_hint(&repo.mabo(&args), json);
                assert_eq!(
                    hint.contains("--delete-unpreserved-branch"),
                    unpreserved,
                    "{hint}"
                );
                assert_eq!(hint.contains("--discard-changes"), !unpreserved, "{hint}");
                let removed = run_setup_retry_hint(&repo, &repo.repo, &hint);
                assert!(
                    removed.status.success(),
                    "{hint}: {} {}",
                    text(&removed.stdout),
                    text(&removed.stderr)
                );
                assert!(!path.exists());
                assert!(!worktree_registered(&repo, "topic"));
            }
        }
    }
}

fn persist_retirement_hyphen_alias(repo: &Repo) {
    // The current CLI rejects option-like --name values, but recorded aliases
    // (including imported metadata) are valid selectors and must remain usable.
    let store = repo.repo.join(".git/maboroshi/workspaces");
    let mut document: serde_json::Value =
        serde_json::from_slice(&records::read(&store).unwrap()).unwrap();
    document["worktrees"][0]["name"] = serde_json::json!("-alias");
    records::write(&store, serde_json::to_vec(&document).unwrap()).unwrap();
}

#[test]
fn retirement_review2_sync_base_hints_accept_leading_hyphen_alias() {
    for missing_base in [false, true] {
        let repo = Repo::new();
        assert!(repo
            .mabo(&["create", "topic", "--no-setup"])
            .status
            .success());
        if missing_base {
            repo.git(&["branch", "obsolete"]);
            assert!(repo
                .mabo(&["set", "topic", "--base", "obsolete"])
                .status
                .success());
            repo.git(&["branch", "-D", "obsolete"]);
        } else {
            assert!(repo
                .mabo(&["set", "topic", "--unset", "base"])
                .status
                .success());
        }
        persist_retirement_hyphen_alias(&repo);
        let other = Repo::new();
        assert!(other
            .mabo(&["create", "topic", "--no-setup"])
            .status
            .success());
        assert!(other
            .mabo(&["set", "topic", "--unset", "base"])
            .status
            .success());
        persist_retirement_hyphen_alias(&other);
        let out = repo
            .command(
                env!("CARGO_BIN_EXE_mabo"),
                &[
                    "-R",
                    repo.repo.to_str().unwrap(),
                    "sync",
                    "--json",
                    "--",
                    "-alias",
                ],
            )
            .current_dir(&other.repo)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "{} {}",
            text(&out.stdout),
            text(&out.stderr)
        );
        let doc = json_value(&out);
        let item = &doc["data"]["workspaces"][0];
        assert_eq!(
            item["status"],
            if missing_base {
                "base-gone"
            } else {
                "base-unknown"
            }
        );
        let hint = item["detail"].as_str().unwrap().split_once(": ").unwrap().1;
        let hint = hint.replace("<ref>", "main").replace("REF", "main");
        let set = run_setup_retry_hint(&repo, &other.repo, &hint);
        assert!(
            set.status.success(),
            "{hint}: {} {}",
            text(&set.stdout),
            text(&set.stderr)
        );
        let show = repo.mabo(&["show", "--json", "--", "-alias"]);
        assert_eq!(
            json_value(&show)["data"]["workspace"]["base"],
            "refs/heads/main"
        );
        let decoy = other.mabo(&["show", "--json", "--", "-alias"]);
        assert!(json_value(&decoy)["data"]["workspace"]["base"].is_null());
    }
}

#[test]
fn retirement_review4_rejects_own_branch_as_base() {
    assert_retirement_rejects_self_evidence("base");
}

#[test]
fn retirement_review4_rejects_symbolic_base_to_own_branch() {
    assert_retirement_rejects_self_evidence("symbolic-base");
}

#[test]
fn retirement_review4_rejects_own_branch_as_upstream() {
    assert_retirement_rejects_self_evidence("upstream");
}

#[test]
fn retirement_review4_rejects_symbolic_upstream_to_own_branch() {
    assert_retirement_rejects_self_evidence("symbolic-upstream");
}

fn assert_retirement_rejects_self_evidence(evidence: &str) {
    let repo = Repo::new();
    assert!(repo
        .mabo(&["create", "topic", "--no-setup"])
        .status
        .success());
    commit_file(&repo, "topic", "precious", "only on topic\n");
    if evidence.contains("base") {
        let base = if evidence == "base" { "topic" } else { "alias" };
        if base == "alias" {
            repo.git(&["branch", "alias"]);
        }
        assert!(repo
            .mabo(&["set", "topic", "--base", base])
            .status
            .success());
    } else {
        repo.git(&["config", "branch.topic.remote", "."]);
        repo.git(&[
            "config",
            "branch.topic.merge",
            if evidence == "upstream" {
                "refs/heads/topic"
            } else {
                "refs/heads/alias"
            },
        ]);
    }
    if evidence.starts_with("symbolic") {
        // Retarget after recording too: stored names must be resolved at deletion time.
        repo.git(&["symbolic-ref", "refs/heads/alias", "refs/heads/topic"]);
    }
    assert_retirement_review3_keeps_workspace(&repo, "topic", false);
}

#[test]
fn retirement_review4_rejects_detached_head_and_unrooted_commit_bases() {
    for base in ["HEAD", "oid", "worktree-head"] {
        let repo = Repo::new();
        assert!(repo
            .mabo(&["create", "topic", "--detach", "--no-setup"])
            .status
            .success());
        commit_file(&repo, "topic", "precious", "only in detached HEAD\n");
        let path = managed(&repo, "topic");
        let head = retirement_head_at(&repo, &path);
        let admin = repo
            .command("git", &["rev-parse", "--absolute-git-dir"])
            .current_dir(&path)
            .output()
            .unwrap();
        assert!(admin.status.success());
        let id = Path::new(&text(&admin.stdout))
            .file_name()
            .unwrap()
            .to_str()
            .unwrap()
            .to_owned();
        let reference = match base {
            "oid" => head.trim().to_owned(),
            "worktree-head" => format!("worktrees/{id}/HEAD"),
            _ => "HEAD".to_owned(),
        };
        // Exercise imported/raw metadata as well as the OID produced by normalizing
        // --base HEAD in a detached checkout. HEAD must not prove its own retention.
        let store = repo.repo.join(".git/maboroshi/workspaces");
        let mut document: serde_json::Value =
            serde_json::from_slice(&records::read(&store).unwrap()).unwrap();
        document["worktrees"][0]["base"] = serde_json::json!(reference);
        records::write(&store, serde_json::to_vec(&document).unwrap()).unwrap();
        if base == "HEAD" {
            // The observing checkout's HEAD can itself be detached at this tip.
            repo.git(&["checkout", "--detach", head.trim()]);
        }
        assert_retirement_review3_keeps_workspace(&repo, "topic", true);
    }
}

#[test]
fn retirement_review4_accepts_independent_refs_at_same_commit() {
    for evidence in [
        "branch",
        "tag",
        "custom-fetch",
        "symbolic-base",
        "upstream",
        "symbolic-upstream",
    ] {
        let repo = Repo::new();
        assert!(repo
            .mabo(&["create", "topic", "--no-setup"])
            .status
            .success());
        commit_file(&repo, "topic", "precious", "saved independently\n");
        repo.git(&["branch", "saved", "topic"]);
        repo.git(&["symbolic-ref", "refs/heads/alias", "refs/heads/saved"]);
        if evidence.contains("upstream") {
            repo.git(&["config", "branch.topic.remote", "."]);
            repo.git(&[
                "config",
                "branch.topic.merge",
                if evidence == "upstream" {
                    "refs/heads/saved"
                } else {
                    "refs/heads/alias"
                },
            ]);
        } else {
            let base = match evidence {
                "custom-fetch" => {
                    repo.git(&["update-ref", "refs/cache/saved", "topic"]);
                    "refs/cache/saved"
                }
                "tag" => {
                    repo.git(&["tag", "archive", "topic"]);
                    "refs/tags/archive"
                }
                "symbolic-base" => "alias",
                _ => "saved",
            };
            assert!(repo
                .mabo(&["set", "topic", "--base", base])
                .status
                .success());
        }
        let out = repo.mabo(&["remove", "topic", "--json"]);
        assert!(out.status.success(), "{evidence}: {}", text(&out.stdout));
        assert_eq!(
            json_value(&out)["data"]["items"][0]["branchDeleted"],
            true,
            "{evidence}"
        );
        assert!(branch_listed(&repo, "saved"));
    }
}

#[test]
fn retirement_review4_missing_git_only_workspace_hint_uses_link() {
    assert_retirement_missing_git_only_hint("linked");
}

#[test]
fn retirement_review4_missing_git_only_workspace_hint_uses_git() {
    assert_retirement_missing_git_only_hint("unrecorded");
    assert_retirement_missing_git_only_hint("ambiguous");
}

fn assert_retirement_missing_git_only_hint(kind: &str) {
    for json in [false, true] {
        for apply in [false, true] {
            let repo = Repo::new();
            let other = Repo::new();
            let path = managed(&repo, "topic+fix");
            repo.git(&[
                "worktree",
                "add",
                "--detach",
                path.to_str().unwrap(),
                "HEAD",
            ]);
            if kind != "unrecorded" {
                let out = repo.mabo(&["adopt", path.to_str().unwrap(), "--issue", "17"]);
                assert!(out.status.success(), "{}", text(&out.stderr));
                if kind == "ambiguous" {
                    let decoy = managed(&repo, "decoy");
                    repo.git(&[
                        "worktree",
                        "add",
                        "-b",
                        "decoy",
                        decoy.to_str().unwrap(),
                        "HEAD",
                    ]);
                    let adopted = repo.mabo(&["adopt", decoy.to_str().unwrap(), "--issue", "17"]);
                    assert!(adopted.status.success(), "{}", text(&adopted.stderr));
                }
            }
            commit_file(
                &repo,
                "topic+fix",
                "precious",
                "unpreserved detached work\n",
            );
            let admin = repo
                .command("git", &["rev-parse", "--absolute-git-dir"])
                .current_dir(&path)
                .output()
                .unwrap();
            assert!(admin.status.success());
            let admin = PathBuf::from(text(&admin.stdout));
            let head = fs::read(admin.join("HEAD")).unwrap();
            let reflog = fs::read(admin.join("logs/HEAD")).unwrap();
            fs::remove_dir_all(&path).unwrap();
            let mut args = vec!["-R", repo.repo.to_str().unwrap(), "gc", "--orphaned"];
            if json {
                args.push("--json");
            }
            if apply {
                args.push("--apply");
            }
            let out = repo
                .command(env!("CARGO_BIN_EXE_mabo"), &args)
                .current_dir(&other.repo)
                .output()
                .unwrap();
            let hint = retirement_review_gc_hint(&out, json);
            assert_eq!(fs::read(admin.join("HEAD")).unwrap(), head);
            assert_eq!(fs::read(admin.join("logs/HEAD")).unwrap(), reflog);
            assert!(!hint.contains("cd "), "{hint}");
            if kind == "linked" {
                assert!(hint.contains("'issue:17'"), "{hint}");
                assert!(hint.contains("--delete-unpreserved-branch"), "{hint}");
            } else {
                assert!(hint.contains("worktree remove --force"), "{hint}");
            }
            let removed = run_setup_retry_hint(&repo, &other.repo, &hint);
            assert!(
                removed.status.success(),
                "{hint}: {} {}",
                text(&removed.stdout),
                text(&removed.stderr)
            );
            assert!(!admin.exists(), "{hint}");
            assert!(!worktree_registered(&repo, "topic+fix"));
            assert!(other.repo.join(".git").is_dir());
            if kind == "ambiguous" {
                assert!(managed(&repo, "decoy").is_dir());
            }
        }
    }
}

#[test]
fn retirement_review4_sync_missing_directory_hint_can_set_base() {
    let repo = Repo::new();
    assert!(repo
        .mabo(&["create", "topic", "--no-setup"])
        .status
        .success());
    assert!(repo
        .mabo(&["set", "topic", "--unset", "base"])
        .status
        .success());
    persist_retirement_hyphen_alias(&repo);
    fs::remove_dir_all(managed(&repo, "topic")).unwrap();
    let other = Repo::new();
    let out = repo
        .command(
            env!("CARGO_BIN_EXE_mabo"),
            &[
                "-R",
                repo.repo.to_str().unwrap(),
                "sync",
                "--json",
                "--",
                "-alias",
            ],
        )
        .current_dir(&other.repo)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{} {}",
        text(&out.stdout),
        text(&out.stderr)
    );
    let doc = json_value(&out);
    let hint = doc["data"]["workspaces"][0]["detail"]
        .as_str()
        .unwrap()
        .split_once(": ")
        .unwrap()
        .1
        .replace("REF", "main");
    assert!(!hint.contains("cd "), "{hint}");
    let set = run_setup_retry_hint(&repo, &other.repo, &hint);
    assert!(
        set.status.success(),
        "{hint}: {} {}",
        text(&set.stdout),
        text(&set.stderr)
    );
    let show = repo.mabo(&["show", "--json", "--", "-alias"]);
    assert_eq!(
        json_value(&show)["data"]["workspace"]["base"],
        "refs/heads/main"
    );
}

#[test]
fn retirement_remove_unknown_selectors_preflight_all_targets_without_hooks() {
    let repo = Repo::new();
    assert!(repo
        .mabo(&["create", "known", "--no-setup"])
        .status
        .success());
    fs::write(
        repo.repo.join(".mabo.toml"),
        "[hooks]\npre-remove = [\"touch hook-ran\"]\n",
    )
    .unwrap();
    let records_dir = repo.repo.join(".git/maboroshi/workspaces");
    let before = records::read(&records_dir).unwrap();
    let missing_path = repo.root.join("missing path's $(touch injected)");
    let unregistered_path = managed(&repo, "unregistered-directory");
    fs::create_dir_all(&unregistered_path).unwrap();
    fs::write(unregistered_path.join("precious"), "keep").unwrap();
    let selectors = [
        "typo",
        "pr:999",
        "issue:999",
        "https://github.com/acme/demo/pull/999",
        "https://github.com/acme/demo/issues/999",
        missing_path.to_str().unwrap(),
        "./missing",
        "../missing",
        "unregistered-directory",
        unregistered_path.to_str().unwrap(),
    ];
    for dry_run in [false, true] {
        for json in [false, true] {
            for mixed in [false, true] {
                let mut args = vec!["remove"];
                if mixed {
                    args.push("known");
                }
                args.extend(selectors);
                if dry_run {
                    args.push("--dry-run");
                }
                if json {
                    args.push("--json");
                }
                let out = repo.mabo(&args);
                assert_eq!(
                    out.status.code(),
                    Some(3),
                    "{args:?}: {} {}",
                    text(&out.stdout),
                    text(&out.stderr)
                );
                if json {
                    let doc = assert_envelope(&out, "remove");
                    assert_eq!(doc["error"]["code"], "not_found");
                    for item in doc["data"]["items"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .skip(usize::from(mixed))
                    {
                        assert_eq!(item["alreadyGone"], false);
                        assert_eq!(item["error"]["code"], "not_found");
                    }
                } else {
                    for selector in selectors {
                        assert!(
                            text(&out.stderr).contains(selector),
                            "{}",
                            text(&out.stderr)
                        );
                    }
                }
                assert!(managed(&repo, "known").is_dir());
                assert!(!managed(&repo, "known/hook-ran").exists());
                assert!(branch_listed(&repo, "known"));
                assert_eq!(
                    fs::read_to_string(unregistered_path.join("precious")).unwrap(),
                    "keep"
                );
                assert_eq!(records::read(&records_dir).unwrap(), before);
            }
        }
    }
    // Each spelling also fails by itself, without relying on another missing name.
    for selector in selectors {
        let out = repo.mabo(&["remove", selector, "--json"]);
        assert_eq!(
            out.status.code(),
            Some(3),
            "{selector}: {}",
            text(&out.stdout)
        );
        assert_eq!(json_value(&out)["error"]["code"], "not_found");
    }
}

#[test]
fn retirement_remove_already_gone_requires_metadata_or_git_registration() {
    for recorded in [false, true] {
        for registered in [false, true] {
            let repo = Repo::new();
            assert!(repo
                .create_recorded(&[
                    "create",
                    "gone",
                    "--pr",
                    "https://github.com/acme/demo/pull/7",
                    "--issue",
                    "https://github.com/acme/demo/issues/8"
                ])
                .status
                .success());
            let path = managed(&repo, "gone");
            if !recorded {
                assert!(repo.mabo(&["forget", "gone"]).status.success());
            }
            fs::remove_dir_all(&path).unwrap();
            if !registered {
                repo.git(&["worktree", "prune", "--expire", "now"]);
            }
            fs::write(
                repo.repo.join(".mabo.toml"),
                "[hooks]\npre-remove = [\"exit 99\"]\n",
            )
            .unwrap();
            let mut selectors = vec!["gone", path.to_str().unwrap()];
            if recorded {
                selectors.extend([
                    "pr:7",
                    "issue:8",
                    "https://github.com/acme/demo/pull/7",
                    "https://github.com/acme/demo/issues/8",
                ]);
            }
            for dry_run in [true, false] {
                // Aliases in one command deduplicate to the one evidenced target.
                let mut args = vec!["remove", "--json"];
                if dry_run {
                    args.push("--dry-run");
                }
                args.extend(selectors.iter().copied());
                let out = repo.mabo(&args);
                assert_eq!(
                    out.status.code(),
                    Some(if recorded || registered { 0 } else { 3 }),
                    "recorded={recorded}, registered={registered}: {}",
                    text(&out.stdout)
                );
                let doc = json_value(&out);
                if recorded || registered {
                    let items = doc["data"]["items"].as_array().unwrap();
                    assert_eq!(items.len(), 1);
                    assert_eq!(items[0]["alreadyGone"], true);
                    assert!(items[0]["error"].is_null());
                } else {
                    assert_eq!(doc["error"]["code"], "not_found");
                }
                assert!(branch_listed(&repo, "gone"));
            }
        }
    }
}

#[test]
fn retirement_remove_retry_quotes_repository_and_preserves_permission_flags() {
    for json in [false, true] {
        let repo = Repo::new();
        // Exercise quoting in -R, including shell syntax and control characters.
        let selected = repo.root.join("repo's $(touch injected)\ncheckout");
        fs::rename(&repo.repo, &selected).unwrap();
        let repo = Repo {
            root: repo.root.clone(),
            repo: selected,
            home: repo.home.clone(),
        };
        for name in ["done", "-remaining", "last"] {
            if name.starts_with('-') {
                let path = managed(&repo, name);
                repo.git(&[
                    "worktree",
                    "add",
                    "-b",
                    "remaining-branch",
                    path.to_str().unwrap(),
                ]);
                assert!(repo
                    .mabo(&["adopt", path.to_str().unwrap()])
                    .status
                    .success());
            } else {
                let out = repo.mabo(&["create", "--no-setup", "--", name]);
                assert!(
                    out.status.success(),
                    "{} {}",
                    text(&out.stdout),
                    text(&out.stderr)
                );
            }
            fs::write(managed(&repo, &format!("{name}/dirty")), "dirty").unwrap();
            commit_file(&repo, name, "committed.txt", "unpreserved history");
        }
        // The second hook fails only after the first workspace is removed.
        fs::write(
            repo.repo.join(".mabo.toml"),
            "[hooks]\npre-remove = [\"test \\\"$MABO_WORKSPACE\\\" != -remaining || exit 1\"]\n",
        )
        .unwrap();
        let mut args = vec![
            "-R",
            repo.repo.to_str().unwrap(),
            "remove",
            "--discard-changes",
            "--delete-unpreserved-branch",
            "--keep-branch",
            "--no-input",
        ];
        if json {
            args.push("--json");
        }
        args.extend(["--", "done", "-remaining", "last"]);
        let out = repo.mabo(&args);
        assert_eq!(
            out.status.code(),
            Some(6),
            "{} {}",
            text(&out.stdout),
            text(&out.stderr)
        );
        let hint = setup_retry_hint(&out, json);
        if json {
            assert_eq!(json_value(&out)["error"]["details"]["retryCommand"], hint);
        }
        assert!(hint.contains("-R "));
        for flag in [
            "--discard-changes",
            "--delete-unpreserved-branch",
            "--keep-branch",
            "--no-input",
            " -- ",
        ] {
            assert!(hint.contains(flag), "{hint}");
        }
        assert!(!hint.contains("'done'"));
        fs::remove_file(repo.repo.join(".mabo.toml")).unwrap();
        let out = run_setup_retry_hint(&repo, &repo.home, &hint);
        assert_eq!(
            out.status.code(),
            Some(0),
            "{hint}: {} {}",
            text(&out.stdout),
            text(&out.stderr)
        );
        assert!(!managed(&repo, "-remaining").exists());
        assert!(!managed(&repo, "last").exists());
        assert!(!repo.home.join("injected").exists());
    }
}

#[test]
fn retirement_remove_missing_wins_over_other_preflight_errors() {
    let repo = Repo::new();
    assert!(repo
        .mabo(&["create", "dirty", "--no-setup"])
        .status
        .success());
    fs::write(managed(&repo, "dirty/changed"), "keep").unwrap();
    for selectors in [["dirty", "unknown"], ["unknown", "dirty"]] {
        for dry_run in [false, true] {
            let mut args = vec!["remove", "--json"];
            if dry_run {
                args.push("--dry-run");
            }
            args.extend(selectors);
            let out = repo.mabo(&args);
            assert_eq!(out.status.code(), Some(3), "{}", text(&out.stdout));
            assert_eq!(json_value(&out)["error"]["code"], "not_found");
            assert!(managed(&repo, "dirty/changed").is_file());
        }
    }
}

#[test]
fn retirement_remove_retry_finishes_branch_failure_without_reselecting_deleted_workspace() {
    for json in [false, true] {
        let repo = Repo::new();
        for name in ["done", "branch-failure", "last"] {
            assert!(repo.mabo(&["create", name, "--no-setup"]).status.success());
        }
        // Prevent only branch deletion; the checkout and record really disappear.
        let lock = repo.repo.join(".git/refs/heads/branch-failure.lock");
        fs::write(&lock, "locked").unwrap();
        let mut args = vec!["remove", "done", "branch-failure", "last", "--no-hooks"];
        if json {
            args.push("--json");
        }
        let out = repo.mabo(&args);
        assert_eq!(
            out.status.code(),
            Some(6),
            "{} {}",
            text(&out.stdout),
            text(&out.stderr)
        );
        assert!(!managed(&repo, "branch-failure").exists());
        assert!(branch_listed(&repo, "branch-failure"));
        let hint = setup_retry_hint(&out, json);
        assert!(
            hint.contains("show-ref --verify --hash 'refs/heads/branch-failure'"),
            "{hint}"
        );
        assert!(hint.contains("--no-hooks"), "{hint}");
        fs::remove_file(lock).unwrap();
        let retried = run_setup_retry_hint(&repo, &repo.home, &hint);
        assert_eq!(
            retried.status.code(),
            Some(0),
            "{hint}: {} {}",
            text(&retried.stdout),
            text(&retried.stderr)
        );
        assert!(!branch_listed(&repo, "branch-failure"));
        assert!(!managed(&repo, "last").exists());
    }
}

#[test]
fn retirement_remove_retry_keeps_a_branch_changed_after_partial_removal() {
    let repo = Repo::new();
    assert!(repo
        .mabo(&["create", "branch-failure", "--no-setup"])
        .status
        .success());
    let lock = repo.repo.join(".git/refs/heads/branch-failure.lock");
    fs::write(&lock, "locked").unwrap();
    let out = repo.mabo(&["remove", "branch-failure", "--json"]);
    assert_eq!(out.status.code(), Some(6));
    let hint = setup_retry_hint(&out, true);
    fs::remove_file(lock).unwrap();
    fs::write(repo.repo.join("new-commit"), "preserve").unwrap();
    repo.git(&["add", "new-commit"]);
    repo.git(&["commit", "-m", "advance"]);
    repo.git(&["branch", "-f", "branch-failure", "HEAD"]);
    let out = run_setup_retry_hint(&repo, &repo.home, &hint);
    assert!(!out.status.success());
    assert!(branch_listed(&repo, "branch-failure"));
}

#[test]
fn retirement_remove_retry_finishes_metadata_failure_after_checkout_is_gone() {
    use std::os::unix::fs::PermissionsExt;
    for json in [false, true] {
        let repo = Repo::new();
        for name in ["metadata-failure", "last"] {
            assert!(repo.mabo(&["create", name, "--no-setup"]).status.success());
        }
        let real_git = repo
            .command("sh", &["-c", "command -v git"])
            .output()
            .unwrap();
        let bin = repo.root.join("bin");
        fs::create_dir(&bin).unwrap();
        let wrapper = bin.join("git");
        // Real Git removal succeeds, then a filesystem obstruction makes the
        // metadata write fail. Restore it before executing the supplied hint.
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
        .unwrap();
        fs::set_permissions(&wrapper, fs::Permissions::from_mode(0o755)).unwrap();
        let metadata_dir = repo.repo.join(".git/maboroshi/workspaces");
        let mut args = vec!["remove", "metadata-failure", "last", "--no-hooks"];
        if json {
            args.push("--json");
        }
        let out = repo
            .command(env!("CARGO_BIN_EXE_mabo"), &args)
            .env(
                "PATH",
                format!("{}:{}", bin.display(), std::env::var("PATH").unwrap()),
            )
            .env("REAL_GIT", text(&real_git.stdout))
            .env("METADATA_DIR", &metadata_dir)
            .output()
            .unwrap();
        assert_eq!(
            out.status.code(),
            Some(6),
            "{} {}",
            text(&out.stdout),
            text(&out.stderr)
        );
        assert!(!managed(&repo, "metadata-failure").exists());
        let hint = setup_retry_hint(&out, json);
        fs::remove_file(&metadata_dir).unwrap();
        fs::rename(metadata_dir.with_extension("saved"), &metadata_dir).unwrap();
        let out = run_setup_retry_hint(&repo, &repo.home, &hint);
        assert_eq!(
            out.status.code(),
            Some(0),
            "{hint}: {} {}",
            text(&out.stdout),
            text(&out.stderr)
        );
        assert!(!managed(&repo, "last").exists());
        let records: serde_json::Value =
            serde_json::from_slice(&records::read(metadata_dir).unwrap()).unwrap();
        assert_eq!(records["worktrees"], serde_json::json!([]));
    }
}

#[test]
fn retirement_remove_path_and_name_aliases_deduplicate_before_hooks() {
    let repo = Repo::new();
    assert!(repo
        .mabo(&["create", "target", "--no-setup"])
        .status
        .success());
    let path = managed(&repo, "target");
    let marker = repo.repo.join("hook-count");
    fs::write(
        repo.repo.join(".mabo.toml"),
        "[hooks]\npre-remove = ['printf x >> \"$MABO_REPO_PATH/hook-count\"']\n",
    )
    .unwrap();
    let relative = format!("./{}", maboroshi::paths::relative(&repo.repo, &path));
    for dry_run in [true, false] {
        let mut args = vec![
            "remove",
            "target",
            path.to_str().unwrap(),
            &relative,
            "--json",
        ];
        if dry_run {
            args.push("--dry-run");
        }
        let out = repo.mabo(&args);
        assert_eq!(
            out.status.code(),
            Some(0),
            "{} {}",
            text(&out.stdout),
            text(&out.stderr)
        );
        assert_eq!(
            json_value(&out)["data"]["items"].as_array().unwrap().len(),
            1
        );
        assert_eq!(marker.exists(), !dry_run);
    }
    assert_eq!(fs::read_to_string(marker).unwrap(), "x");
    assert!(!path.exists());
}

#[test]
fn retirement_remove_retry_preserves_linked_source_hooks() {
    let repo = Repo::new();
    for name in ["source", "done", "remaining"] {
        assert!(repo.mabo(&["create", name, "--no-setup"]).status.success());
    }
    let source = managed(&repo, "source");
    fs::write(source.join(".mabo.toml"), "[hooks]\npre-remove = ['test \"$MABO_WORKSPACE\" != remaining || test -f \"$MABO_REPO_PATH/allow-remove\"', 'printf x >> \"$MABO_REPO_PATH/source-hooks\"']\n").unwrap();
    let out = repo
        .command(
            env!("CARGO_BIN_EXE_mabo"),
            &["remove", "done", "remaining", "--json"],
        )
        .current_dir(&source)
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(6), "{}", text(&out.stdout));
    let hint = setup_retry_hint(&out, true);
    fs::write(repo.repo.join("allow-remove"), "allow").unwrap();
    let out = run_setup_retry_hint(&repo, &repo.home, &hint);
    assert_eq!(
        out.status.code(),
        Some(0),
        "{hint}: {} {}",
        text(&out.stdout),
        text(&out.stderr)
    );
    assert_eq!(
        fs::read_to_string(repo.repo.join("source-hooks")).unwrap(),
        "xx"
    );
    assert!(!managed(&repo, "remaining").exists());
    assert!(source.is_dir());
}
