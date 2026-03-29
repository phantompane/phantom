import fs from "node:fs/promises";
import path from "node:path";
import { err, ok, type Result } from "@phantompane/utils";
import type { z } from "zod";
import {
  type ConfigValidationError,
  type phantomConfigSchema,
  validateConfig,
} from "./validate.ts";

export type PhantomConfig = z.infer<typeof phantomConfigSchema>;

export class ConfigNotFoundError extends Error {
  constructor() {
    super("phantom.config.json not found");
    this.name = this.constructor.name;
  }
}

export class ConfigParseError extends Error {
  constructor(message: string) {
    super(`Failed to parse phantom.config.json: ${message}`);
    this.name = this.constructor.name;
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
  const configPath = path.join(gitRoot, "phantom.config.json");

  try {
    const content = await fs.readFile(configPath, "utf-8");
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
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return err(new ConfigNotFoundError());
    }
    throw error;
  }
}
