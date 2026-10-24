//! CLI adapters: argv, session extraction and final-answer files only.
#![allow(dead_code)]

use std::fs;
use std::path::Path;
use std::process::{Command, Stdio};

use crate::error::{Error, Result};
use crate::workflow::{Agent, Mode, Provider};

pub(crate) fn supported(provider: Provider) -> Result<()> {
    match provider {
        Provider::Codex => Ok(()),
        Provider::Claude | Provider::Cursor => Err(Error::msg(format!(
            "Provider {provider:?} is not supported yet"
        ))),
    }
}

pub(crate) fn codex(
    agent: &Agent,
    mode: &Mode,
    workspace: &Path,
    dir: &Path,
    session: Option<&str>,
) -> Result<Command> {
    supported(agent.provider)?;
    let mut command = Command::new("codex");
    // exec-level flags must precede resume, which has no -C or --sandbox.
    command.args(["exec", "--json", "-C"]);
    command.arg(workspace).args([
        "--sandbox",
        match mode {
            Mode::ReadOnly => "read-only",
            Mode::Edit => "workspace-write",
        },
    ]);
    if matches!(mode, Mode::Edit) {
        // Agents commit their own work. A linked workspace keeps its index and
        // objects in the common Git directory, outside the workspace root.
        command
            .arg("--add-dir")
            .arg(crate::git::git_common_dir(workspace)?);
    }
    if let Some(model) = &agent.model {
        command.args(["-m", model]);
    }
    if let Some(effort) = &agent.effort {
        // JSON strings are also TOML basic strings, including escaped quotes.
        let quoted =
            serde_json::to_string(effort).map_err(|error| Error::msg(error.to_string()))?;
        command.args(["-c", &format!("model_reasoning_effort={quoted}")]);
    }
    command.arg("-o").arg(dir.join("answer.md"));
    if let Some(session) = session {
        command.args(["resume", session]);
    }
    command.arg("-").current_dir(workspace);
    command.stdin(Stdio::from(
        fs::File::open(dir.join("prompt.md")).map_err(|error| Error::msg(error.to_string()))?,
    ));
    Ok(command)
}

pub(crate) fn session_id(stdout: &Path) -> Result<String> {
    use std::io::{BufRead, BufReader};
    let file = fs::File::open(stdout).map_err(|error| Error::msg(error.to_string()))?;
    for line in BufReader::new(file).lines() {
        let line = line.map_err(|error| Error::msg(error.to_string()))?;
        if let Ok(event) = serde_json::from_str::<serde_json::Value>(&line) {
            if event["type"] == "thread.started" {
                if let Some(id) = event["thread_id"].as_str().filter(|id| !id.is_empty()) {
                    return Ok(id.to_owned());
                }
            }
        }
    }
    Err(Error::msg("Codex did not report thread.started.thread_id"))
}
