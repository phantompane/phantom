import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const rootDirectory = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: rootDirectory,
  server: {
    deps: {
      inline: [/^@phantompane\//, /^human-id$/, /^@octokit\/rest$/],
    },
  },
  test: {
    environment: "node",
    exclude: ["**/dist/**"],
    include: ["packages/**/*.test.ts", "packages/**/*.test.shell.ts"],
  },
});
