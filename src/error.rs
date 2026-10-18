pub const SUCCESS: i32 = 0;
pub const GENERAL: i32 = 1;
pub const NOT_FOUND: i32 = 2;
pub const VALIDATION: i32 = 3;
pub const NOT_REPOSITORY: i32 = 4;

/// Schema version for machine-readable `--json` output.
///
/// Worktree commands and `--json` errors use this version. `project list --json`
/// keeps its own catalog version. Parsers must ignore unknown fields.
pub const JSON_VERSION: u32 = 1;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{0}")]
    Message(String),
    #[error("{0}")]
    Validation(String),
    #[error("Worktree '{0}' not found")]
    WorktreeNotFound(String),
    #[error("Worktree '{0}' already exists")]
    WorktreeAlreadyExists(String),
    #[error("Branch '{0}' not found")]
    BranchNotFound(String),
    #[error("Not a git repository. Run ptm from inside a Git repository.")]
    NotARepository,
    #[error(
        "Worktree '{name}' has uncommitted changes ({files} files). Use --force to delete anyway."
    )]
    Uncommitted { name: String, files: usize },
    #[error("Command '{command}' failed with exit code {code}")]
    CommandFailed { command: String, code: i32 },
    #[error("Command terminated by signal: {0}")]
    Signaled(String),
    #[error("Error executing command '{command}': {details}")]
    Spawn { command: String, details: String },
    #[error("{0}")]
    Projects(String),
}

impl Error {
    pub fn msg(message: impl Into<String>) -> Self {
        Self::Message(message.into())
    }

    pub fn exit_code(&self) -> i32 {
        match self {
            Self::CommandFailed { code, .. } => *code,
            Self::Signaled(name) => 128 + i32::from(name == "SIGTERM").saturating_mul(14) + 1,
            Self::NotARepository => NOT_REPOSITORY,
            Self::Validation(_) => VALIDATION,
            _ => GENERAL,
        }
    }

    pub fn to_json(&self, exit_code: i32) -> JsonError {
        JsonError {
            version: JSON_VERSION,
            error: JsonErrorBody {
                message: self.to_string(),
                code: self.json_code(exit_code).to_string(),
                exit_code,
            },
        }
    }

    pub fn json_code(&self, exit_code: i32) -> &'static str {
        match self {
            Self::WorktreeNotFound(_) => "not_found",
            Self::WorktreeAlreadyExists(_) => "already_exists",
            Self::BranchNotFound(_) => "branch_not_found",
            Self::NotARepository => "not_repository",
            Self::Uncommitted { .. } => "uncommitted",
            Self::CommandFailed { .. } => "command_failed",
            Self::Signaled(_) => "signaled",
            Self::Spawn { .. } => "spawn",
            Self::Projects(_) => "projects",
            Self::Validation(_) => "validation",
            Self::Message(_) => match exit_code {
                NOT_FOUND => "not_found",
                VALIDATION => "validation",
                NOT_REPOSITORY => "not_repository",
                _ => "error",
            },
        }
    }
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JsonError {
    pub version: u32,
    pub error: JsonErrorBody,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JsonErrorBody {
    pub message: String,
    pub code: String,
    pub exit_code: i32,
}

pub type Result<T> = std::result::Result<T, Error>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn json_error_codes_follow_the_error_kind() {
        let missing = Error::WorktreeNotFound("topic".to_string());
        let document = missing.to_json(NOT_FOUND);
        assert_eq!(document.version, JSON_VERSION);
        assert_eq!(document.error.code, "not_found");
        assert_eq!(document.error.exit_code, NOT_FOUND);
        assert!(document.error.message.contains("topic"));

        assert_eq!(
            Error::WorktreeAlreadyExists("topic".to_string()).json_code(VALIDATION),
            "already_exists"
        );
        assert_eq!(
            Error::BranchNotFound("topic".to_string()).json_code(NOT_FOUND),
            "branch_not_found"
        );
        assert_eq!(
            Error::NotARepository.json_code(NOT_REPOSITORY),
            "not_repository"
        );
        assert_eq!(
            Error::Uncommitted {
                name: "topic".to_string(),
                files: 1,
            }
            .json_code(VALIDATION),
            "uncommitted"
        );
        assert_eq!(
            Error::msg("Usage: ptm where <worktree-name>").json_code(VALIDATION),
            "validation"
        );
        assert_eq!(Error::msg("boom").json_code(GENERAL), "error");
        let value = serde_json::to_value(document).expect("json");
        assert_eq!(value["error"]["exitCode"], NOT_FOUND);
        assert!(value["error"].get("exit_code").is_none());
    }
}
