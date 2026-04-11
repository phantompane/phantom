import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const appDirectory = join(scriptDirectory, "..");
const sourceDirectory = join(appDirectory, ".output");
const targetDirectory = join(
  appDirectory,
  "..",
  "cli",
  "dist",
  "app",
  ".output",
);

await rm(targetDirectory, { recursive: true, force: true });
await mkdir(dirname(targetDirectory), { recursive: true });
await cp(sourceDirectory, targetDirectory, { recursive: true });
