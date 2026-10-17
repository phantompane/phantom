import { err, ok, type Result } from "@phantompane/utils";

export class ConfigValidationError extends Error {
  constructor(message: string) {
    super(`Invalid phantom.config.json: ${message}`);
    this.name = "ConfigValidationError";
  }
}

export interface PostCreateConfig {
  copyFiles?: string[];
  commands?: string[];
}

export interface PreDeleteConfig {
  commands?: string[];
}

export interface PhantomConfig {
  postCreate?: PostCreateConfig;
  preDelete?: PreDeleteConfig;
  directoryNameSeparator?: string;
  worktreesDirectory?: string;
}

// scriptc 0.3 crashes while compiling zod (internal "null is not representable"
// error). These objects are small and passthrough, so validation is inlined.
// The returned value is the original object when it is valid, which keeps
// unknown keys the way zod's passthrough() did.
export function validateConfig(
  config: unknown,
): Result<PhantomConfig, ConfigValidationError> {
  if (!isRecord(config)) {
    return err(new ConfigValidationError(expectedMessage("object", config)));
  }

  const postCreateError = validateOptionalRecord(
    config.postCreate,
    "postCreate",
    [
      ["copyFiles", "copyFiles"],
      ["commands", "commands"],
    ],
  );
  if (postCreateError) {
    return err(new ConfigValidationError(postCreateError));
  }

  const preDeleteError = validateOptionalRecord(config.preDelete, "preDelete", [
    ["commands", "commands"],
  ]);
  if (preDeleteError) {
    return err(new ConfigValidationError(preDeleteError));
  }

  const separatorError = validateOptionalString(
    config.directoryNameSeparator,
    "directoryNameSeparator",
  );
  if (separatorError) {
    return err(new ConfigValidationError(separatorError));
  }

  const directoryError = validateOptionalString(
    config.worktreesDirectory,
    "worktreesDirectory",
  );
  if (directoryError) {
    return err(new ConfigValidationError(directoryError));
  }

  return ok(config as PhantomConfig);
}

function validateOptionalRecord(
  value: unknown,
  path: string,
  stringArrays: Array<[string, string]>,
): string | null {
  if (value === undefined) {
    return null;
  }

  if (!isRecord(value)) {
    return `${path}: ${expectedMessage("object", value)}`;
  }

  for (const [key] of stringArrays) {
    const fieldError = validateOptionalStringArray(
      value[key],
      `${path}.${key}`,
    );
    if (fieldError) {
      return fieldError;
    }
  }

  return null;
}

function validateOptionalString(value: unknown, path: string): string | null {
  if (value === undefined) {
    return null;
  }

  if (typeof value !== "string") {
    return `${path}: ${expectedMessage("string", value)}`;
  }

  return null;
}

function validateOptionalStringArray(
  value: unknown,
  path: string,
): string | null {
  if (value === undefined) {
    return null;
  }

  if (!Array.isArray(value)) {
    return `${path}: ${expectedMessage("array", value)}`;
  }

  for (let index = 0; index < value.length; index++) {
    if (typeof value[index] !== "string") {
      return `${path}.${index}: ${expectedMessage("string", value[index])}`;
    }
  }

  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function expectedMessage(expected: string, received: unknown): string {
  return `Invalid input: expected ${expected}, received ${receivedTypeName(received)}`;
}

function receivedTypeName(value: unknown): string {
  if (value === null) {
    return "null";
  }

  if (Array.isArray(value)) {
    return "array";
  }

  return typeof value;
}
