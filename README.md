# Maboroshi

Maboroshi (幻, "phantom space") — workspaces for parallel coding agents.

Maboroshi manages local Git workspaces so that many coding agents and humans can work independently in the same repository at the same time. A workspace is one checkout of one repository plus what Git doesn't track about it: its name, its owner, its purpose (pull request, issue, base), and its observed state. Today each checkout is a Git worktree.

The Rust rewrite lives on `next` and ships as `v7.0.0-alpha` prereleases on [GitHub Releases](https://github.com/phantompane/phantom/releases) (it is not on npm yet). The previous TypeScript version stays on `main`; its README is at <https://github.com/phantompane/phantom/blob/main/README.md>.

## Why

Git records the code and the checkouts. It does not record who is responsible for a checkout, why it exists, or whether it can be retired. With many agents working in one repository at once, those are the questions nobody can answer. Maboroshi fills that gap on top of plain Git: repositories, branches, and worktrees stay ordinary Git, and `git` keeps working alongside `mabo`.

Workspaces separate files and branches, not processes, ports, databases, or credentials. Maboroshi coordinates workspace boundaries and its own operations; running services side by side is up to your project and its hooks.

## What it does

Maboroshi creates, takes over, and prepares workspaces, keeps them current with their base, and retires them:

- **Allocate and prepare.** `clone` places a repository in the ghq layout. `create`, `attach`, and `github checkout` (alias `gh checkout`) give each piece of work its own worktree, copy ignored files matched by `.worktreeinclude`, and run project hooks in repositories you trust.
- **Identify.** `meta set` records the owner, purpose, linked pull request or issue, and base. New workspaces use `MABO_AGENT_ID` as the owner when nonblank, unless `--owner` overrides it; owner and purpose can be left unset. `list` and `where` show what exists and where.
- **Update.** `sync` fetches, fast-forwards the default branch when possible, and brings selected workspaces up to date with their base.
- **Retire.** `gc` selects workspaces on evidence: merged branches, closed pull requests, orphaned records, and age (`--older-than`).

Every command can run non-interactively. `--json` success output is versioned (`version`, or `schema` for `sync`), except `project add` and `project remove`, which return `{status, project}`. Errors are structured, with stable, documented exit codes (see [Machine-readable JSON](#machine-readable-json)). `exec` passes through the child command's output and exit code instead. Humans use the same commands with plain-text output.

## Safe by default, explicit when you want otherwise

- **Merged, unowned, or old are signals, not permission to delete.** `gc` only prints its plan until you pass `--apply` or `--force` (`--force` also applies the plan). It keeps dirty work and commits it cannot confirm as published or landed unless you pass `--force`. The default-branch, current, and Git-locked worktrees remain protected even with `--force`.
- **Ownership is information, not enforcement.** Naming a workspace explicitly lets `sync` work on it whoever owns it. `gc` can still select other agents' merged, closed-PR, or orphaned workspaces.
- **Pushed history is kept by default.** When integration is needed, `sync` merges the base into published work; rebasing it takes `--rebase --force`. A workspace counts as published when at least one commit beyond its base is reachable from a known remote-tracking ref or configured fetch destination.
- **Non-interactive runs never wait at a prompt.** With a nonblank `MABO_AGENT_ID` or `CI`, with `--json`, or when stdin or stderr is not a terminal, `mabo` itself does not ask questions. If an operation would run untrusted hooks, it refuses before changing the repository and exits 1 (`untrusted` in JSON); `gc` instead skips removals requiring those hooks, without treating the skip as an error. Record trust in advance with `mabo trust --yes`, or skip hooks with `--no-hooks`. Git authentication and your own hooks can still prompt.

## Non-goals

Maboroshi will not become:

- an agent runner or scheduler (launching, supervising, or assigning agents);
- a task tracker or PR bot (assignments, reviews, comments, merges);
- a replacement for everyday Git (commit, push, history editing; only integrating with the base is in scope);
- a sandbox or environment platform (containers, dependencies, secrets, ports, databases); it only runs project hooks;
- a terminal or session manager (tmux, panes, dashboards); it gives you a path;
- security isolation. Ownership is cooperative information, not an access boundary.

## User preferences

`mabo` stores user preferences in `$XDG_CONFIG_HOME/maboroshi/config.toml` (default `~/.config/maboroshi/config.toml`). `mabo preferences get`, `set`, and `remove` read and write that file. The first `set` creates the directory and file.

```toml
worktrees-directory = "../maboroshi-worktrees"
directory-name-separator = "-"
keep-branch = false
ghq-discovery = true
root = "~/ghq"
```

When `worktrees-directory` is unset, `mabo create` and `mabo attach` place the new worktree at `$XDG_DATA_HOME/maboroshi/worktrees/<checkout>-<hash>/<name>`. The fallback is `~/.local/share/maboroshi/worktrees/...` when `XDG_DATA_HOME` is unset, empty, or not absolute. `<checkout>` is the canonical main checkout directory name, with characters outside letters, numbers, `.`, `_`, and `-` replaced by `-`. A symlink to that checkout uses the same directory. `<hash>` is the first 8 hexadecimal digits of the SHA-256 of the canonical Git common directory. Two clones of the same remote get different directories. `directory-name-separator` still applies only inside that project directory. Deleting the last worktree inside that directory removes the project directory only when `.maboroshi-common-dir` names this repository, and does not remove `maboroshi/worktrees`. `delete` and `gc` also remove a linked worktree recorded in `maboroshi/worktrees.json`, including one created under `.git/maboroshi/worktrees` or a different data directory. An unrecorded worktree outside the resolved directory stays. Parent cleanup runs only for a worktree inside the resolved directory. A set `worktrees-directory` is still a path relative to the repository root, and that directory is left in place when it becomes empty.

`root` is where `mabo clone` places repositories. It is an absolute path or a path starting with `~/`. When `root` is unset, `mabo clone` uses the first `git config ghq.root` value, then `$GHQ_ROOT`, then `~/ghq`. A configured `root` is used without reading git config. If reading `ghq.root` fails, `mabo` warns and continues with `$GHQ_ROOT` or `~/ghq`. `project list` scans that same directory.

## Cloning repositories

`mabo clone` clones a Git repository into `<root>/<host>/<owner>/<repo>` and registers it. `owner/repo` uses `github.com`. The command accepts `https` and `http` URLs, `ssh://` URLs, scp-style `git@host:owner/repo` paths, `host/owner/repo`, and `owner/repo`. The host directory is lowercased, and a URL port is part of it (`example.net:9443`). `file://` URLs are rejected. A local path has no host, owner, and repository to place under that layout. A clone that exits early can leave a hidden `.maboroshi-clone-<pid>-<uuid>` directory beside the destination. A later clone in that directory removes it when the recorded process is no longer running.

```bash
mabo clone aku11i/phantom
mabo clone git@github.com:aku11i/phantom.git --branch next
mabo clone github.com/aku11i/phantom --depth 1
mabo clone aku11i/phantom --update
```

If that path is already the same repository, `mabo` registers it and prints the path instead of cloning again. `--update` fetches `origin` in that case. If the path exists but is a different repository, the command exits with a validation error. `--branch` and `--depth` apply only to a new clone.

Authentication is left to Git. `mabo` does not call `gh`. Git's progress is written to stderr. New worktrees for the cloned repository are created under `$XDG_DATA_HOME/maboroshi/worktrees/<checkout>-<hash>` (`~/.local/share/maboroshi/worktrees/...` when `XDG_DATA_HOME` is unset, empty, or relative). `<checkout>` is the canonical main checkout directory name, so a symlink or a non-canonical path uses the same directory. `<hash>` is the first 8 hexadecimal digits of the SHA-256 of the canonical Git common directory, the same path `mabo trust` records. A `worktrees-directory` preference still overrides that location and is joined to the repository root.

## Targeting a project

Worktree commands (`create`, `attach`, `list`, `where`, `delete`, `exec`, and `github checkout`) accept `--project <ref>` (`-p`) so they can run against a repository other than the current directory. Those commands accept it anywhere their other options are accepted. `mabo exec` is the exception: it parses mabo options only before the worktree name, and passes everything after that name to the command. This runs `pwd --project y` inside the `feature` worktree of `owner/repo`:

```bash
mabo exec --project owner/repo feature pwd --project y
mabo list --project ~/src/foo --json
```

A ref that starts with `/`, `.`, or `~` is a directory. It can be anywhere inside the repository, including a linked worktree, and resolves to the main checkout. Hooks and `.worktreeinclude` are read from that main checkout.

Any other ref is matched against registered projects and discovered checkouts (the same set as `project list`, including when `ghq-discovery` is false). The canonical name is `host/owner/repo`: from the `origin` URL when it is an http(s), ssh, or scp-style remote, otherwise from a checkout stored at `<root>/<host>/<owner>/<repo>`. A local or relative origin, including `backups/widget.git`, is not a host-based name. `owner/repo` and `repo` match when only one project has that suffix. The directory name shown by `project list` matches too, including when it differs from the canonical name. A location name that differs from the remote also matches. Several matches is a validation error (exit code 3) that lists the candidates. No match is not found (exit code 2). A path that does not exist is not found and says the path does not exist. A `--project` value that starts with `-` is a validation error.

## Copying gitignored files

`mabo create` and `mabo attach` read `.worktreeinclude` from the root of the source checkout. The file uses gitignore syntax. A file is copied only when a pattern matches it and Git ignores it, so tracked files are never duplicated.

```text
.env
.env.local
config/secrets.json
```

Files that already exist in the new worktree are left unchanged. Symlinks are skipped and are not followed. A `.worktreeinclude` that is itself a symlink is not read.

`--copy-file` adds extra gitignore patterns for that command.

## Project hooks

`.mabo.toml` is read from the source checkout: the checkout where the command runs (`git rev-parse --show-toplevel`). `.worktreeinclude` is read from that same checkout.

```toml
[hooks]
post-create = ["pnpm install"]
pre-delete = ["./scripts/teardown.sh"]
```

`mabo create`, `mabo attach`, and `mabo github checkout` run `post-create` in the new worktree. `mabo delete` and `mabo gc --apply` run `pre-delete` in the worktree before removing it. Commands run in order and stop at the first failure. Unknown keys are rejected.

Hooks run only when that repository is trusted. `.worktreeinclude` copies are not hooks and do not need trust. A repository with no hook commands never asks.

On a terminal, mabo prints the project path and the hook commands, then asks `Trust this project and run its hooks? [y/N]`. `y` or `yes` saves trust and runs the hooks. mabo does not ask when `CI` is set, when `MABO_AGENT_ID` is set, when stdin or stderr is not a terminal, or when `--json` is set. An empty value counts as unset. It then exits 1 before changing the repository, the same as a non-terminal. With `--json`, stdout is only the error object and `code` is `untrusted`. The message tells you to run `mabo trust --yes` or pass `--no-hooks`.

`mabo trust [path]` shows the hooks and asks `Trust this project? [y/N]`. `--yes` skips the question. The same `CI`, `MABO_AGENT_ID`, and terminal rules apply, and `--yes` is how a non-interactive run records trust. `mabo untrust [path]` removes that repository. `mabo trust --list` prints each trusted git common directory and when it was trusted. Trust is keyed by the path of the canonical git common directory, so the main checkout and its linked worktrees share one record. Deleting the checkout and cloning it again at the same path keeps that record. `mabo untrust` clears it. Editing the hook commands later does not ask again.

The record is `$XDG_STATE_HOME/maboroshi/trust.toml` when `XDG_STATE_HOME` is an absolute path, otherwise `~/.local/state/maboroshi/trust.toml`. Each entry stores `path` and `trustedAt`.

`MABO_TRUST_ALL=1` trusts every repository for that process and does not write the file. The value has to be the single character `1`. Use it in CI and containers. `--no-hooks` on `create`, `attach`, `delete`, `gc`, and `github checkout` does the worktree change and skips hooks. It does not write trust.

`mabo gc` never asks, including on a terminal. An untrusted repository that has `pre-delete` hooks is skipped. The candidate detail is `untrusted hooks`. Other candidates still run. `--no-hooks` removes those worktrees without running hooks.

Each hook receives:

- `MABO` — `1`
- `MABO_NAME` — worktree name
- `MABO_PATH` — absolute path of the worktree directory
- `MABO_ROOT_PATH` — path of the source checkout

## Worktree environment

`mabo exec` and `--exec` export:

- `MABO` — `1`
- `MABO_NAME` — worktree name
- `MABO_PATH` — absolute path of the worktree directory

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

`code` is the stable machine code. `exitCode` is the process status: `1` general, `2` not found (`where`, `delete`, and `exec`, and a `--project` name or path that matches nothing), `3` validation (an invalid worktree name, an unknown or incomplete option on any command, or a `--project` name that matches more than one project), `4` not a repository. `code` values include `not_found`, `already_exists`, `branch_not_found`, `not_repository`, `uncommitted`, `unpushed`, `validation`, `command_failed`, `spawn`, `signaled`, `projects`, `untrusted`, and `error`. `untrusted` exits 1. It means project hooks would have run and the repository is not trusted. Nothing was created or deleted. `unpushed` exits 3. `delete` returns it when removing the worktree would drop commits that are not on the default branch or a remote, and when that check cannot be completed. A branch whose upstream ref is gone counts as already on the default branch when a clean merge leaves that branch's tree unchanged and the branch diff is not empty. A conflict, an empty diff, or a failed git command stays an unpushed refusal. A branch is told to use `--keep-branch` or `--force`. A detached HEAD is told to use `--force`. `delete` of several names checks every name before it removes any. If one is refused, none are removed. `delete` returns `validation` when it runs inside the worktree being deleted, unless `--current` or `--force` is set.

`delete --json` can include `deleted` entries and a top-level `error`. If any name fails the checks, nothing is removed and `deleted` lists every refusal. A missing name has `worktree: null` and a string `error`. If removal fails after the checks pass, entries already removed stay in `deleted`. The process exits nonzero.

`create` and `attach` still print the result object when the worktree exists but a post-create hook or `--exec` fails, including when that command is killed by a signal or the shell fails to start. The process exits with that command's status. `postCreate.ok` or `exec.ok` is false. That is not the error envelope. A pre-delete hook that exits nonzero, is signaled, or fails to start still aborts deletion.

### Worktree object

`list`, `where`, `create`, `attach`, `delete`, and `github checkout` share this object. `path` is absolute. `head` is the full HEAD SHA, or null when Git has no HEAD. `branch` is null when HEAD is detached (`detached` is true). `base` is the commit-ish this command started from when it knows one; otherwise it is the recorded sync base (a full ref such as `refs/remotes/origin/main`), or null for legacy/unrecorded worktrees. `list --json` exposes that recorded base. `dirty` is true when `git status --porcelain` reports any change. `default` is true for the repository's primary checkout.

```json
{
  "name": "feature/add-tests",
  "path": "/home/user/.local/share/maboroshi/worktrees/repo-6b4ca2db/feature/add-tests",
  "branch": "feature/add-tests",
  "head": "0123456789abcdef0123456789abcdef01234567",
  "base": "HEAD",
  "dirty": false,
  "default": false,
  "detached": false,
  "owner": "grok",
  "purpose": "fix the flaky checkout test",
  "createdAt": "2026-10-18T11:46:00.000Z",
  "createdFrom": "0123456789abcdef0123456789abcdef01234567",
  "lastUsedAt": "2026-10-18T11:46:00.000Z",
  "links": {
    "pr": { "number": 774, "url": null },
    "issue": null
  }
}
```

`owner`, `purpose`, `base`, `createdAt`, `createdFrom`, `lastUsedAt`, and `links` come from `maboroshi/worktrees.json` in the Git common directory (`git rev-parse --git-common-dir`). For a normal repository that directory is `.git`. `mabo create`, `mabo attach`, and `mabo github checkout` write a record. `owner` is `--owner` or `MABO_AGENT_ID`, and null when neither is set. `links.pr` and `links.issue` are `{ "number", "url" }` or null. A number stores `url` as null. An http(s) URL stores the URL and a number parsed from `/pull/`, `/pulls/`, `/issues/`, or `/issue/` when one is present. `github checkout` fills the matching link, including `https://<host>/<owner>/<repo>/pull/<number>` or `.../issues/<number>`. `where` and `exec` refresh `lastUsedAt` when a record already exists. A failure to update it is a warning on stderr and does not change the exit code. `delete` removes the record after Git removes the worktree. `create` and `attach` replace any record already stored at that path. `meta set` and a second `github checkout` of a worktree that already exists patch the record. `create --json` and `attach --json` include `metadata` as `{ "ok": true, "error": null }`. When saving the record fails after the worktree exists, `ok` is false, `error` explains why, copy and hooks still run, and the process exits 1. The stdout document is the result object, not the error envelope. A corrupt `worktrees.json` makes `list`, `where`, and `exec` continue with null metadata fields and a stderr warning. `create`, `attach`, `delete`, `meta set`, and `github checkout` refuse and leave the file unchanged. `createdFrom` is the full commit the branch was created from, or the base tip sync last fast-forwarded it to while it had no commits of its own. `create` stores the new branch's HEAD. A record for a branch that already existed stores the oldest `refs/heads` reflog entry, or null when that reflog is missing. `meta set` and a later checkout leave it unchanged. A record written before this field existed has `createdFrom` null. `mabo meta set` patches the fields you pass and leaves the others. A worktree Git created outside `mabo`, including the default checkout, has null metadata fields until `meta set` or `github checkout` records it. Cleanup details (`prunable`, `locked`) can be added later without a new version.

### Sync

`mabo sync` maps bases to remotes through their configured fetch refspecs, fetches each involved remote once, fast-forwards the default branch, and integrates worktree bases. It never pushes, changes upstream configuration, or runs hooks; every Git call during sync, including status checks and rollback, disables Git hooks and fsmonitor. A repository operation lock serializes sync with create, attach, delete, gc, and GitHub checkout.

```sh
# Human: from the main checkout, update only the default branch.
mabo sync
# From a linked worktree or any subdirectory, also sync that worktree.
cd "$(mabo where feature/auth)"
mabo sync
# Select worktrees and choose a strategy explicitly.
mabo sync feature/auth feature/tests --merge
mabo sync feature/auth --rebase --force
# Agent: select only your recorded worktrees.
export MABO_AGENT_ID=worker-1
mabo create feature/task --purpose 'implement task'
mabo sync --mine --json
# Skip the default branch, or process all recorded worktrees.
mabo sync --all --no-default
mabo sync -p owner/repo --all
# Keep a single conflicted operation for manual resolution.
mabo sync feature/auth --keep-conflicts
mabo meta set feature/auth --base origin/main
```

`create` and new GitHub issue checkouts record a sync `base`: an explicit `--base` is normalized to a full ref, otherwise the remote-tracking default branch when available, then the local default branch. Commit bases remain supported. When a clone has no discoverable default branch, creation retains its existing HEAD-based behavior and records that ref. PR checkout records the PR target as a full `origin` remote-tracking ref when present locally, otherwise the same fallback. A second GitHub checkout preserves an existing base, including one set by the user. Older metadata without `base` uses the same default-branch fallback at sync time. `meta set --base <ref>` validates and replaces the base; a removed base is skipped as `base-gone` with a repair hint.

Auto strategy rebases when none of the worktree's own commits (`base..branch`) is reachable from any remote-tracking ref, including destinations outside `refs/remotes` in configured fetch refspecs; otherwise it merges. `--rebase` refuses published commits with code `pushed` and exit 3 unless `--force` is given. `--merge` always selects merge. Rebasing requires Git 2.29 or later, reapplies upstream cherry-picks (including reverted ones), and keeps intentionally empty commits and commits that become empty. Before flattening merges, sync requires Git 2.38 or later to verify their automatic merge trees; merges with their own changes or conflict resolutions (and merges it cannot verify) fail untouched with a `--merge` hint. `--force` only permits local history rewriting. Dirty worktrees (including untracked, non-ignored files), detached worktrees, and already landed branches are skipped. Ignored paths that integration could overwrite also cause a dirty skip, with case-insensitive comparisons when `core.ignorecase` is true. Landed branches suggest `mabo gc`. With `--all` and `MABO_AGENT_ID`, worktrees owned by another agent are skipped as `owned`; explicitly naming one is allowed. `--mine` requires that environment variable.

A conflict reports the conflicting files and aborts the operation, restoring HEAD, the index tree, and file contents. `--keep-conflicts` leaves the operation in progress and requires exactly one target; several targets produce usage exit 2. Default-branch updates are fast-forward only, including in a linked worktree, which is reported once by the default item; with `--no-default`, that worktree is excluded unless explicitly named, when it still uses `ff-only`. Local commits cause `diverged`; blocking local changes cause `dirty`, even when branch merge options request autostash. With worktree targets, those default-branch skips are best effort and do not block worktree updates; fetch failures mark only items using that remote as `failed`, while other bases proceed. If the default cannot be resolved, its item and targets needing its fallback base report `failed`, while targets with recorded bases continue.

Human output has one `<name>  <status>  [detail]` line per item, followed by status counts such as `Sync complete: 2 updated, 1 conflict, 1 dirty`. Conflicts use `topic  conflict  file.rs (rebase aborted; worktree unchanged)` (or `merge`); with `--keep-conflicts`, the ending is `(rebase left in progress)`. Other failures show the first meaningful diagnostic line. Fresh branches with no work of their own are integrated, rather than reported as merged. The operation lock covers Git and metadata mutations, permits nested mabo commands from Git hooks (preserving tokens through internal Git calls in read-only intermediaries), and is released before create/attach actions and `.mabo.toml` post-create or pre-delete hooks run; a process borrowing an ancestor’s lock refuses project hooks, `--exec`, standalone `exec` (including shells), and `gh` children before starting them, because it cannot release that lock for its children. `--json` uses a separate versioned schema:

```json
{
  "schema": 1,
  "default": {
    "name": "main", "path": "/checkout", "branch": "refs/heads/main",
    "base": "refs/remotes/origin/main", "status": "updated", "strategy": "ff-only",
    "before": "<old-sha>", "after": "<new-sha>", "conflicts": [],
    "detail": null, "code": null
  },
  "worktrees": [{
    "name": "feature/task", "path": "/worktrees/feature/task", "branch": "feature/task",
    "base": "refs/remotes/origin/main", "status": "updated", "strategy": "rebase",
    "before": "<old-sha>", "after": "<new-sha>", "conflicts": [],
    "detail": null, "code": null
  }]
}
```

`default` is null with `--no-default`. Otherwise `name` is the default branch name, `branch` its full local ref, `base` the fetched target ref, and `path` its checkout path or null if not checked out. `strategy` is `ff-only`. Worktree `branch` is the branch name or null for detached HEAD, `base` is the normalized base, and `strategy` is `rebase`, `merge`, or null when skipped before strategy selection. Both item types report full `before`/`after` commit IDs, conflicting file paths in `conflicts`, optional human `detail`, and optional refusal `code` (`pushed`). Fields unavailable after an error are null.

Statuses are `updated`, `up-to-date`, `dirty`, `diverged`, `merged`, `detached`, `owned`, `base-gone`, `conflict`, and `failed`. Exit 0 means successful updates or skips; exit 1 means any conflict/failure, or a default-only `dirty`/`diverged` result; exit 2 means invalid usage; exit 3 means refusals to rewrite published history with no ordinary failure (ordinary failures take precedence with exit 1).

Orphaned records have neither a Git worktree registration nor an existing directory. `list` includes them with a trailing `[orphaned]`; the shared JSON worktree object has `orphaned: true` (false for existing entries), with null `branch` and `head`. `where` and `exec` refuse orphaned names. `delete <name>` removes only the stale record, exits 0, and reports that the worktree was already gone; it runs no hooks and leaves branches alone. Its existing JSON result uses `worktree.orphaned: true` and `branchDeleted: false`. A live worktree matching the same name takes precedence; multiple orphaned records with the same resolved name are refused as ambiguous. Orphaned records do not reserve names for live worktrees. When a live worktree takes the same name, the orphan remains visible in `list`; use `gc --apply` to remove it, since `delete <name>` resolves to the live worktree.

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

`gc --json` is a dry run unless `--apply` or `--force` is set. Before each removal, gc rechecks that target under the operation lock, querying its linked PR at most once during that recheck and skipping missing registrations whose branch or HEAD changed since planning. A branch that still points at its recorded `createdFrom` commit is not merged. A branch whose upstream ref is gone is merged when a clean merge would leave the default branch tree unchanged and the branch diff is not empty. When `createdFrom` is null, gc uses the oldest branch reflog entry for that check, and recognizes subsequent fast-forwards performed by `mabo sync` when the branch has no commits outside the base. For unrecorded worktrees, missing or incomplete branch reflogs are treated conservatively as not merged, so sync can keep updating and gc keeps the worktree. Recorded worktrees retain their existing missing-reflog behavior. A worktree still at that commit can match `--older-than` or an orphaned checkout. A worktree checked out on the default branch is kept, including when fetch refspecs store its remote branch under a different namespace; local defaults use full branch refs despite same-name tags. If gc cannot resolve the default base or local branch name, it warns and keeps all branch worktrees, including with `--force`, while allowing orphan-record cleanup. `gh pr view` receives the stored pull request URL when one was recorded. A number with no confirmed repository is unavailable, and gc says so instead of ignoring the link. `applied` is true when a removal was requested. Each candidate names the worktree, why it matched (`merged`, `pullRequest`, `orphaned`, `olderThan`), and `action`: `wouldRemove`, `removed`, `skipped`, or `failed`. `detail` explains a skip or a failure. `branchDeleted` is null on a dry run and on a skip. A removal failure sets the top-level `error` object and exits 1, and the other candidates are still listed. An empty plan exits 0.

```json
{
  "version": 1,
  "applied": false,
  "candidates": [
    {
      "name": "feature",
      "path": "/home/user/.local/share/maboroshi/worktrees/repo-6b4ca2db/feature",
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

In a single-branch or otherwise narrow-refspec clone, `github checkout` writes `branch.<b>.remote/merge` so `git pull` works, but `@{upstream}` and ahead/behind do not resolve because mabo does not change `remote.origin.fetch`.

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
      "rootPath": "/home/maboroshi/ghq/github.com/aku11i/phantom",
      "createdAt": "2026-01-01T00:00:00.000Z"
    },
    {
      "source": "ghq",
      "name": "repo",
      "canonicalName": "github.com/owner/repo",
      "rootPath": "/home/maboroshi/ghq/github.com/owner/repo"
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
  "path": "/home/maboroshi/ghq/github.com/aku11i/phantom",
  "host": "github.com",
  "owner": "aku11i",
  "repo": "phantom",
  "remoteUrl": "https://github.com/aku11i/phantom.git",
  "cloned": true,
  "updated": false
}
```

A failed clone uses the version 1 error object. A destination that is not the expected repository is `validation` / exit code 3. A path component the filesystem rejects, such as a name longer than the filename limit, is also `validation` / exit code 3. If Git cannot read its configuration while inspecting an existing checkout, the error includes Git's message and uses exit code 1. A Git failure during clone or fetch is `command_failed` with Git's exit code.
