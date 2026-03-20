import { exitCodes } from "@phantompane/shared";
import { output } from "./output.ts";

export { exitCodes };

export function getProcessExitCode(error: unknown): number | undefined {
  if (
    !error ||
    typeof error !== "object" ||
    !("exitCode" in error) ||
    typeof error.exitCode !== "number"
  ) {
    return undefined;
  }

  return error.exitCode;
}

export function handleError(
  error: unknown,
  exitCode: number = exitCodes.generalError,
): never {
  if (error instanceof Error) {
    output.error(error.message);
  } else {
    output.error(String(error));
  }
  process.exit(exitCode);
}

export function exitWithSuccess(): never {
  process.exit(exitCodes.success);
}

export function exitWithError(
  message: string,
  exitCode: number = exitCodes.generalError,
): never {
  output.error(message);
  process.exit(exitCode);
}
