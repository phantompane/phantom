use std::path::Path;

use crate::error::{Error, Result};
use crate::process;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TmuxDirection {
    New,
    Vertical,
    Horizontal,
}

pub fn inside_tmux() -> bool {
    std::env::var("TMUX").is_ok()
}

pub fn open_shell(
    direction: TmuxDirection,
    cwd: &Path,
    env: &[(String, String)],
    window_name: Option<&str>,
) -> Result<()> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
    let mut tmux_args = Vec::new();
    match direction {
        TmuxDirection::New => {
            tmux_args.push("new-window".to_string());
            if let Some(name) = window_name {
                tmux_args.push("-n".to_string());
                tmux_args.push(name.to_string());
            }
        }
        TmuxDirection::Vertical => {
            tmux_args.push("split-window".to_string());
            tmux_args.push("-v".to_string());
        }
        TmuxDirection::Horizontal => {
            tmux_args.push("split-window".to_string());
            tmux_args.push("-h".to_string());
        }
    }
    tmux_args.push("-c".to_string());
    tmux_args.push(cwd.display().to_string());
    for (key, value) in env {
        tmux_args.push("-e".to_string());
        tmux_args.push(format!("{key}={value}"));
    }
    tmux_args.push(shell);
    let refs = tmux_args.iter().map(String::as_str).collect::<Vec<_>>();
    let code = process::inherit("tmux", &refs, None, &[])?;
    if code == 0 {
        Ok(())
    } else {
        Err(Error::CommandFailed {
            command: "tmux".to_string(),
            code,
        })
    }
}

pub fn run_command(
    direction: TmuxDirection,
    command: &str,
    args: &[&str],
    cwd: &Path,
    env: &[(String, String)],
    window_name: Option<&str>,
) -> Result<()> {
    let mut tmux_args = Vec::new();
    match direction {
        TmuxDirection::New => {
            tmux_args.push("new-window".to_string());
            if let Some(name) = window_name {
                tmux_args.push("-n".to_string());
                tmux_args.push(name.to_string());
            }
        }
        TmuxDirection::Vertical => {
            tmux_args.push("split-window".to_string());
            tmux_args.push("-v".to_string());
        }
        TmuxDirection::Horizontal => {
            tmux_args.push("split-window".to_string());
            tmux_args.push("-h".to_string());
        }
    }
    tmux_args.push("-c".to_string());
    tmux_args.push(cwd.display().to_string());
    for (key, value) in env {
        tmux_args.push("-e".to_string());
        tmux_args.push(format!("{key}={value}"));
    }
    tmux_args.push(command.to_string());
    tmux_args.extend(args.iter().map(|arg| (*arg).to_string()));
    let refs = tmux_args.iter().map(String::as_str).collect::<Vec<_>>();
    let code = process::inherit("tmux", &refs, None, &[])?;
    if code == 0 {
        Ok(())
    } else {
        Err(Error::CommandFailed {
            command: "tmux".to_string(),
            code,
        })
    }
}
