import { globSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { err, ok, type Result  } from "@phantompane/shared";

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

/**
 * Recursively find all files in a directory
 * This is a workaround for Node.js glob's limitation with dotfiles in ** patterns
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

/**
 * Filter out directories from glob matches, keeping only files
 */
async function filterOnlyFiles(
  gitRoot: string,
  matches: string[],
): Promise<string[]> {
  const files: string[] = [];

  for (const match of matches) {
    const fullPath = path.join(gitRoot, match);
    try {
      const stats = await stat(fullPath);
      if (stats.isFile()) {
        files.push(match);
      }
    } catch {
      // Skip files that can't be stat'd
    }
  }

  return files;
}

/**
 * Simple glob pattern matcher for filenames
 * Supports *, ?, and [abc] patterns
 */
function matchesPattern(filename: string, pattern: string): boolean {
  // Convert glob pattern to regex
  const regexPattern = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&") // Escape regex special chars except glob chars
    .replace(/\*/g, ".*") // * matches any characters
    .replace(/\?/g, "."); // ? matches single character

  const regex = new RegExp(`^${regexPattern}$`);
  return regex.test(filename);
}

/**
 * Expand a single pattern to matching file paths
 */
async function expandPattern(
  gitRoot: string,
  pattern: string,
): Promise<string[]> {
  // First check if pattern exists as a literal file path
  // This handles files with glob metacharacters in their names (e.g., "file[1].txt")
  const literalPath = path.join(gitRoot, pattern);
  try {
    const stats = await stat(literalPath);
    if (stats.isFile()) {
      // File exists literally, return it as exact match
      return [pattern];
    }
  } catch {
    // File doesn't exist literally, continue to pattern matching
  }

  // Check if pattern contains glob metacharacters
  if (!isGlobPattern(pattern)) {
    // Not a glob pattern and doesn't exist, return as exact path
    // (will be handled by file-copier as non-existent file)
    return [pattern];
  }

  // Workaround for Node.js glob limitation with **/dotfile patterns
  // If pattern contains **/ and might match dotfiles, use recursive readdir
  if (pattern.includes("**/")) {
    const parts = pattern.split("**/");
    const prefix = parts[0]; // e.g., "oa-application/" or ""
    const suffix = parts.slice(1).join("**/"); // e.g., ".env" or "*.local.yml"

    // Get all files recursively
    const baseDir = prefix ? path.join(gitRoot, prefix) : gitRoot;
    const allFiles = await recursiveReaddir(baseDir);

    // Match files against the suffix pattern
    const matchedFiles = allFiles.filter((file) => {
      const basename = path.basename(file);
      return matchesPattern(basename, suffix);
    });

    // Prepend the prefix back to the matched files
    if (prefix) {
      return matchedFiles.map((file) => path.join(prefix, file));
    }

    return matchedFiles;
  }

  // Use glob to expand pattern
  const matches = globSync(pattern, {
    cwd: gitRoot,
  });

  // Filter out directories
  return filterOnlyFiles(gitRoot, matches);
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
