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
    #[error("Project '{0}' not found")]
    ProjectNotFound(String),
    #[error("Path '{0}' does not exist")]
    PathNotFound(String),
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

    /// Invalid command-line arguments. Every parser failure uses this so the
    /// exit code and JSON `code` stay `validation` / 3 for every subcommand.
    pub fn validation(message: impl Into<String>) -> Self {
        Self::Validation(message.into())
    }

    pub fn exit_code(&self) -> i32 {
        match self {
            Self::CommandFailed { code, .. } => *code,
            Self::Signaled(name) => 128 + signal_number(name),
            Self::NotARepository => NOT_REPOSITORY,
            Self::ProjectNotFound(_) | Self::PathNotFound(_) => NOT_FOUND,
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
            Self::WorktreeNotFound(_) | Self::ProjectNotFound(_) | Self::PathNotFound(_) => {
                "not_found"
            }
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

/// Conventional status for a process killed by `number`: `128` plus that signal.
fn signal_number(name: &str) -> i32 {
    match name {
        "SIGHUP" => 1,
        "SIGINT" => 2,
        "SIGQUIT" => 3,
        "SIGKILL" => 9,
        "SIGPIPE" => 13,
        "SIGTERM" => 15,
        other => other
            .strip_prefix("SIG")
            .and_then(|rest| rest.parse().ok())
            .unwrap_or(0),
    }
}

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
        let project = Error::ProjectNotFound("widget".to_string());
        assert_eq!(project.exit_code(), NOT_FOUND);
        assert_eq!(project.json_code(NOT_FOUND), "not_found");
        assert_eq!(project.to_string(), "Project 'widget' not found");
        let missing_path = Error::PathNotFound("/no/such".to_string());
        assert_eq!(missing_path.exit_code(), NOT_FOUND);
        assert_eq!(missing_path.json_code(NOT_FOUND), "not_found");
        assert_eq!(missing_path.to_string(), "Path '/no/such' does not exist");
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
        assert_eq!(Error::Signaled("SIGTERM".to_string()).exit_code(), 143);
        assert_eq!(Error::Signaled("SIGINT".to_string()).exit_code(), 130);
        assert_eq!(Error::Signaled("SIGKILL".to_string()).exit_code(), 137);
        assert_eq!(Error::Signaled("SIGHUP".to_string()).exit_code(), 129);
        assert_eq!(Error::Signaled("SIG13".to_string()).exit_code(), 141);
        let signaled = Error::Signaled("SIGINT".to_string());
        let signaled_json = signaled.to_json(signaled.exit_code());
        assert_eq!(signaled_json.error.code, "signaled");
        assert_eq!(signaled_json.error.exit_code, 130);
        let value = serde_json::to_value(document).expect("json");
        assert_eq!(value["error"]["exitCode"], NOT_FOUND);
        assert!(value["error"].get("exit_code").is_none());
    }
}
