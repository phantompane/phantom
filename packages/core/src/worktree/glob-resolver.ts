import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { err, ok, type Result } from "@phantompane/utils";

export interface ResolvedPattern {
  pattern: string;
  resolvedFiles: string[];
}

export interface GlobResolutionResult {
  resolvedFiles: string[];
  patterns: ResolvedPattern[];
}

export class GlobResolutionError extends Error {
  public readonly pattern: string;

  constructor(pattern: string, message: string) {
    super(`Failed to resolve pattern '${pattern}': ${message}`);
    this.name = "GlobResolutionError";
    this.pattern = pattern;
  }
}

/**
 * Check if a string contains glob pattern characters
 */
function isGlobPattern(pattern: string): boolean {
  return /[*?[\]{}]/.test(pattern);
}

function normalizeRelativePath(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}

/**
 * Recursively find all files in a directory
 */
async function recursiveReaddir(dir: string, prefix = ""): Promise<string[]> {
  const files: string[] = [];

  try {
    const entries = await readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      // Skip .git directory to avoid traversing git metadata and other worktrees
      if (entry.name === ".git") {
        continue;
      }

      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        const subFiles = await recursiveReaddir(
          path.join(dir, entry.name),
          relativePath,
        );
        files.push(...subFiles);
      } else if (entry.isFile()) {
        files.push(relativePath);
      }
    }
  } catch {
    // Skip directories that can't be read
  }

  return files;
}

function escapeRegexChar(char: string): string {
  return /[\\^$.*+?()[\]{}|]/.test(char) ? `\\${char}` : char;
}

function escapeCharacterClass(content: string): string {
  return content.replace(/\\/g, "\\\\").replace(/\]/g, "\\]");
}

function escapeBraceAlternative(content: string): string {
  return [...content].map(escapeRegexChar).join("");
}

function globPatternToRegex(pattern: string): RegExp {
  const normalizedPattern = normalizeRelativePath(pattern);
  let regexPattern = "";

  for (let index = 0; index < normalizedPattern.length; ) {
    const char = normalizedPattern[index];

    if (char === "*") {
      if (normalizedPattern[index + 1] === "*") {
        if (normalizedPattern[index + 2] === "/") {
          regexPattern += "(?:.*/)?";
          index += 3;
        } else {
          regexPattern += ".*";
          index += 2;
        }
      } else {
        regexPattern += "[^/]*";
        index += 1;
      }
      continue;
    }

    if (char === "?") {
      regexPattern += "[^/]";
      index += 1;
      continue;
    }

    if (char === "[") {
      const closingIndex = normalizedPattern.indexOf("]", index + 1);
      if (closingIndex === -1) {
        regexPattern += "\\[";
        index += 1;
        continue;
      }

      const classContent = normalizedPattern.slice(index + 1, closingIndex);
      if (classContent.length === 0) {
        regexPattern += "\\[\\]";
      } else if (classContent.startsWith("!")) {
        regexPattern += `[^${escapeCharacterClass(classContent.slice(1))}]`;
      } else {
        regexPattern += `[${escapeCharacterClass(classContent)}]`;
      }

      index = closingIndex + 1;
      continue;
    }

    if (char === "{") {
      const closingIndex = normalizedPattern.indexOf("}", index + 1);
      if (closingIndex === -1) {
        regexPattern += "\\{";
        index += 1;
        continue;
      }

      const braceContent = normalizedPattern.slice(index + 1, closingIndex);
      if (braceContent.includes(",")) {
        const alternatives = braceContent
          .split(",")
          .map(escapeBraceAlternative)
          .join("|");
        regexPattern += `(?:${alternatives})`;
      } else {
        regexPattern += `\\{${escapeBraceAlternative(braceContent)}\\}`;
      }

      index = closingIndex + 1;
      continue;
    }

    regexPattern += escapeRegexChar(char);
    index += 1;
  }

  return new RegExp(`^${regexPattern}$`);
}

/**
 * Expand a single pattern to matching file paths
 */
async function expandPattern(
  gitRoot: string,
  pattern: string,
): Promise<string[]> {
  const normalizedPattern = normalizeRelativePath(pattern);

  // First check if pattern exists as a literal file path
  // This handles files with glob metacharacters in their names (e.g., "file[1].txt")
  const literalPath = path.join(gitRoot, pattern);
  try {
    const stats = await stat(literalPath);
    if (stats.isFile()) {
      // File exists literally, return it as exact match
      return [normalizedPattern];
    }
  } catch {
    // File doesn't exist literally, continue to pattern matching
  }

  // Check if pattern contains glob metacharacters
  if (!isGlobPattern(pattern)) {
    // Not a glob pattern and doesn't exist, return as exact path
    // (will be handled by file-copier as non-existent file)
    return [normalizedPattern];
  }

  const regex = globPatternToRegex(normalizedPattern);
  const allFiles = await recursiveReaddir(gitRoot);
  return allFiles.filter((file) => regex.test(file));
}

/**
 * Resolve glob patterns to actual file paths
 *
 * @param gitRoot - The git repository root directory
 * @param patterns - Array of file paths or glob patterns
 * @returns Result containing resolved files and pattern details, or error
 */
export async function resolveGlobPatterns(
  gitRoot: string,
  patterns: string[],
): Promise<Result<GlobResolutionResult, GlobResolutionError>> {
  const allFiles = new Set<string>();
  const resolutionDetails: ResolvedPattern[] = [];

  for (const pattern of patterns) {
    try {
      const resolvedFiles = await expandPattern(gitRoot, pattern);

      // Add to deduplication set
      for (const file of resolvedFiles) {
        allFiles.add(file);
      }

      resolutionDetails.push({
        pattern,
        resolvedFiles,
      });
    } catch (error) {
      // Return error for unexpected glob failures
      return err(
        new GlobResolutionError(
          pattern,
          error instanceof Error ? error.message : String(error),
        ),
      );
    }
  }

  return ok({
    resolvedFiles: Array.from(allFiles),
    patterns: resolutionDetails,
  });
}
