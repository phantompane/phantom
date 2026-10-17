use std::fs;
use std::path::PathBuf;
use std::process::Command;

struct Script {
    _dir: PathBuf,
    path: PathBuf,
}

fn completion_script(shell: &str) -> Script {
    let output = Command::new(env!("CARGO_BIN_EXE_phantom"))
        .args(["completion", shell])
        .output()
        .expect("completion");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let dir = std::env::temp_dir().join(format!(
        "phantom-completion-{shell}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock")
            .as_nanos()
    ));
    fs::create_dir_all(&dir).expect("dir");
    let path = dir.join(format!("phantom.{shell}"));
    fs::write(&path, &output.stdout).expect("write");
    let embedded = fs::read_to_string(
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(format!("completions/phantom.{shell}")),
    )
    .expect("embedded");
    let stdout = String::from_utf8(output.stdout).expect("utf8");
    assert_eq!(stdout, format!("{embedded}\n"));
    Script { _dir: dir, path }
}

impl Drop for Script {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self._dir);
    }
}

fn lines(stdout: &str) -> Vec<String> {
    stdout
        .trim()
        .lines()
        .filter(|line| !line.is_empty())
        .map(|line| line.split('\t').next().unwrap_or(line).to_string())
        .collect()
}

fn shell_json(words: &[&str]) -> String {
    words
        .iter()
        .map(|word| serde_json::to_string(word).expect("json"))
        .collect::<Vec<_>>()
        .join(" ")
}

fn bash(script: &Script, words: &[&str], setup: &str) -> Vec<String> {
    let index = words.len().saturating_sub(1);
    let current = words.get(index).copied().unwrap_or("");
    let previous = if index == 0 { "" } else { words[index - 1] };
    let command = format!(
        r#"
set -e
shopt -s progcomp
source {script}
{setup}
_init_completion() {{
  cur={current}
  prev={previous}
  words=({words})
  cword={index}
  return 0
}}
COMP_WORDS=({words})
COMP_CWORD={index}
_phantom_completion
printf '%s\n' "${{COMPREPLY[@]}}"
"#,
        script = serde_json::to_string(script.path.to_str().expect("path")).expect("json"),
        setup = setup,
        current = serde_json::to_string(current).expect("json"),
        previous = serde_json::to_string(previous).expect("json"),
        words = shell_json(words),
        index = index,
    );
    let output = Command::new("bash")
        .args(["-lc", &command])
        .output()
        .expect("bash");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    lines(&String::from_utf8_lossy(&output.stdout))
}

fn zsh(script: &Script, words: &[&str]) -> Vec<String> {
    let index = words.len().saturating_sub(1);
    let arguments = shell_json(&words[1..words.len().saturating_sub(1)]);
    let command = format!(
        r#"
set -e
compdef() {{ return 0; }}
_arguments() {{
  if [[ "$1" == "-C" ]]; then
    if (( CURRENT <= 2 )); then state="command"; else state="args"; fi
    line=({arguments})
    return 0
  fi
  local spec option choices
  for spec in "$@"; do
    case "$spec" in
      [0-9]*:*:\(*\))
        choices="${{spec##*:\(}}"
        choices="${{choices%\)}}"
        completions+=(${{(z)choices}})
        ;;
      --*|'('*--*)
        option="${{spec%%\[*}}"
        option="${{option##*)}}"
        completions+=("$option")
        ;;
    esac
  done
  return 0
}}
_describe() {{
  local array_name=$2
  local -a items
  items=(${{(P)array_name[@]}})
  for item in "${{items[@]}}"; do completions+=("${{item%%:*}}"); done
  return 0
}}
_command_names() {{ return 0; }}
_files() {{ return 0; }}
source {script}
words=({words})
CURRENT={current}
BUFFER={buffer}
completions=()
_phantom
printf '%s\n' "${{completions[@]}}"
"#,
        arguments = arguments,
        script = serde_json::to_string(script.path.to_str().expect("path")).expect("json"),
        words = shell_json(words),
        current = index + 1,
        buffer = serde_json::to_string(&words.join(" ")).expect("json"),
    );
    let output = Command::new("zsh")
        .args(["-lc", &command])
        .output()
        .expect("zsh");
    assert!(
        output.status.success(),
        "zsh failed\nstderr:\n{}\nscript:\n{command}",
        String::from_utf8_lossy(&output.stderr)
    );
    lines(&String::from_utf8_lossy(&output.stdout))
}

fn fish(script: &Script, words: &[&str], setup: &str) -> Vec<String> {
    let command = format!(
        "source {script}\n{setup}\ncomplete -C{buffer}\n",
        script = serde_json::to_string(script.path.to_str().expect("path")).expect("json"),
        setup = setup,
        buffer = serde_json::to_string(&words.join(" ")).expect("json"),
    );
    let output = Command::new("fish")
        .args(["-c", &command])
        .output()
        .expect("fish");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    lines(&String::from_utf8_lossy(&output.stdout))
}

