import { cp, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
  version?: string;
};

if (!packageJson.version) {
  throw new Error("Version not found in package.json");
}

const distDir = "dist";

await rename(join(distDir, "index.js"), join(distDir, "server.js"));
await rename(join(distDir, "index.js.map"), join(distDir, "server.js.map"));

await cp("../../LICENSE", join(distDir, "LICENSE"));
await cp("../../README.md", join(distDir, "README.md"));

await writeFile(
  join(distDir, "package.json"),
  `${JSON.stringify(
    {
      name: "@phantompane/server",
      version: packageJson.version,
      description: "Hono-hosted React SPA package for Phantom",
      keywords: ["hono", "react", "server", "phantom", "vite"],
      homepage: "https://github.com/phantompane/phantom#readme",
      bugs: {
        url: "https://github.com/phantompane/phantom/issues",
      },
      repository: {
        type: "git",
        url: "git+https://github.com/phantompane/phantom.git",
      },
      license: "MIT",
      author: "aku11i",
      type: "module",
      main: "./server.js",
      files: ["package.json", "README.md", "LICENSE", "public", "server.js"],
      engines: {
        node: ">=22.0.0",
      },
      dependencies: {},
    },
    null,
    2,
  )}\n`,
);
