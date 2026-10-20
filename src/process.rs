use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::Duration;

use crate::error::{Error, Result};

#[derive(Debug)]
pub struct Captured {
    pub stdout: String,
    pub stderr: String,
    pub code: i32,
}

pub fn raw(command: &str, args: &[&str], cwd: Option<&Path>) -> Result<Captured> {
    raw_with_env(command, args, cwd, &[])
}

pub fn raw_with_env(
    command: &str,
    args: &[&str],
    cwd: Option<&Path>,
    env: &[(&str, &str)],
) -> Result<Captured> {
    let mut cmd = Command::new(command);
    cmd.args(args);
    for (key, value) in env {
        cmd.env(key, value);
    }
    if let Some(cwd) = cwd {
        cmd.current_dir(cwd);
    }
    crate::operation::configure_command(&mut cmd, command);
    let output = cmd.output().map_err(|error| spawn_error(command, &error))?;
    Ok(Captured {
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        code: output.status.code().unwrap_or(1),
    })
}

pub fn capture(
    command: &str,
    args: &[&str],
    cwd: Option<&Path>,
    trim_stdout: bool,
) -> Result<Captured> {
    let mut cmd = Command::new(command);
    cmd.args(args);
    if let Some(cwd) = cwd {
        cmd.current_dir(cwd);
    }
    crate::operation::configure_command(&mut cmd, command);
    let output = cmd.output().map_err(|error| spawn_error(command, &error))?;
    let stdout_raw = String::from_utf8_lossy(&output.stdout).into_owned();
    let stderr_raw = String::from_utf8_lossy(&output.stderr).into_owned();
    let code = output.status.code().unwrap_or(1);
    if output.status.success() {
        return Ok(Captured {
            stdout: if trim_stdout {
                stdout_raw.trim().to_string()
            } else {
                stdout_raw
            },
            stderr: stderr_raw.trim().to_string(),
            code,
        });
    }
    if !stderr_raw.trim().is_empty() {
        return Err(Error::msg(stderr_raw.trim().to_string()));
    }
    Ok(Captured {
        stdout: if trim_stdout {
            stdout_raw.trim().to_string()
        } else {
            stdout_raw
        },
        stderr: stderr_raw.trim().to_string(),
        code,
    })
}

pub fn inherit(
    command: &str,
    args: &[&str],
    cwd: Option<&Path>,
    env: &[(&str, &str)],
    redirect_stdout_to_stderr: bool,
) -> Result<i32> {
    let mut cmd = Command::new(command);
    cmd.args(args)
        .stdin(Stdio::inherit())
        .stderr(Stdio::inherit());
    if redirect_stdout_to_stderr {
        cmd.stdout(Stdio::from(std::io::stderr()));
    } else {
        cmd.stdout(Stdio::inherit());
    }
    if let Some(cwd) = cwd {
        cmd.current_dir(cwd);
    }
    for (key, value) in env {
        cmd.env(key, value);
    }
    crate::operation::configure_command(&mut cmd, command);
    let status = cmd.status().map_err(|error| spawn_error(command, &error))?;
    exit_code(command, status)
}

pub fn run_with_timeout(command: &str, args: &[&str], timeout: Duration) -> Result<Captured> {
    let mut cmd = Command::new(command);
    cmd.args(args).stdout(Stdio::piped()).stderr(Stdio::piped());
    crate::operation::configure_command(&mut cmd, command);
    let mut child = cmd.spawn().map_err(|error| spawn_error(command, &error))?;
    let started = std::time::Instant::now();
    loop {
        if let Some(status) = child
            .try_wait()
            .map_err(|error| Error::msg(error.to_string()))?
        {
            let mut stdout = String::new();
            let mut stderr = String::new();
            if let Some(mut pipe) = child.stdout.take() {
                pipe.read_to_string(&mut stdout)
                    .map_err(|error| Error::msg(error.to_string()))?;
            }
            if let Some(mut pipe) = child.stderr.take() {
                pipe.read_to_string(&mut stderr)
                    .map_err(|error| Error::msg(error.to_string()))?;
            }
            return Ok(Captured {
                stdout,
                stderr,
                code: status.code().unwrap_or(1),
            });
        }
        if started.elapsed() > timeout {
            let _ = child.kill();
            let _ = child.wait();
            return Err(Error::msg(format!(
                "Failed to discover ghq repositories: timed out after {} ms",
                timeout.as_millis()
            )));
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn exit_code(command: &str, status: std::process::ExitStatus) -> Result<i32> {
    if let Some(code) = status.code() {
        return Ok(code);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        if let Some(signal) = status.signal() {
            let name = signal_name(signal);
            return Err(Error::Signaled(name));
        }
    }
    Err(Error::Spawn {
        command: command.to_string(),
        details: "process exited without a status".to_string(),
    })
}

fn signal_name(signal: i32) -> String {
    match signal {
        15 => "SIGTERM".to_string(),
        2 => "SIGINT".to_string(),
        9 => "SIGKILL".to_string(),
        1 => "SIGHUP".to_string(),
        other => format!("SIG{other}"),
    }
}

fn spawn_error(command: &str, error: &std::io::Error) -> Error {
    if error.kind() == std::io::ErrorKind::NotFound {
        return Error::Spawn {
            command: command.to_string(),
            details: "ENOENT".to_string(),
        };
    }
    Error::Spawn {
        command: command.to_string(),
        details: error.to_string(),
    }
}
