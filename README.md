# Maboroshi

Maboroshi (幻, "phantom space") — workspaces for parallel coding agents.

Maboroshi manages local Git workspaces so that many coding agents and humans can work independently in the same repository at the same time. A workspace is one checkout of one repository plus what Git doesn't track about it: its name, its purpose (pull request, issue, base), and its observed state. Today each checkout is a Git worktree.

The Rust rewrite lives on `next` and ships as `v7.0.0-alpha` prereleases on [GitHub Releases](https://github.com/phantompane/phantom/releases) (it is not on npm yet). The previous TypeScript version stays on `main`; its README is at <https://github.com/phantompane/phantom/blob/main/README.md>.

## Why

Git records the code and the checkouts. It does not record why a checkout exists or whether it can be retired. With many agents working in one repository at once, those are the questions nobody can answer. Maboroshi fills that gap on top of plain Git: repositories, branches, and worktrees stay ordinary Git, and `git` keeps working alongside `mabo`.

Workspaces separate files and branches, not processes, ports, databases, or credentials. Maboroshi coordinates workspace boundaries and its own operations; running services side by side is up to your repo and its hooks.

## What it does

Maboroshi creates, takes over, and prepares workspaces, keeps them current with their base, and retires them:

- **Allocate and prepare.** `clone` places a repository in the ghq layout. `create`, `attach`, and `github checkout` (alias `gh checkout`) give each piece of work its own workspace, copy ignored files matched by `.worktreeinclude`, and run repository hooks in repositories you trust.
- **Identify.** `meta set` records the purpose, linked pull request or issue, and base. `list` and `where` show what exists and where.
- **Update.** `sync` fetches, fast-forwards the default branch when possible, and brings selected workspaces up to date with their base.
- **Retire.** `gc` selects workspaces on evidence: merged branches, closed pull requests, orphaned records, and age (`--older-than`).

Every command can run non-interactively. Every JSON command returns a schema 2 envelope containing `command`, `ok`, `data`, `warnings`, and `error`. Errors are structured, with stable, documented exit codes (see [Machine-readable JSON](#machine-readable-json)). `exec` passes through the child command's output and exit code instead. Humans use the same commands with plain-text output.

## Safe by default, explicit when you want otherwise

- **Merged, closed, or old are signals, not permission to delete.** `gc` only prints its plan until you pass `--apply` or `--force` (`--force` also applies the plan). It keeps dirty work and commits it cannot confirm as published or landed unless you pass `--force`. The default-branch, current, and Git-locked workspaces remain protected even with `--force`.
- **Bulk operations address every workspace.** `sync --all` selects every workspace in the repository (and updates the default branch unless `--no-default` is set). Use explicit names to narrow the selection. `gc` selects by evidence and age, with the same checks for dirty work and unpreserved commits.
- **Pushed history is kept by default.** When integration is needed, `sync` merges the base into published work; rebasing it takes `--rebase --force`. A workspace counts as published when at least one commit beyond its base is reachable from a known remote-tracking ref or configured fetch destination.
- **Non-interactive runs never wait at a prompt.** With nonempty `CI`, JSON output, `--no-input`, `MABO_NO_INPUT` other than empty or `0`, or when stdin or stderr is not a terminal, `mabo` itself does not ask questions. If an operation would run untrusted hooks, it refuses before changing the repository and exits 4 (`untrusted` in JSON); `gc` instead skips removals requiring those hooks, without treating the skip as an error. Record trust in advance with `mabo trust add`, or skip hooks with `--no-hooks`. Network Git operations receive `GIT_TERMINAL_PROMPT=0`; repository hooks and gh read stdin from `/dev/null`.

## Non-goals

Maboroshi will not become:

- an agent runner or scheduler (launching, supervising, or assigning agents);
- a task tracker or PR bot (assignments, reviews, comments, merges);
- a replacement for everyday Git (commit, push, history editing; only integrating with the base is in scope);
- a sandbox or environment platform (containers, dependencies, secrets, ports, databases); it only runs repository hooks;
- a terminal or session manager (tmux, panes, dashboards); it gives you a path;
- security isolation or access control between agents.

## Command migration and machine-readable help

The old `project`, `preferences`, `untrust`, and `version` commands, `trust --yes/--list` (and `-y`), and `-p/--project` are removed. They exit 2 with a replacement hint; there are no aliases. Use `repo`, `config`, `trust remove`, `--version`, `trust add/list`, and `-R/--repo` respectively. `--version` and `-v` remain available. `mabo --version --json` returns the schema 2 envelope with `command: "--version"` and `data.version` containing the application version (`data.display` contains the text version line).

Workspace ownership and `lastUsedAt` have been removed. `--owner` (on create, attach, GitHub checkout, meta set, list, and gc) exits 2: use `--purpose`, PR links, and workspace names. `sync --mine` exits 2: use explicit names or `--all`. `MABO_AGENT_ID` no longer affects mabo. Old records remain readable; their removed fields disappear when the record is next written. `where` and `exec` leave records unchanged, and `gc --older-than` uses `createdAt`.

`mabo help [COMMAND...]` prints the same text as `--help`. `mabo help --json` returns the schema 2 envelope with the complete contents of `help-data.json` in `data`: `commands`, `helps` (all commands and flags), `globalOptions`, `exitCodes`, `errorCodes`, and `schemaVersion: 2`. `mabo help repo show --json` includes the same contract plus `data.selected` for that command.

## User configuration

`mabo` stores user configuration in `$XDG_CONFIG_HOME/maboroshi/config.toml` (default `~/.config/maboroshi/config.toml`). `mabo config get`, `set`, `unset`, and `list` read and write that file. The first `set` creates the directory and file.

```toml
workspace-root = "../maboroshi-workspaces"
keep-branch = false
discover-ghq = true
clone-root = "~/ghq"
```

When `workspace-root` is unset, `mabo create` and `mabo attach` place the new workspace at `$XDG_DATA_HOME/maboroshi/workspaces/<checkout>-<hash>/<name>`. The fallback is `~/.local/share/maboroshi/workspaces/...` when `XDG_DATA_HOME` is unset, empty, or not absolute. `<checkout>` is the canonical primary checkout directory name, with characters outside letters, numbers, `.`, `_`, and `-` replaced by `-`. A symlink to that checkout uses the same directory. `<hash>` is the first 8 hexadecimal digits of the SHA-256 of the canonical Git common directory. Two clones of the same remote get different directories. Workspace names retain their `/` hierarchy. Existing workspaces under `maboroshi/worktrees/` stay at their current paths and remain available to `list`, `where`, `delete`, `sync`, and `gc`. Deleting the last workspace keeps the repo directory and its `.maboroshi-common-dir` marker so concurrent and subsequent creates can reuse it safely. `delete` and `gc` also remove a linked workspace recorded in `maboroshi/workspaces/<id>.json`, including one created under `.git/maboroshi/worktrees` or a different data directory. An unrecorded workspace outside the resolved directory stays. Empty parent directories below the repo directory are cleaned up only for a workspace inside the resolved directory. A set `workspace-root` may be absolute, start with `~/`, or be relative to the repository root, and that directory is left in place when it becomes empty.

`clone-root` is where `mabo clone` places repositories. It is an absolute path or a path starting with `~/`. When `clone-root` is unset, `mabo clone` uses the first `git config ghq.root` value, then `$GHQ_ROOT`, then `~/ghq`. A configured `clone-root` is used without reading git config. If reading `ghq.root` fails, `mabo` warns and continues with `$GHQ_ROOT` or `~/ghq`. `repo list` scans that same directory.

`config get KEY` and `config list` return effective values, including defaults. Add `--sources` to see `value`, `source` (`config`, `env`, or `default`), and `detail`. JSON stores those values under `data.config[KEY]`; without `--sources`, each entry is the value itself. `workspace-root` defaults to null (the XDG layout), `discover-ghq` to true, and `keep-branch` to false. The clone-root default chain stays `ghq.root` → `$GHQ_ROOT` → `~/ghq`, below user config. Future command policy keys follow flag → environment → user config → default precedence; these keys have no additional flag or environment override.

Old config.toml keys `worktrees-directory`, `root`, and `ghq-discovery` still take effect as `workspace-root`, `clone-root`, and `discover-ghq`, with `config_key_renamed` warnings and migration hints. If both names exist, the new name wins. Reading does not change the file. The next successful `config set` or `config unset` rewrites old names. `directory-name-separator` is ignored with `config_key_removed` and removed on that write. `keep-branch` remains supported until the retirement redesign.

```sh
mabo config list --sources
mabo config get clone-root --sources --json
mabo config set workspace-root ~/workspaces
mabo config unset workspace-root
```

## Cloning repositories

`mabo clone` clones a Git repository into `<root>/<host>/<owner>/<repo>` and registers it. `owner/repo` uses `github.com`. The command accepts `https` and `http` URLs, `ssh://` URLs, scp-style `git@host:owner/repo` paths, `host/owner/repo`, and `owner/repo`. The host directory is lowercased, and a URL port is part of it (`example.net:9443`). `file://` URLs are rejected. A local path has no host, owner, and repository to place under that layout. A clone that exits early can leave a hidden `.maboroshi-clone-<pid>-<uuid>` directory beside the destination. A later clone in that directory removes it when the recorded process is no longer running.

```bash
mabo clone aku11i/phantom
mabo clone git@github.com:aku11i/phantom.git --branch next
mabo clone github.com/aku11i/phantom --depth 1
mabo clone aku11i/phantom --update
```

If that path is already the same repository, `mabo` registers it and prints the path instead of cloning again. `--update` fetches `origin` in that case. If the path exists but is a different repository, the command exits with a validation error. `--branch` and `--depth` apply only to a new clone.

Authentication is left to Git. `mabo` does not call `gh`. Git's progress is written to stderr. New workspaces for the cloned repository are created under `$XDG_DATA_HOME/maboroshi/workspaces/<checkout>-<hash>` (`~/.local/share/maboroshi/workspaces/...` when `XDG_DATA_HOME` is unset, empty, or relative). `<checkout>` is the canonical primary checkout directory name, so a symlink or a non-canonical path uses the same directory. `<hash>` is the first 8 hexadecimal digits of the SHA-256 of the canonical Git common directory, the same path `mabo trust` records. The `workspace-root` config key overrides that location; relative values are joined to the repository root.

## Repository registrations

```sh
mabo repo add [PATH]
mabo repo list [--registered | --discovered] [--names | --paths]
mabo repo show [REF]
mabo repo forget REF
```

`repo add` defaults to the selected repository or current checkout and registers its primary checkout. `repo list` combines registrations and discovered repositories; registered roots take precedence. `--registered` disables discovery; `--discovered` shows unregistered discovered roots. `discover-ghq=false` disables discovery. `repo show` reports `repo.root`, `name`, `defaultBranch` (null if unknown), `configPresent` for `.mabo.toml`, `trusted` (including `MABO_TRUST_ALL=1`), and `workspaceRoot`. REF accepts a registration ID, path, canonical name, or unambiguous suffix; omission uses `-R` or the current repository. `repo forget` removes only the registration, leaving files and workspaces intact. A forgotten repository may remain discoverable.

## Targeting a repository

The global `-R/--repo` option selects a repository. Workspace commands (`create`, `attach`, `list`, `where`, `delete`, `sync`, `gc`, `exec`, `meta set`, and `github checkout`) accept `--repo <ref>` (`-R`) so they can run against a repository other than the current directory. It may precede the command or appear among its options. `mabo exec` is the exception: it parses mabo options only before the workspace name, and passes everything after that name to the command. This runs `pwd --repo y` inside the `feature` workspace of `owner/repo`:

```bash
mabo exec --repo owner/repo feature pwd --repo y
mabo list --repo ~/src/foo --json
```

A ref that starts with `/`, `.`, or `~` is a directory. It can be anywhere inside the repository, including a linked workspace, and resolves to the primary checkout. Hooks and `.worktreeinclude` are read from that primary checkout.

Any other ref is matched against registered repos and discovered checkouts (the same set as `repo list`, including when `discover-ghq` is false). The canonical name is `host/owner/repo`: from the `origin` URL when it is an http(s), ssh, or scp-style remote, otherwise from a checkout stored at `<root>/<host>/<owner>/<repo>`. A local or relative origin, including `backups/widget.git`, is not a host-based name. `owner/repo` and `repo` match when only one repo has that suffix. The directory name shown by `repo list` matches too, including when it differs from the canonical name. A location name that differs from the remote also matches. Several matches is a usage error (exit code 2) that lists the candidates. No match is not found (exit code 3). A path that does not exist is not found and says the path does not exist. A `--repo` value that starts with `-` is a validation error.

## Copying gitignored files

`mabo create` and `mabo attach` read `.worktreeinclude` from the root of the source checkout. The file uses gitignore syntax. A file is copied only when a pattern matches it and Git ignores it, so tracked files are never duplicated.

```text
.env
.env.local
config/secrets.json
```

Files that already exist in the new workspace are left unchanged. Symlinks are skipped and are not followed. A `.worktreeinclude` that is itself a symlink is not read.

`--copy-file` adds extra gitignore patterns for that command.

## Repository hooks

`.mabo.toml` is read from the source checkout: the checkout where the command runs (`git rev-parse --show-toplevel`). `.worktreeinclude` is read from that same checkout.

```toml
[hooks]
post-create = ["pnpm install"]
pre-delete = ["./scripts/teardown.sh"]
```

`mabo create`, `mabo attach`, and `mabo github checkout` run `post-create` in the new workspace. `mabo delete` and `mabo gc --apply` run `pre-delete` in the workspace before removing it. Commands run in order and stop at the first failure. Unknown keys are rejected.

Hooks run only when that repository is trusted. `.worktreeinclude` copies are not hooks and do not need trust. A repository with no hook commands never asks.

On a terminal, mabo prints the repo path and the hook commands, then asks `Trust this project and run its hooks? [y/N]`. `y` or `yes` saves trust and runs the hooks. mabo does not ask when `CI` is nonempty, when `--no-input` or `MABO_NO_INPUT` is enabled, when stdin or stderr is not a terminal, or when JSON output is selected. It then exits 4 before changing the repository, the same as a non-terminal. With `--json`, stdout contains one error envelope with `error.code` set to `untrusted`. The message tells you to run `mabo trust add` or pass `--no-hooks`.

`mabo trust add [REPO]` shows the hooks on stderr and records trust without prompting. `mabo trust remove [REPO]` removes the grant, and `mabo trust list` prints trusted common directories and grant times. REPO uses the same paths and names as `-R`; omission uses `-R` or the current repository. Trust is keyed by the canonical Git common directory, so the primary checkout and linked workspaces share a grant. Re-cloning at the same path keeps trust until `mabo trust remove`. Editing the hook commands does not ask again. The human TTY prompt during create is unchanged.

The record is `$XDG_STATE_HOME/maboroshi/trust.toml` when `XDG_STATE_HOME` is an absolute path, otherwise `~/.local/state/maboroshi/trust.toml`. Each entry stores `path` and `trustedAt`.

`MABO_TRUST_ALL=1` trusts every repository for that process and does not write the file. The value has to be the single character `1`. Use it in CI and containers. `--no-hooks` on `create`, `attach`, `delete`, `gc`, and `github checkout` does the workspace change and skips hooks. It does not write trust.

`mabo gc` never asks, including on a terminal. An untrusted repository that has `pre-delete` hooks is skipped. The candidate detail is `untrusted hooks`. Other candidates still run. `--no-hooks` removes those workspaces without running hooks.

Hooks, `mabo exec`, and `create`/`attach --exec` receive the same environment:

- `MABO` — `1`
- `MABO_WORKSPACE` — workspace name
- `MABO_WORKSPACE_ID` — recorded `ws_` ID, or empty when unrecorded
- `MABO_WORKSPACE_PATH` — absolute workspace path
- `MABO_REPO_PATH` — absolute primary checkout path, even when hooks are read from a linked workspace

The old `MABO_NAME`, `MABO_PATH`, and `MABO_ROOT_PATH` variables are removed from child environments. Update hook scripts and exec commands to use the variables above.

## Machine-readable JSON

`--json` (an alias for `--output json`) prints exactly one schema 2 envelope to **stdout**. Every JSON command uses the same contract, including errors and `repo list`. Parsers must ignore unknown fields. Progress, hooks, Git output and `--exec` output go to **stderr**. Human output is selected with `--output text`.

```json
{
  "schema": 2,
  "command": "where",
  "ok": false,
  "data": null,
  "warnings": [],
  "error": { "code": "not_found", "message": "Workspace 'topic' not found" }
}
```

`command` uses space-separated names such as `meta set` and `github checkout`. `data` contains the command result without a top-level `schema`; only `--version` uses `data.version` for the application version. `error` is null on success, otherwise an object with stable `code`, human `message` and optional `details`. Partial results remain in `data`, including setup failures and per-item delete/gc/sync results. Per-item errors stay on their items. `warnings` contains objects with stable `code` and `message`, including metadata read/update failures and unavailable PR status; warnings may also appear on stderr.

| Exit | Meaning | Example error codes |
|---|---|---|
| 0 | Success, including gc plans with protected candidates | |
| 1 | Operational failure | `failed`, `git_failed`, `io`, `command_failed`, `spawn`, `signaled` |
| 2 | Invalid invocation | `usage`, `ambiguous` |
| 3 | Not found or outside a repository | `not_found`, `branch_not_found`, `not_repository` |
| 4 | Safety refusal before changes | `dirty`, `unpreserved`, `published`, `exists`, `exists_remote`, `untrusted`, `refused` |
| 5 | Sync conflict, rolled back or kept with `--keep-conflicts` | `conflict` |
| 6 | Persistent changes followed by failure or partial success | `partial` |

`refused` is the fallback when a safety refusal has no more specific cause. The same statuses apply to text output. Standalone `exec` preserves its child's exit status, including 128+signal. Create/attach/checkout setup failures exit 6 and retain the workspace plus child statuses in `data.postCreate.exitCode` or `data.exec.exitCode`. Metadata save and copy failures after creation also exit 6. Delete checks every name before removing any; a safety refusal exits 4 and removes nothing. A later failure exits 6 if something was removed, otherwise 1. A failed pre-delete hook aborts deletion. `unpreserved` protects commits absent from the default branch or remotes, or commits that could not be checked; use `--keep-branch` or `--force` (detached HEAD requires `--force`).

`MABO_OUTPUT=json|text` sets the default; empty means unset and other values exit 2. Explicit output flags override it. Unknown commands and missing commands after common options also return a usage envelope when JSON is selected. `list --names` (and repo `--names`/`--paths`) selects text even with `MABO_OUTPUT=json`; explicitly combining it with JSON is a usage error. `exec` and text help through `--help` ignore `MABO_OUTPUT`. `--version` and `help` support JSON and honor the output mode. Explicit `exec --json` or `exec --output json` is a usage error; arguments after the workspace name belong to the child.

Mabo never prompts in non-interactive mode: nonempty `CI`, JSON output, `--no-input`, `MABO_NO_INPUT` other than empty or `0`, or stdin/stderr without a TTY. Untrusted hooks refuse before changes with exit 4 and a `mabo trust add` / `--no-hooks` hint. Network Git operations receive `GIT_TERMINAL_PROMPT=0`; repository hooks and gh read stdin from `/dev/null`. User commands (`--exec` and standalone `exec`) inherit stdin.

### Workspace object

`list`, `where`, `create`, `attach`, `meta set`, `delete`, and `github checkout` share this object. Their data uses `workspace` or `workspaces` keys (including each `deleted` entry); sync reports its results under `default` and `workspaces`. `path` is absolute. `head` is the full HEAD SHA, or null when Git has no HEAD. `branch` is null when HEAD is detached (`detached` is true). `base` is the commit-ish this command started from when it knows one; otherwise it is the recorded sync base (a full ref such as `refs/remotes/origin/main`), or null for legacy/unrecorded workspaces. `list --json` exposes that recorded base. `dirty` is true when `git status --porcelain` reports any change. `kind` is `primary` for the repository's primary checkout and `workspace` for other workspaces.

```json
{
  "name": "feature/add-tests",
  "path": "/home/user/.local/share/maboroshi/workspaces/repo-6b4ca2db/feature/add-tests",
  "branch": "feature/add-tests",
  "head": "0123456789abcdef0123456789abcdef01234567",
  "base": "HEAD",
  "dirty": false,
  "kind": "workspace",
  "detached": false,
  "purpose": "fix the flaky checkout test",
  "createdAt": "2026-10-18T11:46:00.000Z",
  "createdFrom": "0123456789abcdef0123456789abcdef01234567",
  "links": {
    "pr": { "number": 774, "url": null },
    "issue": null
  }
}
```

`id`, `purpose`, `base`, `createdAt`, `createdFrom`, and `links` come from `maboroshi/workspaces/<id>.json` in the Git common directory (`git rev-parse --git-common-dir`). For a normal repository that directory is `.git`. `mabo create`, `mabo attach`, and `mabo github checkout` write a record. `links.pr` and `links.issue` are `{ "number", "url" }` or null. A number stores `url` as null. An http(s) URL stores the URL and a number parsed from `/pull/`, `/pulls/`, `/issues/`, or `/issue/` when one is present. `github checkout` fills the matching link, including `https://<host>/<owner>/<repo>/pull/<number>` or `.../issues/<number>`. `where` and `exec` read metadata without changing record files. `delete` removes the record after Git removes the workspace. `create` and `attach` replace any record already stored at that path. `meta set` and a second `github checkout` of a workspace that already exists patch the record. `create --json` and `attach --json` include `metadata` as `{ "ok": true, "error": null }`. When saving the record fails after the workspace exists, `ok` is false, `error` explains why, copy and hooks still run, and the process exits 6 with `error.code` set to `partial` and the result retained in `data`. A corrupt workspace record makes `list`, `where`, and `exec` continue with null metadata for that record and a warning; other records remain readable. `create`, `attach`, `delete`, `meta set`, `sync`, and `github checkout` refuse and leave the file unchanged. Sync validates metadata before fetching or updating any target. Concurrent first registrations for the same path are read as one record: the oldest `createdAt` wins, then the lexicographically smallest `id` breaks ties. All fields come from that record, and the next metadata write removes the extra files. `createdFrom` is the full commit the branch was created from, or the base tip sync last fast-forwarded it to while it had no commits of its own. `create` stores the new branch's HEAD. A record for a branch that already existed stores the oldest `refs/heads` reflog entry, or null when that reflog is missing. `meta set` and a later checkout leave it unchanged. A record written before this field existed has `createdFrom` null. `mabo meta set` patches the fields you pass and leaves the others. A workspace Git created outside `mabo`, including the primary checkout, has null metadata fields until `meta set` or `github checkout` records it. Cleanup details (`prunable`, `locked`) can be added later without a new version.

Workspace records contain `schema: 2`, an `id` of the form `ws_<uuid v4>`, `path`, an optional `name`, and the metadata fields above. JSON workspace objects include `id` (null for an unrecorded workspace). Each record is written atomically through a temporary file in the same directory, fsync, and rename. Deleting a record removes only its file. Concurrent additions of different records preserve both; concurrent updates of the same record use the last write.

Repo registrations live in `$XDG_STATE_HOME/maboroshi/repos/<id>.json`, falling back to `~/.local/state/maboroshi/repos/<id>.json`. They keep their existing `proj_<uuid>` IDs. Readers deduplicate registrations by root path, keeping the oldest `createdAt` (then the smallest ID on a tie). The first write imports legacy `maboroshi/worktrees.json` or `$XDG_STATE_HOME/maboroshi/projects.json` into individual files and renames the source to `*.json.imported`. Read-only commands can read the legacy files before import. Failed imports leave the source intact. Mabo uses no internal file locks; trust and user config remain single files replaced atomically.

### Sync

`mabo sync` maps bases to remotes through their configured fetch refspecs, fetches each involved remote once, fast-forwards the default branch, and integrates workspace bases. It never pushes, changes upstream configuration, or runs hooks; every Git call during sync, including status checks and rollback, disables Git hooks and fsmonitor.

```sh
# Human: from the primary checkout, update only the default branch.
mabo sync
# From a linked workspace or any subdirectory, also sync that workspace.
cd "$(mabo where feature/auth)"
mabo sync
# Select workspaces and choose a strategy explicitly.
mabo sync feature/auth feature/tests --merge
mabo sync feature/auth --rebase --force
# Select a workspace by name.
mabo create feature/task --purpose 'implement task'
mabo sync feature/task --json
# Skip the default branch, or process all workspaces.
mabo sync --all --no-default
mabo sync -R owner/repo --all
# Keep a single conflicted operation for manual resolution.
mabo sync feature/auth --keep-conflicts
mabo meta set feature/auth --base origin/main
```

`create` and new GitHub issue checkouts record a sync `base`: an explicit `--base` is normalized to a full ref, otherwise the remote-tracking default branch when available, then the local default branch. Commit bases remain supported. When a clone has no discoverable default branch, creation retains its existing HEAD-based behavior and records that ref. PR checkout records the PR target as a full `origin` remote-tracking ref when present locally, otherwise the same fallback. A second GitHub checkout preserves an existing base, including one set by the user. Older metadata without `base` uses the same default-branch fallback at sync time. `meta set --base <ref>` validates and replaces the base; a removed base is skipped as `base-gone` with a repair hint.

Auto strategy rebases when none of the workspace's own commits (`base..branch`) is reachable from any remote-tracking ref, including destinations outside `refs/remotes` in configured fetch refspecs; otherwise it merges. `--rebase` refuses published commits with code `published` and exit 4 unless `--force` is given. `--merge` always selects merge. Rebasing requires Git 2.29 or later, reapplies upstream cherry-picks (including reverted ones), and keeps intentionally empty commits and commits that become empty. Before flattening merges, sync requires Git 2.38 or later to verify their automatic merge trees; merges with their own changes or conflict resolutions (and merges it cannot verify) fail untouched with a `--merge` hint. `--force` only permits local history rewriting. Dirty workspaces (including untracked, non-ignored files), detached workspaces, and already landed branches are skipped. Ignored paths that integration could overwrite also cause a dirty skip, with case-insensitive comparisons when `core.ignorecase` is true. Landed branches suggest `mabo gc`. `--all` selects every workspace in the repository.

A conflict reports the conflicting files and aborts the operation, restoring HEAD, the index tree, and file contents. `--keep-conflicts` leaves the operation in progress and requires exactly one target; several targets produce usage exit 2. Default-branch updates are fast-forward only, including in a linked workspace, which is reported once by the default item; with `--no-default`, that workspace is excluded unless explicitly named, when it still uses `ff-only`. Local commits cause `diverged`; blocking local changes cause `dirty`, even when branch merge options request autostash. With workspace targets, those default-branch skips are best effort and do not block workspace updates; fetch failures mark only items using that remote as `failed`, while other bases proceed. If the default cannot be resolved, its item and targets needing its fallback base report `failed`, while targets with recorded bases continue.

Human output has one `<name>  <status>  [detail]` line per item, followed by status counts such as `Sync complete: 2 updated, 1 conflict, 1 dirty`. Conflicts use `topic  conflict  file.rs (rebase aborted; workspace unchanged)` (or `merge`); with `--keep-conflicts`, the ending is `(rebase left in progress)`. Other failures show the first meaningful diagnostic line. Fresh branches with no work of their own are integrated, rather than reported as merged. `--json` uses the shared envelope:

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
    "workspaces": [
      {
        "name": "feature/task",
        "path": "/workspaces/feature/task",
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

`default` is null with `--no-default`. Otherwise `name` is the default branch name, `branch` its full local ref, `base` the fetched target ref, and `path` its checkout path or null if not checked out. `strategy` is `ff-only`. Workspace `branch` is the branch name or null for detached HEAD, `base` is the normalized base, and `strategy` is `rebase`, `merge`, or null when skipped before strategy selection. Both item types report full `before`/`after` commit IDs, conflicting file paths in `conflicts`, optional human `detail`, and optional refusal `code` (`published`). Fields unavailable after an error are null.

Statuses are `updated`, `up-to-date`, `dirty`, `diverged`, `merged`, `detached`, `base-gone`, `conflict`, and `failed`. Exit 6 takes precedence when any item changes and a failure, conflict, or published refusal occurs. Without changes, failures exit 1, conflicts exit 5, and published refusals exit 4; other outcomes exit 0. A default-only `dirty`/`diverged` result remains an operational failure (1). Usage errors exit 2.

Orphaned records have neither a Git worktree registration nor an existing directory. `list` includes them with a trailing `[orphaned]`; the shared JSON workspace object has `orphaned: true` (false for existing entries), with null `branch` and `head`. `where` and `exec` refuse orphaned names. `delete <name>` removes only the stale record, exits 0, and reports that the workspace was already gone; it runs no hooks and leaves branches alone. Its existing JSON result uses `workspace.orphaned: true` and `branchDeleted: false`. A live workspace matching the same name takes precedence; multiple orphaned records with the same resolved name are refused as ambiguous. Orphaned records do not reserve names for live workspaces. When a live workspace takes the same name, the orphan remains visible in `list`; use `gc --apply` to remove it, since `delete <name>` resolves to the live workspace.

### Commands

`list --json`:

```json
{
  "schema": 2,
  "command": "list",
  "ok": true,
  "data": {
    "workspaces": []
  },
  "warnings": [],
  "error": null
}
```

`where --json` and the result of a create, attach, or checkout use the workspace object. `where` returns:

```json
{
  "schema": 2,
  "command": "where",
  "ok": true,
  "data": {
    "workspace": {}
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
    "workspace": {},
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

`copyFiles.ok` is false when copying `.worktreeinclude` matches fails. The workspace is still created. `postCreate.ran` is false when no hook is configured. On success, `exitCode` is 0 and `command`, `signal`, and `error` are null. On failure, `command` is the hook that failed and `exitCode` is its status. `exec` is null when `--exec` was not passed. Otherwise it is `{ "ok": true, "command": "npm test", "exitCode": 0, "signal": null, "error": null }`. For both `postCreate` and `exec`, `signal` is the signal name when the process was killed, and `exitCode` is `128` plus the signal number (`143` for `SIGTERM`, `130` for `SIGINT`, `137` for `SIGKILL`, `129` for `SIGHUP`). `error` is set when the shell or program failed to start. `ok` is false in both cases, and the workspace object is still returned.

`attach` leaves `workspace.base` null. `create` sets it to the requested base (`HEAD` when omitted).

`delete --json`:

```json
{
  "schema": 2,
  "command": "delete",
  "ok": true,
  "data": {
    "deleted": [
      {
        "workspace": {},
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

`gc --json` is a dry run unless `--apply` or `--force` is set. Before each removal, gc rechecks that target, querying its linked PR at most once during that recheck and skipping missing registrations whose branch or HEAD changed since planning. A branch that still points at its recorded `createdFrom` commit is not merged. A branch whose upstream ref is gone is merged when a clean merge would leave the default branch tree unchanged and the branch diff is not empty. When `createdFrom` is null, gc uses the oldest branch reflog entry for that check, and recognizes subsequent fast-forwards performed by `mabo sync` when the branch has no commits outside the base. For unrecorded workspaces, missing or incomplete branch reflogs are treated conservatively as not merged, so sync can keep updating and gc keeps the workspace. Recorded workspaces retain their existing missing-reflog behavior. A workspace still at that commit can match `--older-than` or an orphaned checkout. A workspace checked out on the default branch is kept, including when fetch refspecs store its remote branch under a different namespace; local defaults use full branch refs despite same-name tags. If gc cannot resolve the default base or local branch name, it warns and keeps all branch workspaces, including with `--force`, while allowing orphan-record cleanup. `gh pr view` receives the stored pull request URL when one was recorded. A number with no confirmed repository is unavailable, and gc says so instead of ignoring the link. `applied` is true when a removal was requested. Each candidate names the workspace, why it matched (`merged`, `pullRequest`, `orphaned`, `olderThan`), and `action`: `wouldRemove`, `removed`, `skipped`, or `failed`. `detail` explains a skip or a failure. `branchDeleted` is null on a dry run and on a skip. A removal failure sets the envelope `error` and exits 6 if a persistent removal occurred, including when the same candidate fails metadata cleanup after checkout or registration removal, otherwise 1, and the other candidates are still listed. An empty plan exits 0.

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
        "path": "/home/user/.local/share/maboroshi/workspaces/repo-6b4ca2db/feature",
        "branch": "feature",
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
    "workspace": {},
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

`github.kind` is `pullRequest` or `issue`. `headRef` is the pull request head ref, and null for an issue. `workspace.base` is the fetched upstream for a new pull request, the requested base for a new issue, and null when the workspace already existed.

In a single-branch or otherwise narrow-refspec clone, `github checkout` writes `branch.<b>.remote/merge` so `git pull` works, but `@{upstream}` and ahead/behind do not resolve because mabo does not change `remote.origin.fetch`.

### Repo list

`repo list --json` uses the common schema 2 envelope. It uses camelCase and absolute `rootPath` values. Each repo includes `canonicalName` (`host/owner/repo` from `origin`, otherwise from a `<root>/<host>/<owner>/<repo>` checkout, otherwise the directory name). `name` stays the directory name. Warnings are recorded in the envelope and on stderr. Parsers must ignore unknown fields, so adding `canonicalName` does not change `schema`.

```json
{
  "schema": 2,
  "command": "repo list",
  "ok": true,
  "data": {
    "repos": [
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

`repo add --json` and `repo forget --json` return `{ "status", "repo" }` in `data`. Errors use the common envelope.

### Clone

`clone --json` uses the common schema 2 envelope. `repo.root` is the absolute primary checkout path. `repo.name` is the canonical `host/owner/repo` name, with a lowercased host (including any port). `repo.remoteUrl` is the clone URL with the same lowercased host. `http` and `https` userinfo is removed, including a token used as the username (`https://github.com/<owner>/<repo>.git` for `owner/repo` and `host/owner/repo`). `ssh` and scp-style URLs keep the login name. `cloned` is true when this command created the checkout. `updated` is true only when `--update` fetched an existing checkout. Git's progress stays on stderr.

```json
{
  "schema": 2,
  "command": "clone",
  "ok": true,
  "data": {
    "repo": {
      "root": "/home/maboroshi/ghq/github.com/aku11i/phantom",
      "name": "github.com/aku11i/phantom",
      "remoteUrl": "https://github.com/aku11i/phantom.git"
    },
    "cloned": true,
    "updated": false
  },
  "warnings": [],
  "error": null
}
```

A failed clone uses the common error envelope. A destination that is not the expected repository is `usage` / exit code 2. A path component the filesystem rejects, such as a name longer than the filename limit, is also `usage` / exit code 2. If Git cannot read its configuration while inspecting an existing checkout, the error includes Git's message and uses exit code 1. A Git failure during clone or fetch is `command_failed` with exit code 1. If repo registration fails after a checkout was created or an existing checkout was fetched, the command exits 6 with `error.code` set to `partial`, retaining the completed result (including `repo.root`, `cloned`, and `updated`) in `data`. The checkout remains available; retrying the command can register it. Registration failure without a clone or fetch exits 1.
