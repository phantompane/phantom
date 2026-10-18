use std::path::{Path, PathBuf};

use crate::config::{self, PtmConfig};
use crate::error::Result;
use crate::git;
use crate::paths;
use crate::preferences::{self, Preferences};

#[derive(Debug, Clone)]
pub struct Context {
    pub git_root: PathBuf,
    /// Checkout the command is running in. `.ptm.toml` is loaded from here.
    pub source_checkout: PathBuf,
    pub worktrees_directory: PathBuf,
    pub directory_name_separator: String,
    pub config: Option<PtmConfig>,
    pub preferences: Preferences,
}

pub fn create(git_root: &Path) -> Result<Context> {
    let source_checkout = git::source_checkout(git_root);
    let config = config::load_config(&source_checkout)?;
    let preferences = preferences::load_preferences()?;
    let separator = preferences
        .directory_name_separator
        .clone()
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "/".to_string());
    Ok(Context {
        git_root: git_root.to_path_buf(),
        source_checkout,
        worktrees_directory: paths::worktrees_directory(
            git_root,
            preferences.worktrees_directory.as_deref(),
        ),
        directory_name_separator: separator,
        config,
        preferences,
    })
}
