#![cfg_attr(
    not(test),
    deny(
        clippy::disallowed_macros,
        clippy::unwrap_used,
        clippy::expect_used,
        clippy::panic,
        clippy::todo,
        clippy::unimplemented,
        clippy::unreachable,
    )
)]

use std::process::ExitCode;

fn main() -> ExitCode {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    match mabo::cli::run(&args) {
        Ok(code) => ExitCode::from(u8::try_from(code).unwrap_or(1)),
        Err(error) => {
            let code = u8::try_from(error.exit_code()).unwrap_or(1);
            mabo::output::stderr(format_args!("Error: {error}\n"));
            ExitCode::from(code)
        }
    }
}
