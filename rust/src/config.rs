use std::fs;
use std::path::Path;

use serde::Deserialize;

use crate::error::{Error, Result};

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PhantomConfig {
    pub worktrees_directory: Option<String>,
    pub directory_name_separator: Option<String>,
    pub post_create: Option<PostCreate>,
    pub pre_delete: Option<PreDelete>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PostCreate {
    #[serde(default)]
    pub copy_files: Option<Vec<String>>,
    #[serde(default)]
    pub commands: Option<Vec<String>>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreDelete {
    #[serde(default)]
    pub commands: Option<Vec<String>>,
}

pub fn load_config(git_root: &Path) -> Option<PhantomConfig> {
    let path = git_root.join("phantom.config.json");
    let content = fs::read_to_string(path).ok()?;
    validate_config(&content).ok()
}

pub fn validate_config(content: &str) -> Result<PhantomConfig> {
    let value: serde_json::Value = serde_json::from_str(content)
        .map_err(|error| Error::msg(format!("Failed to parse phantom.config.json: {error}")))?;
    validate_value(&value, "")?;
    serde_json::from_value(value)
        .map_err(|error| Error::msg(format!("Invalid phantom.config.json: {error}")))
}

fn validate_value(value: &serde_json::Value, path: &str) -> Result<()> {
    let object = value.as_object().ok_or_else(|| {
        Error::msg(format!(
            "Invalid phantom.config.json: {}",
            if path.is_empty() {
                "Expected object".to_string()
            } else {
                format!("{path}: Expected object")
            }
        ))
    })?;
    for (key, child) in object {
        let child_path = if path.is_empty() {
            key.clone()
        } else {
            format!("{path}.{key}")
        };
        match key.as_str() {
            "worktreesDirectory" | "directoryNameSeparator" => {
                if !child.is_string() {
                    return Err(Error::msg(format!(
                        "Invalid phantom.config.json: {child_path}: Expected string"
                    )));
                }
            }
            "postCreate" | "preDelete" => validate_hooks(child, &child_path)?,
            _ => {}
        }
    }
    Ok(())
}

fn validate_hooks(value: &serde_json::Value, path: &str) -> Result<()> {
    let object = value.as_object().ok_or_else(|| {
        Error::msg(format!(
            "Invalid phantom.config.json: {path}: Expected object"
        ))
    })?;
    for (key, child) in object {
        if matches!(key.as_str(), "copyFiles" | "commands") && !is_string_array(child) {
            return Err(Error::msg(format!(
                "Invalid phantom.config.json: {path}.{key}: Expected array"
            )));
        }
    }
    Ok(())
}

fn is_string_array(value: &serde_json::Value) -> bool {
    value
        .as_array()
        .is_some_and(|items| items.iter().all(serde_json::Value::is_string))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_project_config() {
        let config = validate_config(
            r#"{"worktreesDirectory":"../phantom-worktrees","postCreate":{"copyFiles":[".env"],"commands":["pnpm install"]}}"#,
        )
        .expect("config");
        assert_eq!(
            config.worktrees_directory.as_deref(),
            Some("../phantom-worktrees")
        );
        assert_eq!(
            config.post_create.and_then(|post| post.copy_files),
            Some(vec![".env".to_string()])
        );
    }

    #[test]
    fn rejects_bad_copy_files() {
        let error = validate_config(r#"{"postCreate":{"copyFiles":[1]}}"#).expect_err("invalid");
        assert!(error.to_string().contains("copyFiles"));
    }
}
