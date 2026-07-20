import { parseArgs, type ParseArgsConfig } from "node:util";
import { exitCodes, exitWithError } from "./errors.ts";

export function parseArgsOrExit<T extends ParseArgsConfig>(config: T) {
  try {
    return parseArgs(config);
  } catch (error) {
    if (isParseArgsError(error)) {
      exitWithError(error.message, exitCodes.validationError);
    }
    throw error;
  }
}

function isParseArgsError(error: unknown): error is Error & { code: string } {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code.startsWith("ERR_PARSE_ARGS_")
  );
}
