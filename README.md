# Maboroshi

Maboroshi (幻, "phantom space") — workspaces for parallel coding agents.

Maboroshi manages local Git workspaces so that many coding agents and humans can work independently in the same repository at the same time. A workspace is one checkout of one repository plus what Git doesn't track about it: its name, its purpose (pull request, issue, base), and its observed state. Today each checkout is a Git worktree.

The Rust rewrite lives on `next` and ships as `v7.0.0-alpha` prereleases on [GitHub Releases](https://github.com/phantompane/phantom/releases) (it is not on npm yet). The previous TypeScript version stays on `main`; its README is at <https://github.com/phantompane/phantom/blob/main/README.md>.

## Why

Git records the code and the checkouts. It does not record why a checkout exists or whether it can be retired. With many agents working in one repository at once, those are the questions nobody can answer. Maboroshi fills that gap on top of plain Git: repositories, branches, and worktrees stay ordinary Git, and `git` keeps working alongside `mabo`.

Workspaces separate files and branches, not processes, ports, databases, or credentials. Maboroshi coordinates workspace boundaries and its own operations; running services side by side is up to your repo and its hooks.

## What it does

Maboroshi creates, takes over, and prepares workspaces, keeps them current with their base, and retires them:

- **Allocate and prepare.** `clone` places a repository in the ghq layout. `create` give each piece of work its own workspace, copy ignored files matched by `.worktreeinclude`, and run repository hooks in repositories you trust.
- **Identify.** `set` records the purpose, linked pull request or issue, and base. `list` and `show` show what exists and where.
- **Update.** `sync` fetches and brings selected workspaces up to date with their base; `--main` explicitly advances primary.
- **Retire.** `gc` selects workspaces on evidence: merged branches, closed pull requests, and orphaned records; `--older-than` only narrows those candidates.

Every command can run non-interactively. Every JSON command returns a schema 2 envelope containing `command`, `ok`, `data`, `warnings`, and `error`. Errors are structured, with stable, documented exit codes (see [Machine-readable JSON](#machine-readable-json)). `exec` passes through the child command's output and exit code instead. Humans use the same commands with plain-text output.

## Safe by default, explicit when you want otherwise

- **Retirement is safe by default.** `gc` prints a plan until `--apply`. It skips dirty and unpreserved work, giving targeted `remove` hints with separate permissions. The primary checkout, default branch, current workspace, and Git-locked checkouts remain protected during gc.
- **Bulk operations address every workspace.** `sync --all` selects every workspace in the repository; add `--main` to advance primary. Use explicit names to narrow the selection. `gc` selects by evidence and age, with the same checks for dirty work and unpreserved commits.
- **Pushed history is kept by default.** When integration is needed, `sync` merges the base into published work. A workspace counts as published when at least one commit beyond its base is reachable from a known remote-tracking ref or configured fetch destination.
- **Non-interactive runs never wait at a prompt.** With nonempty `CI`, JSON output, `--no-input`, `MABO_NO_INPUT` other than empty or `0`, or when stdin or stderr is not a terminal, `mabo` itself does not ask questions. If an operation would run untrusted hooks, it refuses before changing the repository and exits 4 (`untrusted` in JSON); `gc` instead skips removals requiring those hooks, without treating the skip as an error. Record trust in advance with `mabo trust add`, or use `create --no-setup` / `setup --no-hooks` / `remove --no-hooks` / `gc --no-hooks`. Network Git operations receive `GIT_TERMINAL_PROMPT=0`; repository hooks and gh read stdin from `/dev/null`.

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

Workspace ownership and `lastUsedAt` have been removed. `--owner` exits 2: use `--purpose`, PR links, and workspace names. `sync --mine` exits 2: use explicit names or `--all`. `MABO_AGENT_ID` no longer affects mabo. Old records remain readable; their removed fields disappear when the record is next written. `show`, `path`, `list`, and `exec` leave records unchanged, and `gc --older-than` uses `createdAt`.

`mabo help [COMMAND...]` prints the same text as `--help`. `mabo help --json` returns the schema 2 envelope with the complete contents of `help-data.json` in `data`: `commands`, `helps` (all commands and flags), `globalOptions`, `exitCodes`, `errorCodes`, and `schemaVersion: 2`. `mabo help repo show --json` includes the same contract plus `data.selected` for that command.

## User configuration

`mabo` stores user configuration in `$XDG_CONFIG_HOME/maboroshi/config.toml` (default `~/.config/maboroshi/config.toml`). `mabo config get`, `set`, `unset`, and `list` read and write that file. The first `set` creates the directory and file.

```toml
workspace-root = "../maboroshi-workspaces"
discover-ghq = true
clone-root = "~/ghq"
```

When `workspace-root` is unset, `mabo create` place the new workspace at `$XDG_DATA_HOME/maboroshi/workspaces/<checkout>-<hash>/<name>`. The fallback is `~/.local/share/maboroshi/workspaces/...` when `XDG_DATA_HOME` is unset, empty, or not absolute. `<checkout>` is the canonical primary checkout directory name, with characters outside letters, numbers, `.`, `_`, and `-` replaced by `-`. A symlink to that checkout uses the same directory. `<hash>` is the first 8 hexadecimal digits of the SHA-256 of the canonical Git common directory. Two clones of the same remote get different directories. Workspace names retain their `/` hierarchy. Existing workspaces under `maboroshi/worktrees/` stay at their current paths and remain available to `list`, `show`, `remove`, `sync`, and `gc`. Deleting the last workspace keeps the repo directory and its `.maboroshi-common-dir` marker so concurrent and subsequent creates can reuse it safely. `remove` and `gc` also remove a linked workspace recorded in `maboroshi/workspaces/<id>.json`, including one created under `.git/maboroshi/worktrees` or a different data directory. An unrecorded workspace outside the resolved directory stays. Empty parent directories below the repo directory are cleaned up only for a workspace inside the resolved directory. A set `workspace-root` may be absolute, start with `~/`, or be relative to the repository root, and that directory is left in place when it becomes empty.

`clone-root` is where `mabo clone` places repositories. It is an absolute path or a path starting with `~/`. When `clone-root` is unset, `mabo clone` uses the first `git config ghq.root` value, then `$GHQ_ROOT`, then `~/ghq`. A configured `clone-root` is used without reading git config. If reading `ghq.root` fails, `mabo` warns and continues with `$GHQ_ROOT` or `~/ghq`. `repo list` scans that same directory.

`config get KEY` and `config list` return effective values, including defaults. Add `--sources` to see `value`, `source` (`config`, `env`, or `default`), and `detail`. JSON stores those values under `data.config[KEY]`; without `--sources`, each entry is the value itself. `workspace-root` defaults to null (the XDG layout), `discover-ghq` to true. The clone-root default chain stays `ghq.root` → `$GHQ_ROOT` → `~/ghq`, below user config. `sync.strategy` accepts `auto` (default), `rebase`, or `merge`; `sync.rewrite-published` is a boolean (default false). Sync flags override these user settings. Invalid policy values exit 2. Store them under `[sync]` in user config.toml; `.mabo.toml` rejects personal sync policy.

Old config.toml keys `worktrees-directory`, `root`, and `ghq-discovery` still take effect as `workspace-root`, `clone-root`, and `discover-ghq`, with `config_key_renamed` warnings and migration hints. If both names exist, the new name wins. Reading does not change the file. The next successful `config set` or `config unset` rewrites old names. `directory-name-separator` is ignored with `config_key_removed` and removed on that write. `keep-branch` also warns and is ignored, then removed on the next config write.

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

The global `-R/--repo` option selects a repository. Workspace commands (`create`, `adopt`, `forget`, `list`, `show`, `path`, `remove`, `sync`, `gc`, `exec`, `set`) accept `--repo <ref>` (`-R`) so they can run against a repository other than the current directory. It may precede the command or appear among its options. `mabo exec` is the exception: put mabo options before SEL and separate the child command with the required `--`. Everything after `--` is passed to the command. This runs `pwd --repo y` inside the `feature` workspace of `owner/repo`:

```bash
mabo exec --repo owner/repo feature -- pwd --repo y
mabo list --repo ~/src/foo --json
```

A ref that starts with `/`, `.`, or `~` is a directory. It can be anywhere inside the repository, including a linked workspace, and resolves to the primary checkout. Hooks and `.worktreeinclude` are read from that primary checkout.

Any other ref is matched against registered repos and discovered checkouts (the same set as `repo list`, including when `discover-ghq` is false). The canonical name is `host/owner/repo`: from the `origin` URL when it is an http(s), ssh, or scp-style remote, otherwise from a checkout stored at `<root>/<host>/<owner>/<repo>`. A local or relative origin, including `backups/widget.git`, is not a host-based name. `owner/repo` and `repo` match when only one repo has that suffix. The directory name shown by `repo list` matches too, including when it differs from the canonical name. A location name that differs from the remote also matches. Several matches is a usage error (exit code 2) that lists the candidates. No match is not found (exit code 3). A path that does not exist is not found and says the path does not exist. A `--repo` value that starts with `-` is a validation error.

## Selecting and inspecting workspaces

`SEL` accepts a workspace name, `.` (the checkout containing cwd), `pr:N`, `issue:N`, or a PR/issue URL. Linked selectors only find existing records; they never create workspaces. A missing match exits 3 (`not_found`), and multiple matches exit 2 (`ambiguous`). A URL matches its recorded repository and link; a bare number is scoped to the selected repository. Using `.` with a different `-R` exits 2. Outside a repository, current selection exits 3.

`show [SEL]`, `path [SEL]`, `set [SEL]`, and `exec [SEL] -- COMMAND [ARG...]` default to `.`. In the primary checkout, `.` refers to that checkout. `show` reports its context with `managed:false`; unrecorded checkouts outside mabo's workspace directory also report `managed:false`. Positional arguments of `sync` and `remove` accept the same selectors. Sync without arguments selects only the current workspace; in primary it behaves as `--main`. Remove requires explicit selectors and retains its safety checks.

```sh
mabo show --json
mabo show pr:774 --json
mabo path issue:12
cd "$(mabo path feature/auth)"
mabo set --purpose 'fix checkout' --pr 774 --base origin/main
mabo set feature/auth --unset purpose --unset base --unset pr --unset issue
mabo exec -- git status
mabo exec feature/auth -- npm test
mabo sync pr:774
```

`path` prints only an absolute path and newline in text mode; JSON is `data: {path}`. `show` and `set` return `data.workspace`. `show`, `path`, `list`, and `exec` never change record contents or mtimes, or import legacy state. `set` atomically replaces the supplied purpose, base, PR and issue fields; omitted fields are kept. `--unset FIELD` clears one of purpose/base/pr/issue per occurrence; repeat the flag to clear several fields. It rejects unknown fields or a field that is also being set. `--base` validates and normalizes a ref; commit bases remain supported. `--unset base` records an unknown base without choosing a default. Sync skips it with `base-unknown` until `mabo set <name> --base REF` restores a base. Older records with no base field still use the default base.

`list` includes primary checkouts. Use `--kind workspace` or `--kind primary` to filter, `--names` or `--paths` for shell output, and `--all-repos` for repositories known to `repo list` (registrations and enabled discovery). `--all-repos` cannot be combined with `-R`. Its JSON includes `data.repos` as well as the flattened `data.workspaces`. Human output starts each repository with its name and primary path, then shows current (`*`), name, branch, ahead/behind (`↑a ↓b`), dirty state, PR/issue links (`#12` / `issue #34`), setup state when it is not `ok` (such as `setup:failed`), and purpose. A deleted upstream appears as `upstream:gone`.

The removed `where` command exits 2 with a `path` / `show --json` hint. `meta` and `meta set` exit 2 with a `set` / `show` hint. `list --no-default` exits 2 with `--kind workspace` guidance. An exec invocation without the required `--` exits 2 with the new syntax. Exec preserves child output and exit status, ignores `MABO_OUTPUT`, and refuses explicit JSON output. Usage diagnostics and any accompanying help go to stderr, leaving text stdout empty.

## Shell conveniences

Load the directory helper and completions separately in your shell startup file:

```bash
# ~/.bashrc
eval "$(mabo shell-init bash)"
eval "$(mabo completions bash)"
```

```zsh
# ~/.zshrc (run compinit before loading completions)
autoload -Uz compinit
compinit
eval "$(mabo shell-init zsh)"
eval "$(mabo completions zsh)"
```

```fish
# ~/.config/fish/config.fish
mabo shell-init fish | source
mabo completions fish | source
```

The helper defines only a `mabo` function. `mabo cd [SEL] [-R REF]` resolves `command mabo path` in text mode and changes directory only on success; a lookup failure preserves the current directory, diagnostic and exit status. Repository options may also precede `cd`: `mabo -R owner/repo cd feature`. Use `mabo cd -- -leading-name` for a selector starting with a hyphen. Paths containing spaces stay one argument, for example `mabo cd './workspace with spaces'`. Other invocations pass every argument to `command mabo` unchanged. There are no sessions or panes, and shell-init does not load completions.

Completions derive commands, subcommands and flags from `help-data.json`. Workspace selector candidates are queried with `command mabo list --names` when completing; query failures silently produce no workspace candidates. `-R`/`--repo` selects the repository for that query. Fish and zsh also show descriptions. These are minimal completions: they do not complete arbitrary Git refs, child commands after `exec --`, or every option value.

Both script commands require `bash`, `zsh` or `fish`; missing or unknown shells exit 2 with a usage hint. They ignore `MABO_OUTPUT` and reject explicit `--json` / `--output json` with exit 2. `mabo help completions`, `mabo help shell-init` and `mabo help --json` describe the contract.

## Copying gitignored files

`mabo create` and `mabo setup` read `.worktreeinclude` and copy files from the **primary checkout**, even when run in a subdirectory or another workspace. The file uses gitignore syntax. A file is copied only when a pattern matches it and Git ignores it, so tracked files are never duplicated.

```text
.env
.env.local
config/secrets.json
```

Files that already exist in the new workspace are left unchanged. Symlinks are skipped and are not followed. A `.worktreeinclude` that is itself a symlink is not read.

`--copy-file` adds extra gitignore patterns for that command.

## Re-running setup

```sh
mabo setup feature-auth                     # copy, then run trusted setup hooks
mabo setup --no-hooks --copy-file '*.env'    # current workspace, copying only
mabo create feature-auth --no-setup         # prepare later
```

`setup [SEL]` defaults to `.` and uses the shared workspace selectors. The primary checkout is refused with exit 4 (`primary`), since it is the copy source. An untrusted setup hook refuses with exit 4 (`untrusted`) **before copying or updating records**. Missing targets exit 3. Copy or hook failures exit 1; a successful setup exits 0. Existing target files are preserved; a copying failure stops before hooks run.

After create exits 6 because setup failed, run the retry command from the error in bash or zsh: `cd '/absolute/source/checkout' && mabo setup 'SELECTOR'`. It preserves the original checkout's hook configuration and uses the workspace name or a unique PR/issue selector. If neither resolves uniquely, the hint uses `(cd WORKSPACE && mabo setup . --source-checkout SOURCE)` to retain the original hooks while selecting the target with dot. `--source-checkout` must belong to the same repository. The hint retains every `--copy-file` pattern, using ANSI-C quoting (`$'...'`) for control characters. `create NAME --reuse` only returns the matching workspace and never reruns setup. Setup hooks must be safe to run again.

Every shared workspace JSON object includes `setup: {state, at, error}`, or `null` for an unrecorded checkout (including after `forget`). New creations record `pending`, then `running`, then `ok` or `failed`; `--no-setup` records `skipped`. Old, imported, and adopted records report `unknown` with null time/error. Setup records the current attempt's timestamp and error, clearing the error on success. `data.setup` also includes `ran`, `ok`, `command`, `exitCode`, and `signal` for the invocation; `data.copy` contains `copied` paths and `error`.

A running attempt records its process ID and host internally. If that process no longer exists on the same host, inspection displays `interrupted` without changing the record. A different or unknown host keeps `running`. This is informational: it does not lock a workspace or block setup or any other operation. Concurrent updates of one record still use the last write.

## Repository hooks

`.mabo.toml` is read from the source checkout: the checkout where the command runs (`git rev-parse --show-toplevel`). `.worktreeinclude` and the files to copy always come from the primary checkout.

```toml
[hooks]
setup = ["pnpm install"]
pre-remove = ["./scripts/teardown.sh"]
```

`mabo create` and `mabo setup` run `setup` in the target workspace after copying. Write setup hooks to tolerate repeated execution. `mabo remove` and `mabo gc --apply` run `pre-remove` in the workspace before removing it. Commands run in order and stop at the first failure. Unknown keys are rejected. Old `[hooks] post-create` and `pre-remove` keys fail with exit 1 (`failed`), with a hint to rename them to `setup` and `pre-remove`.

Hooks run only when that repository is trusted. `.worktreeinclude` copies are not hooks and do not need trust. A repository with no hook commands never asks.

On a terminal, mabo prints the repo path and the hook commands, then asks `Trust this project and run its hooks? [y/N]`. `y` or `yes` saves trust and runs the hooks. mabo does not ask when `CI` is nonempty, when `--no-input` or `MABO_NO_INPUT` is enabled, when stdin or stderr is not a terminal, or when JSON output is selected. It then exits 4 before changing the repository, the same as a non-terminal. With `--json`, stdout contains one error envelope with `error.code` set to `untrusted`. The message tells you to run `mabo trust add` or pass `--no-setup` for create / `--no-hooks` for setup, remove, and gc.

`mabo trust add [REPO]` shows the hooks on stderr and records trust without prompting. `mabo trust remove [REPO]` removes the grant, and `mabo trust list` prints trusted common directories and grant times. REPO uses the same paths and names as `-R`; omission uses `-R` or the current repository. Trust is keyed by the canonical Git common directory, so the primary checkout and linked workspaces share a grant. Re-cloning at the same path keeps trust until `mabo trust remove`. Editing the hook commands does not ask again. The human TTY prompt during create is unchanged.

The record is `$XDG_STATE_HOME/maboroshi/trust.toml` when `XDG_STATE_HOME` is an absolute path, otherwise `~/.local/state/maboroshi/trust.toml`. Each entry stores `path` and `trustedAt`.

`MABO_TRUST_ALL=1` trusts every repository for that process and does not write the file. The value has to be the single character `1`. Use it in CI and containers. `create --no-setup` skips copying and hooks. `setup --no-hooks` copies files only; `remove --no-hooks` and `gc --no-hooks` skip removal hooks. These flags do not write trust. Old `create --no-hooks` exits 2 with a `--no-setup` migration hint; `--no-setup` cannot be combined with `--copy-file`.

`mabo gc` never asks, including on a terminal. An untrusted repository that has `pre-remove` hooks is skipped. The candidate detail is `untrusted hooks`. Other candidates still run. `--no-hooks` removes those workspaces without running hooks.

Hooks and `mabo exec` receive the same environment:

- `MABO` — `1`
- `MABO_WORKSPACE` — workspace name
- `MABO_WORKSPACE_ID` — recorded `ws_` ID, or empty when unrecorded
- `MABO_WORKSPACE_PATH` — absolute workspace path
- `MABO_REPO_PATH` — absolute primary checkout path, even when hooks are read from a linked workspace

The old `MABO_NAME`, `MABO_PATH`, and `MABO_ROOT_PATH` variables are removed from child environments. Update hook scripts and exec commands to use the variables above.

## Machine-readable JSON

`--json` (an alias for `--output json`) prints exactly one schema 2 envelope to **stdout**. Every JSON command uses the same contract, including errors and `repo list`. Parsers must ignore unknown fields. Progress, hooks, Git output output go to **stderr**. Human output is selected with `--output text`.

```json
{
  "schema": 2,
  "command": "show",
  "ok": false,
  "data": null,
  "warnings": [],
  "error": { "code": "not_found", "message": "Workspace 'topic' not found" }
}
```

`command` uses space-separated names such as `set` and `repo list`. `data` contains the command result without a top-level `schema`; only `--version` uses `data.version` for the application version. `error` is null on success, otherwise an object with stable `code`, human `message` and optional `details`. Partial results remain in `data`, including setup failures and per-item remove/gc/sync results. Per-item errors stay on their items. `warnings` contains objects with stable `code` and `message`, including metadata read/update failures and unavailable PR status; warnings may also appear on stderr.

| Exit | Meaning | Example error codes |
|---|---|---|
| 0 | Success, including gc plans with protected candidates | |
| 1 | Operational failure | `failed`, `git_failed`, `io`, `command_failed`, `spawn`, `signaled` |
| 2 | Invalid invocation | `usage`, `ambiguous` |
| 3 | Not found or outside a repository | `not_found`, `branch_not_found`, `not_repository` |
| 4 | Safety refusal before changes | `dirty`, `unpreserved`, `published`, `exists`, `exists_remote`, `untrusted`, `primary`, `refused` |
| 5 | Sync conflict, rolled back or kept with `--keep-conflicts` | `conflict` |
| 6 | Persistent changes followed by failure or partial success | `partial` |

`refused` is the fallback when a safety refusal has no more specific cause. The same statuses apply to text output. Standalone `exec` preserves its child's exit status, including 128+signal. Create setup failures exit 6 and retain the workspace plus hook status in `data.setup.exitCode`. Metadata save and copy failures after creation also exit 6. Remove checks every selector and safety guard before removing anything. A later failure exits 6 after persistent removal, otherwise the cause exit code. Per-item results remain available for retries. Remove reports unknown selectors as exit 3 before any hooks or removal, including with `--dry-run`. After exit 6, use `error.details.retryCommand` (also shown in text) to retry only unfinished work; repeating the original command may exit 3 for completed targets.

`MABO_OUTPUT=json|text` sets the default; empty means unset and other values exit 2. Explicit output flags override it. Unknown commands and missing commands after common options also return a usage envelope when JSON is selected. `list --names`/`--paths` (and repo `--names`/`--paths`) select text even with `MABO_OUTPUT=json`; explicitly combining it with JSON is a usage error. `exec`, `completions`, `shell-init` and text help through `--help` ignore `MABO_OUTPUT`. `--version` and `help` support JSON and honor the output mode. Explicit JSON output for `exec`, `completions` or `shell-init` is a usage error; arguments after the required `--` belong to the child.

Mabo never prompts in non-interactive mode: nonempty `CI`, JSON output, `--no-input`, `MABO_NO_INPUT` other than empty or `0`, or stdin/stderr without a TTY. Untrusted hooks refuse before changes with exit 4 and a `mabo trust add` / `create --no-setup` / `setup --no-hooks` hint. Network Git operations receive `GIT_TERMINAL_PROMPT=0`; repository hooks and gh read stdin from `/dev/null`. User commands (Standalone `exec`) inherit stdin.

### Workspace object

`current` identifies the checkout containing cwd. `repo` contains the primary root and repository name. `managed` is false for the primary checkout and unrecorded checkouts outside the workspace directory. `upstream` is null when no upstream is configured, otherwise `{ref,ahead,behind,gone}`; ref is fully qualified, and counts are null when the upstream is gone or unavailable. Unknown metadata and observed state are null. For an orphaned record, branch, head, dirty and detached are null. Reads never invent timestamps.

`list`, `show`, `create`, `adopt`, `set`, `remove` share this object. Their data uses `workspace` or `workspaces` keys (including each `items` entry); sync reports its results under `main` and `items`. `path` is absolute. `head` is the full HEAD SHA, or null when Git has no HEAD. `branch` is null when HEAD is detached (`detached` is true). `base` is the commit-ish this command started from when it knows one; otherwise it is the recorded sync base (a full ref such as `refs/remotes/origin/main`), or null for legacy/unrecorded workspaces. `list --json` exposes that recorded base. `dirty` is true when `git status --porcelain` reports any change. `kind` is `primary` for the repository's primary checkout and `workspace` for other workspaces.

```json
{
  "id": "ws_12345678-1234-4000-8000-123456789abc",
  "name": "feature/add-tests",
  "current": false,
  "repo": {"root": "/home/user/ghq/github.com/acme/demo", "name": "github.com/acme/demo"},
  "managed": true,
  "orphaned": false,
  "upstream": null,
  "path": "/home/user/.local/share/maboroshi/workspaces/repo-6b4ca2db/feature/add-tests",
  "branch": "feature/add-tests",
  "head": "0123456789abcdef0123456789abcdef01234567",
  "base": "refs/heads/main",
  "dirty": false,
  "kind": "workspace",
  "detached": false,
  "purpose": "fix the flaky checkout test",
  "createdAt": "2026-10-18T11:46:00.000Z",
  "updatedAt": "2026-10-18T11:46:00.000Z",
  "createdFrom": "0123456789abcdef0123456789abcdef01234567",
  "links": {
    "pr": { "number": 774, "url": null },
    "issue": null
  }
}
```

`id`, `purpose`, `base`, `createdAt`, `updatedAt`, `createdFrom`, `setup`, and `links` come from `maboroshi/workspaces/<id>.json` in the Git common directory (`git rev-parse --git-common-dir`). For a normal repository that directory is `.git`. `mabo create` writes a record. `links.pr` and `links.issue` are `{ "number", "url" }` or null. A number stores `url` as null. An http(s) URL stores the URL and a number parsed from `/pull/`, `/pulls/`, `/issues/`, or `/issue/` when one is present. `create --pr` or `create --issue` fills the matching link, including `https://<host>/<owner>/<repo>/pull/<number>` or `.../issues/<number>`. `show`, `path`, `list`, and `exec` read metadata without changing record files. `remove` removes the record after Git removes the workspace. `create` replaces any record already stored at that path. `set` patches intent. Reusing an existing PR branch can add its missing PR link while preserving creation details. `create --json` include `metadata` as `{ "ok": true, "error": null }`. When saving the record fails after the workspace exists, `ok` is false, `error` explains why, copy and hooks still run, and the process exits 6 with `error.code` set to `partial` and the result retained in `data`. A corrupt workspace record makes `list`, `show`, and `exec` continue with null metadata for that record and a warning; other records remain readable. `create`, `setup`, `adopt`, `forget`, `remove`, `set`, `sync` refuse and leave the file unchanged. Sync validates metadata before fetching or updating any target. Concurrent first registrations for the same path are read as one record: the oldest `createdAt` wins, then the lexicographically smallest `id` breaks ties. All fields come from that record, and the next metadata write removes the extra files. `createdFrom` is the full commit the branch was created from, or the base tip sync last fast-forwarded it to while it had no commits of its own. `create` stores the new branch's HEAD. A record for a branch that already existed stores the oldest `refs/heads` reflog entry, or null when that reflog is missing. `set` and a later checkout leave it unchanged. A record written before this field existed has `createdFrom` null. `mabo set` patches the fields you pass and leaves the others. A workspace Git created outside `mabo`, including the primary checkout, has null metadata fields until `set`, `adopt`, or PR reuse records it. Cleanup details (`prunable`, `locked`) can be added later without a new version.

Workspace records contain `schema: 2`, an `id` of the form `ws_<uuid v4>`, `path`, an optional `name`, and the metadata fields above. JSON workspace objects include `id` (null for an unrecorded workspace). Each record is written atomically through a temporary file in the same directory, fsync, and rename. Deleting a record removes only its file. Concurrent additions of different records preserve both; concurrent updates of the same record use the last write.

Repo registrations live in `$XDG_STATE_HOME/maboroshi/repos/<id>.json`, falling back to `~/.local/state/maboroshi/repos/<id>.json`. They keep their existing `proj_<uuid>` IDs. Readers deduplicate registrations by root path, keeping the oldest `createdAt` (then the smallest ID on a tie). The first write imports legacy `maboroshi/worktrees.json` or `$XDG_STATE_HOME/maboroshi/projects.json` into individual files and renames the source to `*.json.imported`. Read-only commands can read the legacy files before import. Failed imports leave the source intact. Mabo uses no internal file locks; trust and user config remain single files replaced atomically.

### Sync

```sh
mabo sync [SEL... | --all | --main] [--auto | --rebase | --merge] [--rewrite-published] [--keep-conflicts] [--dry-run]
```

No arguments sync only the current workspace (including from a subdirectory). In primary, no arguments behave as `--main`: fast-forward primary only when it is on the default branch, otherwise skip with `not-default-branch`. A workspace sync never advances primary implicitly. `--main` alone selects primary; `sync . --main` selects the current workspace and primary. `--all` selects every workspace in the selected repository and cannot combine with SELs (exit 2); add `--main` to include primary.

```sh
mabo sync
mabo sync feature/auth feature/tests --merge
mabo sync . --main --dry-run --json
mabo -R owner/repo sync --all
mabo sync feature/auth --rebase --rewrite-published
mabo sync feature/auth --keep-conflicts
mabo set feature/auth --base origin/main
```

Sync maps bases to remotes through configured fetch refspecs and fetches each involved remote once. It never pushes, changes upstream configuration, or runs hooks; every Git call, including status and rollback, disables Git hooks and fsmonitor. `--dry-run` also fetches, then returns `plan:true` without changing checkout contents, the index, local branches, or workspace records. Plans show the expected action in `status`/`detail`; a future merge/rebase commit ID is unknown (`after:null`). Plans never claim a published rewrite happened.

Both execution and dry runs use ordinary `git fetch` in the invoking repository. Before any fetch or integration, sync checks every configured fetch refspec of every involved remote and refuses with exit 4 `refused` if a positive refspec has a destination outside `refs/remotes/` (including explicit `refs/tags/` destinations and mirror mappings). Negative exclusions do not relax this conservative check; a missing or empty destination only writes `FETCH_HEAD` and is allowed. Use a tracking destination under `refs/remotes/` for custom namespaces. Sync also refuses any existing symbolic ref visible to `git for-each-ref` under `refs/remotes/` or `refs/tags/` that points outside `refs/remotes/`; repair or remove the alias before retrying. Dangling symbolic refs are omitted by Git's enumeration and are not detected: this is a known limit shared with plain `git fetch`. Git retains its configured pruning, automatic tag following, negative exclusions and `followRemoteHEAD` behavior; automatic tag following is not an explicit fetch refspec. Combined dry runs evaluate local bases against tips planned for primary and earlier workspaces, in selection order. Planned branch tips are keyed by full refs: the short branch name `refs/heads/a` maps to `refs/heads/refs/heads/a`, independently of branch `a` at `refs/heads/a`. When an earlier planned tip is unknown, dependent items report `updated`, `after:null`, `strategy:null` and a dependency explanation in `detail`, without deciding against the old base.

`create` records the normalized base; absent legacy bases fall back to the repository default. `set --unset base` and adoption without a base report `base-unknown` until `set --base REF` supplies one. A removed base reports `base-gone` with a repair hint. Explicitly cleared bases do not cause a fetch by themselves.

Strategy precedence is `--auto`/`--rebase`/`--merge`, user `sync.strategy`, then `auto`. Auto rebases when none of the workspace's own commits (`base..branch`) is reachable from an observed remote-tracking ref, configured fetch destination, or upstream; otherwise it merges. Independent local branch destinations count too, including those of remotes not fetched by this sync; only the current branch itself is excluded from publication evidence. An explicit rebase refuses published commits with exit 4 `published` and a `--rewrite-published` hint, unless `--rewrite-published` or user `sync.rewrite-published=true` allows it. Permission does not select a strategy: auto still merges published work. Items report `strategySource` (`flag`, `config`, `default`) separately from `rewriteAllowed` and `rewriteSource` (`flag`, `config`, or null). Explicit config false has source `config`.

When published history is actually rebased, `rewrotePublished:true` and a `published_rewritten` warning identify the workspace: “updating the existing remote branch may require a force push”. Sync leaves the remote branch and upstream settings untouched. Personal policy belongs in user config, never in repository `.mabo.toml`:

```sh
mabo config set sync.strategy rebase
mabo config set sync.rewrite-published true
mabo config list --sources
mabo config unset sync.rewrite-published
```

Rebase preserves upstream cherry-picks (including reverted ones), intentionally empty commits, and commits that become empty. It requires Git 2.29 or later; verifying that merge commits can be flattened requires Git 2.38 or later. Merges with their own changes or conflict resolutions, or whose automatic merge trees cannot be verified, fail untouched with a `--merge` hint. Dirty workspaces (including untracked non-ignored files), detached workspaces, and already integrated branches are skipped. Ignored paths that integration could overwrite cause a dirty skip, respecting `core.ignorecase`. Selected linked workspaces on the default branch retain the ff-only guard, regardless of strategy or rewrite permission. Local divergence is retained. Fetch failures affect items using that remote; other bases can proceed.

Conflicts list the files and roll back HEAD, index and contents (exit 5). `--keep-conflicts` leaves one workspace's operation in progress and requires exactly one workspace integration target; the optional primary update remains ff-only. Exit 6 takes precedence if another item changed before a failure, conflict or published refusal. Without changes, operational failures exit 1, conflicts 5, published refusals 4; skipped workspace outcomes exit 0. Primary-only dirty/diverged retains exit 1. Usage errors exit 2. There are no owners, internal locks, or in-use detection.

Human output has one `<name>  <status>  [detail]` line per item and a status count. JSON uses envelope schema 2 with `data: {plan, items:[…], main:item|null}`. Each item contains `workspace` (the shared observed workspace object), `status`, `strategy`, `strategySource`, `rewriteAllowed`, `rewriteSource`, `rewrotePublished`, `before`, `after`, `conflicts`, `detail`, and `code` (e.g. `published`). The observed workspace describes the checkout before integration; `before`/`after` report full HEAD IDs. Diagnostic aliases `name`, `path`, `branch`, and `base` are also included. `strategy` is `rebase`, `merge`, `ff-only`, or null when skipped before selection. Unavailable fields are null.

Statuses: `updated`, `up-to-date`, `dirty`, `diverged`, `integrated` (formerly `merged`), `detached`, `base-gone`, `base-unknown`, `conflict`, `refused`, `failed`, plus primary's `not-default-branch`.

Migration: `-f`/`--force` exits 2 with guidance to `--rewrite-published`. `--no-default` exits 2 because current-only is now the default; add `--main` to advance primary. `--mine` exits 2 with guidance to a workspace selector or `--all`. JSON `default`/`workspaces` results moved to `main`/`items`.

Orphaned records have neither a Git worktree registration nor an existing directory. `list` includes them with a trailing `[orphaned]`; the shared JSON workspace object has `orphaned: true` (false for existing entries), with null `branch` and `head`. `path` and `exec` refuse orphaned names; `show` can inspect their records. `remove <name>` removes only the stale record, exits 0, and reports that the workspace was already gone; it runs no hooks and leaves branches alone. Its existing JSON result uses `workspace.orphaned: true` and `branchDeleted: false`. A live workspace matching the same name takes precedence; multiple orphaned records with the same resolved name are refused as ambiguous. Orphaned records do not reserve names for live workspaces. When a live workspace takes the same name, the orphan remains visible in `list`; use `gc --apply` to remove it, since `remove <name>` resolves to the live workspace.

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

`show --json` and the result of a create or adopt use the workspace object. `show` returns:

```json
{
  "schema": 2,
  "command": "show",
  "ok": true,
  "data": {
    "workspace": {}
  },
  "warnings": [],
  "error": null
}
```

`create --json`:

```json
{
  "schema": 2,
  "command": "create",
  "ok": true,
  "data": {
    "workspace": {},
    "source": {"kind": "new", "base": "refs/remotes/origin/main", "reused": false},
    "setup": {"state": "ok", "at": "2026-10-21T09:00:00Z", "ran": false, "ok": true, "command": null, "exitCode": null, "signal": null, "error": null},
    "copy": {"copied": [], "error": null},
    "metadata": {"ok": true, "error": null}
  },
  "warnings": [],
  "error": null
}
```

`source.kind` is `new`, `branch`, `pr`, `issue`, or `detach`. Sources include the normalized `base`; branch sources add `branch` and `ref`. PR sources add `number`, `url`, `headRef`, `headRepository`, `branch`, and `checkout` (`branch` or `pullHead` on creation). Issue sources add `number`, `url`, and `issue`; an issue combined with another source is recorded as a link. `reused` indicates that no checkout or setup was performed.

`copy.copied` contains the relative paths copied during this invocation. Copy errors leave the workspace in place. `setup.ran` is false when hooks did not run; a successful hook has `exitCode: 0`. A failed hook reports its command, exit code, signal, or startup error. Checkout creation followed by a metadata, copy, or hook failure exits 6 and preserves the workspace object in `data`.

`adopt --json` returns `{workspace: {...}}`. If refreshing the workspace after saving its record fails, it exits 6 (`partial`) and preserves the saved registration fields in `data.workspace`. `forget --json` returns `{items: [{workspace: {...}, ok: true}]}` using the workspace state after record removal.

Retire workspaces with explicit selectors:

```sh
mabo remove SEL... [--keep-branch] [--delete-unpreserved-branch] [--discard-changes] [--no-hooks] [--dry-run]
mabo remove .
mabo gc [--merged] [--closed-pr] [--orphaned] [--older-than D] [--apply] [--keep-branch] [--no-hooks]
```

Remove runs trusted `pre-remove` hooks before deleting the checkout and rechecks the target after hooks. A branch is preserved when its commits are integrated into its base (normal merge, or squash/rebase proven by exact tree-entry transitions) or its tip exactly matches its own upstream. With no recorded base, retirement checks the repository default base. The base or upstream must resolve to an independent ref in the common Git directory, including custom fetch namespaces. A symbolic alias to the retiring branch, detached HEAD, or a bare commit ID does not establish preservation. Preserved branches are deleted; other branches stay with warning `branch_kept_unpreserved` and `branchKeptReason: "unpreserved"`. `--keep-branch` always keeps the branch; `--delete-unpreserved-branch` explicitly permits deleting unpreserved history.

Modified, untracked, and ignored files require `--discard-changes` (otherwise exit 4 `dirty`). Unpreserved detached commits require `--delete-unpreserved-branch` (otherwise exit 4 `unpreserved`). The two permissions are independent. The primary checkout always exits 4 `primary`. `--dry-run` runs no hooks and changes no files, refs, or records; its items have `removed: false`, `wouldRemove`, and `wouldDeleteBranch`, with `plan: true`.

`remove --json` returns the shared schema 2 envelope with this data:

```json
{
  "items": [{
    "workspace": {},
    "removed": true,
    "branchDeleted": true,
    "branchKeptReason": null,
    "alreadyGone": false,
    "error": null
  }]
}
```

Per-item errors are structured `{code,message}` objects. A selector with neither a metadata record nor a matching Git worktree exits 3 `not_found`, including with `--dry-run`. Every selector is checked first: one unknown target prevents all hooks and removal, and text output lists every unknown selector. Select by name, `.`, `pr:N`, `issue:N`, PR/issue URL, or an absolute path or path starting with `./` or `../`.

`alreadyGone: true` requires evidence of the workspace. A missing directory with a record, a Git registration inside the workspace directory, or both succeeds with exit 0; only stale records and registrations are removed, without hooks or branch deletion. If a record and files remain but the Git registration is gone, remove acknowledges it with `alreadyGone: true` and leaves the files, record, and branch untouched. A branch alone or an unregistered directory without a record is insufficient evidence.

If branch deletion fails after checkout removal, remove keeps the branch with warning `branch_kept_delete_failed`, `branchKeptReason: "delete_failed"`, and the Git error in the item `detail`. This does not fail the item or stop later targets; branch-only failures exit 0 and have no retry command. Decide on any later branch cleanup with Git.

A failure after persistent removal exits 6 and retains every item result. Completed removals also remove their records, so repeating the original command may exit 3. Fix the cause, then run `error.details.retryCommand`, also shown as `Retry with` in text. The retry is one invocation: `cd <primary> && mabo -R <primary> remove [flags] -- <unfinished paths>`. It selects only unfinished checkout or record work, preserves permission flags and output mode, and protects selectors with `--`. Run hints in bash or zsh; paths are shell-quoted and control characters use ANSI-C quoting. Metadata cleanup is retried only for recorded targets, using the absolute path spelling saved in the record before removal. Location selectors are fixed before removal. A linked checkout supplying pre-remove hooks is removed last; retries preserve its configuration with `--source-checkout PATH`, which must belong to the selected repository. Once that source is removed, only record cleanup remains and retries disable hooks. Retries add `--no-hooks` when the original command disabled hooks or its source had no pre-remove hooks, preserving hook non-execution even if primary defines hooks. With `-R PRIMARY`, dot also resolves a recorded checkout whose Git registration disappeared.

Squash and rebase checks compare complete changed entries: exact paths, file modes, and full before/after blob or gitlink IDs. Evidence comes from non-merge commits on the base's first-parent history. A squash must match one base commit; rebased history must match every workspace commit to a distinct base commit in ancestor-to-tip order. A base commit cannot prove multiple reapplications. Base history remains evidence after later edits. Evidence found only on side histories, unverified merges, ambiguous merge bases, Git failures, and differing file contents keep the branch. These checks do not run external diff or textconv commands, write Git objects, or require `merge-tree --write-tree`.

GC defaults to all three criteria: integrated work (`--merged`, including verified squash and rebase history), closed or merged linked PRs (`--closed-pr`), and missing directories or registrations (`--orphaned`). `--older-than D` filters by `createdAt`; unknown creation times are excluded and age alone never creates a candidate. D is a positive integer plus `m`, `h`, `d`, or `w`. A branch still at its creation commit is not merged. Git reflog checks for older and unrecorded checkouts remain conservative.

Without `--apply`, gc returns `plan: true` and exit 0, including protected candidates. Applying follows remove safety rules, skips dirty or unpreserved candidates, and reports a targeted `mabo remove 'NAME' --discard-changes` or `mabo remove 'NAME' --delete-unpreserved-branch` hint. Permissions are never bundled. Hints pin the repository and verify that the selector resolves uniquely. The cd/dot fallback requires an existing directory. For a missing directory, hints use a recorded PR/issue selector when possible; otherwise they show an explicit `git -C REPO worktree remove --force -- PATH` command that discards only that Git registration and its HEAD reflog. Any remaining metadata record can be cleaned by a later orphan gc. Orphan cleanup removes stale records and registrations while preserving branches and any remaining checkout files. Missing gh or unavailable PR status is reported as `unavailable`. Each target is rechecked after hooks; failures after persistent removal exit 6, otherwise 1.

```json
{
  "plan": true,
  "items": [{
    "workspace": {},
    "reasons": ["merged"],
    "action": "wouldRemove",
    "detail": null
  }]
}
```

Actions are `wouldRemove`, `removed`, `skipped`, and `failed`. Repeating `gc --apply` is safe; retired workspaces are no longer candidates.

Migration: old `delete` exits 2 with a hint to `mabo remove SEL...`; `--current` becomes `remove .`. Old remove/gc `-f`/`--force` exit 2: use separate remove permissions, or `gc --apply` for safe candidates. `gc --pr` becomes `gc --closed-pr`. The `keep-branch` config key warns and is ignored regardless of its type, then disappears on the next successful config write; pass `--keep-branch` explicitly. Sync behavior is unchanged pending P8.

In a single-branch or otherwise narrow-refspec clone, `create --pr` writes `branch.<b>.remote/merge` so `git pull` works, but `@{upstream}` and ahead/behind do not resolve because mabo does not change `remote.origin.fetch`.

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

### Creating, adopting, and forgetting workspaces

```sh
mabo create feature --base origin/main
mabo create --branch origin/existing
mabo create --pr 123
mabo create --issue 456 --base main
mabo create snapshot --detach --base main
mabo create feature --base origin/main --reuse
mabo adopt /path/to/linked-checkout --name review --purpose 'review existing work'
mabo forget review pr:123
```

`create [NAME]` makes a new branch from `--base`, defaulting to the remote default branch and then the local default branch. An omitted name is generated. A name that is already a local branch or locally observed remote-tracking branch exits 4 (`exists_remote`), without fetching; use `--branch` to use that branch. A qualified `--branch remote/name` uses local `name` or creates it tracking the observed remote ref. Multiple remote matches exit 2 and list the choices.

`--pr NUMBER|URL` uses the PR head branch, with `owner/branch` for forks. Forks and deleted heads use `pull/N/head` without setting an upstream. `--issue NUMBER|URL` alone creates `issues/N` and defaults the purpose to the issue title. With `--pr` or `--branch`, it only adds a link. An explicit NAME overrides the workspace name; an existing branch retains its branch name. `--base`, `--branch`, and `--pr` are mutually exclusive. `--detach` accepts `--base` and `--issue`.

An existing workspace exits 4 (`exists`). With `--reuse`, a workspace matching the requested base, branch or PR and any requested issue returns successfully without copying files or running hooks, even after a failed setup. A mismatch still exits 4. Repeated reuse preserves creation details and existing purpose. `--no-setup` skips copying and hooks and cannot be combined with `--copy-file`. Old `create --no-hooks` exits 2 with migration guidance.

`adopt PATH` records an existing linked Git worktree of the selected repository without running setup. It accepts `--name`, `--base`, `--purpose`, `--pr`, and `--issue`. `--base` optionally records the sync target for the existing checkout; when omitted, the target is unknown (`null`). Unknown creation time and creation commit are null. An already recorded path exits 4; a path that is not a linked checkout of this repository exits 3.

`forget SEL...` drops only records, including intent on the primary checkout. Files, branches and Git worktree registrations remain. It accepts names, `.`, `pr:N`, `issue:N`, and PR/issue URLs, and resolves every selector before dropping any records.

Migration: `attach BRANCH` becomes `create --branch BRANCH`; `github checkout` / `gh checkout` become `create --pr REF` or `create --issue REF`. `create -x/--exec` becomes `create` followed by `exec SEL -- COMMAND`. Removed forms exit 2 with a migration hint in text and JSON.
