# Phantom

Development of Phantom, the Git worktree manager, has ended.

Phantom is being rebuilt from scratch as a tool designed to work closely with AI agents. That work is in progress.

The previous version's README is at <https://github.com/phantompane/phantom/blob/main/README.md>.

## User preferences

`ptm` stores user preferences in `$XDG_CONFIG_HOME/ptm/config.toml` (default `~/.config/ptm/config.toml`). `ptm preferences get`, `set`, and `remove` read and write that file. The first `set` creates the directory and file.

```toml
worktrees-directory = "../phantom-worktrees"
directory-name-separator = "-"
keep-branch = false
ghq-discovery = true
root = "~/ghq"
```

`root` is where `ptm clone` places repositories. It is an absolute path or a path starting with `~/`. When `root` is unset, `ptm clone` uses the first `git config ghq.root` value, then `$GHQ_ROOT`, then `~/ghq`. `project list` scans that same directory.

## Cloning repositories

`ptm clone` clones a Git repository into `<root>/<host>/<owner>/<repo>` and registers it. `owner/repo` uses `github.com`. The command accepts `https` and `http` URLs, `ssh://` URLs, scp-style `git@host:owner/repo` paths, `host/owner/repo`, and `owner/repo`.

```bash
ptm clone aku11i/phantom
ptm clone git@github.com:aku11i/phantom.git --branch next
ptm clone github.com/aku11i/phantom --depth 1
ptm clone aku11i/phantom --update
```

If that path is already the same repository, `ptm` registers it and prints the path instead of cloning again. `--update` fetches `origin` in that case. If the path exists but is a different repository, the command exits with a validation error. `--branch` and `--depth` apply only to a new clone.

Authentication is left to Git. `ptm` does not call `gh`. Git's progress is written to stderr. Worktrees for the cloned repository stay under its `.git/phantom/worktrees` directory.

## Copying gitignored files

`ptm create` and `ptm attach` read `.worktreeinclude` from the root of the source checkout. The file uses gitignore syntax. A file is copied only when a pattern matches it and Git ignores it, so tracked files are never duplicated.

```text
.env
.env.local
config/secrets.json
```

Files that already exist in the new worktree are left unchanged. Symlinks are skipped and are not followed. A `.worktreeinclude` that is itself a symlink is not read.

`--copy-file` adds extra gitignore patterns for that command.

## Project hooks

`.ptm.toml` is read from the source checkout: the checkout where the command runs (`git rev-parse --show-toplevel`). `.worktreeinclude` is read from that same checkout.

```toml
[hooks]
post-create = ["pnpm install"]
pre-delete = ["./scripts/teardown.sh"]
```

`ptm create` and `ptm attach` run `post-create` in the new worktree. `ptm delete` runs `pre-delete` in the worktree before removing it. Commands run in order and stop at the first failure. Unknown keys are rejected.

Each hook receives:

- `PTM` — `1`
- `PTM_NAME` — worktree name
- `PTM_PATH` — absolute path of the worktree directory
- `PTM_ROOT_PATH` — path of the source checkout

## Worktree environment

`ptm exec` and `--exec` export:

- `PTM` — `1`
- `PTM_NAME` — worktree name
- `PTM_PATH` — absolute path of the worktree directory

## Machine-readable JSON

`--json` prints one pretty-printed JSON document to **stdout** and exits nonzero on failure. Field names are camelCase, the same convention as `project list --json` (`rootPath`, `createdAt`). Parsers must ignore unknown fields. Adding a field does not change `version`. Removing, renaming, or changing the meaning of a field does.

Worktree commands and every `--json` error use schema version **1**. `project list --json` keeps its own catalog version (currently 2).

In `--json` mode, stdout is only that document. Progress lines, warnings, hook command output, and `--exec` output go to **stderr**. `--json` cannot be combined with `list --names`. `list --names` stays available for the one-name-per-line human format.

### Errors

A command that does not produce a result writes this object to stdout:

```json
{
  "version": 1,
  "error": {
    "message": "Worktree 'topic' not found",
    "code": "not_found",
    "exitCode": 2
  }
}
```

`code` is the stable machine code. `exitCode` is the process status: `1` general, `2` not found (`where`, `delete`, and `exec`), `3` validation (an invalid worktree name, or an unknown or incomplete option on any command), `4` not a repository. `code` values include `not_found`, `already_exists`, `branch_not_found`, `not_repository`, `uncommitted`, `validation`, `command_failed`, `spawn`, `signaled`, `projects`, and `error`.

`delete --json` is the exception that can include both deleted entries and a top-level `error`. Entries that were removed stay in `deleted`. The failed name has `worktree: null` and a string `error`. The process still exits nonzero.

`create` and `attach` still print the result object when the worktree exists but a post-create hook or `--exec` fails, including when that command is killed by a signal or the shell fails to start. The process exits with that command's status. `postCreate.ok` or `exec.ok` is false. That is not the error envelope. A pre-delete hook that exits nonzero, is signaled, or fails to start still aborts deletion.

