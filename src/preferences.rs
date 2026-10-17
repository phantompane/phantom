use crate::error::{Error, Result};
use crate::git;

pub const SUPPORTED_KEYS: &[&str] = &[
    "ai",
    "worktreesDirectory",
    "directoryNameSeparator",
    "keepBranch",
    "ghqDiscovery",
];

#[derive(Debug, Clone, Default)]
pub struct Preferences {
    pub ai: Option<String>,
    pub worktrees_directory: Option<String>,
    pub directory_name_separator: Option<String>,
    pub keep_branch: Option<bool>,
    pub ghq_discovery: Option<bool>,
}

pub fn is_preference_key(value: &str) -> bool {
    SUPPORTED_KEYS.contains(&value)
}

pub fn config_key(key: &str) -> String {
    format!("phantom.{key}")
}

pub fn preference_value(preferences: &Preferences, key: &str) -> Option<String> {
    match key {
        "ai" => preferences.ai.clone(),
        "worktreesDirectory" => preferences.worktrees_directory.clone(),
        "directoryNameSeparator" => preferences.directory_name_separator.clone(),
        "keepBranch" => preferences.keep_branch.map(|value| value.to_string()),
        "ghqDiscovery" => preferences.ghq_discovery.map(|value| value.to_string()),
        _ => None,
    }
}

pub fn validate_preference_value(key: &str, value: &str) -> Option<String> {
    if matches!(key, "keepBranch" | "ghqDiscovery") && value != "true" && value != "false" {
        Some(format!("Preference '{key}' must be 'true' or 'false'"))
    } else {
        None
    }
}

pub fn load_preferences() -> Result<Preferences> {
    let stdout = git::config_get_regexp_global("^phantom\\.")?;
    Ok(parse_preferences(&stdout))
}

pub fn parse_preferences(output: &str) -> Preferences {
    let mut preferences = Preferences::default();
    if output.is_empty() {
        return preferences;
    }
    for record in output.split('\0').filter(|record| !record.is_empty()) {
        let separator = record.find('\n').or_else(|| record.find(' '));
        let Some(separator) = separator else {
            continue;
        };
        let key = &record[..separator];
        let value = &record[separator + 1..];
        let Some(stripped) = key.strip_prefix("phantom.") else {
            continue;
        };
        match stripped.to_ascii_lowercase().as_str() {
            "ai" => preferences.ai = Some(value.to_string()),
            "worktreesdirectory" => preferences.worktrees_directory = Some(value.to_string()),
            "directorynameseparator" => {
                preferences.directory_name_separator = Some(value.to_string());
            }
            "keepbranch" => preferences.keep_branch = parse_bool(value),
            "ghqdiscovery" => preferences.ghq_discovery = parse_bool(value),
            _ => {}
        }
    }
    preferences
}

fn parse_bool(value: &str) -> Option<bool> {
    match value {
        "true" => Some(true),
        "false" => Some(false),
        _ => None,
    }
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

    #[test]
    fn parses_null_separated_git_config() {
        let parsed = parse_preferences(
            "phantom.worktreesDirectory\n.phantom\0phantom.keepBranch\ntrue\0phantom.editor\ncode\0",
        );
        assert_eq!(parsed.worktrees_directory.as_deref(), Some(".phantom"));
        assert_eq!(parsed.keep_branch, Some(true));
        assert!(parsed.ai.is_none());
    }
}
