import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
  version?: string;
};

if (!packageJson.version) {
  throw new Error("Version not found in package.json");
}

const standaloneDir = join(".next", "standalone");
const staticDir = join(".next", "static");
const packageDir = join(standaloneDir, "packages", "server");
const distDir = "dist";
const distStaticDir = join(distDir, ".next", "static");
const distPublicDir = join(distDir, "public");

await rm(distDir, { recursive: true, force: true });
await mkdir(distDir, { recursive: true });
await mkdir(dirname(distStaticDir), { recursive: true });
await mkdir(distPublicDir, { recursive: true });

await cp(packageDir, distDir, { recursive: true });
await cp(staticDir, distStaticDir, { recursive: true });
await cp("public", distPublicDir, { recursive: true });
await cp("../../LICENSE", join(distDir, "LICENSE"));
await cp("../../README.md", join(distDir, "README.md"));

await writeFile(
  join(distDir, "package.json"),
  `${JSON.stringify(
    {
      name: "@phantompane/server",
      version: packageJson.version,
      description: "Standalone Next.js server package for Phantom",
      keywords: ["nextjs", "server", "phantom"],
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
      files: [
        ".next",
        "package.json",
        "public",
        "README.md",
        "LICENSE",
        "server.js",
      ],
      engines: {
        node: ">=22.0.0",
      },
      dependencies: {},
    },
    null,
    2,
  )}\n`,
);
