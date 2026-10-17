import { execFile } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const entryPoint = join("native", "bin", "phantom.ts");
const distDir = "dist";
const outputDir = "output";
const binaryName = "phantom";
const scriptcExecutable = "scriptc";

type Target = {
  // Empty string builds for the host. Other values are SCRIPTC_TARGET triples.
  scriptcTarget: string;
  os: "linux" | "darwin";
  arch: "x64" | "arm64";
  binaryFileName: string;
};

// scriptc 0.3 builds macOS and Linux executables (arm64 and x64). Windows and
// WASI are supported by the compiler but are not release targets today.
const targets: Target[] = [
  {
    scriptcTarget: "x86_64-linux-gnu",
    os: "linux",
    arch: "x64",
    binaryFileName: binaryName,
  },
  {
    scriptcTarget: "aarch64-linux-gnu",
    os: "linux",
    arch: "arm64",
    binaryFileName: binaryName,
  },
  {
    scriptcTarget: "arm64-apple-macosx14.0.0",
    os: "darwin",
    arch: "arm64",
    binaryFileName: binaryName,
  },
  {
    scriptcTarget: "x86_64-apple-macosx14.0.0",
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

const selected = process.env.PHANTOM_COMPILE_TARGETS?.split(",")
  .map((name) => name.trim())
  .filter((name) => name.length > 0);
const selectedTargets = selected
  ? targets.filter((target) => selected.includes(`${target.os}-${target.arch}`))
  : targets;

if (selectedTargets.length === 0) {
  throw new Error(
    `No compile targets matched PHANTOM_COMPILE_TARGETS=${process.env.PHANTOM_COMPILE_TARGETS}`,
  );
}

await mkdir(distDir, { recursive: true });
await mkdir(outputDir, { recursive: true });

for (const target of selectedTargets) {
  await compile(target);
  const archiveName = `phantom-v${version}-${target.os}-${target.arch}.tar.gz`;
  const archivePath = join(outputDir, archiveName);
  console.log(`Packing ${archiveName}...`);
  await tarGz(archivePath, distDir, target.binaryFileName);
  console.log(`Packaged ${archivePath}`);
}

async function compile(target: Target): Promise<string> {
  console.log(
    `Building phantom with scriptc (${target.scriptcTarget || "host"})...`,
  );
  const binaryPath = join(distDir, target.binaryFileName);
  const env = { ...process.env };
  if (target.scriptcTarget) {
    env.SCRIPTC_TARGET = target.scriptcTarget;
  } else {
    delete env.SCRIPTC_TARGET;
  }

  await execFileAsync(
    scriptcExecutable,
    [
      "build",
      entryPoint,
      "--optimization=release",
      "--strip",
      "--no-keep-llvm",
      "-o",
      binaryPath,
    ],
    { env },
  );
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
