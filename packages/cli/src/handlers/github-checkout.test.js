import { equal } from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { exitCodes } from "../errors.ts";

// Use the same mocking pattern as github-checkout-postcreate.test.js
const exitWithErrorMock = mock.fn((message, code) => {
  throw new Error(`Exit with code ${code}: ${message}`);
});

const outputLogMock = mock.fn();
const outputErrorMock = mock.fn();
const githubCheckoutMock = mock.fn();
const isInsideTmuxMock = mock.fn();
const executeTmuxCommandMock = mock.fn();
const getPhantomEnvMock = mock.fn();

mock.module("../errors.ts", {
  namedExports: {
    exitWithError: exitWithErrorMock,
    exitCodes: {
      validationError: 3,
      generalError: 1,
    },
  },
});

mock.module("../output.ts", {
  namedExports: {
    output: { log: outputLogMock, error: outputErrorMock },
  },
});

mock.module("@phantompane/github", {
  namedExports: {
    githubCheckout: githubCheckoutMock,
  },
});

mock.module("@phantompane/process", {
  namedExports: {
    isInsideTmux: isInsideTmuxMock,
    executeTmuxCommand: executeTmuxCommandMock,
    getPhantomEnv: getPhantomEnvMock,
  },
});

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
    exitWithErrorMock.mock.resetCalls();

    try {
      await githubCheckoutHandler([]);
    } catch {
      // Expected to throw due to mocked process.exit
    }

    equal(exitWithErrorMock.mock.calls.length, 1);
    equal(
      exitWithErrorMock.mock.calls[0].arguments[0],
      "Please specify a PR or issue number",
    );
    equal(
      exitWithErrorMock.mock.calls[0].arguments[1],
      exitCodes.validationError,
    );
  });

  it("should exit with error when only base option is provided", async () => {
    exitWithErrorMock.mock.resetCalls();

    try {
      await githubCheckoutHandler(["--base", "develop"]);
    } catch {
      // Expected to throw due to mocked process.exit
    }

    equal(exitWithErrorMock.mock.calls.length, 1);
    equal(
      exitWithErrorMock.mock.calls[0].arguments[0],
      "Please specify a PR or issue number",
    );
    equal(
      exitWithErrorMock.mock.calls[0].arguments[1],
      exitCodes.validationError,
    );
  });

  it("should exit with error when tmux option is used outside tmux", async () => {
    exitWithErrorMock.mock.resetCalls();
    isInsideTmuxMock.mock.resetCalls();
    githubCheckoutMock.mock.resetCalls();

    // Mock not being inside tmux
    isInsideTmuxMock.mock.mockImplementation(() => Promise.resolve(false));

    try {
      await githubCheckoutHandler(["123", "--tmux"]);
    } catch {
      // Expected to throw due to mocked process.exit
    }

    equal(exitWithErrorMock.mock.calls.length, 1);
    equal(
      exitWithErrorMock.mock.calls[0].arguments[0],
      "The --tmux option can only be used inside a tmux session",
    );
    equal(
      exitWithErrorMock.mock.calls[0].arguments[1],
      exitCodes.validationError,
    );
  });

  it("should parse tmux options correctly", async () => {
    exitWithErrorMock.mock.resetCalls();
    isInsideTmuxMock.mock.resetCalls();

    // Mock not being inside tmux
    isInsideTmuxMock.mock.mockImplementation(() => Promise.resolve(false));

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
        call.arguments[0],
        "The --tmux option can only be used inside a tmux session",
      );
      equal(call.arguments[1], exitCodes.validationError);
    }
  });
});
