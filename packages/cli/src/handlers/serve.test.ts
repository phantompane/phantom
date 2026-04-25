import { rejects, strictEqual } from "node:assert";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it, vi } from "vitest";

const fileURLToPathMock = vi.hoisted(() => vi.fn());
const consoleLogMock = vi.fn();
const consoleErrorMock = vi.fn();
const consoleWarnMock = vi.fn();
const spawnSyncMock = vi.fn(
  (
    _command: string,
    _args: string[],
    _options: { stdio: "ignore" },
  ): { status: number; error?: Error } => ({ status: 0 }),
);
const spawnMock = vi.fn(
  (
    _command: string,
    _args: string[],
    _options: { detached: boolean; stdio: "ignore" },
  ) => ({ unref: vi.fn() }),
);
const exitWithErrorMock = vi.fn((message: string) => {
  consoleErrorMock(`Error: ${message}`);
  throw new Error(`Exit: ${message}`);
});

const temporaryDirectories: string[] = [];
const originalHost = process.env.HOST;
const originalNitroHost = process.env.NITRO_HOST;
const originalPort = process.env.PORT;
const originalNitroPort = process.env.NITRO_PORT;
const originalCodexBin = process.env.PHANTOM_SERVE_CODEX_BIN;
const originalDataDir = process.env.PHANTOM_SERVE_DATA_DIR;
const originalArgv = [...process.argv];

vi.doMock("node:url", async () => {
  const actual = await vi.importActual<typeof import("node:url")>("node:url");

  return {
    ...actual,
    fileURLToPath: fileURLToPathMock,
  };
});

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

vi.doMock("node:child_process", () => ({
  spawn: spawnMock,
  spawnSync: spawnSyncMock,
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

  if (originalCodexBin === undefined) {
    delete process.env.PHANTOM_SERVE_CODEX_BIN;
  } else {
    process.env.PHANTOM_SERVE_CODEX_BIN = originalCodexBin;
  }

  if (originalDataDir === undefined) {
    delete process.env.PHANTOM_SERVE_DATA_DIR;
  } else {
    process.env.PHANTOM_SERVE_DATA_DIR = originalDataDir;
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
  await writeFile(serverEntry, "export default {};\n");

  return { cliEntry, serverEntry };
}

describe("serveHandler", () => {
  it("uses port 9640 by default", async () => {
    const { cliEntry, serverEntry } = await createBundledCliFixture();
    fileURLToPathMock.mockReturnValue(cliEntry);

    await serveHandler([]);

    strictEqual(process.env.HOST, "127.0.0.1");
    strictEqual(process.env.NITRO_HOST, "127.0.0.1");
    strictEqual(process.env.PORT, "9640");
    strictEqual(process.env.NITRO_PORT, "9640");
    strictEqual(process.env.PHANTOM_SERVE_CODEX_BIN, "codex");
    strictEqual(spawnSyncMock.mock.calls[0][0], "codex");
    strictEqual(consoleWarnMock.mock.calls.length, 1);
    strictEqual(
      consoleWarnMock.mock.calls[0][0],
      "Warning: `phantom serve` is experimental and may change without notice.",
    );
    strictEqual(consoleLogMock.mock.calls.length, 2);
    strictEqual(
      consoleLogMock.mock.calls[0][0],
      `Starting Phantom server from ${serverEntry}`,
    );
    strictEqual(
      consoleLogMock.mock.calls[1][0],
      "Phantom server listening at http://127.0.0.1:9640",
    );
  });

  it("lets --port override the default port", async () => {
    const { cliEntry } = await createBundledCliFixture();
    fileURLToPathMock.mockReturnValue(cliEntry);

    await serveHandler(["--port", "4100"]);

    strictEqual(process.env.PORT, "4100");
    strictEqual(process.env.NITRO_PORT, "4100");
    strictEqual(consoleWarnMock.mock.calls.length, 1);
  });

  it("passes host, codex binary, and data directory through the environment", async () => {
    const { cliEntry } = await createBundledCliFixture();
    fileURLToPathMock.mockReturnValue(cliEntry);

    await serveHandler([
      "--host",
      "0.0.0.0",
      "--codex-bin",
      "/opt/codex",
      "--data-dir",
      "/tmp/phantom-serve",
    ]);

    strictEqual(process.env.HOST, "0.0.0.0");
    strictEqual(process.env.NITRO_HOST, "0.0.0.0");
    strictEqual(process.env.PHANTOM_SERVE_CODEX_BIN, "/opt/codex");
    strictEqual(process.env.PHANTOM_SERVE_DATA_DIR, "/tmp/phantom-serve");
    strictEqual(spawnSyncMock.mock.calls[0][0], "/opt/codex");
  });

  it("opens the browser when --open is provided", async () => {
    const { cliEntry } = await createBundledCliFixture();
    fileURLToPathMock.mockReturnValue(cliEntry);

    await serveHandler(["--open"]);

    strictEqual(spawnMock.mock.calls.length, 1);
  });

  it("ignores process.argv[1] and resolves from the bundled entrypoint path", async () => {
    const { cliEntry, serverEntry } = await createBundledCliFixture();
    fileURLToPathMock.mockReturnValue(cliEntry);
    process.argv[1] = "/tmp/fake-bin/phantom";

    await serveHandler([]);

    strictEqual(consoleWarnMock.mock.calls.length, 1);
    strictEqual(consoleLogMock.mock.calls.length, 2);
    strictEqual(
      consoleLogMock.mock.calls[0][0],
      `Starting Phantom server from ${serverEntry}`,
    );
  });

  it("fails when bundled server assets are missing", async () => {
    const directory = await createTemporaryDirectory();
    const cliEntry = join(directory, "packages", "cli", "dist", "phantom.js");

    await mkdir(join(directory, "packages", "cli", "dist"), {
      recursive: true,
    });
    await writeFile(cliEntry, "");
    fileURLToPathMock.mockReturnValue(cliEntry);

    await rejects(
      serveHandler([]),
      /Exit: Failed to start Phantom server: Could not find Phantom server assets/,
    );

    strictEqual(consoleWarnMock.mock.calls.length, 1);
  });

  it("fails when the Codex executable cannot be found", async () => {
    const { cliEntry } = await createBundledCliFixture();
    fileURLToPathMock.mockReturnValue(cliEntry);
    spawnSyncMock.mockReturnValueOnce({
      status: 1,
      error: new Error("ENOENT"),
    });

    await rejects(
      serveHandler(["--codex-bin", "missing-codex"]),
      /Exit: Failed to start Phantom server: Could not find Codex executable 'missing-codex'/,
    );
  });
});
