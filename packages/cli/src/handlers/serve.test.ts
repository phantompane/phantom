import { rejects, strictEqual } from "node:assert";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it, vi } from "vitest";

const consoleLogMock = vi.fn();
const consoleErrorMock = vi.fn();
const consoleWarnMock = vi.fn();
const exitWithErrorMock = vi.fn((message: string) => {
  consoleErrorMock(`Error: ${message}`);
  throw new Error(`Exit: ${message}`);
});

const temporaryDirectories: string[] = [];
const originalHost = process.env.HOST;
const originalNitroHost = process.env.NITRO_HOST;
const originalPort = process.env.PORT;
const originalNitroPort = process.env.NITRO_PORT;
const originalArgv = [...process.argv];

vi.doMock("../output.ts", () => ({
  output: {
    log: consoleLogMock,
    error: consoleErrorMock,
    warn: consoleWarnMock,
  },
}));

vi.doMock("../errors.ts", () => ({
  exitWithError: exitWithErrorMock,
}));

const { serveHandler } = await import("./serve.ts");

afterEach(async () => {
  vi.clearAllMocks();
  process.argv = [...originalArgv];

  if (originalHost === undefined) {
    delete process.env.HOST;
  } else {
    process.env.HOST = originalHost;
  }

  if (originalNitroHost === undefined) {
    delete process.env.NITRO_HOST;
  } else {
    process.env.NITRO_HOST = originalNitroHost;
  }

  if (originalPort === undefined) {
    delete process.env.PORT;
  } else {
    process.env.PORT = originalPort;
  }

  if (originalNitroPort === undefined) {
    delete process.env.NITRO_PORT;
  } else {
    process.env.NITRO_PORT = originalNitroPort;
  }

  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "phantom-serve-handler-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function createBundledCliFixture(): Promise<{
  cliEntry: string;
  serverEntry: string;
}> {
  const directory = await createTemporaryDirectory();
  const cliEntry = join(directory, "packages", "cli", "dist", "phantom.js");
  const serverEntry = join(
    directory,
    "packages",
    "cli",
    "dist",
    "app",
    ".output",
    "server",
    "index.mjs",
  );

  await mkdir(
    join(directory, "packages", "cli", "dist", "app", ".output", "server"),
    {
      recursive: true,
    },
  );
  await writeFile(cliEntry, "");
  await writeFile(serverEntry, "");

  return { cliEntry, serverEntry };
}

describe("serveHandler", () => {
  it("uses port 9640 by default", async () => {
    const { cliEntry, serverEntry } = await createBundledCliFixture();
    process.argv[1] = cliEntry;

    await serveHandler([]);

    strictEqual(process.env.PORT, "9640");
    strictEqual(process.env.NITRO_PORT, "9640");
    strictEqual(consoleWarnMock.mock.calls.length, 1);
    strictEqual(
      consoleWarnMock.mock.calls[0][0],
      "Warning: `phantom serve` is experimental and may change without notice.",
    );
    strictEqual(consoleLogMock.mock.calls.length, 1);
    strictEqual(
      consoleLogMock.mock.calls[0][0],
      `Starting Phantom server from ${serverEntry}`,
    );
  });

  it("lets --port override the default port", async () => {
    const { cliEntry } = await createBundledCliFixture();
    process.argv[1] = cliEntry;

    await serveHandler(["--port", "4100"]);

    strictEqual(process.env.PORT, "4100");
    strictEqual(process.env.NITRO_PORT, "4100");
    strictEqual(consoleWarnMock.mock.calls.length, 1);
  });

  it("fails when bundled server assets are missing", async () => {
    const directory = await createTemporaryDirectory();
    const cliEntry = join(directory, "packages", "cli", "dist", "phantom.js");

    await mkdir(join(directory, "packages", "cli", "dist"), {
      recursive: true,
    });
    await writeFile(cliEntry, "");
    process.argv[1] = cliEntry;

    await rejects(
      serveHandler([]),
      /Exit: Failed to start Phantom server: Could not find Phantom server assets/,
    );

    strictEqual(consoleWarnMock.mock.calls.length, 1);
  });

  it("fails when called from the source CLI entrypoint", async () => {
    const directory = await createTemporaryDirectory();
    const cliEntry = join(
      directory,
      "packages",
      "cli",
      "src",
      "bin",
      "phantom.ts",
    );
    const serverEntry = join(
      directory,
      "packages",
      "cli",
      "dist",
      "app",
      ".output",
      "server",
      "index.mjs",
    );

    await mkdir(join(directory, "packages", "cli", "src", "bin"), {
      recursive: true,
    });
    await mkdir(
      join(directory, "packages", "cli", "dist", "app", ".output", "server"),
      {
        recursive: true,
      },
    );
    await writeFile(cliEntry, "");
    await writeFile(serverEntry, "");
    process.argv[1] = cliEntry;

    await rejects(
      serveHandler([]),
      /Exit: Failed to start Phantom server: Could not find Phantom server assets/,
    );

    strictEqual(consoleWarnMock.mock.calls.length, 1);
  });
});
