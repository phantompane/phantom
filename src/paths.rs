use std::path::{Component, Path, PathBuf};

use crate::error::{Error, Result};

pub fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => match out.components().next_back() {
                Some(Component::Normal(_)) => {
                    out.pop();
                }
                Some(Component::RootDir) | Some(Component::Prefix(_)) => {}
                _ => out.push(".."),
            },
            Component::RootDir => out.push(component),
            Component::Normal(part) => out.push(part),
            Component::Prefix(prefix) => out.push(prefix.as_os_str()),
        }
    }
    out
}

pub fn relative(from: &Path, to: &Path) -> String {
    let from = normalize(from);
    let to = normalize(to);
    let from_components = from.components().collect::<Vec<_>>();
    let to_components = to.components().collect::<Vec<_>>();
    let mut shared = 0;
    while shared < from_components.len()
        && shared < to_components.len()
        && from_components[shared] == to_components[shared]
    {
        shared += 1;
    }
    let mut out = PathBuf::new();
    for component in &from_components[shared..] {
        if !matches!(component, Component::RootDir | Component::Prefix(_)) {
            out.push("..");
        }
    }
    for component in &to_components[shared..] {
        out.push(component.as_os_str());
    }
    if out.as_os_str().is_empty() {
        String::new()
    } else {
        out.to_string_lossy().replace('\\', "/")
    }
}

pub fn worktrees_directory(git_root: &Path, configured: Option<&str>) -> PathBuf {
    match configured.filter(|value| !value.is_empty()) {
        Some(directory) if Path::new(directory).is_absolute() => normalize(Path::new(directory)),
        Some(directory) => normalize(&git_root.join(directory)),
        None => normalize(&git_root.join(".git").join("phantom").join("worktrees")),
    }
}

pub fn worktree_path(directory: &Path, name: &str, separator: &str) -> PathBuf {
    let directory_name = if separator == "/" {
        name.to_string()
    } else {
        name.replace('/', separator)
    };
    normalize(&directory.join(directory_name))
}

/// `$XDG_CONFIG_HOME/ptm/config.toml`, or `~/.config/ptm/config.toml` when
/// `XDG_CONFIG_HOME` is unset, empty, or relative.
pub fn user_config_file(home: &Path, xdg_config_home: Option<&Path>) -> PathBuf {
    let config_home = match xdg_config_home {
        Some(path) if path.is_absolute() => path.to_path_buf(),
        _ => home.join(".config"),
    };
    ptm_config_file(&config_home)
}

pub fn user_config_path() -> Result<PathBuf> {
    if let Some(xdg) = absolute_xdg_config_home() {
        return Ok(ptm_config_file(&xdg));
    }
    let Some(home) = std::env::var_os("HOME").filter(|value| !value.is_empty()) else {
        return Err(Error::msg("HOME is not set"));
    };
    Ok(user_config_file(Path::new(&home), None))
}

fn ptm_config_file(config_home: &Path) -> PathBuf {
    config_home.join("ptm").join("config.toml")
}

fn absolute_xdg_config_home() -> Option<PathBuf> {
    let value = std::env::var_os("XDG_CONFIG_HOME")?;
    if value.is_empty() {
        return None;
    }
    let path = PathBuf::from(value);
    path.is_absolute().then_some(path)
}

pub fn is_strictly_inside(path: &Path, directory: &Path) -> bool {
    let relative_path = relative(directory, path);
    !relative_path.is_empty()
        && !relative_path.starts_with("..")
        && !Path::new(&relative_path).is_absolute()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relative_paths_match_node() {
        assert_eq!(relative(Path::new("/repo"), Path::new("/repo")), "");
        assert_eq!(
            relative(
                Path::new("/repo"),
                Path::new("/repo/.git/phantom/worktrees/listed")
            ),
            ".git/phantom/worktrees/listed"
        );
        assert_eq!(relative(Path::new("/repo/a"), Path::new("/repo/b")), "../b");
    }

    #[test]
    fn flattens_directory_names() {
        let path = worktree_path(Path::new("/tmp/worktrees"), "feature/test", "-");
        assert_eq!(path, PathBuf::from("/tmp/worktrees/feature-test"));
    }

    #[test]
    fn user_config_file_follows_xdg_config_home() {
        let home = Path::new("/home/phantom");
        let xdg = Path::new("/tmp/xdg");
        assert_eq!(
            user_config_file(home, Some(xdg)),
            PathBuf::from("/tmp/xdg/ptm/config.toml")
        );
        assert_eq!(
            user_config_file(home, None),
            PathBuf::from("/home/phantom/.config/ptm/config.toml")
        );
        assert_eq!(
            user_config_file(home, Some(Path::new("relative"))),
            PathBuf::from("/home/phantom/.config/ptm/config.toml")
        );
        assert_eq!(
            user_config_file(home, Some(Path::new(""))),
            PathBuf::from("/home/phantom/.config/ptm/config.toml")
        );
    }
}
