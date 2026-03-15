import { err, ok, type Result } from "@phantompane/shared";
import { z } from "zod";
import type { PhantomConfig } from "./loader.ts";

export class ConfigValidationError extends Error {
  constructor(message: string) {
    super(`Invalid phantom.config.json: ${message}`);
    this.name = this.constructor.name;
  }
}

export const phantomConfigSchema = z
  .object({
    postCreate: z
      .object({
        copyFiles: z.array(z.string()).optional(),
        commands: z.array(z.string()).optional(),
      })
      .passthrough()
      .optional(),
    preDelete: z
      .object({
        commands: z.array(z.string()).optional(),
      })
      .passthrough()
      .optional(),
    worktreesDirectory: z.string().optional(),
  })
  .passthrough();

export function validateConfig(
  config: unknown,
): Result<PhantomConfig, ConfigValidationError> {
  const result = phantomConfigSchema.safeParse(config);

  if (!result.success) {
    const firstError = result.error.issues[0];
    const path = firstError.path.join(".");
    const message = path
      ? `${path}: ${firstError.message}`
      : firstError.message;

    return err(new ConfigValidationError(message));
  }

  return ok(result.data as PhantomConfig);
}
