import { glob } from "glob";
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
 * Expand a single pattern to matching file paths
 */
async function expandPattern(
  gitRoot: string,
  pattern: string,
): Promise<string[]> {
  const normalizedPattern = normalizeRelativePath(pattern);

  // Check if pattern contains glob metacharacters
  if (!isGlobPattern(pattern)) {
    // Not a glob pattern and doesn't exist, return as exact path
    // (will be handled by file-copier as non-existent file)
    return [normalizedPattern];
  }

  return glob(normalizedPattern, {
    cwd: gitRoot,
    dot: true,
    ignore: ".git/**",
    nodir: true,
    posix: true,
  });
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
