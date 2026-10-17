import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { err, ok, type Result } from "@phantompane/utils";
import {
  ConfigValidationError,
  type PhantomConfig,
  validateConfig,
} from "./validate.ts";

export class ConfigNotFoundError extends Error {
  constructor() {
    super("phantom.config.json not found");
    this.name = "ConfigNotFoundError";
  }
}

export class ConfigParseError extends Error {
  constructor(message: string) {
    super(`Failed to parse phantom.config.json: ${message}`);
    this.name = "ConfigParseError";
  }
}

export async function loadConfig(
  gitRoot: string,
): Promise<
  Result<
    PhantomConfig,
    ConfigNotFoundError | ConfigParseError | ConfigValidationError
  >
> {
  const configPath = join(gitRoot, "phantom.config.json");

  try {
    const content = await readFile(configPath, "utf-8");

    try {
      const parsed = JSON.parse(content);
      const validationResult = validateConfig(parsed);

      if (!validationResult.ok) {
        return err(validationResult.error);
      }

      return ok(validationResult.value);
    } catch (error) {
      return err(
        new ConfigParseError(
          error instanceof Error ? error.message : String(error),
        ),
      );
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes("ENOENT")) {
      return err(new ConfigNotFoundError());
    }

    throw error instanceof Error ? error : new Error(String(error));
  }
}
