use std::fs;
use std::path::{Path, PathBuf};

use toml_edit::{DocumentMut, Item, Value};

use crate::error::{Error, Result};
use crate::paths;

pub const SUPPORTED_KEYS: &[&str] = &[
    "worktrees-directory",
    "directory-name-separator",
    "keep-branch",
    "ghq-discovery",
    "root",
];

const NEW_FILE_COMMENT: &str =
    "# mabo user preferences. `mabo preferences` reads and writes this file.\n";

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Preferences {
    pub worktrees_directory: Option<String>,
    pub directory_name_separator: Option<String>,
    pub keep_branch: Option<bool>,
    pub ghq_discovery: Option<bool>,
    pub root: Option<String>,
}

pub fn is_preference_key(value: &str) -> bool {
    SUPPORTED_KEYS.contains(&value)
}

pub fn preference_value(preferences: &Preferences, key: &str) -> Option<String> {
    match key {
        "worktrees-directory" => preferences.worktrees_directory.clone(),
        "directory-name-separator" => preferences.directory_name_separator.clone(),
        "keep-branch" => preferences.keep_branch.map(|value| value.to_string()),
        "ghq-discovery" => preferences.ghq_discovery.map(|value| value.to_string()),
        "root" => preferences.root.clone(),
        _ => None,
    }
}

pub fn validate_preference_value(key: &str, value: &str) -> Option<String> {
    if is_bool_key(key) && value != "true" && value != "false" {
        Some(format!("Preference '{key}' must be 'true' or 'false'"))
    } else if key == "root" && !is_root_preference(value) {
        Some("Preference 'root' must be an absolute path or start with ~/".to_string())
    } else {
        None
    }
}

fn is_root_preference(value: &str) -> bool {
    let value = value.trim();
    value == "~" || value.starts_with("~/") || Path::new(value).is_absolute()
}

pub fn config_path() -> Result<PathBuf> {
    paths::user_config_path()
}

pub fn load_preferences() -> Result<Preferences> {
    load_preferences_from(&config_path()?)
}

pub fn set_preference(key: &str, value: &str) -> Result<PathBuf> {
    let path = config_path()?;
    set_preference_at(&path, key, value)?;
    Ok(path)
}

pub fn remove_preference(key: &str) -> Result<PathBuf> {
    let path = config_path()?;
    remove_preference_at(&path, key)?;
    Ok(path)
}

fn load_preferences_from(path: &Path) -> Result<Preferences> {
    let Some(document) = read_document(path)? else {
        return Ok(Preferences::default());
    };
    preferences_from(&document, path)
}

fn set_preference_at(path: &Path, key: &str, value: &str) -> Result<()> {
    require_key(key)?;
    if let Some(message) = validate_preference_value(key, value) {
        return Err(Error::msg(message));
    }
    let existing = read_document(path)?;
    let created = existing.is_none();
    let mut document = match existing {
        Some(document) => {
            preferences_from(&document, path)?;
            document
        }
        None => DocumentMut::new(),
    };
    assign(&mut document, key, toml_value(key, value));
    write_document(path, &document, created)
}

fn remove_preference_at(path: &Path, key: &str) -> Result<()> {
    require_key(key)?;
    let Some(mut document) = read_document(path)? else {
        return Err(not_set(path, key));
    };
    preferences_from(&document, path)?;
    if document.remove(key).is_none() {
        return Err(not_set(path, key));
    }
    write_document(path, &document, false)
}

fn read_document(path: &Path) -> Result<Option<DocumentMut>> {
    match fs::read_to_string(path) {
        Ok(content) => content
            .parse::<DocumentMut>()
            .map(Some)
            .map_err(|error| Error::msg(format!("Failed to parse {}: {error}", path.display()))),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(Error::msg(format!(
            "Failed to read {}: {error}",
            path.display()
        ))),
    }
}

fn write_document(path: &Path, document: &DocumentMut, prepend_header: bool) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            Error::msg(format!("Failed to create {}: {error}", parent.display()))
        })?;
    }
    let body = document.to_string();
    let contents = if prepend_header {
        format!("{NEW_FILE_COMMENT}{body}")
    } else {
        body
    };
    crate::atomic::write(path, contents.as_bytes())
        .map_err(|error| Error::msg(format!("Failed to write {}: {error}", path.display())))
}

fn preferences_from(document: &DocumentMut, path: &Path) -> Result<Preferences> {
    let mut preferences = Preferences::default();
    for (key, item) in document.iter() {
        if item.is_none() {
            continue;
        }
        match key {
            "worktrees-directory" => {
                preferences.worktrees_directory = Some(require_string(path, key, item)?);
            }
            "directory-name-separator" => {
                preferences.directory_name_separator = Some(require_string(path, key, item)?);
            }
            "keep-branch" => preferences.keep_branch = Some(require_bool(path, key, item)?),
            "ghq-discovery" => preferences.ghq_discovery = Some(require_bool(path, key, item)?),
            "root" => preferences.root = Some(require_string(path, key, item)?),
            _ => return Err(unknown_file_key(path, key)),
        }
    }
    Ok(preferences)
}

