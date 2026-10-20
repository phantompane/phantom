//! Invocation-scoped execution settings; never mutate the process environment.
use std::cell::Cell;
use std::io::IsTerminal;
use std::time::Duration;

use crate::error::{Error, Result};

thread_local! {
    static NO_INPUT: Cell<bool> = const { Cell::new(false) };
    static TIMEOUT: Cell<Option<Duration>> = const { Cell::new(None) };
    static HOOK: Cell<bool> = const { Cell::new(false) };
}

pub(crate) fn non_interactive() -> bool {
    NO_INPUT.get()
        || crate::output::json()
        || std::env::var_os("CI").is_some_and(|value| !value.is_empty())
        || std::env::var_os("MABO_NO_INPUT").is_some_and(|value| !value.is_empty() && value != "0")
        || !std::io::stdin().is_terminal()
        || !std::io::stderr().is_terminal()
}

pub(crate) fn timeout() -> Result<Duration> {
    match TIMEOUT.get() {
        Some(duration) => Ok(duration),
        None => match std::env::var("MABO_LOCK_TIMEOUT")
            .ok()
            .filter(|value| !value.is_empty())
        {
            Some(value) => parse_duration(&value),
            None => Ok(Duration::from_secs(30)),
        },
    }
}

pub(crate) fn parse_duration(value: &str) -> Result<Duration> {
    let (digits, factor) = if let Some(value) = value.strip_suffix("ms") {
        (value, 1)
    } else if let Some(value) = value.strip_suffix('s') {
        (value, 1000)
    } else if let Some(value) = value.strip_suffix('m') {
        (value, 60_000)
    } else {
        (value, 1000)
    };
    let invalid =
        || Error::validation("Invalid lock timeout; use 500ms, 30s, 2m, or integer seconds");
    if digits.is_empty() || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(invalid());
    }
    let count: u64 = digits.parse().map_err(|_| invalid())?;
    Ok(Duration::from_millis(
        count.checked_mul(factor).ok_or_else(invalid)?,
    ))
}

pub(crate) fn is_hook() -> bool {
    HOOK.get()
}
pub(crate) struct HookScope(bool);
pub(crate) fn hook_scope() -> HookScope {
    HookScope(HOOK.replace(true))
}
impl Drop for HookScope {
    fn drop(&mut self) {
        HOOK.set(self.0);
    }
}

/// Extract common options without consuming option values or user command argv.
/// Existing command parsers still validate their own options and positionals.
pub(crate) fn prepare(
    args: &[String],
    supports_json: bool,
    locks: bool,
    key: &str,
) -> Result<Vec<String>> {
    NO_INPUT.set(false);
    TIMEOUT.set(None);
    let mut remaining = Vec::new();
    let mut explicit = None;
    let mut names = false;
    let mut timeout = None;
    let mut error = None;
    let mut index = 0;
    while index < args.len() {
        let arg = &args[index];
        if arg == "--" || arg == "--exec" || arg == "-x" {
            remaining.extend_from_slice(&args[index..]);
            break;
        }
        let (name, inline) = arg
            .split_once('=')
            .map(|(a, b)| (a, Some(b)))
            .unwrap_or((arg.as_str(), None));
        match name {
            "--no-input" if inline.is_none() => NO_INPUT.set(true),
            "--json" if inline.is_none() => {
                explicit = Some(true);
                crate::output::set_json(supports_json);
            }
            "--output" | "--lock-timeout" => {
                let value = match inline {
                    Some(value) => value,
                    None => {
                        index += 1;
                        let Some(value) = args.get(index).map(String::as_str) else {
                            error.get_or_insert_with(|| {
                                Error::validation(format!("Option '{name}' argument missing"))
                            });
                            break;
                        };
                        value
                    }
                };
                if name == "--output" {
                    match value {
                        "json" => explicit = Some(true),
                        "text" => explicit = Some(false),
                        _ => {
                            error.get_or_insert_with(|| {
                                Error::validation("Invalid output mode; use text or json")
                            });
                        }
                    }
                } else {
                    if !locks {
                        error.get_or_insert_with(|| {
                            Error::validation("This command does not accept --lock-timeout")
                        });
                    }
                    match parse_duration(value) {
                        Ok(duration) => timeout = Some(duration),
                        Err(invalid) => {
                            error.get_or_insert(invalid);
                        }
                    }
                }
            }

            _ => {
                if name == "--names" || name == "--paths" {
                    names = true;
                }
                remaining.push(arg.clone());
                if takes_value(name) && !(key == "gc" && name == "--pr") && inline.is_none() {
                    if let Some(value) = args.get(index + 1) {
                        remaining.push(value.clone());
                        index += 1;
                    }
                } else if key == "exec" && !arg.starts_with('-') {
                    remaining.extend_from_slice(&args[index + 1..]);
                    break;
                }
            }
        }
        index += 1;
    }
    if !supports_json && explicit == Some(true) {
        return Err(Error::validation(
            "This command does not support JSON output",
        ));
    }
    // Validate the environment even when an explicit flag overrides its default.
    let env_json = if supports_json {
        match std::env::var("MABO_OUTPUT").ok().as_deref() {
            None | Some("") | Some("text") => false,
            Some("json") => true,
            _ => {
                error.get_or_insert_with(|| {
                    Error::validation("Invalid MABO_OUTPUT; use text or json")
                });
                false
            }
        }
    } else {
        false
    };
    let json = supports_json && explicit.unwrap_or(env_json && !names);
    crate::output::set_json(json);
    TIMEOUT.set(timeout);
    if let Some(error) = error {
        return Err(error);
    }
    if locks {
        self::timeout()?;
    }
    if json {
        remaining.insert(0, "--json".into());
    }
    Ok(remaining)
}

fn takes_value(name: &str) -> bool {
    matches!(
        name,
        "--project"
            | "-p"
            | "--base"
            | "--copy-file"
            | "--owner"
            | "--purpose"
            | "--pr"
            | "--issue"
            | "--older-than"
            | "--branch"
            | "--depth"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lock_durations_are_bounded_and_do_not_accept_ambiguous_units() {
        for (input, millis) in [
            ("500ms", 500),
            ("30s", 30_000),
            ("2m", 120_000),
            ("3", 3000),
            ("0", 0),
        ] {
            assert_eq!(parse_duration(input).unwrap().as_millis(), millis);
        }
        for input in ["", "-1", "1.5s", "10h", "ms", "18446744073709551615m"] {
            assert_eq!(
                parse_duration(input).unwrap_err().exit_code(),
                crate::error::VALIDATION
            );
        }
    }
}
