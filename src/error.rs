pub const SUCCESS: i32 = 0;
pub const GENERAL: i32 = 1;
pub const NOT_FOUND: i32 = 2;
pub const VALIDATION: i32 = 3;
pub const NOT_REPOSITORY: i32 = 4;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{0}")]
    Message(String),
    #[error("Worktree '{0}' not found")]
    WorktreeNotFound(String),
    #[error("Worktree '{0}' already exists")]
    WorktreeAlreadyExists(String),
    #[error("Branch '{0}' not found")]
    BranchNotFound(String),
    #[error("Not a git repository. Run phantom from inside a Git repository.")]
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
            _ => GENERAL,
        }
    }
}

pub type Result<T> = std::result::Result<T, Error>;
