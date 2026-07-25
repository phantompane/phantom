import { deepStrictEqual, rejects, strictEqual } from "node:assert";
import { describe, it } from "vitest";
import {
  DEFAULT_GHQ_DISCOVERY_TIMEOUT_MS,
  discoverGhqRepositories,
  GhqDiscoveryError,
  type GhqCommandRunner,
  type GhqCommandOptions,
} from "./ghq.ts";

describe("discoverGhqRepositories", () => {
  it("runs ghq list --full-path with a finite timeout and returns normalized absolute paths", async () => {
    const calls: Array<{
      command: string;
      args: readonly string[];
      options: GhqCommandOptions;
    }> = [];
    const commandRunner: GhqCommandRunner = async (command, args, options) => {
      calls.push({ command, args, options });
      return {
        stdout:
          "/work/github.com/example/alpha/\n/work/github.com/example/beta\n",
        stderr: "",
      };
    };

    const result = await discoverGhqRepositories({ commandRunner });

    deepStrictEqual(calls, [
      {
        command: "ghq",
        args: ["list", "--full-path"],
        options: { timeoutMs: DEFAULT_GHQ_DISCOVERY_TIMEOUT_MS },
      },
    ]);
    deepStrictEqual(result, {
      available: true,
      rootPaths: [
        "/work/github.com/example/alpha",
        "/work/github.com/example/beta",
      ],
    });
  });

  it("passes a custom timeout to the command runner", async () => {
    let receivedOptions: GhqCommandOptions | undefined;
    const commandRunner: GhqCommandRunner = async (
      _command,
      _args,
      options,
    ) => {
      receivedOptions = options;
      return { stdout: "", stderr: "" };
    };

    await discoverGhqRepositories({
      commandRunner,
      timeoutMs: 250,
    });

    deepStrictEqual(receivedOptions, { timeoutMs: 250 });
  });

  it("ignores blank lines and deterministically deduplicates normalized paths", async () => {
    const commandRunner: GhqCommandRunner = async () => ({
      stdout:
        "\n  /work/zeta  \r\n/work/alpha/../beta/\n/work/beta\n\t\n/work/zeta\n",
      stderr: "",
    });

    const result = await discoverGhqRepositories({ commandRunner });

    deepStrictEqual(result, {
      available: true,
      rootPaths: ["/work/beta", "/work/zeta"],
    });
  });

  it("reports ghq as unavailable when the executable is not found", async () => {
    const commandRunner: GhqCommandRunner = async () => {
      throw Object.assign(new Error("spawn ghq ENOENT"), { code: "ENOENT" });
    };

    deepStrictEqual(await discoverGhqRepositories({ commandRunner }), {
      available: false,
      rootPaths: [],
    });
  });

  it("wraps nonzero command failures in GhqDiscoveryError", async () => {
    const commandFailure = Object.assign(new Error("Command failed"), {
      code: 2,
      stderr: "ghq: unknown option --full-path\n",
    });
    const commandRunner: GhqCommandRunner = async () => {
      throw commandFailure;
    };

    await rejects(
      discoverGhqRepositories({ commandRunner }),
      (error: unknown) => {
        strictEqual(error instanceof GhqDiscoveryError, true);
        if (!(error instanceof GhqDiscoveryError)) {
          return false;
        }
        strictEqual(
          error.message,
          "Failed to discover ghq repositories: ghq: unknown option --full-path",
        );
        strictEqual(error.exitCode, 2);
        strictEqual(error.stderr, "ghq: unknown option --full-path");
        strictEqual(error.cause, commandFailure);
        return true;
      },
    );
  });

  it("wraps timeout failures in GhqDiscoveryError", async () => {
    const timeoutFailure = Object.assign(
      new Error("Command failed: ghq list --full-path"),
      {
        code: null,
        killed: true,
        signal: "SIGTERM",
        stderr: "",
      },
    );
    const commandRunner: GhqCommandRunner = async () => {
      throw timeoutFailure;
    };

    await rejects(
      discoverGhqRepositories({ commandRunner, timeoutMs: 10 }),
      (error: unknown) => {
        strictEqual(error instanceof GhqDiscoveryError, true);
        if (!(error instanceof GhqDiscoveryError)) {
          return false;
        }
        strictEqual(
          error.message,
          "Failed to discover ghq repositories: timed out after 10 ms",
        );
        strictEqual(error.exitCode, undefined);
        strictEqual(error.stderr, "");
        strictEqual(error.cause, timeoutFailure);
        return true;
      },
    );
  });
});
