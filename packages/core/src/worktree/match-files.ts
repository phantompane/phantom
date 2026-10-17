import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";

// scriptc 0.3 refuses the published `glob` package because its JavaScript is
// minified. This matcher covers the patterns phantom's copy-file config uses.

const MAGIC = /[*?[\]{}]/;

export function hasMagic(pattern: string): boolean {
  return MAGIC.test(pattern);
}

export async function matchFiles(
  cwd: string,
  pattern: string,
): Promise<string[]> {
  const files = await walkFiles(cwd);
  const expression = globToRegExp(pattern);
  return files
    .filter((file) => !isGitPath(file) && expression.test(file))
    .sort();
}

async function walkFiles(cwd: string): Promise<string[]> {
  const files: string[] = [];

  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === ".git") {
        continue;
      }
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolute);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      files.push(relative(cwd, absolute).replace(/\\/g, "/"));
    }
  }

  await visit(cwd);
  return files;
}

function isGitPath(file: string): boolean {
  return file === ".git" || file.startsWith(".git/");
}

function globToRegExp(pattern: string): RegExp {
  let source = "^";
  let index = 0;

  while (index < pattern.length) {
    const char = pattern[index];

    if (char === "*") {
      if (pattern[index + 1] === "*") {
        if (pattern[index + 2] === "/") {
          source += "(?:[^/]+/)*";
          index += 3;
          continue;
        }
        source += ".*";
        index += 2;
        continue;
      }
      source += "[^/]*";
      index += 1;
      continue;
    }

    if (char === "?") {
      source += "[^/]";
      index += 1;
      continue;
    }

    if (char === "{") {
      const end = pattern.indexOf("}", index);
      const body = pattern.slice(index + 1, end);
      const alternatives = body.split(",").map((part) => escapeRegExp(part));
      source += `(?:${alternatives.join("|")})`;
      index = end + 1;
      continue;
    }

    if (char === "[") {
      const end = pattern.indexOf("]", index);
      source += pattern.slice(index, end + 1);
      index = end + 1;
      continue;
    }

    source += escapeRegExp(char ?? "");
    index += 1;
  }

  source += "$";
  return new RegExp(source);
}

function escapeRegExp(value: string): string {
  return value.replace(/[\\^$.*+?()|[\]{}]/g, "\\$&");
}
