use std::path::{Path, PathBuf};

use crate::config::{self, PhantomConfig};
use crate::error::Result;
use crate::paths;
use crate::preferences::{self, Preferences};

#[derive(Debug, Clone)]
pub struct Context {
    pub git_root: PathBuf,
    pub worktrees_directory: PathBuf,
    pub directory_name_separator: String,
    pub config: Option<PhantomConfig>,
    pub preferences: Preferences,
}

pub fn create(git_root: &Path) -> Result<Context> {
    let config = config::load_config(git_root);
    let preferences = preferences::load_preferences()?;
    let configured_directory = preferences.worktrees_directory.clone().or_else(|| {
        config
            .as_ref()
            .and_then(|config| config.worktrees_directory.clone())
    });
    let separator = preferences
        .directory_name_separator
        .clone()
        .filter(|value| !value.is_empty())
        .or_else(|| {
            config
                .as_ref()
                .and_then(|config| config.directory_name_separator.clone())
                .filter(|value| !value.is_empty())
        })
        .unwrap_or_else(|| "/".to_string());
    Ok(Context {
        git_root: git_root.to_path_buf(),
        worktrees_directory: paths::worktrees_directory(git_root, configured_directory.as_deref()),
        directory_name_separator: separator,
        config,
        preferences,
    })
}
