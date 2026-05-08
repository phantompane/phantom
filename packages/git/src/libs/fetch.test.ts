import { deepEqual, equal, ok } from "node:assert/strict";
import { describe, it, vi } from "vitest";
import { isErr } from "@phantompane/utils";

const executeGitCommandMock = vi.fn();

vi.doMock("../executor.ts", () => ({
  executeGitCommand: executeGitCommandMock,
}));

const { fetch } = await import("./fetch.ts");

describe("fetch", () => {
  const resetMocks = () => {
    executeGitCommandMock.mockClear();
  };

  it("should export fetch function", () => {
    equal(typeof fetch, "function");
  });

  it("should fetch with default remote", async () => {
    resetMocks();
    executeGitCommandMock.mockImplementation(async () => ({
      stdout: "",
      stderr: "",
    }));

    const result = await fetch();

    ok(result.ok);
    equal(executeGitCommandMock.mock.calls.length, 1);
    deepEqual(executeGitCommandMock.mock.calls[0][0], ["fetch", "origin"]);
  });

  it("should fetch with custom remote", async () => {
    resetMocks();
    executeGitCommandMock.mockImplementation(async () => ({
      stdout: "",
      stderr: "",
    }));

    const result = await fetch({ remote: "upstream" });

    ok(result.ok);
    deepEqual(executeGitCommandMock.mock.calls[0][0], ["fetch", "upstream"]);
  });

  it("should fetch with refspec", async () => {
    resetMocks();
    executeGitCommandMock.mockImplementation(async () => ({
      stdout: "",
      stderr: "",
    }));

    const result = await fetch({ refspec: "pull/123/head:pr-123" });

    ok(result.ok);
    deepEqual(executeGitCommandMock.mock.calls[0][0], [
      "fetch",
      "origin",
      "pull/123/head:pr-123",
    ]);
  });

  it("should fetch with custom remote and refspec", async () => {
    resetMocks();
    executeGitCommandMock.mockImplementation(async () => ({
      stdout: "",
      stderr: "",
    }));

    const result = await fetch({
      remote: "upstream",
      refspec: "main:upstream-main",
    });

    ok(result.ok);
    deepEqual(executeGitCommandMock.mock.calls[0][0], [
      "fetch",
      "upstream",
      "main:upstream-main",
    ]);
  });

  it("should pass cwd option", async () => {
    resetMocks();
    executeGitCommandMock.mockImplementation(async () => ({
      stdout: "",
      stderr: "",
    }));

    await fetch({ cwd: "/path/to/repo" });

    equal(executeGitCommandMock.mock.calls[0][1].cwd, "/path/to/repo");
  });

  it("should handle fetch errors", async () => {
    resetMocks();
    executeGitCommandMock.mockImplementation(async () => {
      throw new Error("fatal: couldn't find remote ref");
    });

    const result = await fetch({ refspec: "invalid:ref" });

    ok(isErr(result));
    ok(result.error.message.includes("git fetch failed"));
    ok(result.error.message.includes("fatal: couldn't find remote ref"));
  });

  it("should handle non-Error exceptions", async () => {
    resetMocks();
    executeGitCommandMock.mockImplementation(async () => {
      throw "Network error";
    });

    const result = await fetch();

    ok(isErr(result));
    ok(result.error.message.includes("git fetch failed"));
    ok(result.error.message.includes("Network error"));
  });
});
