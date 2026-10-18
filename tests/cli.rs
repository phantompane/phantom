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
        version_line.starts_with("Phantom v6.3.2+rust"),
        "{version_line}"
    );
    assert_ne!(version_line, "Phantom v6.3.2");
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
            Some(1),
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
fn invalid_config_names_the_file_and_the_problem() {
    let repo = Repo::new();
    fs::write(repo.repo.join("phantom.config.json"), "{").expect("config");
    let created = repo.phantom(&["create", "feature/bad-json"]);
    let stderr = text(&created.stderr);
    assert!(
        !created.status.success(),
        "invalid JSON should fail, stdout: {}",
        text(&created.stdout)
    );
    assert!(
        stderr.contains("phantom.config.json"),
        "stderr should name the file: {stderr}"
    );
    assert!(
        stderr.contains("parse") || stderr.contains("expected"),
        "stderr should describe the JSON problem: {stderr}"
    );
    assert!(!repo
        .repo
        .join(".git/phantom/worktrees/feature/bad-json")
        .exists());

    fs::write(
        repo.repo.join("phantom.config.json"),
        r#"{"postCreate":{"copyFiles":[1]}}"#,
    )
    .expect("schema");
    let created = repo.phantom(&["where", "feature/bad-json"]);
    let stderr = text(&created.stderr);
    assert!(!created.status.success(), "{}", text(&created.stdout));
    assert!(stderr.contains("phantom.config.json"), "{stderr}");
    assert!(stderr.contains("copyFiles"), "{stderr}");
}

#[test]
fn github_checkout_logger_follows_the_caller() {
    let repo = Repo::new();
    fs::write(
        repo.repo.join("phantom.config.json"),
        r#"{"postCreate":{"commands":["true"]}}"#,
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

    let mcp = mcp_tool(
        &repo,
        &[("PATH", path.as_str())],
        "phantom_github_checkout",
        serde_json::json!({"number": "8"}),
    );
    assert!(
        !mcp.stdout.contains("Running post-create"),
        "MCP stdout must stay JSON-RPC:\n{}",
        mcp.stdout
    );
    assert!(
        !mcp.stdout.contains("Executing:"),
        "MCP stdout must stay JSON-RPC:\n{}",
        mcp.stdout
    );
    assert!(
        mcp.stdout.contains("issues/8"),
        "MCP should still return the checkout:\n{}\n{}",
        mcp.stdout,
        mcp.stderr
    );
}

struct McpOutput {
    stdout: String,
    stderr: String,
}

fn mcp_tool(
    repo: &Repo,
    env: &[(&str, &str)],
    tool: &str,
    arguments: serde_json::Value,
) -> McpOutput {
    let mut command = repo.command(env!("CARGO_BIN_EXE_ptm"), &["mcp", "serve"]);
    command
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    for (key, value) in env {
        command.env(key, value);
    }
    let mut child = command.spawn().expect("mcp");
    let mut stdin = child.stdin.take().expect("stdin");
    let call = serde_json::json!({
        "jsonrpc": "2.0",
        "id": 2,
        "method": "tools/call",
        "params": {"name": tool, "arguments": arguments}
    });
    use std::io::Write;
    writeln!(
        stdin,
        r#"{{"jsonrpc":"2.0","id":1,"method":"initialize","params":{{"protocolVersion":"2024-11-05","capabilities":{{}},"clientInfo":{{"name":"test","version":"0"}}}}}}"#
    )
    .expect("init");
    writeln!(
        stdin,
        r#"{{"jsonrpc":"2.0","method":"notifications/initialized"}}"#
    )
    .expect("initialized");
    writeln!(stdin, "{call}").expect("call");
    drop(stdin);
    let pid = child.id();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(8));
        let _ = std::process::Command::new("kill")
            .arg(pid.to_string())
            .status();
    });
    let output = child.wait_with_output().expect("wait");
    McpOutput {
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
    }
}

