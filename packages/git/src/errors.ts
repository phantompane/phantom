export class GitOperationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitOperationError";
  }
}

export class GitWorktreeError extends GitOperationError {
  constructor(message: string) {
    super(message);
    this.name = "GitWorktreeError";
  }
}
