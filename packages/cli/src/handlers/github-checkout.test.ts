import { equal } from "node:assert/strict";
import { describe, it, vi } from "vitest";
import { exitCodes } from "../errors.ts";

// Use the same mocking pattern as github-checkout-postcreate.test.ts
const exitWithErrorMock = vi.fn((message, code) => {
  throw new Error(`Exit with code ${code}: ${message}`);
});

const outputLogMock = vi.fn();
const outputErrorMock = vi.fn();
const githubCheckoutMock = vi.fn();
const isInsideTmuxMock = vi.fn();
const executeTmuxCommandMock = vi.fn();
const getPhantomEnvMock = vi.fn();

vi.doMock("../errors.ts", () => ({
  exitWithError: exitWithErrorMock,
  exitCodes: {
    validationError: 3,
    generalError: 1,
  },
}));

vi.doMock("../output.ts", () => ({
  output: { log: outputLogMock, error: outputErrorMock },
}));

vi.doMock("@phantompane/github", () => ({
  githubCheckout: githubCheckoutMock,
}));

vi.doMock("@phantompane/process", () => ({
  getPhantomEnv: getPhantomEnvMock,
}));

vi.doMock("@phantompane/tmux", () => ({
  isInsideTmux: isInsideTmuxMock,
  executeTmuxCommand: executeTmuxCommandMock,
}));

const { githubCheckoutHandler } = await import("./github-checkout.ts");

describe("githubCheckoutHandler", () => {
  it("should export githubCheckoutHandler function", () => {
    equal(typeof githubCheckoutHandler, "function");
  });

  it("should have correct function signature", () => {
    // Check function accepts 1 parameter (args array)
    equal(githubCheckoutHandler.length, 1);
  });

  it("should exit with error when number is not provided", async () => {
    exitWithErrorMock.mockClear();

    try {
      await githubCheckoutHandler([]);
    } catch {
      // Expected to throw due to mocked process.exit
    }

    equal(exitWithErrorMock.mock.calls.length, 1);
    equal(
      exitWithErrorMock.mock.calls[0][0],
      "Please specify a PR or issue number",
    );
    equal(exitWithErrorMock.mock.calls[0][1], exitCodes.validationError);
  });

  it("should exit with error when only base option is provided", async () => {
    exitWithErrorMock.mockClear();

    try {
      await githubCheckoutHandler(["--base", "develop"]);
    } catch {
      // Expected to throw due to mocked process.exit
    }

    equal(exitWithErrorMock.mock.calls.length, 1);
    equal(
      exitWithErrorMock.mock.calls[0][0],
      "Please specify a PR or issue number",
    );
    equal(exitWithErrorMock.mock.calls[0][1], exitCodes.validationError);
  });

  it("should exit with error when tmux option is used outside tmux", async () => {
    exitWithErrorMock.mockClear();
    isInsideTmuxMock.mockClear();
    githubCheckoutMock.mockClear();

    // Mock not being inside tmux
    isInsideTmuxMock.mockImplementation(() => Promise.resolve(false));

    try {
      await githubCheckoutHandler(["123", "--tmux"]);
    } catch {
      // Expected to throw due to mocked process.exit
    }

    equal(exitWithErrorMock.mock.calls.length, 1);
    equal(
      exitWithErrorMock.mock.calls[0][0],
      "The --tmux option can only be used inside a tmux session",
    );
    equal(exitWithErrorMock.mock.calls[0][1], exitCodes.validationError);
  });

  it("should parse tmux options correctly", async () => {
    exitWithErrorMock.mockClear();
    isInsideTmuxMock.mockClear();

    // Mock not being inside tmux
    isInsideTmuxMock.mockImplementation(() => Promise.resolve(false));

    const tmuxOptions = [
      ["--tmux"],
      ["-t"],
      ["--tmux-vertical"],
      ["--tmux-v"],
      ["--tmux-horizontal"],
      ["--tmux-h"],
    ];

    for (const option of tmuxOptions) {
      try {
        await githubCheckoutHandler(["123", ...option]);
      } catch {
        // Expected to throw due to mocked process.exit
      }
    }

    // All should fail due to not being in tmux
    equal(exitWithErrorMock.mock.calls.length, tmuxOptions.length);
    for (const call of exitWithErrorMock.mock.calls) {
      equal(
        call[0],
        "The --tmux option can only be used inside a tmux session",
      );
      equal(call[1], exitCodes.validationError);
    }
  });
});
