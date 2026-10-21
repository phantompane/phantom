//! Shared diagnostics and one JSON document per invocation.
use std::cell::RefCell;

use serde::Serialize;
use serde_json::Value;

use crate::error::{Error, JsonErrorBody, Result};

#[derive(Default)]
struct Output {
    command: String,
    json: bool,
    data: Option<Value>,
    warnings: Vec<Warning>,
    error: Option<JsonErrorBody>,
    reported_errors: Vec<String>,
}

#[derive(Serialize)]
struct Warning {
    code: String,
    message: String,
}

thread_local! {
    static OUTPUT: RefCell<Output> = RefCell::new(Output::default());
}

pub(crate) fn begin(command: &str, json: bool) {
    OUTPUT.with_borrow_mut(|out| {
        *out = Output {
            command: command.into(),
            json,
            ..Output::default()
        }
    });
}

pub(crate) fn command_is_exec() -> bool {
    OUTPUT.with_borrow(|out| out.command == "exec")
}

pub(crate) fn json() -> bool {
    OUTPUT.with_borrow(|out| out.json)
}

#[cfg(test)]
pub(crate) fn test_data() -> Option<Value> {
    OUTPUT.with_borrow(|out| out.data.clone())
}

pub(crate) fn data(value: &impl Serialize) -> Result<i32> {
    let mut value = serde_json::to_value(value).map_err(|error| Error::msg(error.to_string()))?;
    if let Some(object) = value.as_object_mut() {
        object.remove("version");
        object.remove("schema");
        if let Some(error) = object.remove("error").filter(|error| !error.is_null()) {
            let body =
                serde_json::from_value(error).map_err(|error| Error::msg(error.to_string()))?;
            failure(body);
        }
    }
    OUTPUT.with_borrow_mut(|out| out.data = Some(value));
    Ok(0)
}

pub(crate) fn app_version(version: String) -> Result<i32> {
    OUTPUT.with_borrow_mut(|out| {
        out.data =
            Some(serde_json::json!({"version": env!("CARGO_PKG_VERSION"), "display": version}))
    });
    Ok(0)
}

pub(crate) fn failure(error: JsonErrorBody) {
    failure_with(error, |message| eprintln!("{message}"));
}

fn diagnostic_message(message: &str) -> &str {
    message
        .trim_start()
        .strip_prefix("Warning: ")
        .unwrap_or(message.trim_start())
}

fn failure_with(error: JsonErrorBody, report: impl FnOnce(&str)) {
    OUTPUT.with_borrow_mut(|out| {
        if !out.json && !out.reported_errors.contains(&error.message) {
            if !out.warnings.iter().any(|warning| {
                diagnostic_message(&warning.message) == diagnostic_message(&error.message)
            }) {
                let message = if error.code == "partial" {
                    format!("Warning: {}", error.message)
                } else {
                    error.message.clone()
                };
                // Outer commands may report opaque IO/Git errors containing paths.
                // Ambiguity reports escape each value where their list is built,
                // so their intentional line breaks can remain readable.
                if ((is_outer_command(&out.command) && error.code != "ambiguous")
                    || matches!(
                        out.command.as_str(),
                        "create" | "adopt" | "forget" | "setup"
                    ))
                    // Create partial errors contain an already shell-encoded retry
                    // command. Preserve it verbatim for execution in bash/zsh.
                    && !(out.command == "create" && error.code == "partial")
                {
                    report(&visible_text(&message));
                } else {
                    report(&message);
                }
            }
            out.reported_errors.push(error.message.clone());
        }
        out.error = Some(error);
    });
}

pub(crate) fn warning(code: &str, message: impl Into<String>) {
    let message = message.into();
    if code == "repo_discovery" {
        eprintln!("{}", visible_text(&message));
    } else {
        eprintln!("{message}");
    }
    OUTPUT.with_borrow_mut(|out| {
        out.warnings.push(Warning {
            code: code.into(),
            message,
        })
    });
}

/// Report a diagnostic only once in the invocation begun by `begin`.
pub(crate) fn warning_once(code: &str, message: impl Into<String>) {
    let message = message.into();
    let reported = OUTPUT.with_borrow(|out| {
        out.warnings
            .iter()
            .any(|warning| warning.code == code && warning.message == message)
    });
    if !reported {
        warning(code, message);
    }
}

