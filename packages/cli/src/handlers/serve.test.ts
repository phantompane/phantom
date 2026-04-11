import { strictEqual } from "node:assert";
import { afterEach, describe, it, vi } from "vitest";

const consoleLogMock = vi.fn();
const consoleErrorMock = vi.fn();
const resolveServeServerEntryMock = vi.fn();
const startServeServerMock = vi.fn();
const exitWithErrorMock = vi.fn((message: string) => {
  consoleErrorMock(`Error: ${message}`);
  throw new Error(`Exit: ${message}`);
});

const originalHost = process.env.HOST;
const originalNitroHost = process.env.NITRO_HOST;
const originalPort = process.env.PORT;
const originalNitroPort = process.env.NITRO_PORT;

vi.doMock("../output.ts", () => ({
  output: {
    log: consoleLogMock,
    error: consoleErrorMock,
  },
}));

vi.doMock("../errors.ts", () => ({
  exitWithError: exitWithErrorMock,
}));

vi.doMock("../serve.ts", () => ({
  resolveServeServerEntry: resolveServeServerEntryMock,
  startServeServer: startServeServerMock,
}));

const { serveHandler } = await import("./serve.ts");

afterEach(() => {
  vi.clearAllMocks();

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
});

describe("serveHandler", () => {
  it("uses port 9640 by default", async () => {
    resolveServeServerEntryMock.mockResolvedValue("/bundle/server/index.mjs");

    await serveHandler([]);

    strictEqual(process.env.PORT, "9640");
    strictEqual(process.env.NITRO_PORT, "9640");
    strictEqual(resolveServeServerEntryMock.mock.calls.length, 1);
    strictEqual(startServeServerMock.mock.calls.length, 1);
    strictEqual(
      startServeServerMock.mock.calls[0][0],
      "/bundle/server/index.mjs",
    );
  });

  it("lets --port override the default port", async () => {
    resolveServeServerEntryMock.mockResolvedValue("/bundle/server/index.mjs");

    await serveHandler(["--port", "4100"]);

    strictEqual(process.env.PORT, "4100");
    strictEqual(process.env.NITRO_PORT, "4100");
  });
});
