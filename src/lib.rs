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