#[test]
fn post_create_failure_reports_the_created_worktree() {
    let repo = Repo::new();
    fs::write(
        repo.repo.join("phantom.config.json"),
        r#"{"postCreate":{"commands":["phantom-missing-post-create-bin"]}}"#,
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
        text(&attached.stdout).contains("Attached phantom: existing-hook"),
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
fn removed_ai_command_and_preference_are_unknown() {
    let repo = Repo::new();
    let command = repo.phantom(&["ai", "feature"]);
    assert_eq!(command.status.code(), Some(1));
    assert!(text(&command.stderr).contains("Unknown command 'ai feature'"));

    let preference = repo.phantom(&["preferences", "set", "ai", "claude"]);
    assert_eq!(preference.status.code(), Some(3));
    let stderr = text(&preference.stderr);
    assert!(stderr.contains("Unknown preference 'ai'"), "{stderr}");
    assert!(stderr.contains("worktreesDirectory"), "{stderr}");
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
    assert!(stderr.contains("worktreesDirectory"), "{stderr}");
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
            Some(1),
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
            Some(1),
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
        "#!/bin/sh\nif [ \"$1\" != \"list\" ] || [ \"$2\" != \"--full-path\" ]; then\n  exit 2\nfi\nprintf \"%s\\n\" \"$PHANTOM_TEST_GHQ_PROJECT\"\n",
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
        .env("PHANTOM_TEST_GHQ_PROJECT", &repo.repo)
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
fn copy_file_globs_match_v6() {
    let repo = Repo::new();
    fs::write(repo.repo.join("local.env"), "env\n").expect("env");
    fs::write(repo.repo.join("config.json"), "{}\n").expect("json");
    fs::write(repo.repo.join("readme.md"), "md\n").expect("md");
    fs::create_dir_all(repo.repo.join("nested/deep")).expect("nested");
    fs::write(repo.repo.join("nested/deep/file.txt"), "nested\n").expect("nested file");
    let created = repo.phantom(&[
        "create",
        "copied",
        "--copy-file",
        "*.{env,json}",
        "--copy-file",
        "nested/**",
    ]);
    assert!(created.status.success(), "{}", text(&created.stderr));
    let worktree = repo.repo.join(".git/phantom/worktrees/copied");
    assert_eq!(
        fs::read_to_string(worktree.join("local.env")).expect("env"),
        "env\n"
    );
    assert_eq!(
        fs::read_to_string(worktree.join("config.json")).expect("json"),
        "{}\n"
    );
    assert!(fs::read_to_string(worktree.join("readme.md")).is_err());
    assert_eq!(
        fs::read_to_string(worktree.join("nested/deep/file.txt")).expect("nested"),
        "nested\n"
    );
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
    repo.phantom(&["preferences", "set", "ghqDiscovery", "false"]);
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
fn create_and_attach_exec_export_phantom_env() {
    let repo = Repo::new();
    let script =
        "printf '%s\\n' \"$PHANTOM\" \"$PHANTOM_NAME\" \"$PHANTOM_PATH\" > phantom-env.txt";
    let created = repo.phantom(&["create", "feature/env", "--exec", script]);
    assert!(
        created.status.success(),
        "{}\n{}",
        text(&created.stdout),
        text(&created.stderr)
    );
    let worktree = repo.repo.join(".git/phantom/worktrees/feature/env");
    assert_phantom_env(&worktree, "feature/env");

    repo.git(&["branch", "attached-env"]);
    let attached = repo.phantom(&["attach", "attached-env", "--exec", script]);
    assert!(
        attached.status.success(),
        "{}\n{}",
        text(&attached.stdout),
        text(&attached.stderr)
    );
    assert_phantom_env(
        &repo.repo.join(".git/phantom/worktrees/attached-env"),
        "attached-env",
    );

    let execed = repo.phantom(&["exec", "feature/env", "--", "sh", "-c", script]);
    assert!(execed.status.success(), "{}", text(&execed.stderr));
    assert_phantom_env(&worktree, "feature/env");
}

fn assert_phantom_env(worktree: &std::path::Path, name: &str) {
    let recorded = fs::read_to_string(worktree.join("phantom-env.txt")).expect("phantom env");
    let mut lines = recorded.lines();
    assert_eq!(lines.next(), Some("1"), "{recorded}");
    assert_eq!(lines.next(), Some(name), "{recorded}");
    assert_eq!(
        lines.next(),
        Some(worktree.to_string_lossy().as_ref()),
        "{recorded}"
    );
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
fn mcp_hooks_do_not_write_to_stdout() {
    let repo = Repo::new();
    fs::write(
        repo.repo.join("phantom.config.json"),
        r#"{"postCreate":{"commands":["printf 'HOOK_STDOUT\\n'"]},"preDelete":{"commands":["printf 'PRE_STDOUT\\n'"]}}"#,
    )
    .expect("config");

    let cli = repo.phantom(&["create", "cli-hooks"]);
    assert!(cli.status.success(), "{}", text(&cli.stderr));
    assert!(
        text(&cli.stdout).contains("HOOK_STDOUT"),
        "CLI hooks stay on stdout:\n{}",
        text(&cli.stdout)
    );

    let created = mcp_tool(
        &repo,
        &[],
        "phantom_create_worktree",
        serde_json::json!({"name": "mcp-hooks"}),
    );
    assert!(
        !created.stdout.contains("HOOK_STDOUT"),
        "post-create output leaked onto MCP stdout:\n{}",
        created.stdout
    );
    assert!(
        !created.stdout.contains("Running post-create") && !created.stdout.contains("Executing:"),
        "hook status leaked onto MCP stdout:\n{}",
        created.stdout
    );
    assert!(
        created.stderr.contains("HOOK_STDOUT"),
        "hook output should be on stderr:\n{}",
        created.stderr
    );
    assert!(
        created.stdout.contains("mcp-hooks"),
        "create tool should still return JSON:\n{}\n{}",
        created.stdout,
        created.stderr
    );

    let deleted = mcp_tool(
        &repo,
        &[],
        "phantom_delete_worktree",
        serde_json::json!({"name": "mcp-hooks"}),
    );
    assert!(
        !deleted.stdout.contains("PRE_STDOUT"),
        "pre-delete output leaked onto MCP stdout:\n{}",
        deleted.stdout
    );
    assert!(
        !deleted.stdout.contains("pre-delete"),
        "pre-delete status leaked onto MCP stdout:\n{}",
        deleted.stdout
    );
    assert!(
        deleted.stderr.contains("PRE_STDOUT"),
        "pre-delete output should be on stderr:\n{}",
        deleted.stderr
    );
    assert!(
        deleted.stdout.contains("deleted"),
        "delete tool should still return JSON:\n{}\n{}",
        deleted.stdout,
        deleted.stderr
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

#[test]
fn exec_preserves_the_child_exit_code() {
    let repo = Repo::new();
    let created = repo.phantom(&["create", "feature/exec"]);
    assert!(created.status.success(), "{}", text(&created.stderr));
    let output = repo.phantom(&["exec", "feature/exec", "--", "sh", "-c", "exit 4"]);
    assert_eq!(output.status.code(), Some(4));
    assert!(text(&output.stderr).contains("failed with exit code 4"));
}
