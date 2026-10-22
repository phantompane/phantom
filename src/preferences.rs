use std::fs;
use std::path::{Path, PathBuf};

use toml_edit::{DocumentMut, Item, Value};

use crate::error::{Error, Result};
use crate::paths;

pub const SUPPORTED_KEYS: &[&str] = &[
    "workspace-root",
    "discover-ghq",
    "clone-root",
    "sync.strategy",
    "sync.rewrite-published",
];

const NEW_FILE_COMMENT: &str = "# mabo user config. `mabo config` reads and writes this file.\n";

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Preferences {
    pub worktrees_directory: Option<String>,
    pub ghq_discovery: Option<bool>,
    pub root: Option<String>,
    pub sync_strategy: Option<String>,
    pub sync_rewrite_published: Option<bool>,
}

pub fn is_preference_key(value: &str) -> bool {
    SUPPORTED_KEYS.contains(&value)
}

pub fn preference_value(preferences: &Preferences, key: &str) -> Option<String> {
    match key {
        "workspace-root" => preferences.worktrees_directory.clone(),
        "discover-ghq" => preferences.ghq_discovery.map(|value| value.to_string()),
        "clone-root" => preferences.root.clone(),
        "sync.strategy" => preferences.sync_strategy.clone(),
        "sync.rewrite-published" => preferences
            .sync_rewrite_published
            .map(|value| value.to_string()),
        _ => None,
    }
}

#[derive(serde::Serialize)]
pub struct EffectiveValue {
    pub value: serde_json::Value,
    pub source: &'static str,
    pub detail: String,
}

pub fn effective_value(preferences: &Preferences, key: &str) -> Result<EffectiveValue> {
    require_key(key)?;
    if key == "clone-root" {
        let (path, source, detail) =
            crate::repository::clone_root_with_source(preferences.root.as_deref())?;
        return Ok(EffectiveValue {
            value: serde_json::json!(path),
            source,
            detail: detail.into(),
        });
    }
    let configured = preference_value(preferences, key).filter(|value| !value.is_empty());
    let source = if configured.is_some() {
        "config"
    } else {
        "default"
    };
    let value = match key {
        "sync.strategy" => {
            serde_json::json!(preferences.sync_strategy.as_deref().unwrap_or("auto"))
        }
        "sync.rewrite-published" => {
            serde_json::json!(preferences.sync_rewrite_published.unwrap_or(false))
        }
        "workspace-root" => serde_json::json!(configured),
        "discover-ghq" => serde_json::json!(preferences.ghq_discovery.unwrap_or(true)),
        _ => return Err(Error::validation(unknown_key_message(key))),
    };
    Ok(EffectiveValue {
        value,
        source,
        detail: if source == "config" {
            config_path()?.to_string_lossy().into_owned()
        } else {
            "built-in".into()
        },
    })
}

