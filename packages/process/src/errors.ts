export class ProcessError extends Error {
  public readonly exitCode?: number;

  constructor(message: string, exitCode?: number) {
    super(message);
    this.name = "ProcessError";
    this.exitCode = exitCode;
  }
}

export class ProcessExecutionError extends ProcessError {
  constructor(command: string, exitCode: number) {
    super(`Command '${command}' failed with exit code ${exitCode}`, exitCode);
    this.name = "ProcessExecutionError";
  }
}

export class ProcessSignalError extends ProcessError {
  constructor(signal: string) {
    const exitCode = 128 + (signal === "SIGTERM" ? 15 : 1);
    super(`Command terminated by signal: ${signal}`, exitCode);
    this.name = "ProcessSignalError";
  }
}

export class ProcessSpawnError extends ProcessError {
  constructor(command: string, details: string) {
    super(`Error executing command '${command}': ${details}`);
    this.name = "ProcessSpawnError";
  }
}
