import { deepStrictEqual, ok } from "node:assert";
import type { ExecFileException } from "node:child_process";
import { normalize } from "node:path";
import { describe, it, vi } from "vitest";

const execFileMock = vi.fn();

const mockCwd = () =>
  vi.spyOn(process, "cwd").mockImplementation(() => "/test/repo");

vi.doMock("node:child_process", () => ({
  execFile: (
    cmd: string,
    args: string[],
    options: { cwd?: string; env?: NodeJS.ProcessEnv; encoding: string },
    callback?: (
      error: ExecFileException | null,
      result?: { stdout: string; stderr: string },
    ) => void,
  ) => {
    const result = execFileMock(cmd, args, options);
    if (callback) {
      result.then(
        (res: { stdout: string; stderr: string }) => callback(null, res),
        (err: ExecFileException) => callback(err),
      );
    }
    return {};
  },
}));

vi.doMock("node:util", () => ({
  promisify: () => execFileMock,
}));
const { listWorktrees } = await import("./list.ts");

const normalizeWorktrees = (
  worktrees: Array<{
    name: string;
    path: string;
    pathToDisplay: string;
    branch: string;
    isClean: boolean;
  }>,
) =>
  worktrees.map((worktree) => ({
    ...worktree,
    path: normalize(worktree.path),
    pathToDisplay: normalize(worktree.pathToDisplay),
  }));

