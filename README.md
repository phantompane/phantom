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

Every command can run non-interactively. Every JSON command returns a schema 2 envelope containing `command`, `ok`, `data`, `warnings`, and `error`. Errors are structured, with stable, documented exit codes (see [Machine-readable JSON](#machine-readable-json)). `exec` passes through the child command's output and exit code instead. Humans use the same commands with plain-text output.

## Safe by default, explicit when you want otherwise

- **Merged, unowned, or old are signals, not permission to delete.** `gc` only prints its plan until you pass `--apply` or `--force` (`--force` also applies the plan). It keeps dirty work and commits it cannot confirm as published or landed unless you pass `--force`. The default-branch, current, and Git-locked worktrees remain protected even with `--force`.
- **Ownership is information, not enforcement.** With a nonblank `MABO_AGENT_ID`, `sync --mine` selects only that agent's workspaces and `sync --all` skips other agents' (both also attempt to update the default branch unless `--no-default` is set). Naming a workspace explicitly lets `sync` work on it whoever owns it. `gc` can still select other agents' merged, closed-PR, or orphaned workspaces.
- **Pushed history is kept by default.** When integration is needed, `sync` merges the base into published work; rebasing it takes `--rebase --force`. A workspace counts as published when at least one commit beyond its base is reachable from a known remote-tracking ref or configured fetch destination.
- **Non-interactive runs never wait at a prompt.** With nonempty `CI`, JSON output, `--no-input`, `MABO_NO_INPUT` other than empty or `0`, or when stdin or stderr is not a terminal, `mabo` itself does not ask questions. If an operation would run untrusted hooks, it refuses before changing the repository and exits 4 (`untrusted` in JSON); `gc` instead skips removals requiring those hooks, without treating the skip as an error. Record trust in advance with `mabo trust --yes`, or skip hooks with `--no-hooks`. Network Git operations receive `GIT_TERMINAL_PROMPT=0`; project hooks and gh read stdin from `/dev/null`. `MABO_AGENT_ID` sets the owner and does not suppress prompts.

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

When `worktrees-directory` is unset, `mabo create` and `mabo attach` place the new worktree at `$XDG_DATA_HOME/maboroshi/worktrees/<checkout>-<hash>/<name>`. The fallback is `~/.local/share/maboroshi/worktrees/...` when `XDG_DATA_HOME` is unset, empty, or not absolute. `<checkout>` is the canonical main checkout directory name, with characters outside letters, numbers, `.`, `_`, and `-` replaced by `-`. A symlink to that checkout uses the same directory. `<hash>` is the first 8 hexadecimal digits of the SHA-256 of the canonical Git common directory. Two clones of the same remote get different directories. `directory-name-separator` still applies only inside that project directory. Deleting the last worktree inside that directory removes the project directory only when `.maboroshi-common-dir` names this repository, and does not remove `maboroshi/worktrees`. `delete` and `gc` also remove a linked worktree recorded in `maboroshi/workspaces/<id>.json`, including one created under `.git/maboroshi/worktrees` or a different data directory. An unrecorded worktree outside the resolved directory stays. Parent cleanup runs only for a worktree inside the resolved directory. A set `worktrees-directory` is still a path relative to the repository root, and that directory is left in place when it becomes empty.

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

Any other ref is matched against registered projects and discovered checkouts (the same set as `project list`, including when `ghq-discovery` is false). The canonical name is `host/owner/repo`: from the `origin` URL when it is an http(s), ssh, or scp-style remote, otherwise from a checkout stored at `<root>/<host>/<owner>/<repo>`. A local or relative origin, including `backups/widget.git`, is not a host-based name. `owner/repo` and `repo` match when only one project has that suffix. The directory name shown by `project list` matches too, including when it differs from the canonical name. A location name that differs from the remote also matches. Several matches is a usage error (exit code 2) that lists the candidates. No match is not found (exit code 3). A path that does not exist is not found and says the path does not exist. A `--project` value that starts with `-` is a validation error.

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

On a terminal, mabo prints the project path and the hook commands, then asks `Trust this project and run its hooks? [y/N]`. `y` or `yes` saves trust and runs the hooks. mabo does not ask when `CI` is nonempty, when `--no-input` or `MABO_NO_INPUT` is enabled, when stdin or stderr is not a terminal, or when JSON output is selected. `MABO_AGENT_ID` does not suppress prompts. It then exits 4 before changing the repository, the same as a non-terminal. With `--json`, stdout contains one error envelope with `error.code` set to `untrusted`. The message tells you to run `mabo trust --yes` or pass `--no-hooks`.

`mabo trust [path]` shows the hooks and asks `Trust this project? [y/N]`. `--yes` skips the question. The same non-interactive rules apply, and `--yes` is how a non-interactive run records trust. `mabo untrust [path]` removes that repository. `mabo trust --list` prints each trusted git common directory and when it was trusted. Trust is keyed by the path of the canonical git common directory, so the main checkout and its linked worktrees share one record. Deleting the checkout and cloning it again at the same path keeps that record. `mabo untrust` clears it. Editing the hook commands later does not ask again.

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

`--json` (an alias for `--output json`) prints exactly one schema 2 envelope to **stdout**. Every JSON command uses the same contract, including errors and `project list`. Parsers must ignore unknown fields. Progress, hooks, Git output and `--exec` output go to **stderr**. Human output is selected with `--output text`.

```json
{
  "schema": 2,
  "command": "where",
  "ok": false,
  "data": null,
  "warnings": [],
  "error": { "code": "not_found", "message": "Worktree 'topic' not found" }
}
```

`command` uses space-separated names such as `meta set` and `github checkout`. `data` contains the command result without a top-level `version` or `schema`. `error` is null on success, otherwise an object with stable `code`, human `message` and optional `details`. Partial results remain in `data`, including setup failures and per-item delete/gc/sync results. Per-item errors stay on their items. `warnings` contains objects with stable `code` and `message`, including metadata read/update failures and unavailable PR status; warnings may also appear on stderr.

| Exit | Meaning | Example error codes |
|---|---|---|
| 0 | Success, including gc plans with protected candidates | |
| 1 | Operational failure | `failed`, `git_failed`, `io`, `command_failed`, `spawn`, `signaled` |
| 2 | Invalid invocation | `usage`, `ambiguous` |
| 3 | Not found or outside a repository | `not_found`, `branch_not_found`, `not_repository` |
| 4 | Safety refusal before changes | `dirty`, `unpreserved`, `published`, `exists`, `exists_remote`, `untrusted`, `refused` |
| 5 | Sync conflict, rolled back or kept with `--keep-conflicts` | `conflict` |
| 6 | Persistent changes followed by failure or partial success | `partial` |

The same statuses apply to text output. Standalone `exec` preserves its child's exit status, including 128+signal. Create/attach/checkout setup failures exit 6 and retain the worktree plus child statuses in `data.postCreate.exitCode` or `data.exec.exitCode`. Metadata save and copy failures after creation also exit 6. Delete checks every name before removing any; a safety refusal exits 4 and removes nothing. A later failure exits 6 if something was removed, otherwise 1. A failed pre-delete hook aborts deletion. `unpreserved` protects commits absent from the default branch or remotes, or commits that could not be checked; use `--keep-branch` or `--force` (detached HEAD requires `--force`).

`MABO_OUTPUT=json|text` sets the default; empty means unset and other values exit 2. Explicit output flags override it. `list --names` (and project `--names`/`--paths`) selects text even with `MABO_OUTPUT=json`; explicitly combining it with JSON is a usage error. `exec`, `version` and help ignore `MABO_OUTPUT`. Explicit `exec --json` or `exec --output json` is a usage error; arguments after the worktree name belong to the child.

Mabo never prompts in non-interactive mode: nonempty `CI`, JSON output, `--no-input`, `MABO_NO_INPUT` other than empty or `0`, or stdin/stderr without a TTY. `MABO_AGENT_ID` only supplies the default owner and does not suppress prompts. Untrusted hooks refuse before changes with exit 4 and a `mabo trust --yes` / `--no-hooks` hint. Network Git operations receive `GIT_TERMINAL_PROMPT=0`; project hooks and gh read stdin from `/dev/null`. User commands (`--exec` and standalone `exec`) inherit stdin.

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

`id`, `owner`, `purpose`, `base`, `createdAt`, `createdFrom`, `lastUsedAt`, and `links` come from `maboroshi/workspaces/<id>.json` in the Git common directory (`git rev-parse --git-common-dir`). For a normal repository that directory is `.git`. `mabo create`, `mabo attach`, and `mabo github checkout` write a record. `owner` is `--owner` or `MABO_AGENT_ID`, and null when neither is set. `links.pr` and `links.issue` are `{ "number", "url" }` or null. A number stores `url` as null. An http(s) URL stores the URL and a number parsed from `/pull/`, `/pulls/`, `/issues/`, or `/issue/` when one is present. `github checkout` fills the matching link, including `https://<host>/<owner>/<repo>/pull/<number>` or `.../issues/<number>`. `where` and `exec` refresh `lastUsedAt` when a record already exists. A failure to update it is a warning on stderr and does not change the exit code. `delete` removes the record after Git removes the worktree. `create` and `attach` replace any record already stored at that path. `meta set` and a second `github checkout` of a worktree that already exists patch the record. `create --json` and `attach --json` include `metadata` as `{ "ok": true, "error": null }`. When saving the record fails after the worktree exists, `ok` is false, `error` explains why, copy and hooks still run, and the process exits 6 with `error.code` set to `partial` and the result retained in `data`. A corrupt workspace record makes `list`, `where`, and `exec` continue with null metadata for that record and a warning; other records remain readable. `create`, `attach`, `delete`, `meta set`, and `github checkout` refuse and leave the file unchanged. `createdFrom` is the full commit the branch was created from, or the base tip sync last fast-forwarded it to while it had no commits of its own. `create` stores the new branch's HEAD. A record for a branch that already existed stores the oldest `refs/heads` reflog entry, or null when that reflog is missing. `meta set` and a later checkout leave it unchanged. A record written before this field existed has `createdFrom` null. `mabo meta set` patches the fields you pass and leaves the others. A worktree Git created outside `mabo`, including the default checkout, has null metadata fields until `meta set` or `github checkout` records it. Cleanup details (`prunable`, `locked`) can be added later without a new version.

Workspace records contain `schema: 2`, an `id` of the form `ws_<uuid v4>`, `path`, an optional `name`, and the metadata fields above. JSON worktree objects include `id` (null for an unrecorded worktree). Each record is written atomically through a temporary file in the same directory, fsync, and rename. Deleting a record removes only its file. Concurrent additions of different records preserve both; concurrent updates of the same record use the last write.

Project registrations live in `$XDG_STATE_HOME/maboroshi/repos/<id>.json`, falling back to `~/.local/state/maboroshi/repos/<id>.json`. They keep their existing `proj_<uuid>` IDs. Readers deduplicate registrations by root path, keeping the oldest `createdAt` (then the smallest ID on a tie). The first write imports legacy `maboroshi/worktrees.json` or `$XDG_STATE_HOME/maboroshi/projects.json` into individual files and renames the source to `*.json.imported`. Read-only commands can read the legacy files before import. Failed imports leave the source intact. Mabo uses no internal file locks; trust and preferences remain single files replaced atomically.

### Sync

`mabo sync` maps bases to remotes through their configured fetch refspecs, fetches each involved remote once, fast-forwards the default branch, and integrates worktree bases. It never pushes, changes upstream configuration, or runs hooks; every Git call during sync, including status checks and rollback, disables Git hooks and fsmonitor.

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

Auto strategy rebases when none of the worktree's own commits (`base..branch`) is reachable from any remote-tracking ref, including destinations outside `refs/remotes` in configured fetch refspecs; otherwise it merges. `--rebase` refuses published commits with code `published` and exit 4 unless `--force` is given. `--merge` always selects merge. Rebasing requires Git 2.29 or later, reapplies upstream cherry-picks (including reverted ones), and keeps intentionally empty commits and commits that become empty. Before flattening merges, sync requires Git 2.38 or later to verify their automatic merge trees; merges with their own changes or conflict resolutions (and merges it cannot verify) fail untouched with a `--merge` hint. `--force` only permits local history rewriting. Dirty worktrees (including untracked, non-ignored files), detached worktrees, and already landed branches are skipped. Ignored paths that integration could overwrite also cause a dirty skip, with case-insensitive comparisons when `core.ignorecase` is true. Landed branches suggest `mabo gc`. With `--all` and `MABO_AGENT_ID`, worktrees owned by another agent are skipped as `owned`; explicitly naming one is allowed. `--mine` requires that environment variable.

A conflict reports the conflicting files and aborts the operation, restoring HEAD, the index tree, and file contents. `--keep-conflicts` leaves the operation in progress and requires exactly one target; several targets produce usage exit 2. Default-branch updates are fast-forward only, including in a linked worktree, which is reported once by the default item; with `--no-default`, that worktree is excluded unless explicitly named, when it still uses `ff-only`. Local commits cause `diverged`; blocking local changes cause `dirty`, even when branch merge options request autostash. With worktree targets, those default-branch skips are best effort and do not block worktree updates; fetch failures mark only items using that remote as `failed`, while other bases proceed. If the default cannot be resolved, its item and targets needing its fallback base report `failed`, while targets with recorded bases continue.

Human output has one `<name>  <status>  [detail]` line per item, followed by status counts such as `Sync complete: 2 updated, 1 conflict, 1 dirty`. Conflicts use `topic  conflict  file.rs (rebase aborted; worktree unchanged)` (or `merge`); with `--keep-conflicts`, the ending is `(rebase left in progress)`. Other failures show the first meaningful diagnostic line. Fresh branches with no work of their own are integrated, rather than reported as merged. `--json` uses the shared envelope:

```json
{
  "schema": 2,
  "command": "sync",
  "ok": true,
  "data": {
    "default": {
      "name": "main",
      "path": "/checkout",
      "branch": "refs/heads/main",
      "base": "refs/remotes/origin/main",
      "status": "updated",
      "strategy": "ff-only",
      "before": "<old-sha>",
      "after": "<new-sha>",
      "conflicts": [],
      "detail": null,
      "code": null
    },
    "worktrees": [
      {
        "name": "feature/task",
        "path": "/worktrees/feature/task",
        "branch": "feature/task",
        "base": "refs/remotes/origin/main",
        "status": "updated",
        "strategy": "rebase",
        "before": "<old-sha>",
        "after": "<new-sha>",
        "conflicts": [],
        "detail": null,
        "code": null
      }
    ]
  },
  "warnings": [],
  "error": null
}
```

`default` is null with `--no-default`. Otherwise `name` is the default branch name, `branch` its full local ref, `base` the fetched target ref, and `path` its checkout path or null if not checked out. `strategy` is `ff-only`. Worktree `branch` is the branch name or null for detached HEAD, `base` is the normalized base, and `strategy` is `rebase`, `merge`, or null when skipped before strategy selection. Both item types report full `before`/`after` commit IDs, conflicting file paths in `conflicts`, optional human `detail`, and optional refusal `code` (`published`). Fields unavailable after an error are null.

Statuses are `updated`, `up-to-date`, `dirty`, `diverged`, `merged`, `detached`, `owned`, `base-gone`, `conflict`, and `failed`. Failures take precedence: exit 6 when failures accompany changes in another item, otherwise 1. Without failures, conflicts exit 5, published refusals exit 4, and other outcomes exit 0. A default-only `dirty`/`diverged` result remains an operational failure (1). Usage errors exit 2.

Orphaned records have neither a Git worktree registration nor an existing directory. `list` includes them with a trailing `[orphaned]`; the shared JSON worktree object has `orphaned: true` (false for existing entries), with null `branch` and `head`. `where` and `exec` refuse orphaned names. `delete <name>` removes only the stale record, exits 0, and reports that the worktree was already gone; it runs no hooks and leaves branches alone. Its existing JSON result uses `worktree.orphaned: true` and `branchDeleted: false`. A live worktree matching the same name takes precedence; multiple orphaned records with the same resolved name are refused as ambiguous. Orphaned records do not reserve names for live worktrees. When a live worktree takes the same name, the orphan remains visible in `list`; use `gc --apply` to remove it, since `delete <name>` resolves to the live worktree.

### Commands

`list --json`:

```json
{
  "schema": 2,
  "command": "list",
  "ok": true,
  "data": {
    "worktrees": []
  },
  "warnings": [],
  "error": null
}
```

`where --json` and the result of a create, attach, or checkout use the worktree object. `where` returns:

```json
{
  "schema": 2,
  "command": "where",
  "ok": true,
  "data": {
    "worktree": {}
  },
  "warnings": [],
  "error": null
}
```

`create --json` and `attach --json`:

```json
{
  "schema": 2,
  "command": "create",
  "ok": true,
  "data": {
    "worktree": {},
    "copyFiles": {
      "ok": true,
      "error": null
    },
    "postCreate": {
      "ran": false,
      "ok": true,
      "command": null,
      "exitCode": null,
      "signal": null,
      "error": null
    },
    "exec": null
  },
  "warnings": [],
  "error": null
}
```

`copyFiles.ok` is false when copying `.worktreeinclude` matches fails. The worktree is still created. `postCreate.ran` is false when no hook is configured. On success, `exitCode` is 0 and `command`, `signal`, and `error` are null. On failure, `command` is the hook that failed and `exitCode` is its status. `exec` is null when `--exec` was not passed. Otherwise it is `{ "ok": true, "command": "npm test", "exitCode": 0, "signal": null, "error": null }`. For both `postCreate` and `exec`, `signal` is the signal name when the process was killed, and `exitCode` is `128` plus the signal number (`143` for `SIGTERM`, `130` for `SIGINT`, `137` for `SIGKILL`, `129` for `SIGHUP`). `error` is set when the shell or program failed to start. `ok` is false in both cases, and the worktree object is still returned.

`attach` leaves `worktree.base` null. `create` sets it to the requested base (`HEAD` when omitted).

`delete --json`:

```json
{
  "schema": 2,
  "command": "delete",
  "ok": true,
  "data": {
    "deleted": [
      {
        "worktree": {},
        "branchDeleted": true,
        "branchError": null,
        "error": null
      }
    ]
  },
  "warnings": [],
  "error": null
}
```

`branchDeleted` is false for a detached HEAD, for `--keep-branch`, and when deleting the branch failed. A failed branch delete sets `branchError` and still exits 0. A fatal per-item failure sets `error` on that entry and the top-level `error` object, and exits nonzero.

`gc --json` is a dry run unless `--apply` or `--force` is set. Before each removal, gc rechecks that target, querying its linked PR at most once during that recheck and skipping missing registrations whose branch or HEAD changed since planning. A branch that still points at its recorded `createdFrom` commit is not merged. A branch whose upstream ref is gone is merged when a clean merge would leave the default branch tree unchanged and the branch diff is not empty. When `createdFrom` is null, gc uses the oldest branch reflog entry for that check, and recognizes subsequent fast-forwards performed by `mabo sync` when the branch has no commits outside the base. For unrecorded worktrees, missing or incomplete branch reflogs are treated conservatively as not merged, so sync can keep updating and gc keeps the worktree. Recorded worktrees retain their existing missing-reflog behavior. A worktree still at that commit can match `--older-than` or an orphaned checkout. A worktree checked out on the default branch is kept, including when fetch refspecs store its remote branch under a different namespace; local defaults use full branch refs despite same-name tags. If gc cannot resolve the default base or local branch name, it warns and keeps all branch worktrees, including with `--force`, while allowing orphan-record cleanup. `gh pr view` receives the stored pull request URL when one was recorded. A number with no confirmed repository is unavailable, and gc says so instead of ignoring the link. `applied` is true when a removal was requested. Each candidate names the worktree, why it matched (`merged`, `pullRequest`, `orphaned`, `olderThan`), and `action`: `wouldRemove`, `removed`, `skipped`, or `failed`. `detail` explains a skip or a failure. `branchDeleted` is null on a dry run and on a skip. A removal failure sets the envelope `error` and exits 6 if any candidate was removed, otherwise 1, and the other candidates are still listed. An empty plan exits 0.

```json
{
  "schema": 2,
  "command": "gc",
  "ok": true,
  "data": {
    "applied": false,
    "candidates": [
      {
        "name": "feature",
        "path": "/home/user/.local/share/maboroshi/worktrees/repo-6b4ca2db/feature",
        "branch": "feature",
        "owner": "grok",
        "reasons": [
          "merged"
        ],
        "action": "wouldRemove",
        "detail": null,
        "branchDeleted": null
      }
    ],
    "plan": true
  },
  "warnings": [],
  "error": null
}
```

`github checkout --json`:

```json
{
  "schema": 2,
  "command": "github checkout",
  "ok": true,
  "data": {
    "worktree": {},
    "github": {
      "kind": "pullRequest",
      "number": 123,
      "headRef": "feature/add-logging",
      "alreadyExists": false
    },
    "copyFiles": {
      "ok": true,
      "error": null
    },
    "postCreate": {
      "ran": false,
      "ok": true,
      "command": null,
      "exitCode": null,
      "signal": null,
      "error": null
    }
  },
  "warnings": [],
  "error": null
}
```

`github.kind` is `pullRequest` or `issue`. `headRef` is the pull request head ref, and null for an issue. `worktree.base` is the fetched upstream for a new pull request, the requested base for a new issue, and null when the worktree already existed.

In a single-branch or otherwise narrow-refspec clone, `github checkout` writes `branch.<b>.remote/merge` so `git pull` works, but `@{upstream}` and ahead/behind do not resolve because mabo does not change `remote.origin.fetch`.

### Project list

`project list --json` uses the common schema 2 envelope. It uses camelCase and absolute `rootPath` values. Each project includes `canonicalName` (`host/owner/repo` from `origin`, otherwise from a `<root>/<host>/<owner>/<repo>` checkout, otherwise the directory name). `name` stays the directory name. Warnings are recorded in the envelope and on stderr. Parsers must ignore unknown fields, so adding `canonicalName` does not change `schema`.

```json
{
  "schema": 2,
  "command": "project list",
  "ok": true,
  "data": {
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
  },
  "warnings": [],
  "error": null
}
```

`project add --json` and `project remove --json` return `{ "status", "project" }` in `data`. Errors use the common envelope.

### Clone

`clone --json` uses the common schema 2 envelope. `path` is the absolute Git root. `host` is lowercased and includes a port when the URL has one. `remoteUrl` is the clone URL with that same lowercased host. `http` and `https` userinfo is removed, including a token used as the username (`https://github.com/<owner>/<repo>.git` for `owner/repo` and `host/owner/repo`). `ssh` and scp-style URLs keep the login name. `cloned` is true when this command created the checkout. `updated` is true only when `--update` fetched an existing checkout. Git's progress stays on stderr.

```json
{
  "schema": 2,
  "command": "clone",
  "ok": true,
  "data": {
    "path": "/home/maboroshi/ghq/github.com/aku11i/phantom",
    "host": "github.com",
    "owner": "aku11i",
    "repo": "phantom",
    "remoteUrl": "https://github.com/aku11i/phantom.git",
    "cloned": true,
    "updated": false
  },
  "warnings": [],
  "error": null
}
```

A failed clone uses the common error envelope. A destination that is not the expected repository is `usage` / exit code 2. A path component the filesystem rejects, such as a name longer than the filename limit, is also `usage` / exit code 2. If Git cannot read its configuration while inspecting an existing checkout, the error includes Git's message and uses exit code 1. A Git failure during clone or fetch is `command_failed` with exit code 1.