### Worktree object

`list`, `where`, `create`, `attach`, `delete`, and `github checkout` share this object. `path` is absolute. `head` is the full HEAD SHA, or null when Git has no HEAD. `branch` is null when HEAD is detached (`detached` is true). `base` is the commit-ish this command started from, when it knows one, and null otherwise. `dirty` is true when `git status --porcelain` reports any change. `default` is true for the repository's primary checkout.

```json
{
  "name": "feature/add-tests",
  "path": "/repo/.git/phantom/worktrees/feature/add-tests",
  "branch": "feature/add-tests",
  "head": "0123456789abcdef0123456789abcdef01234567",
  "base": "HEAD",
  "dirty": false,
  "default": false,
  "detached": false
}
```

The object is intentionally open. Ownership and purpose metadata (owner, purpose, createdAt, lastUsedAt, links) and cleanup details (prunable, locked) can be added later without a new version.

### Commands

`list --json`:

```json
{ "version": 1, "worktrees": [] }
```

`where --json` and the result of a create, attach, or checkout use the worktree object. `where` returns:

```json
{ "version": 1, "worktree": {} }
```

`create --json` and `attach --json`:

```json
{
  "version": 1,
  "worktree": {},
  "copyFiles": { "ok": true, "error": null },
  "postCreate": { "ran": false, "ok": true, "command": null, "exitCode": null, "signal": null, "error": null },
  "exec": null
}
```

`copyFiles.ok` is false when copying `.worktreeinclude` matches fails. The worktree is still created. `postCreate.ran` is false when no hook is configured. On success, `exitCode` is 0 and `command`, `signal`, and `error` are null. On failure, `command` is the hook that failed and `exitCode` is its status. `exec` is null when `--exec` was not passed. Otherwise it is `{ "ok": true, "command": "npm test", "exitCode": 0, "signal": null, "error": null }`. For both `postCreate` and `exec`, `signal` is the signal name when the process was killed, and `exitCode` is `128` plus the signal number (`143` for `SIGTERM`, `130` for `SIGINT`, `137` for `SIGKILL`, `129` for `SIGHUP`). `error` is set when the shell or program failed to start. `ok` is false in both cases, and the worktree object is still returned.

`attach` leaves `worktree.base` null. `create` sets it to the requested base (`HEAD` when omitted).

`delete --json`:

```json
{
  "version": 1,
  "deleted": [
    {
      "worktree": {},
      "branchDeleted": true,
      "branchError": null,
      "error": null
    }
  ],
  "error": null
}
```

`branchDeleted` is false for a detached HEAD, for `--keep-branch`, and when deleting the branch failed. A failed branch delete sets `branchError` and still exits 0. A fatal per-item failure sets `error` on that entry and the top-level `error` object, and exits nonzero.

`github checkout --json`:

```json
{
  "version": 1,
  "worktree": {},
  "github": {
    "kind": "pullRequest",
    "number": 123,
    "headRef": "feature/add-logging",
    "alreadyExists": false
  },
  "copyFiles": { "ok": true, "error": null },
  "postCreate": { "ran": false, "ok": true, "command": null, "exitCode": null, "signal": null, "error": null }
}
```

`github.kind` is `pullRequest` or `issue`. `headRef` is the pull request head ref, and null for an issue. `worktree.base` is the fetched upstream for a new pull request, the requested base for a new issue, and null when the worktree already existed.

### Project list

`project list --json` is unchanged. It uses camelCase and absolute `rootPath` values. Warnings stay on stderr.

```json
{
  "version": 2,
  "projects": [
    {
      "source": "registry",
      "id": "proj_550e8400-e29b-41d4-a716-446655440000",
      "name": "repo",
      "rootPath": "/abs/repo",
      "createdAt": "2026-01-01T00:00:00.000Z"
    },
    {
      "source": "ghq",
      "name": "repo",
      "rootPath": "/abs/ghq/repo"
    }
  ]
}
```

`project add --json` and `project remove --json` still return `{ "status", "project" }`. Their errors use the version 1 error object above.

### Clone

`clone --json` uses schema version 1. `path` is the absolute Git root. `remoteUrl` is the URL passed to `git clone` (`https://github.com/<owner>/<repo>.git` for `owner/repo` and `host/owner/repo`). `cloned` is true when this command created the checkout. `updated` is true only when `--update` fetched an existing checkout. Git's progress stays on stderr.

```json
{
  "version": 1,
  "path": "/home/phantom/ghq/github.com/aku11i/phantom",
  "host": "github.com",
  "owner": "aku11i",
  "repo": "phantom",
  "remoteUrl": "https://github.com/aku11i/phantom.git",
  "cloned": true,
  "updated": false
}
```

A failed clone uses the version 1 error object. A destination that is not the expected repository is `validation` / exit code 3. A Git failure is `command_failed` with Git's exit code.