pub fn validate_preference_value(key: &str, value: &str) -> Option<String> {
    if is_bool_key(key) && value != "true" && value != "false" {
        Some(format!("Config key '{key}' must be 'true' or 'false'"))
    } else if key == "sync.strategy" && !matches!(value, "auto" | "rebase" | "merge") {
        Some("Config key 'sync.strategy' must be auto, rebase, or merge".into())
    } else if key == "clone-root" && !is_root_preference(value) {
        Some("Config key 'clone-root' must be an absolute path or start with ~/".to_string())
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
    require_key(key)?;
    if let Some(message) = validate_preference_value(key, value) {
        return Err(Error::validation(message));
    }
    let path = crate::migration::config_dir(crate::migration::Access::Write)?.join("config.toml");
    set_preference_at(&path, key, value)?;
    Ok(path)
}

pub fn remove_preference(key: &str) -> Result<PathBuf> {
    require_key(key)?;
    let path = crate::migration::config_dir(crate::migration::Access::Write)?.join("config.toml");
    remove_preference_at(&path, key)?;
    Ok(path)
}

fn load_preferences_from(path: &Path) -> Result<Preferences> {
    let Some(document) = read_document(path)? else {
        return Ok(Preferences::default());
    };
    let mut document = document;
    migrate_keys(&mut document);
    preferences_from(&document, path)
}

fn set_preference_at(path: &Path, key: &str, value: &str) -> Result<()> {
    require_key(key)?;
    if let Some(message) = validate_preference_value(key, value) {
        return Err(Error::validation(message));
    }
    let existing = read_document(path)?;
    let created = existing.is_none();
    let mut document = match existing {
        Some(mut document) => {
            migrate_keys(&mut document);
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
    migrate_keys(&mut document);
    preferences_from(&document, path)?;
    let removed = if let Some((table, field)) = key.split_once('.') {
        document
            .get_mut(table)
            .and_then(Item::as_table_like_mut)
            .and_then(|table| table.remove(field))
    } else {
        document.remove(key)
    };
    if removed.is_none() {
        return Err(not_set(path, key));
    }
    write_document(path, &document, false)
}

fn read_document(path: &Path) -> Result<Option<DocumentMut>> {
    match crate::migration::read_product_file(path, crate::migration::Layout::Config) {
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
            "workspace-root" => {
                preferences.worktrees_directory = Some(require_string(path, key, item)?);
            }
            "discover-ghq" => preferences.ghq_discovery = Some(require_bool(path, key, item)?),
            "clone-root" => preferences.root = Some(require_string(path, key, item)?),
            "sync" => {
                let table = item
                    .as_table_like()
                    .ok_or_else(|| Error::validation("Config sync must be a table"))?;
                for (field, value) in table.iter() {
                    match field {
                        "strategy" => {
                            let value = require_string(path, "sync.strategy", value)?;
                            if let Some(message) =
                                validate_preference_value("sync.strategy", &value)
                            {
                                return Err(Error::validation(message));
                            }
                            preferences.sync_strategy = Some(value);
                        }
                        "rewrite-published" => {
                            preferences.sync_rewrite_published =
                                Some(value.as_bool().ok_or_else(|| {
                                    Error::validation(
                                        "Config sync.rewrite-published must be a boolean",
                                    )
                                })?)
                        }
                        _ => return Err(unknown_file_key(path, &format!("sync.{field}"))),
                    }
                }
            }
            _ => return Err(unknown_file_key(path, key)),
        }
    }
    Ok(preferences)
}

const RENAMED_KEYS: &[(&str, &str)] = &[
    ("worktrees-directory", "workspace-root"),
    ("root", "clone-root"),
    ("ghq-discovery", "discover-ghq"),
];

fn migrate_keys(document: &mut DocumentMut) {
    for &(old, new) in RENAMED_KEYS {
        let renamed_key = document.as_table().get_key_value(old).map(|(key, _)| {
            toml_edit::Key::new(new)
                .with_leaf_decor(key.leaf_decor().clone())
                .with_dotted_decor(key.dotted_decor().clone())
        });
        if let Some(item) = document.remove(old) {
            crate::output::warning_once("config_key_renamed", format!(
                "Warning: config key '{old}' was renamed to '{new}'. Use `mabo config set {new} VALUE`; the next config write rewrites old keys. If both exist, '{new}' takes precedence."
            ));
            if !document.contains_key(new) {
                if let Some(key) = renamed_key {
                    document.as_table_mut().insert_formatted(&key, item);
                }
            }
        }
    }
    if document.remove("keep-branch").is_some() {
        crate::output::warning_once("config_key_removed", "Warning: config key 'keep-branch' was removed and is ignored. Use remove --keep-branch explicitly. The next config write removes this key.");
    }
    if document.remove("directory-name-separator").is_some() {
        crate::output::warning_once("config_key_removed", "Warning: config key 'directory-name-separator' was removed and is ignored. Workspace names use '/'. The next config write removes this key.");
    }
}

fn require_string(path: &Path, key: &str, item: &Item) -> Result<String> {
    item.as_str().map(str::to_string).ok_or_else(|| {
        if key == "sync.strategy" {
            Error::validation("Config sync.strategy must be auto, rebase, or merge")
        } else {
            invalid_value(path, key, "a string")
        }
    })
}

fn require_bool(path: &Path, key: &str, item: &Item) -> Result<bool> {
    item.as_bool()
        .ok_or_else(|| invalid_value(path, key, "a boolean"))
}

fn assign(document: &mut DocumentMut, key: &str, new_value: Value) {
    if let Some((table, field)) = key.split_once('.') {
        if document.get(table).is_none() {
            document[table] = Item::Table(toml_edit::Table::new());
        }
        if let Some(existing) = document[table].get_mut(field).and_then(Item::as_value_mut) {
            let decor = existing.decor().clone();
            *existing = new_value;
            *existing.decor_mut() = decor;
        } else {
            document[table][field] = toml_edit::value(new_value);
        }
        return;
    }
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
    matches!(key, "discover-ghq" | "sync.rewrite-published")
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
    Error::Status {
        code: "not_found",
        message: format!("Config key '{key}' is not set in {}", path.display()),
    }
}

pub fn unknown_key_message(key: &str) -> String {
    format!(
        "Unknown config key '{key}'. Supported keys: {}",
        SUPPORTED_KEYS.join(", ")
    )
}

pub fn require_key(key: &str) -> Result<()> {
    if is_preference_key(key) {
        Ok(())
    } else {
        Err(Error::validation(unknown_key_message(key)))
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
    fn stale_config_path_retries_after_migration() {
        let base = xdg_config("read-migration");
        let old = base.join("maboroshi");
        fs::create_dir_all(&old).unwrap();
        let file = old.join("config.toml");
        fs::write(&file, "discover-ghq = false\n").unwrap();
        crate::migration::product_dir(
            &base,
            crate::migration::Access::Write,
            crate::migration::Layout::Config,
        );
        assert!(!file.exists());
        assert_eq!(
            load_preferences_from(&file).unwrap().ghq_discovery,
            Some(false)
        );
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn round_trip_preserves_comments_under_xdg_config_home() {
        let xdg = xdg_config("round-trip");
        let path = xdg.join("mabo").join("config.toml");
        assert!(!path.exists());

        set_preference_at(&path, "discover-ghq", "true").expect("set");
        let created = fs::read_to_string(&path).expect("created");
        assert!(created.starts_with("# mabo user config"), "{created}");
        assert!(created.contains("discover-ghq = true\n"), "{created}");
        assert!(!created.contains("keepBranch"), "{created}");
        assert!(!created.contains("\"true\""), "{created}");

        let commented = "\
# header stays

# keep the branch
discover-ghq = true # inline

# separator
clone-root = \"~/clones\"
";
        fs::write(&path, commented).expect("seed");
        set_preference_at(&path, "discover-ghq", "false").expect("update");
        set_preference_at(&path, "workspace-root", "../phantom-worktrees").expect("directory");
        let updated = fs::read_to_string(&path).expect("updated");
        assert!(updated.contains("# header stays"), "{updated}");
        assert!(updated.contains("# keep the branch"), "{updated}");
        assert!(updated.contains("# inline"), "{updated}");
        assert!(updated.contains("# separator"), "{updated}");
        assert!(updated.contains("discover-ghq = false"), "{updated}");
        assert!(updated.contains("clone-root = \"~/clones\""), "{updated}");
        assert!(
            updated.contains("workspace-root = \"../phantom-worktrees\""),
            "{updated}"
        );

        let loaded = load_preferences_from(&path).expect("load");
        assert_eq!(loaded.ghq_discovery, Some(false));
        assert_eq!(loaded.root.as_deref(), Some("~/clones"));
        assert_eq!(
            loaded.worktrees_directory.as_deref(),
            Some("../phantom-worktrees")
        );
        assert_eq!(
            preference_value(&loaded, "discover-ghq").as_deref(),
            Some("false")
        );

        remove_preference_at(&path, "discover-ghq").expect("remove");
        let removed = fs::read_to_string(&path).expect("removed");
        assert!(!removed.contains("discover-ghq"), "{removed}");
        assert!(removed.contains("# separator"), "{removed}");
        assert!(removed.contains("clone-root"), "{removed}");
        assert!(
            removed.contains("workspace-root = \"../phantom-worktrees\""),
            "{removed}"
        );
        let loaded = load_preferences_from(&path).expect("load after remove");
        assert_eq!(loaded.ghq_discovery, None);

        let _ = fs::remove_dir_all(xdg);
    }

    #[test]
    fn invalid_toml_and_unknown_keys_name_the_file() {
        let xdg = xdg_config("invalid");
        let path = xdg.join("mabo").join("config.toml");
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
        assert!(message.contains("workspace-root"), "{message}");

        fs::write(&path, "discover-ghq = \"yes\"\n").expect("type");
        let error = load_preferences_from(&path).expect_err("type");
        let message = error.to_string();
        assert!(message.contains("discover-ghq"), "{message}");
        assert!(message.contains("boolean"), "{message}");
        assert!(message.contains(&path.display().to_string()), "{message}");

        fs::write(&path, "workspace-root = true\n").expect("string type");
        let error = set_preference_at(&path, "discover-ghq", "false").expect_err("blocked");
        assert!(
            error.to_string().contains(&path.display().to_string()),
            "{error}"
        );
        let unchanged = fs::read_to_string(&path).expect("unchanged");
        assert!(unchanged.contains("workspace-root = true"), "{unchanged}");
        assert!(!unchanged.contains("discover-ghq"), "{unchanged}");

        fs::write(&path, "keepBranch = true\n").expect("legacy");
        let error = load_preferences_from(&path).expect_err("legacy key");
        let message = error.to_string();
        assert!(message.contains("keepBranch"), "{message}");
        assert!(message.contains(&path.display().to_string()), "{message}");

        fs::write(&path, "discover-ghq = true\n").expect("valid");
        let missing = remove_preference_at(&path, "workspace-root").expect_err("missing key");
        let message = missing.to_string();
        assert!(message.contains("not set"), "{message}");
        assert!(message.contains(&path.display().to_string()), "{message}");
        let still = fs::read_to_string(&path).expect("still");
        assert!(still.contains("discover-ghq = true"), "{still}");

        let _ = fs::remove_dir_all(xdg);
    }

    #[test]
    fn missing_file_is_empty_and_remove_does_not_create_it() {
        let xdg = xdg_config("missing");
        let path = xdg.join("mabo").join("config.toml");
        let loaded = load_preferences_from(&path).expect("missing");
        assert_eq!(loaded, Preferences::default());
        let error = remove_preference_at(&path, "discover-ghq").expect_err("remove");
        assert!(
            error.to_string().contains(&path.display().to_string()),
            "{error}"
        );
        assert!(!path.exists());
        let error = set_preference_at(&path, "discover-ghq", "yes").expect_err("bool");
        assert!(error.to_string().contains("true"), "{error}");
        assert!(!path.exists());
        let _ = fs::remove_dir_all(xdg);
    }

    #[test]
    fn camel_case_keys_are_unknown() {
        let error = require_key("keepBranch").expect_err("legacy");
        let message = error.to_string();
        assert!(message.contains("keepBranch"), "{message}");
        assert!(message.contains("discover-ghq"), "{message}");
        assert!(message.contains("workspace-root"), "{message}");
    }

    #[test]
    fn root_preference_is_an_absolute_or_tilde_path() {
        let xdg = xdg_config("clone-root");
        let path = xdg.join("mabo").join("config.toml");
        let error = set_preference_at(&path, "clone-root", "relative").expect_err("relative");
        assert!(error.to_string().contains("absolute"), "{error}");
        assert!(!path.exists());

        set_preference_at(&path, "clone-root", "~/ghq").expect("set");
        let loaded = load_preferences_from(&path).expect("load");
        assert_eq!(loaded.root.as_deref(), Some("~/ghq"));
        assert_eq!(
            preference_value(&loaded, "clone-root").as_deref(),
            Some("~/ghq")
        );
        let _ = fs::remove_dir_all(xdg);
    }
}