pub(crate) fn finish(exit: i32) -> Result<()> {
    OUTPUT.with_borrow_mut(|out| {
        if !out.json {
            return Ok(());
        }
        if exit != 0 && out.error.is_none() {
            out.error = Some(
                Error::status(exit, "Command did not complete successfully")
                    .to_json(exit)
                    .error,
            );
        }
        if exit == crate::error::PARTIAL {
            if let Some(error) = &mut out.error {
                error.code = "partial".into();
            }
        }
        let document = serde_json::json!({
            "schema": crate::error::JSON_VERSION, "command": out.command, "ok": exit == 0,
            "data": out.data, "warnings": out.warnings, "error": out.error,
        });
        let text = serde_json::to_string_pretty(&document)
            .map_err(|error| Error::msg(error.to_string()))?;
        println!("{text}");
        Ok(())
    })
}

fn is_outer_command(command: &str) -> bool {
    matches!(
        command.split_whitespace().next(),
        Some("repo" | "trust" | "config" | "help" | "--version")
    )
}

/// Values in diagnostics that provide their own trusted multiline layout.
pub(crate) fn diagnostic_value(value: &str) -> String {
    if json() {
        value.to_owned()
    } else {
        visible_text(value)
    }
}

/// Escape untrusted values before interpolating them into terminal output.
pub(crate) fn visible_text(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for ch in text.chars() {
        if hides_the_prompt(ch) {
            out.push_str(&format!("\\u{{{:x}}}", u32::from(ch)));
        } else {
            out.push(ch);
        }
    }
    out
}

fn hides_the_prompt(ch: char) -> bool {
    ch.is_control()
        || matches!(
            ch,
            '\u{00ad}'
                | '\u{061c}'
                | '\u{180e}'
                | '\u{200b}'..='\u{200f}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202a}'..='\u{202e}'
                | '\u{2060}'..='\u{2064}'
                | '\u{2066}'..='\u{2069}'
                | '\u{feff}'
                | '\u{fff9}'..='\u{fffb}'
        )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::{GENERAL, PARTIAL, REFUSED};

    #[test]
    fn warning_once_distinguishes_diagnostics_and_resets_per_invocation() {
        for json in [false, true] {
            for _ in 0..2 {
                begin("config list", json);
                warning_once("renamed", "Warning: first key");
                warning_once("renamed", "Warning: first key");
                warning_once("renamed", "Warning: second key");
                warning_once("removed", "Warning: first key");
                OUTPUT.with_borrow(|out| assert_eq!(out.warnings.len(), 3));
            }
        }
    }

    #[test]
    fn recorded_failures_are_reported_once_in_text_and_retained_in_json() {
        for json in [false, true] {
            for exit in [GENERAL, PARTIAL, REFUSED] {
                begin("test", json);
                // An unrelated warning must not hide a later error.
                OUTPUT.with_borrow_mut(|out| {
                    out.warnings.push(Warning {
                        code: "unrelated".into(),
                        message: "Warning: unrelated".into(),
                    })
                });
                let error = Error::status(exit, "injected failure").to_json(exit).error;
                let mut messages = Vec::new();
                for _ in 0..2 {
                    failure_with(error.clone(), |message| messages.push(message.to_string()));
                }
                assert_eq!(messages.len(), usize::from(!json));
                if !json {
                    assert!(messages[0].contains("injected failure"));
                }
                OUTPUT.with_borrow(|out| {
                    assert_eq!(out.error.as_ref().unwrap().message, "injected failure")
                });
            }
        }
    }

    #[test]
    fn an_already_reported_warning_is_not_printed_again_as_an_error() {
        begin("test", false);
        warning("setup", "Warning: setup failed");
        failure_with(
            Error::status(PARTIAL, "setup failed")
                .to_json(PARTIAL)
                .error,
            |_| panic!("the same diagnostic must not be printed twice"),
        );
        OUTPUT.with_borrow(|out| assert_eq!(out.error.as_ref().unwrap().code, "partial"));
    }
}