describe("listWorktrees", () => {
  it("should include root-level worktree when only root exists", async () => {
    const cwdMock = mockCwd();
    execFileMock.mockImplementation((_cmd, _args, _options) => {
      if (_args.includes("worktree") && _args.includes("list")) {
        return Promise.resolve({
          stdout:
            "worktree /test/repo\nHEAD abc123\nbranch refs/heads/main\n\n",
          stderr: "",
        });
      }
      if (_args.includes("status") && _args.includes("--porcelain")) {
        return Promise.resolve({ stdout: "", stderr: "" });
      }
      return Promise.resolve({ stdout: "", stderr: "" });
    });

    const result = await listWorktrees("/test/repo");

    ok(result.ok);
    if (result.ok) {
      deepStrictEqual(
        normalizeWorktrees(result.value.worktrees),
        normalizeWorktrees([
          {
            name: "main",
            path: "/test/repo",
            pathToDisplay: ".",
            branch: "main",
            isClean: true,
          },
        ]),
      );
      deepStrictEqual(result.value.message, undefined);
    }

    execFileMock.mockClear();
    cwdMock.mockRestore();
  });

  it("should return empty array when excluding default worktree", async () => {
    const cwdMock = mockCwd();
    execFileMock.mockImplementation((_cmd, _args, _options) => {
      if (_args.includes("worktree") && _args.includes("list")) {
        return Promise.resolve({
          stdout:
            "worktree /test/repo\nHEAD abc123\nbranch refs/heads/main\n\n",
          stderr: "",
        });
      }
      if (_args.includes("status") && _args.includes("--porcelain")) {
        return Promise.resolve({ stdout: "", stderr: "" });
      }
      return Promise.resolve({ stdout: "", stderr: "" });
    });

    const result = await listWorktrees("/test/repo", {
      excludeDefault: true,
    });

    ok(result.ok);
    if (result.ok) {
      deepStrictEqual(result.value.worktrees, []);
      deepStrictEqual(result.value.message, "No sub worktrees found");
    }

    execFileMock.mockClear();
    cwdMock.mockRestore();
  });

  it("should list worktrees with clean status", async () => {
    const cwdMock = mockCwd();
    execFileMock.mockImplementation((_cmd, _args, _options) => {
      if (_args.includes("worktree") && _args.includes("list")) {
        return Promise.resolve({
          stdout: `worktree /test/repo
HEAD abc123
branch refs/heads/main

worktree /test/repo/.git/phantom/worktrees/feature-1
HEAD def456
branch refs/heads/feature-1

worktree /test/repo/.git/phantom/worktrees/feature-2
HEAD ghi789
branch refs/heads/feature-2
`,
          stderr: "",
        });
      }
      if (_args.includes("status") && _args.includes("--porcelain")) {
        return Promise.resolve({ stdout: "", stderr: "" });
      }
      return Promise.resolve({ stdout: "", stderr: "" });
    });

    const result = await listWorktrees("/test/repo");

    ok(result.ok);
    if (result.ok) {
      deepStrictEqual(
        normalizeWorktrees(result.value.worktrees),
        normalizeWorktrees([
          {
            name: "main",
            path: "/test/repo",
            pathToDisplay: ".",
            branch: "main",
            isClean: true,
          },
          {
            name: "feature-1",
            path: "/test/repo/.git/phantom/worktrees/feature-1",
            pathToDisplay: ".git/phantom/worktrees/feature-1",
            branch: "feature-1",
            isClean: true,
          },
          {
            name: "feature-2",
            path: "/test/repo/.git/phantom/worktrees/feature-2",
            pathToDisplay: ".git/phantom/worktrees/feature-2",
            branch: "feature-2",
            isClean: true,
          },
        ]),
      );
    }

    execFileMock.mockClear();
    cwdMock.mockRestore();
  });

  it("should handle worktrees with dirty status", async () => {
    const cwdMock = mockCwd();
    execFileMock.mockImplementation((_cmd, _args, _options) => {
      if (_args.includes("worktree") && _args.includes("list")) {
        return Promise.resolve({
          stdout: `worktree /test/repo
HEAD abc123
branch refs/heads/main

worktree /test/repo/.git/phantom/worktrees/dirty-feature
HEAD def456
branch refs/heads/dirty-feature
`,
          stderr: "",
        });
      }
      if (_args.includes("status") && _args.includes("--porcelain")) {
        const isDirtyFeature = _args.includes(
          "/test/repo/.git/phantom/worktrees/dirty-feature",
        );
        return Promise.resolve({
          stdout: isDirtyFeature ? "M file.txt\n" : "",
          stderr: "",
        });
      }
      return Promise.resolve({ stdout: "", stderr: "" });
    });

    const result = await listWorktrees("/test/repo");

    ok(result.ok);
    if (result.ok) {
      deepStrictEqual(
        normalizeWorktrees(result.value.worktrees),
        normalizeWorktrees([
          {
            name: "main",
            path: "/test/repo",
            pathToDisplay: ".",
            branch: "main",
            isClean: true,
          },
          {
            name: "dirty-feature",
            path: "/test/repo/.git/phantom/worktrees/dirty-feature",
            pathToDisplay: ".git/phantom/worktrees/dirty-feature",
            branch: "dirty-feature",
            isClean: false,
          },
        ]),
      );
    }

    execFileMock.mockClear();
    cwdMock.mockRestore();
  });

  it("should handle detached HEAD state", async () => {
    const cwdMock = mockCwd();
    execFileMock.mockImplementation((_cmd, _args, _options) => {
      if (_args.includes("worktree") && _args.includes("list")) {
        return Promise.resolve({
          stdout: `worktree /test/repo
HEAD abc123
branch refs/heads/main

worktree /test/repo/.git/phantom/worktrees/detached
HEAD def456
detached
`,
          stderr: "",
        });
      }
      if (_args.includes("status") && _args.includes("--porcelain")) {
        return Promise.resolve({ stdout: "", stderr: "" });
      }
      return Promise.resolve({ stdout: "", stderr: "" });
    });

    const result = await listWorktrees("/test/repo");

    ok(result.ok);
    if (result.ok) {
      deepStrictEqual(
        normalizeWorktrees(result.value.worktrees),
        normalizeWorktrees([
          {
            name: "main",
            path: "/test/repo",
            pathToDisplay: ".",
            branch: "main",
            isClean: true,
          },
          {
            name: "def456",
            path: "/test/repo/.git/phantom/worktrees/detached",
            pathToDisplay: ".git/phantom/worktrees/detached",
            branch: "def456",
            isClean: true,
          },
        ]),
      );
    }

    execFileMock.mockClear();
    cwdMock.mockRestore();
  });

  it("should include non-phantom worktrees including root siblings", async () => {
    const cwdMock = mockCwd();
    execFileMock.mockImplementation((_cmd, _args, _options) => {
      if (_args.includes("worktree") && _args.includes("list")) {
        return Promise.resolve({
          stdout: `worktree /test/repo
HEAD abc123
branch refs/heads/main

worktree /test/repo/.git/phantom/worktrees/phantom-feature
HEAD def456
branch refs/heads/phantom-feature

worktree /test/repo/other-worktree
HEAD ghi789
branch refs/heads/other-feature

worktree /test/other-worktree-sibling
HEAD jkl012
branch refs/heads/sibling-feature
`,
          stderr: "",
        });
      }
      if (_args.includes("status") && _args.includes("--porcelain")) {
        return Promise.resolve({ stdout: "", stderr: "" });
      }
      return Promise.resolve({ stdout: "", stderr: "" });
    });

    const result = await listWorktrees("/test/repo");

    ok(result.ok);
    if (result.ok) {
      deepStrictEqual(
        normalizeWorktrees(result.value.worktrees),
        normalizeWorktrees([
          {
            name: "main",
            path: "/test/repo",
            pathToDisplay: ".",
            branch: "main",
            isClean: true,
          },
          {
            name: "phantom-feature",
            path: "/test/repo/.git/phantom/worktrees/phantom-feature",
            pathToDisplay: ".git/phantom/worktrees/phantom-feature",
            branch: "phantom-feature",
            isClean: true,
          },
          {
            name: "other-feature",
            path: "/test/repo/other-worktree",
            pathToDisplay: "other-worktree",
            branch: "other-feature",
            isClean: true,
          },
          {
            name: "sibling-feature",
            path: "/test/other-worktree-sibling",
            pathToDisplay: "../other-worktree-sibling",
            branch: "sibling-feature",
            isClean: true,
          },
        ]),
      );
    }

    execFileMock.mockClear();
    cwdMock.mockRestore();
  });

  it("should return message when no worktrees are returned", async () => {
    const cwdMock = mockCwd();
    execFileMock.mockImplementation((_cmd, _args, _options) => {
      if (_args.includes("worktree") && _args.includes("list")) {
        return Promise.resolve({
          stdout: "",
          stderr: "",
        });
      }
      return Promise.resolve({ stdout: "", stderr: "" });
    });

    const result = await listWorktrees("/test/repo");

    ok(result.ok);
    if (result.ok) {
      deepStrictEqual(result.value.worktrees, []);
      deepStrictEqual(result.value.message, "No worktrees found");
    }

    execFileMock.mockClear();
    cwdMock.mockRestore();
  });
});
