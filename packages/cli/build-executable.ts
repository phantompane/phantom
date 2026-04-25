import { execFile } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const entryPoint = join("src", "bin", "phantom.ts");
const distDir = "dist";
const outputDir = "output";
const binaryName = "phantom";
const bunExecutable = "bun";
type Target = {
  bunTarget: string;
  os: "linux" | "darwin";
  arch: "x64" | "arm64";
  binaryFileName: string;
};

const targets: Target[] = [
  {
    bunTarget: "bun-linux-x64",
    os: "linux",
    arch: "x64",
    binaryFileName: binaryName,
  },
  {
    bunTarget: "bun-linux-arm64",
    os: "linux",
    arch: "arm64",
    binaryFileName: binaryName,
  },
  {
    bunTarget: "bun-darwin-arm64",
    os: "darwin",
    arch: "arm64",
    binaryFileName: binaryName,
  },
  {
    bunTarget: "bun-darwin-x64",
    os: "darwin",
    arch: "x64",
    binaryFileName: binaryName,
  },
];
const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
  version?: string;
};
const version = packageJson.version;

if (!version) {
  throw new Error("Version not found in package.json");
}

await mkdir(distDir, { recursive: true });
await mkdir(outputDir, { recursive: true });

for (const target of targets) {
  await compile(target);
  const archiveName = `phantom-v${version}-${target.os}-${target.arch}.tar.gz`;
  const archivePath = join(outputDir, archiveName);
  console.log(`Packing ${archiveName}...`);
  await tarGz(archivePath, distDir, target.binaryFileName);
  console.log(`Packaged ${archivePath}`);
}

async function compile(target: Target): Promise<string> {
  console.log(
    `Building phantom single executable with ${bunExecutable} (${target.bunTarget})...`,
  );
  const binaryPath = join(distDir, target.binaryFileName);
  await execFileAsync(bunExecutable, [
    "build",
    entryPoint,
    "--compile",
    `--target=${target.bunTarget}`,
    "--minify",
    "--outfile",
    binaryPath,
  ]);
  console.log(
    `Executable built at ${binaryPath} for ${target.os}/${target.arch}`,
  );
  return binaryPath;
}

async function tarGz(
  archivePath: string,
  sourceDir: string,
  fileName: string,
): Promise<void> {
  await execFileAsync("tar", ["-czf", archivePath, "-C", sourceDir, fileName]);
}
