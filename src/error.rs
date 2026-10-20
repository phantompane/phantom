pub const SUCCESS: i32 = 0;
pub const GENERAL: i32 = 1;
pub const VALIDATION: i32 = 2;
pub const NOT_FOUND: i32 = 3;
pub const NOT_REPOSITORY: i32 = NOT_FOUND;
pub const REFUSED: i32 = 4;
pub const CONFLICT: i32 = 5;
pub const PARTIAL: i32 = 6;
pub const LOCK_TIMEOUT: i32 = 7;

/// Version of the common machine-readable envelope.
pub const JSON_VERSION: u32 = 2;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{message}")]
    Status { code: &'static str, message: String },
    #[error("Timed out waiting for lock {0}; another mabo is running")]
    LockTimeout(std::path::PathBuf),
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
    #[error("Not a git repository. Run mabo from inside a Git repository.")]
    NotARepository,
    #[error(
        "Worktree '{name}' has uncommitted changes ({files} files). Use --force to delete anyway."
    )]
    Uncommitted { name: String, files: usize },
    #[error("Worktree '{name}' {detail}. {hint}")]
    Unpushed {
        name: String,
        detail: &'static str,
        hint: &'static str,
    },
    #[error("Command '{command}' failed with exit code {code}")]
    CommandFailed { command: String, code: i32 },
    #[error("Command terminated by signal: {0}")]
    Signaled(String),
    #[error("Error executing command '{command}': {details}")]
    Spawn { command: String, details: String },
    #[error("{0}")]
    Projects(String),
    #[error("{0}")]
    Untrusted(String),
}

impl Error {
    pub fn msg(message: impl Into<String>) -> Self {
        Self::Message(message.into())
    }

    /// Invalid command-line arguments use the shared usage status.
    pub fn validation(message: impl Into<String>) -> Self {
        Self::Validation(message.into())
    }

    pub(crate) fn unpushed_delete(name: &str, detached: bool, unknown: bool) -> Self {
        let detail = if unknown {
            "has commits that could not be checked"
        } else {
            "has unpushed commits"
        };
        let hint = if detached {
            "Use --force to delete anyway."
        } else {
            "Use --keep-branch to keep the branch, or --force to delete it."
        };
        Self::Unpushed {
            name: name.to_string(),
            detail,
            hint,
        }
    }

    pub fn status(exit: i32, message: impl Into<String>) -> Self {
        Self::Status {
            code: status_code(exit),
            message: message.into(),
        }
    }

    pub fn exit_code(&self) -> i32 {
        exit_for_code(self.json_code(GENERAL))
    }

    /// Only standalone exec passes child statuses through.
    pub fn child_exit_code(&self) -> i32 {
        match self {
            Self::CommandFailed { code, .. } => *code,
            Self::Signaled(name) => 128 + signal_number(name),
            _ => self.exit_code(),
        }
    }

    pub fn to_json(&self, requested: i32) -> JsonError {
        JsonError {
            error: JsonErrorBody {
                message: self.to_string(),
                code: self.json_code(requested).into(),
                details: None,
            },
        }
    }

    /// Aggregate operations can fail after a guard was rechecked, or after changes.
    /// Preserve the cause when its ordinary status differs from the aggregate status.
    pub fn aggregate_json(&self, exit: i32) -> JsonErrorBody {
        let mut error = self.to_json(exit).error;
        if exit_for_code(&error.code) != exit {
            error.details = Some(serde_json::json!({"cause": error.code}));
            error.code = status_code(exit).into();
        }
        error
    }

    pub fn json_code(&self, requested: i32) -> &'static str {
        match self {
            Self::Status { code, .. } => code,
            Self::LockTimeout(_) => "lock_timeout",
            Self::WorktreeNotFound(_) | Self::ProjectNotFound(_) | Self::PathNotFound(_) => {
                "not_found"
            }
            Self::WorktreeAlreadyExists(_) => "exists",
            Self::BranchNotFound(_) => "branch_not_found",
            Self::NotARepository => "not_repository",
            Self::Uncommitted { .. } => "dirty",
            Self::Unpushed { .. } => "unpreserved",
            Self::CommandFailed { .. } => "command_failed",
            Self::Signaled(_) => "signaled",
            Self::Spawn { .. } => "spawn",
            Self::Validation(_) => "usage",
            Self::Untrusted(_) => "untrusted",
            Self::Projects(_) => "failed",
            Self::Message(_) => status_code(requested),
        }
    }
}

/// The single exit-code table used by commands and aggregate reports.
pub fn exit_for_code(code: &str) -> i32 {
    match code {
        "usage" | "ambiguous" => VALIDATION,
        "not_found" | "branch_not_found" | "not_repository" => NOT_FOUND,
        "dirty" | "unpreserved" | "published" | "exists" | "exists_remote" | "untrusted"
        | "refused" => REFUSED,
        "conflict" => CONFLICT,
        "partial" => PARTIAL,
        "lock_timeout" => LOCK_TIMEOUT,
        _ => GENERAL,
    }
}

pub fn status_code(exit: i32) -> &'static str {
    match exit {
        VALIDATION => "usage",
        NOT_FOUND => "not_found",
        REFUSED => "dirty",
        CONFLICT => "conflict",
        PARTIAL => "partial",
        LOCK_TIMEOUT => "lock_timeout",
        _ => "failed",
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JsonError {
    pub error: JsonErrorBody,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JsonErrorBody {
    pub message: String,
    pub code: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<serde_json::Value>,
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
    fn every_machine_error_uses_the_shared_exit_table() {
        for (codes, exit) in [
            (
                "failed git_failed io command_failed spawn signaled",
                GENERAL,
            ),
            ("usage ambiguous", VALIDATION),
            ("not_found branch_not_found not_repository", NOT_FOUND),
            (
                "dirty unpreserved published exists exists_remote untrusted",
                REFUSED,
            ),
            ("conflict", CONFLICT),
            ("partial", PARTIAL),
            ("lock_timeout", LOCK_TIMEOUT),
        ] {
            for code in codes.split_whitespace() {
                assert_eq!(exit_for_code(code), exit, "{code}");
            }
        }
        for error in [
            Error::WorktreeNotFound("topic".into()),
            Error::BranchNotFound("topic".into()),
            Error::NotARepository,
        ] {
            assert_eq!(error.exit_code(), NOT_FOUND);
        }
        assert_eq!(Error::Untrusted("hooks".into()).exit_code(), REFUSED);
        assert_eq!(
            Error::WorktreeAlreadyExists("topic".into()).exit_code(),
            REFUSED
        );
        assert_eq!(Error::Signaled("SIGTERM".into()).exit_code(), GENERAL);
        assert_eq!(Error::Signaled("SIGTERM".into()).child_exit_code(), 143);
        assert_eq!(
            Error::CommandFailed {
                command: "child".into(),
                code: 42
            }
            .child_exit_code(),
            42
        );
    }
}
