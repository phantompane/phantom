#![cfg_attr(
    not(test),
    deny(
        clippy::unwrap_used,
        clippy::expect_used,
        clippy::panic,
        clippy::todo,
        clippy::unimplemented,
        clippy::unreachable,
    )
)]

pub mod args;
pub mod cli;
pub mod config;
pub mod context;
pub mod error;
pub mod gc;
pub mod git;
pub mod github;
pub mod help;
pub mod metadata;
pub mod names;
pub mod operation;
mod output;
pub mod paths;
pub mod preferences;
pub mod process;
pub mod projects;
pub mod repository;
mod runtime;
pub mod sync;
mod tracking;
pub mod trust;
pub mod worktree;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

pub fn version_line() -> String {
    let sha = option_env!("MABO_GIT_SHA").filter(|sha| !sha.is_empty());
    format_version(VERSION, sha)
}

fn format_version(version: &str, sha: Option<&str>) -> String {
    match sha {
        Some(sha) => format!("mabo v{version}+rust ({sha})"),
        None => format!("mabo v{version}+rust"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_line_marks_the_rust_build() {
        assert_eq!(
            format_version("7.0.0-alpha.6", None),
            "mabo v7.0.0-alpha.6+rust"
        );
        assert_eq!(
            format_version("7.0.0-alpha.6", Some("abc1234")),
            "mabo v7.0.0-alpha.6+rust (abc1234)"
        );
        assert_ne!(format_version("7.0.0-alpha.6", None), "mabo v7.0.0-alpha.6");
    }
}
