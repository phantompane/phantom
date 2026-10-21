use std::fs;
use std::path::Path;

use serde::Deserialize;

use crate::error::{Error, Result};

const FILE_NAME: &str = ".mabo.toml";

#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct MaboConfig {
    pub hooks: Hooks,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(default, deny_unknown_fields, rename_all = "kebab-case")]
pub struct Hooks {
    pub setup: Vec<String>,
    pub pre_remove: Vec<String>,
}

pub fn load_config(git_root: &Path) -> Result<Option<MaboConfig>> {
    let path = git_root.join(FILE_NAME);
    let content = match fs::read_to_string(&path) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(Error::msg(format!(
                "Failed to read {}: {error}",
                path.display()
            )));
        }
    };
    parse_config(&content)
        .map(Some)
        .map_err(|error| Error::msg(format!("{}: {error}", path.display())))
}

pub fn setup_commands(config: Option<&MaboConfig>) -> &[String] {
    match config {
        Some(config) => &config.hooks.setup,
        None => &[],
    }
}

pub fn pre_remove_commands(config: Option<&MaboConfig>) -> &[String] {
    match config {
        Some(config) => &config.hooks.pre_remove,
        None => &[],
    }
}

fn parse_config(content: &str) -> Result<MaboConfig> {
    let document = content
        .parse::<toml_edit::DocumentMut>()
        .map_err(|error| Error::msg(format!("Invalid {FILE_NAME}: {error}")))?;
    if let Some(hooks) = document
        .get("hooks")
        .and_then(toml_edit::Item::as_table_like)
    {
        let renamed = [("post-create", "setup"), ("pre-delete", "pre-remove")]
            .into_iter()
            .filter(|(old, _)| hooks.contains_key(old))
            .map(|(old, new)| format!("rename [hooks] {old} to {new}"))
            .collect::<Vec<_>>();
        if !renamed.is_empty() {
            return Err(Error::msg(format!(
                "Invalid {FILE_NAME}: {}",
                renamed.join("; ")
            )));
        }
    }
    toml_edit::de::from_str(content)
        .map_err(|error| Error::msg(format!("Invalid {FILE_NAME}: {error}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_project_hooks() {
        let config = parse_config(
            r#"
# repository hooks
[hooks]
setup = ["pnpm install"]
pre-remove = ["./scripts/teardown.sh"]
"#,
        )
        .expect("config");
        assert_eq!(config.hooks.setup, vec!["pnpm install".to_string()]);
        assert_eq!(
            config.hooks.pre_remove,
            vec!["./scripts/teardown.sh".to_string()]
        );
    }

    #[test]
    fn missing_hooks_are_empty() {
        let config = parse_config("").expect("empty");
        assert!(config.hooks.setup.is_empty());
        assert!(config.hooks.pre_remove.is_empty());

        let config = parse_config("[hooks]\nsetup = [\"pnpm install\"]\n").expect("partial");
        assert_eq!(config.hooks.setup, vec!["pnpm install".to_string()]);
        assert!(config.hooks.pre_remove.is_empty());
        assert!(setup_commands(None).is_empty());
        assert!(pre_remove_commands(None).is_empty());
    }

    #[test]
    fn rejects_unknown_keys_and_wrong_types() {
        let error = parse_config("worktreesDirectory = \"../phantom-worktrees\"\n")
            .expect_err("project directory");
        let message = error.to_string();
        assert!(message.contains(FILE_NAME), "{message}");
        assert!(message.contains("worktreesDirectory"), "{message}");

        let error =
            parse_config("directoryNameSeparator = \"-\"\n").expect_err("project separator");
        assert!(
            error.to_string().contains("directoryNameSeparator"),
            "{error}"
        );

        let error = parse_config("[hooks]\ncopy-files = [\".env\"]\n").expect_err("copy files");
        let message = error.to_string();
        assert!(message.contains("copy-files"), "{message}");

        let error = parse_config("[hooks]\nsetup = \"pnpm install\"\n").expect_err("type");
        let message = error.to_string();
        assert!(
            message.contains("invalid type") || message.contains("setup"),
            "{message}"
        );
    }

    #[test]
    fn load_config_reports_the_file_and_the_problem() {
        let root = std::env::temp_dir().join(format!(
            "phantom-config-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        fs::create_dir_all(&root).expect("root");
        assert!(load_config(&root).expect("missing").is_none());

        fs::write(root.join(FILE_NAME), "[\n").expect("toml");
        let error = load_config(&root).expect_err("invalid toml");
        let message = error.to_string();
        assert!(message.contains(FILE_NAME), "{message}");
        assert!(
            message.contains("parse")
                || message.contains("expected")
                || message.contains("invalid"),
            "{message}"
        );

        fs::write(
            root.join(FILE_NAME),
            "[hooks]\npostCreate = [\"pnpm install\"]\n",
        )
        .expect("schema");
        let error = load_config(&root).expect_err("unknown key");
        let message = error.to_string();
        assert!(message.contains(FILE_NAME), "{message}");
        assert!(message.contains("postCreate"), "{message}");

        let _ = fs::remove_dir_all(root);
    }
}
