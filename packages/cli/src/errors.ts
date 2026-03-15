import { exitCodes } from "@phantompane/shared";
import { output } from "./output.ts";

export { exitCodes };

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