fn require_string(path: &Path, key: &str, item: &Item) -> Result<String> {
    item.as_str()
        .map(str::to_string)
        .ok_or_else(|| invalid_value(path, key, "a string"))
}

fn require_bool(path: &Path, key: &str, item: &Item) -> Result<bool> {
    item.as_bool()
        .ok_or_else(|| invalid_value(path, key, "a boolean"))
}

fn assign(document: &mut DocumentMut, key: &str, new_value: Value) {
    if let Some(existing) = document.get_mut(key).and_then(Item::as_value_mut) {
        let decor = existing.decor().clone();
        *existing = new_value;
        *existing.decor_mut() = decor;
        return;
    }
    document[key] = toml_edit::value(new_value);
}

fn toml_value(key: &str, value: &str) -> Value {
    if is_bool_key(key) {
        Value::from(value == "true")
    } else {
        Value::from(value)
    }
}

fn is_bool_key(key: &str) -> bool {
    matches!(key, "keep-branch" | "ghq-discovery")
}

fn unknown_file_key(path: &Path, key: &str) -> Error {
    Error::msg(format!(
        "Unknown key '{key}' in {}. Supported keys: {}",
        path.display(),
        SUPPORTED_KEYS.join(", ")
    ))
}

fn invalid_value(path: &Path, key: &str, expected: &str) -> Error {
    Error::msg(format!(
        "Invalid value for '{key}' in {}: expected {expected}",
        path.display()
    ))
}

fn not_set(path: &Path, key: &str) -> Error {
    Error::msg(format!(
        "Preference '{key}' is not set in {}",
        path.display()
    ))
}

pub fn unknown_key_message(key: &str) -> String {
    format!(
        "Unknown preference '{key}'. Supported keys: {}",
        SUPPORTED_KEYS.join(", ")
    )
}

