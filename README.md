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

`root` is where `ptm clone` places repositories. It is an absolute path or a path starting with `~/`. When `root` is unset, `ptm clone` uses the first `git config ghq.root` value, then `$GHQ_ROOT`, then `~/ghq`. A configured `root` is used without reading git config. If reading `ghq.root` fails, `ptm` warns and continues with `$GHQ_ROOT` or `~/ghq`. `project list` scans that same directory.

## Cloning repositories

`ptm clone` clones a Git repository into `<root>/<host>/<owner>/<repo>` and registers it. `owner/repo` uses `github.com`. The command accepts `https` and `http` URLs, `ssh://` URLs, scp-style `git@host:owner/repo` paths, `host/owner/repo`, and `owner/repo`. The host directory is lowercased, and a URL port is part of it (`example.net:9443`). `file://` URLs are rejected. A local path has no host, owner, and repository to place under that layout. A clone that exits early can leave a hidden `.ptm-clone-<pid>-<uuid>` directory beside the destination. A later clone in that directory removes it when the recorded process is no longer running.

```bash
ptm clone aku11i/phantom
ptm clone git@github.com:aku11i/phantom.git --branch next
ptm clone github.com/aku11i/phantom --depth 1
ptm clone aku11i/phantom --update
```

If that path is already the same repository, `ptm` registers it and prints the path instead of cloning again. `--update` fetches `origin` in that case. If the path exists but is a different repository, the command exits with a validation error. `--branch` and `--depth` apply only to a new clone.

Authentication is left to Git. `ptm` does not call `gh`. Git's progress is written to stderr. Worktrees for the cloned repository stay under its `.git/ptm/worktrees` directory.

## Targeting a project

Worktree commands (`create`, `attach`, `list`, `where`, `delete`, `exec`, and `github checkout`) accept `--project <ref>` (`-p`) so they can run against a repository other than the current directory. Those commands accept it anywhere their other options are accepted. `ptm exec` is the exception: it parses ptm options only before the worktree name, and passes everything after that name to the command. This runs `pwd --project y` inside the `feature` worktree of `owner/repo`:

```bash
ptm exec --project owner/repo feature pwd --project y
ptm list --project ~/src/foo --json
```

A ref that starts with `/`, `.`, or `~` is a directory. It can be anywhere inside the repository, including a linked worktree, and resolves to the main checkout. Hooks and `.worktreeinclude` are read from that main checkout.

Any other ref is matched against registered projects and discovered checkouts (the same set as `project list`, including when `ghq-discovery` is false). The canonical name is `host/owner/repo`: from the `origin` URL when it is an http(s), ssh, or scp-style remote, otherwise from a checkout stored at `<root>/<host>/<owner>/<repo>`. A local or relative origin, including `backups/widget.git`, is not a host-based name. `owner/repo` and `repo` match when only one project has that suffix. The directory name shown by `project list` matches too, including when it differs from the canonical name. A location name that differs from the remote also matches. Several matches is a validation error (exit code 3) that lists the candidates. No match is not found (exit code 2). A path that does not exist is not found and says the path does not exist. A `--project` value that starts with `-` is a validation error.

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

`code` is the stable machine code. `exitCode` is the process status: `1` general, `2` not found (`where`, `delete`, and `exec`, and a `--project` name or path that matches nothing), `3` validation (an invalid worktree name, an unknown or incomplete option on any command, or a `--project` name that matches more than one project), `4` not a repository. `code` values include `not_found`, `already_exists`, `branch_not_found`, `not_repository`, `uncommitted`, `validation`, `command_failed`, `spawn`, `signaled`, `projects`, and `error`.

`delete --json` is the exception that can include both deleted entries and a top-level `error`. Entries that were removed stay in `deleted`. The failed name has `worktree: null` and a string `error`. The process still exits nonzero.

`create` and `attach` still print the result object when the worktree exists but a post-create hook or `--exec` fails, including when that command is killed by a signal or the shell fails to start. The process exits with that command's status. `postCreate.ok` or `exec.ok` is false. That is not the error envelope. A pre-delete hook that exits nonzero, is signaled, or fails to start still aborts deletion.

### Worktree object

`list`, `where`, `create`, `attach`, `delete`, and `github checkout` share this object. `path` is absolute. `head` is the full HEAD SHA, or null when Git has no HEAD. `branch` is null when HEAD is detached (`detached` is true). `base` is the commit-ish this command started from, when it knows one, and null otherwise. `dirty` is true when `git status --porcelain` reports any change. `default` is true for the repository's primary checkout.

```json
{
  "name": "feature/add-tests",
  "path": "/repo/.git/ptm/worktrees/feature/add-tests",
  "branch": "feature/add-tests",
  "head": "0123456789abcdef0123456789abcdef01234567",
  "base": "HEAD",
  "dirty": false,
  "default": false,
  "detached": false,
  "owner": "grok",
  "purpose": "fix the flaky checkout test",
  "createdAt": "2026-10-18T11:46:00.000Z",
  "lastUsedAt": "2026-10-18T11:46:00.000Z",
  "links": {
    "pr": { "number": 774, "url": null },
    "issue": null
  }
}
```

