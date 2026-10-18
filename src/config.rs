use std::fs;
use std::path::Path;

use serde::Deserialize;

use crate::error::{Error, Result};

const FILE_NAME: &str = ".ptm.toml";

#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct PtmConfig {
    pub hooks: Hooks,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(default, deny_unknown_fields, rename_all = "kebab-case")]
pub struct Hooks {
    pub post_create: Vec<String>,
    pub pre_delete: Vec<String>,
}

pub fn load_config(git_root: &Path) -> Result<Option<PtmConfig>> {
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

pub fn post_create_commands(config: Option<&PtmConfig>) -> &[String] {
    match config {
        Some(config) => &config.hooks.post_create,
        None => &[],
    }
}

pub fn pre_delete_commands(config: Option<&PtmConfig>) -> &[String] {
    match config {
        Some(config) => &config.hooks.pre_delete,
        None => &[],
    }
}

fn parse_config(content: &str) -> Result<PtmConfig> {
    toml::from_str(content).map_err(|error| Error::msg(format!("Invalid {FILE_NAME}: {error}")))
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
post-create = ["pnpm install"]
pre-delete = ["./scripts/teardown.sh"]
"#,
        )
        .expect("config");
        assert_eq!(config.hooks.post_create, vec!["pnpm install".to_string()]);
        assert_eq!(
            config.hooks.pre_delete,
            vec!["./scripts/teardown.sh".to_string()]
        );
    }

    #[test]
    fn missing_hooks_are_empty() {
        let config = parse_config("").expect("empty");
        assert!(config.hooks.post_create.is_empty());
        assert!(config.hooks.pre_delete.is_empty());

        let config = parse_config("[hooks]\npost-create = [\"pnpm install\"]\n").expect("partial");
        assert_eq!(config.hooks.post_create, vec!["pnpm install".to_string()]);
        assert!(config.hooks.pre_delete.is_empty());
        assert!(post_create_commands(None).is_empty());
        assert!(pre_delete_commands(None).is_empty());
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

        let error = parse_config("[hooks]\npost-create = \"pnpm install\"\n").expect_err("type");
        let message = error.to_string();
        assert!(
            message.contains("invalid type") || message.contains("post-create"),
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
