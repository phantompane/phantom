use std::path::{Component, Path, PathBuf};

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
}