`owner`, `purpose`, `createdAt`, `lastUsedAt`, and `links` come from `ptm/worktrees.json` in the Git common directory (`git rev-parse --git-common-dir`). For a normal repository that directory is `.git`. `ptm create`, `ptm attach`, and `ptm github checkout` write a record. `owner` is `--owner` or `PTM_AGENT_ID`, and null when neither is set. `links.pr` and `links.issue` are `{ "number", "url" }` or null. A number stores `url` as null. An http(s) URL stores the URL and a number parsed from `/pull/`, `/pulls/`, `/issues/`, or `/issue/` when one is present. `github checkout` fills the matching link, including `https://<host>/<owner>/<repo>/pull/<number>` or `.../issues/<number>`. `where` and `exec` refresh `lastUsedAt` when a record already exists. A failure to update it is a warning on stderr and does not change the exit code. `delete` removes the record after Git removes the worktree. `create` and `attach` replace any record already stored at that path. `meta set` and a second `github checkout` of a worktree that already exists patch the record. `create --json` and `attach --json` include `metadata` as `{ "ok": true, "error": null }`. When saving the record fails after the worktree exists, `ok` is false, `error` explains why, copy and hooks still run, and the process exits 1. The stdout document is the result object, not the error envelope. A corrupt `worktrees.json` makes `list`, `where`, and `exec` continue with null metadata fields and a stderr warning. `create`, `attach`, `delete`, `meta set`, and `github checkout` refuse and leave the file unchanged. `ptm meta set` patches the fields you pass and leaves the others. A worktree Git created outside `ptm`, including the default checkout, has null metadata fields until `meta set` or `github checkout` records it. Cleanup details (`prunable`, `locked`) can be added later without a new version.

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

`gc --json` is a dry run unless `--apply` or `--force` is set. A branch that still points at the commit it was created from is not merged. A worktree checked out on the default branch is kept. `gh pr view` receives the stored pull request URL when one was recorded. A number with no confirmed repository is unavailable, and gc says so instead of ignoring the link. `applied` is true when a removal was requested. Each candidate names the worktree, why it matched (`merged`, `pullRequest`, `orphaned`, `olderThan`), and `action`: `wouldRemove`, `removed`, `skipped`, or `failed`. `detail` explains a skip or a failure. `branchDeleted` is null on a dry run and on a skip. A removal failure sets the top-level `error` object and exits 1, and the other candidates are still listed. An empty plan exits 0.

```json
{
  "version": 1,
  "applied": false,
  "candidates": [
    {
      "name": "feature",
      "path": "/repo/.git/ptm/worktrees/feature",
      "branch": "feature",
      "owner": "grok",
      "reasons": ["merged"],
      "action": "wouldRemove",
      "detail": null,
      "branchDeleted": null
    }
  ],
  "error": null
}
```

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

`project list --json` keeps catalog version 2. It uses camelCase and absolute `rootPath` values. Each project includes `canonicalName` (`host/owner/repo` from `origin`, otherwise from a `<root>/<host>/<owner>/<repo>` checkout, otherwise the directory name). `name` stays the directory name. Warnings stay on stderr. Parsers must ignore unknown fields, so adding `canonicalName` does not change `version`.

```json
{
  "version": 2,
  "projects": [
    {
      "source": "registry",
      "id": "proj_550e8400-e29b-41d4-a716-446655440000",
      "name": "phantom",
      "canonicalName": "github.com/aku11i/phantom",
      "rootPath": "/home/phantom/ghq/github.com/aku11i/phantom",
      "createdAt": "2026-01-01T00:00:00.000Z"
    },
    {
      "source": "ghq",
      "name": "repo",
      "canonicalName": "github.com/owner/repo",
      "rootPath": "/home/phantom/ghq/github.com/owner/repo"
    }
  ]
}
```

`project add --json` and `project remove --json` still return `{ "status", "project" }`. Their errors use the version 1 error object above.

### Clone

`clone --json` uses schema version 1. `path` is the absolute Git root. `host` is lowercased and includes a port when the URL has one. `remoteUrl` is the clone URL with that same lowercased host. `http` and `https` userinfo is removed, including a token used as the username (`https://github.com/<owner>/<repo>.git` for `owner/repo` and `host/owner/repo`). `ssh` and scp-style URLs keep the login name. `cloned` is true when this command created the checkout. `updated` is true only when `--update` fetched an existing checkout. Git's progress stays on stderr.

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

A failed clone uses the version 1 error object. A destination that is not the expected repository is `validation` / exit code 3. A path component the filesystem rejects, such as a name longer than the filename limit, is also `validation` / exit code 3. If Git cannot read its configuration while inspecting an existing checkout, the error includes Git's message and uses exit code 1. A Git failure during clone or fetch is `command_failed` with Git's exit code.