pub fn require_key(key: &str) -> Result<()> {
    if is_preference_key(key) {
        Ok(())
    } else {
        Err(Error::msg(unknown_key_message(key)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn xdg_config(label: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "mabo-preferences-{label}-{}-{nanos}",
            std::process::id()
        ))
    }

    #[test]
    fn round_trip_preserves_comments_under_xdg_config_home() {
        let xdg = xdg_config("round-trip");
        let path = xdg.join("maboroshi").join("config.toml");
        assert!(!path.exists());

        set_preference_at(&path, "keep-branch", "true").expect("set");
        let created = fs::read_to_string(&path).expect("created");
        assert!(created.starts_with("# mabo user preferences"), "{created}");
        assert!(created.contains("keep-branch = true\n"), "{created}");
        assert!(!created.contains("keepBranch"), "{created}");
        assert!(!created.contains("\"true\""), "{created}");

        let commented = "\
# header stays

# keep the branch
keep-branch = true # inline

# separator
directory-name-separator = \"/\"
";
        fs::write(&path, commented).expect("seed");
        set_preference_at(&path, "keep-branch", "false").expect("update");
        set_preference_at(&path, "worktrees-directory", "../phantom-worktrees").expect("directory");
        let updated = fs::read_to_string(&path).expect("updated");
        assert!(updated.contains("# header stays"), "{updated}");
        assert!(updated.contains("# keep the branch"), "{updated}");
        assert!(updated.contains("# inline"), "{updated}");
        assert!(updated.contains("# separator"), "{updated}");
        assert!(updated.contains("keep-branch = false"), "{updated}");
        assert!(
            updated.contains("directory-name-separator = \"/\""),
            "{updated}"
        );
        assert!(
            updated.contains("worktrees-directory = \"../phantom-worktrees\""),
            "{updated}"
        );

        let loaded = load_preferences_from(&path).expect("load");
        assert_eq!(loaded.keep_branch, Some(false));
        assert_eq!(loaded.directory_name_separator.as_deref(), Some("/"));
        assert_eq!(
            loaded.worktrees_directory.as_deref(),
            Some("../phantom-worktrees")
        );
        assert_eq!(
            preference_value(&loaded, "keep-branch").as_deref(),
            Some("false")
        );

        remove_preference_at(&path, "keep-branch").expect("remove");
        let removed = fs::read_to_string(&path).expect("removed");
        assert!(!removed.contains("keep-branch"), "{removed}");
        assert!(removed.contains("# separator"), "{removed}");
        assert!(
            removed.contains("directory-name-separator = \"/\""),
            "{removed}"
        );
        assert!(
            removed.contains("worktrees-directory = \"../phantom-worktrees\""),
            "{removed}"
        );
        let loaded = load_preferences_from(&path).expect("load after remove");
        assert_eq!(loaded.keep_branch, None);

        let _ = fs::remove_dir_all(xdg);
    }

    #[test]
    fn invalid_toml_and_unknown_keys_name_the_file() {
        let xdg = xdg_config("invalid");
        let path = xdg.join("maboroshi").join("config.toml");
        fs::create_dir_all(path.parent().expect("parent")).expect("dir");

        fs::write(&path, "{\n").expect("toml");
        let error = load_preferences_from(&path).expect_err("parse");
        let message = error.to_string();
        assert!(message.contains(&path.display().to_string()), "{message}");
        assert!(
            message.contains("parse") || message.contains("TOML"),
            "{message}"
        );

        fs::write(&path, "editor = \"code\"\nkeepBranch = true\n").expect("unknown");
        let error = load_preferences_from(&path).expect_err("unknown");
        let message = error.to_string();
        assert!(message.contains("editor"), "{message}");
        assert!(message.contains(&path.display().to_string()), "{message}");
        assert!(message.contains("worktrees-directory"), "{message}");

        fs::write(&path, "keep-branch = \"yes\"\n").expect("type");
        let error = load_preferences_from(&path).expect_err("type");
        let message = error.to_string();
        assert!(message.contains("keep-branch"), "{message}");
        assert!(message.contains("boolean"), "{message}");
        assert!(message.contains(&path.display().to_string()), "{message}");

        fs::write(&path, "worktrees-directory = true\n").expect("string type");
        let error = set_preference_at(&path, "ghq-discovery", "false").expect_err("blocked");
        assert!(
            error.to_string().contains(&path.display().to_string()),
            "{error}"
        );
        let unchanged = fs::read_to_string(&path).expect("unchanged");
        assert!(
            unchanged.contains("worktrees-directory = true"),
            "{unchanged}"
        );
        assert!(!unchanged.contains("ghq-discovery"), "{unchanged}");

        fs::write(&path, "keepBranch = true\n").expect("legacy");
        let error = load_preferences_from(&path).expect_err("legacy key");
        let message = error.to_string();
        assert!(message.contains("keepBranch"), "{message}");
        assert!(message.contains(&path.display().to_string()), "{message}");

        fs::write(&path, "keep-branch = true\n").expect("valid");
        let missing = remove_preference_at(&path, "ghq-discovery").expect_err("missing key");
        let message = missing.to_string();
        assert!(message.contains("not set"), "{message}");
        assert!(message.contains(&path.display().to_string()), "{message}");
        let still = fs::read_to_string(&path).expect("still");
        assert!(still.contains("keep-branch = true"), "{still}");

        let _ = fs::remove_dir_all(xdg);
    }

    #[test]
    fn missing_file_is_empty_and_remove_does_not_create_it() {
        let xdg = xdg_config("missing");
        let path = xdg.join("maboroshi").join("config.toml");
        let loaded = load_preferences_from(&path).expect("missing");
        assert_eq!(loaded, Preferences::default());
        let error = remove_preference_at(&path, "keep-branch").expect_err("remove");
        assert!(
            error.to_string().contains(&path.display().to_string()),
            "{error}"
        );
        assert!(!path.exists());
        let error = set_preference_at(&path, "keep-branch", "yes").expect_err("bool");
        assert!(error.to_string().contains("true"), "{error}");
        assert!(!path.exists());
        let _ = fs::remove_dir_all(xdg);
    }

    #[test]
    fn camel_case_keys_are_unknown() {
        let error = require_key("keepBranch").expect_err("legacy");
        let message = error.to_string();
        assert!(message.contains("keepBranch"), "{message}");
        assert!(message.contains("keep-branch"), "{message}");
        assert!(message.contains("worktrees-directory"), "{message}");
    }

    #[test]
    fn root_preference_is_an_absolute_or_tilde_path() {
        let xdg = xdg_config("root");
        let path = xdg.join("maboroshi").join("config.toml");
        let error = set_preference_at(&path, "root", "relative").expect_err("relative");
        assert!(error.to_string().contains("absolute"), "{error}");
        assert!(!path.exists());

        set_preference_at(&path, "root", "~/ghq").expect("set");
        let loaded = load_preferences_from(&path).expect("load");
        assert_eq!(loaded.root.as_deref(), Some("~/ghq"));
        assert_eq!(preference_value(&loaded, "root").as_deref(), Some("~/ghq"));
        let _ = fs::remove_dir_all(xdg);
    }
}
