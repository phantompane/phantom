export class WorktreeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class WorktreeNotFoundError extends WorktreeError {
  constructor(name: string) {
    super(`Worktree '${name}' not found`);
    this.name = "WorktreeNotFoundError";
  }
}

export class WorktreeAlreadyExistsError extends WorktreeError {
  constructor(name: string) {
    super(`Worktree '${name}' already exists`);
    this.name = "WorktreeAlreadyExistsError";
  }
}

export class InvalidWorktreeNameError extends WorktreeError {
  constructor(name: string) {
    super(`Invalid worktree name: '${name}'`);
    this.name = "InvalidWorktreeNameError";
  }
}

export class BranchNotFoundError extends WorktreeError {
  constructor(branchName: string) {
    super(`Branch '${branchName}' not found`);
    this.name = "BranchNotFoundError";
  }
}

export class WorktreeActionConflictError extends WorktreeError {
  constructor() {
    super("Cannot use --shell, --exec, and --tmux options together");
    this.name = "WorktreeActionConflictError";
  }
}

export class TmuxSessionRequiredError extends WorktreeError {
  constructor() {
    super("The --tmux option can only be used inside a tmux session");
    this.name = "TmuxSessionRequiredError";
  }
}
