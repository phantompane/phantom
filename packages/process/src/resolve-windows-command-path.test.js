import { strictEqual, throws } from "node:assert";
import path from "node:path";
import { describe, it, mock } from "node:test";

const execFileSyncMock = mock.fn();

mock.module("node:child_process", {
  namedExports: {
    execFileSync: execFileSyncMock,
  },
});

const { resolveWindowsCommandPath } =
  await import("./resolve-windows-command-path.ts");

describe("resolveWindowsCommandPath", () => {
  it("should throw when called on non-Windows platforms", () => {
    const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(
      process,
      "platform",
    );

    Object.defineProperty(process, "platform", {
      value: "darwin",
      configurable: true,
    });

    try {
      throws(() => resolveWindowsCommandPath("npm"));
      strictEqual(execFileSyncMock.mock.calls.length, 0);
    } finally {
      if (originalPlatformDescriptor) {
        Object.defineProperty(process, "platform", originalPlatformDescriptor);
      }
    }
  });

  it("should resolve extensionless commands on Windows using where.exe", () => {
    const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(
      process,
      "platform",
    );
    execFileSyncMock.mock.resetCalls();

    execFileSyncMock.mock.mockImplementation(() =>
      Buffer.from("C:/Program Files/nodejs/npm.cmd\r\n"),
    );

    Object.defineProperty(process, "platform", {
      value: "win32",
      configurable: true,
    });

    try {
      const resolved = resolveWindowsCommandPath("npm");
      strictEqual(
        path.normalize(resolved),
        path.normalize("C:/Program Files/nodejs/npm.cmd"),
      );
      strictEqual(execFileSyncMock.mock.calls.length > 0, true);
    } finally {
      if (originalPlatformDescriptor) {
        Object.defineProperty(process, "platform", originalPlatformDescriptor);
      }
    }
  });

  it("should return the first resolved path when where.exe finds multiple matches", () => {
    const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(
      process,
      "platform",
    );
    execFileSyncMock.mock.resetCalls();

    execFileSyncMock.mock.mockImplementation(() =>
      Buffer.from(
        ["C:/Program Files/nodejs/npm", "C:/Program Files/nodejs/npm.cmd"].join(
          "\r\n",
        ),
      ),
    );

    Object.defineProperty(process, "platform", {
      value: "win32",
      configurable: true,
    });

    try {
      const resolved = resolveWindowsCommandPath("npm");
      strictEqual(
        path.normalize(resolved),
        path.normalize("C:/Program Files/nodejs/npm"),
      );
      strictEqual(execFileSyncMock.mock.calls.length > 0, true);
    } finally {
      if (originalPlatformDescriptor) {
        Object.defineProperty(process, "platform", originalPlatformDescriptor);
      }
    }
  });

  it("should bypass resolution when a directory is provided", () => {
    const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(
      process,
      "platform",
    );
    execFileSyncMock.mock.resetCalls();

    Object.defineProperty(process, "platform", {
      value: "win32",
      configurable: true,
    });

    try {
      const result = resolveWindowsCommandPath(
        "C:/Program Files/nodejs/npm.cmd",
      );
      strictEqual(result, "C:/Program Files/nodejs/npm.cmd");
      strictEqual(execFileSyncMock.mock.calls.length, 0);
    } finally {
      if (originalPlatformDescriptor) {
        Object.defineProperty(process, "platform", originalPlatformDescriptor);
      }
    }
  });
});
