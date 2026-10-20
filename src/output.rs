//! One JSON document per invocation, including errors propagated by shared helpers.
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

pub(crate) fn set_json(json: bool) {
    OUTPUT.with_borrow_mut(|out| out.json = json);
}

pub(crate) fn command_is_exec() -> bool {
    OUTPUT.with_borrow(|out| out.command == "exec")
}

pub(crate) fn json() -> bool {
    OUTPUT.with_borrow(|out| out.json)
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

pub(crate) fn failure(error: JsonErrorBody) {
    OUTPUT.with_borrow_mut(|out| out.error = Some(error));
}

pub(crate) fn warning(code: &str, message: impl Into<String>) {
    let message = message.into();
    eprintln!("{message}");
    OUTPUT.with_borrow_mut(|out| {
        out.warnings.push(Warning {
            code: code.into(),
            message,
        })
    });
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
