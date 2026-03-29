import { copyFile, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { err, ok, type Result } from "@phantompane/utils";

export interface CopyFileResult {
  copiedFiles: string[];
  skippedFiles: string[];
}

export class FileCopyError extends Error {
  public readonly file: string;

  constructor(file: string, message: string) {
    super(`Failed to copy ${file}: ${message}`);
    this.name = "FileCopyError";
    this.file = file;
  }
}

export async function copyFiles(
  sourceDir: string,
  targetDir: string,
  files: string[],
): Promise<Result<CopyFileResult, FileCopyError>> {
  const copiedFiles: string[] = [];
  const skippedFiles: string[] = [];

  for (const file of files) {
    const sourcePath = path.join(sourceDir, file);
    const targetPath = path.join(targetDir, file);

    try {
      const stats = await stat(sourcePath);
      if (!stats.isFile()) {
        skippedFiles.push(file);
        continue;
      }

      const targetDirPath = path.dirname(targetPath);
      await mkdir(targetDirPath, { recursive: true });

      await copyFile(sourcePath, targetPath);
      copiedFiles.push(file);
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        skippedFiles.push(file);
      } else {
        return err(
          new FileCopyError(
            file,
            error instanceof Error ? error.message : String(error),
          ),
        );
      }
    }
  }

  return ok({ copiedFiles, skippedFiles });
}
