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
pub mod git;
pub mod github;
pub mod help;
pub mod mcp;
pub mod names;
pub mod paths;
pub mod preferences;
pub mod process;
pub mod projects;
pub mod tmux;
pub mod worktree;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

pub fn version_line() -> String {
    let sha = option_env!("PHANTOM_GIT_SHA").filter(|sha| !sha.is_empty());
    format_version(VERSION, sha)
}

fn format_version(version: &str, sha: Option<&str>) -> String {
    match sha {
        Some(sha) => format!("Phantom v{version}+rust ({sha})"),
        None => format!("Phantom v{version}+rust"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_line_marks_the_rust_build() {
        assert_eq!(format_version("6.3.2", None), "Phantom v6.3.2+rust");
        assert_eq!(
            format_version("6.3.2", Some("abc1234")),
            "Phantom v6.3.2+rust (abc1234)"
        );
        assert_ne!(format_version("6.3.2", None), "Phantom v6.3.2");
    }
}