#[test]
fn bash_completion_matches_the_command_surface() {
    let script = completion_script("bash");
    let version = bash(&script, &["phantom", "v"], "");
    assert!(version.iter().any(|item| item == "version"), "{version:?}");
    let shells = bash(&script, &["phantom", "s"], "");
    assert!(shells.iter().any(|item| item == "shell"), "{shells:?}");
    assert!(!shells.iter().any(|item| item == "serve"));
    assert!(bash(&script, &["phantom", "p"], "")
        .iter()
        .any(|item| item == "project"));
    let project = bash(&script, &["phantom", "project", ""], "");
    for name in ["add", "list", "remove"] {
        assert!(project.iter().any(|item| item == name), "{project:?}");
    }
    let flags = bash(&script, &["phantom", "project", "list", "--"], "");
    for flag in ["--json", "--names", "--paths"] {
        assert!(flags.iter().any(|item| item == flag), "{flags:?}");
    }
    for selected in ["--json", "--names", "--paths"] {
        let offered = bash(&script, &["phantom", "project", "list", selected, "--"], "");
        for flag in ["--json", "--names", "--paths"] {
            assert!(!offered.iter().any(|item| item == flag), "{offered:?}");
        }
    }
    for subcommand in ["add", "remove"] {
        let offered = bash(&script, &["phantom", "project", subcommand, "--j"], "");
        assert!(offered.iter().any(|item| item == "--json"), "{offered:?}");
    }
    let directories = bash(
        &script,
        &["phantom", "project", "add", ""],
        "_filedir() { COMPREPLY=(demo-repository/); }\n",
    );
    assert!(directories.iter().any(|item| item == "demo-repository/"));
    let preferences = bash(&script, &["phantom", "preferences", "set", "ghqD"], "");
    assert!(
        preferences.iter().any(|item| item == "ghqDiscovery"),
        "{preferences:?}"
    );
    let exec = bash(
        &script,
        &["phantom", "exec", "demo-worktree", "dummycmd", "--from"],
        "_dummy_complete() { COMPREPLY=(--from-dummy); }\ncomplete -F _dummy_complete dummycmd\n",
    );
    assert!(exec.iter().any(|item| item == "--from-dummy"), "{exec:?}");
}

#[test]
fn zsh_completion_matches_the_command_surface() {
    let script = completion_script("zsh");
    let version = zsh(&script, &["phantom", "v"]);
    assert!(version.iter().any(|item| item == "version"), "{version:?}");
    let shells = zsh(&script, &["phantom", "s"]);
    assert!(shells.iter().any(|item| item == "shell"), "{shells:?}");
    assert!(!shells.iter().any(|item| item == "serve"));
    assert!(zsh(&script, &["phantom", "p"])
        .iter()
        .any(|item| item == "project"));
    let project = zsh(&script, &["phantom", "project", ""]);
    for name in ["add", "list", "remove"] {
        assert!(project.iter().any(|item| item == name), "{project:?}");
    }
    let flags = zsh(&script, &["phantom", "project", "list", "--"]);
    for flag in ["--json", "--names", "--paths"] {
        assert!(flags.iter().any(|item| item == flag), "{flags:?}");
    }
    for subcommand in ["add", "remove"] {
        let offered = zsh(&script, &["phantom", "project", subcommand, "--j"]);
        assert!(offered.iter().any(|item| item == "--json"), "{offered:?}");
    }
    let preferences = zsh(&script, &["phantom", "preferences", "set", "ghqD"]);
    assert!(
        preferences.iter().any(|item| item == "ghqDiscovery"),
        "{preferences:?}"
    );
}

#[test]
fn fish_completion_matches_the_command_surface() {
    let script = completion_script("fish");
    let version = fish(&script, &["phantom", "v"], "");
    assert!(version.iter().any(|item| item == "version"), "{version:?}");
    let shells = fish(&script, &["phantom", "s"], "");
    assert!(shells.iter().any(|item| item == "shell"), "{shells:?}");
    assert!(!shells.iter().any(|item| item == "serve"));
    assert!(fish(&script, &["phantom", "p"], "")
        .iter()
        .any(|item| item == "project"));
    let project = fish(&script, &["phantom", "project", ""], "");
    for name in ["add", "list", "remove"] {
        assert!(project.iter().any(|item| item == name), "{project:?}");
    }
    let flags = fish(&script, &["phantom", "project", "list", "--"], "");
    for flag in ["--json", "--names", "--paths"] {
        assert!(flags.iter().any(|item| item == flag), "{flags:?}");
    }
    for selected in ["--json", "--names", "--paths"] {
        let offered = fish(&script, &["phantom", "project", "list", selected, "--"], "");
        for flag in ["--json", "--names", "--paths"] {
            assert!(!offered.iter().any(|item| item == flag), "{offered:?}");
        }
    }
    for subcommand in ["add", "remove"] {
        let offered = fish(&script, &["phantom", "project", subcommand, "--j"], "");
        assert!(offered.iter().any(|item| item == "--json"), "{offered:?}");
    }
    let preferences = fish(&script, &["phantom", "preferences", "set", "ghqD"], "");
    assert!(
        preferences.iter().any(|item| item == "ghqDiscovery"),
        "{preferences:?}"
    );
    let exec = fish(
        &script,
        &["phantom", "exec", "demo-worktree", "dummycmd", "--from"],
        "complete -c dummycmd -l from-dummy -d \"Dummy option\"\n",
    );
    assert!(exec.iter().any(|item| item == "--from-dummy"), "{exec:?}");
}
