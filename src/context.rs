use std::path::{Path, PathBuf};

use crate::config::{self, MaboConfig};
use crate::error::{Error, Result};
use crate::git;
use crate::paths;
use crate::preferences::{self, Preferences};

#[derive(Debug, Clone)]
pub struct Context {
    pub git_root: PathBuf,
    /// Checkout the command is running in. `.mabo.toml` is loaded from here.
    pub source_checkout: PathBuf,
    pub worktrees_directory: PathBuf,
    /// Canonical git common dir when `worktrees_directory` is the default
    /// project directory. Unset when `workspace-root` overrides it.
    pub project_common_dir: Option<PathBuf>,
    pub directory_name_separator: String,
    pub config: Option<MaboConfig>,
    pub preferences: Preferences,
}

pub fn create(git_root: &Path) -> Result<Context> {
    assemble(git_root, git::source_checkout(git_root))
}

/// Context for a repository selected with `--repo`.
///
/// Hooks and included files are read from that repository's main checkout.
pub fn create_at(git_root: &Path) -> Result<Context> {
    assemble(git_root, git_root.to_path_buf())
}

/// Open `repository` when `--repo` selected one, otherwise the current directory.
pub fn open(repository: Option<&Path>) -> Result<Context> {
    if let Some(root) = repository {
        return create_at(root);
    }
    let cwd = std::env::current_dir().map_err(|error| Error::msg(error.to_string()))?;
    let git_root = git::git_root(&cwd)?;
    create(&git_root)
}

fn assemble(git_root: &Path, source_checkout: PathBuf) -> Result<Context> {
    let config = config::load_config(&source_checkout)?;
    let preferences = preferences::load_preferences()?;
    let common_dir = git::canonical_common_dir(git_root)?;
    let location = match preferences
        .worktrees_directory
        .as_deref()
        .filter(|value| !value.is_empty())
    {
        Some(directory) => {
            let expanded = if directory == "~" || directory.starts_with("~/") {
                let home = std::env::var_os("HOME")
                    .filter(|value| !value.is_empty())
                    .ok_or_else(|| Error::msg("HOME is not set"))?;
                PathBuf::from(home).join(directory.strip_prefix("~/").unwrap_or(""))
            } else {
                PathBuf::from(directory)
            };
            paths::configured_worktrees_directory(git_root, &expanded.to_string_lossy())
        }
        None => {
            let data_home = paths::data_home_from_env()?;
            paths::default_worktrees_directory(git_root, &common_dir, &data_home)
        }
    };
    Ok(Context {
        git_root: git_root.to_path_buf(),
        source_checkout,
        worktrees_directory: location.path,
        project_common_dir: location.project_common_dir,
        directory_name_separator: "/".to_string(),
        config,
        preferences,
    })
}
