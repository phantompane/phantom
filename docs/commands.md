# Commands

[README](../README.md) · [Commands](commands.md) · [JSON](json.md)

The command and option tables below come from [`help-data.json`](../help-data.json). Use `mabo help COMMAND` for current text help or `mabo help --json` for the complete machine-readable contract. Syntax uses `[optional]`, `A|B` for alternatives, and `…`/`...` for repetition; syntax lines are not shell scripts.

mabo manages workspace boundaries and preparation. Use Git for commits, pushes, and history editing; mabo’s integration scope is syncing with the base. It does not assign tasks, review or comment on PRs, merge PRs, schedule agents, manage terminal sessions, or provide sandboxing or access control. Processes, ports, databases, dependencies, and credentials remain your repository’s responsibility.

## Selecting and inspecting workspaces

`SEL` accepts a workspace name, `.` (the checkout containing cwd), `pr:N`, `issue:N`, a PR/issue URL, or an absolute path / path starting with `./` or `../`. Linked selectors only find existing records; they never create workspaces. A missing match exits 3 (`not_found`), and multiple matches exit 2 (`ambiguous`). A URL matches its recorded repository and link; `pr:N` and `issue:N` are scoped to the selected repository. Using `.` with a different `-R` exits 2. Outside a repository, current selection exits 3.

`show [SEL]`, `path [SEL]`, `set [SEL]`, `setup [SEL]`, and `exec [SEL] -- COMMAND [ARG...]` default to `.`. In the primary checkout, `.` refers to that checkout. `show` reports its context with `managed:false`; unrecorded checkouts outside mabo's workspace directory also report `managed:false`. Positional arguments of `sync` and `remove` accept the same selectors. Sync without arguments selects only the current workspace; in primary it behaves as `--main`. Remove requires explicit selectors and retains its safety checks.

`path` prints only an absolute path and newline in text mode; JSON is `data: {path}`. `show` and `set` return `data.workspace`. `show`, `path`, `list`, and `exec` never change record contents or mtimes. `set` atomically replaces the supplied purpose, base, PR and issue fields; omitted fields are kept. `--unset FIELD` clears one of purpose/base/pr/issue per occurrence; repeat the flag to clear several fields. It rejects unknown fields or a field that is also being set. `--base` validates and normalizes a ref; commit bases remain supported. `--unset base` records an unknown base without choosing a default. Sync skips it with `base-unknown` until `mabo set <name> --base REF` restores a base. Records with no base field still use the default base.

`list` includes primary checkouts. Use `--kind workspace` or `--kind primary` to filter, `--names` or `--paths` for shell output, and `--all-repos` for repositories known to `repo list` (registrations and enabled discovery). `--all-repos` cannot be combined with `-R`. Its JSON includes `data.repos` as well as the flattened `data.workspaces`. Human output starts each repository with its name and primary path, then shows current (`*`), name, branch, ahead/behind (`↑a ↓b`), dirty state, PR/issue links (`#12` / `issue #34`), setup state when it is not `ok` (such as `setup:failed`), and purpose. A deleted upstream appears as `upstream:gone`.

Exec preserves child output and exit status, ignores `MABO_OUTPUT`, and refuses explicit JSON output. Usage diagnostics and any accompanying help go to stderr, leaving text stdout empty.

## Creating, adopting, and forgetting

`create [NAME]` makes a new branch from `--base`, defaulting to the remote default branch and then the local default branch. An omitted name is generated. A name that is already a local branch or locally observed remote-tracking branch exits 4 (`exists_remote`), without fetching; use `--branch` to use that branch. A qualified `--branch remote/name` uses local `name` or creates it tracking the observed remote ref. Multiple remote matches exit 2 and list the choices.

`--pr NUMBER|URL` uses the PR head branch, with `owner/branch` for forks. Forks and deleted heads use `pull/N/head` without setting an upstream. `--issue NUMBER|URL` alone creates `issues/N` and defaults the purpose to the issue title. With `--pr` or `--branch`, it only adds a link. An explicit NAME overrides the workspace name; an existing branch retains its branch name. `--base`, `--branch`, and `--pr` are mutually exclusive. `--detach` accepts `--base` and `--issue`.

An existing workspace exits 4 (`exists`). With `--reuse`, a workspace matching the requested base, branch or PR and any requested issue returns successfully without copying files or running hooks, even after a failed setup. A mismatch still exits 4. Repeated reuse preserves creation details and existing purpose. `--no-setup` skips copying and hooks and cannot be combined with `--copy-file`.

`adopt PATH` records an existing linked Git worktree of the selected repository without running setup. It accepts `--name`, `--base`, `--purpose`, `--pr`, and `--issue`. `--base` optionally records the sync target for the existing checkout; when omitted, the target is unknown (`null`). Unknown creation time and creation commit are null. An already recorded path exits 4; a path that is not a linked checkout of this repository exits 3.

`forget SEL...` drops only records, including intent on the primary checkout. Files, branches and Git worktree registrations remain. It accepts the shared workspace selectors and resolves every selector before dropping any records.

In a single-branch or otherwise narrow-refspec clone, `create --pr` writes `branch.<b>.remote/merge` so `git pull` works, but `@{upstream}` and ahead/behind do not resolve because mabo does not change `remote.origin.fetch`.

## Existing branches, detached checkouts, and reuse

Run these in primary with an existing `origin/existing` tracking ref. `branch-example` uses a new branch; `snapshot` has detached HEAD. Reuse returns the matching workspace without setup:

```sh
mabo create branch-example --base origin/main
mabo create --branch origin/existing
mabo create snapshot --detach --base main
mabo create branch-example --base origin/main --reuse
```

## Several agents in one repository

Start in primary with a local `main` branch and a fetchable `origin` remote. Each agent keeps its workspace name or absolute path in its work log; handing off work means sharing that identifier.

```sh
mabo create feature/auth --base main --purpose 'agent 1: authentication' --json
mabo create feature/tests --base main --purpose 'agent 2: tests' --json
mabo exec feature/auth -- git status --short
mabo show feature/auth --json
mabo path feature/tests
mabo set feature/auth --purpose 'review authentication' --pr 774 --base main
mabo show pr:774 --json
mabo set feature/auth --unset purpose --unset pr --unset issue
mabo list --kind workspace --names
mabo list --kind primary --paths
mabo list --all-repos --json
mabo sync --all --dry-run --json
mabo sync --all --json
```

Setting a link number stores metadata without a GitHub lookup. Creating from a PR or issue uses authenticated `gh`; these independent examples follow the command help and require real links from your repository:

```sh
mabo create --pr 123
mabo create --issue 456 --base main
```

To record a checkout made by Git, run this from primary, with `primary` set to its absolute path:

```sh
git worktree add "$primary/../review" -b review main
mabo adopt "$primary/../review" --name review --base main --purpose 'review existing work'
mabo forget review
```

Forget leaves the checkout and branch in place. See [safety](safety.md) for retirement and [hooks](hooks.md) for preparation.

## Take an issue through cleanup

This workflow requires authenticated `gh` and real issue/PR numbers from your repository. Start in a repository with default base `origin/main`. The initial creation needs GitHub; after editing, use Git and gh to commit, push, and open the PR before recording its link.

```sh
export MABO_NO_INPUT=1
mabo create --issue 812 --base origin/main --json
cd "$(mabo path issues/812)"
# Edit, test, commit, push, and open a PR with Git and gh.
mabo set --pr 853 --json
mabo sync --json
mabo show pr:853 --json
primary=$(mabo repo show --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["repo"]["root"])')
cd "$primary"
mabo remove pr:853 --json
mabo gc --json
```

After integration, remove deletes a branch only with preservation evidence; otherwise it keeps the branch with a warning. Sync auto mode merges published work when integration is needed. A conflict exits 5 and rolls back unless `--keep-conflicts` was requested. After partial removal (exit 6), fix the cause and use the returned retry command. See [safety](safety.md) and [sync](sync.md).

## Global options

| Option | Meaning |
|---|---|
| `-R, --repo <value>` | Select a repository by path, registered ID, canonical host/owner/repo name, or an unambiguous name suffix. May precede the command. For exec, put it before the workspace name. |
| `--output <value>` | Select text or json on JSON-capable commands; overrides MABO_OUTPUT |
| `--json` | Alias for --output json on JSON-capable commands |
| `--no-input` | Never prompt; also enabled by CI, JSON, MABO_NO_INPUT, or no stdin/stderr TTY |
| `-h, --help` | Show text help |
| `-v, --version` | Show the application version; supports --json |

`-R` may precede the command. For `exec`, put mabo options before SEL and always use `--` before the child command. `exec`, `completions`, and `shell-init` reject explicit JSON; the script commands ignore `MABO_OUTPUT`. See [JSON output exceptions](json.md).

## Command syntax and specific options

Common options above apply where listed in command help. Each table below lists only command-specific options.

### mabo create

Create a workspace from a new branch, existing branch, pull request, issue, or detached commit

Usage: `mabo create [NAME] [--base REF | --branch BRANCH | --pr REF] [--issue REF] [--detach] [options]`

| Option | Meaning |
|---|---|
| `--copy-file <value>` | Extra gitignore pattern of files to copy from the primary checkout. Can be used multiple times. Only gitignored matches are copied |
| `--base <value>` | Base ref for a new branch or detached checkout; defaults to the remote default branch, then the local default branch |
| `--purpose <value>` | Free-text description of the task this workspace is for |
| `--pr <value>` | Create from a GitHub pull request number or URL, linking the PR; requires authenticated gh |
| `--issue <value>` | Link a GitHub issue number or URL; without --branch/--pr, default name is issues/N and purpose is its title |
| `--no-setup` | Skip all setup: no copying or hooks; records setup.state skipped. Cannot be combined with --copy-file |
| `--branch <value>` | Use an existing local branch or locally observed remote-tracking branch; no fetch. Pass remote/branch to select a remote |
| `--detach` | Create a detached checkout at --base |
| `--reuse` | Return an existing workspace only when its source matches; skip all setup. Mismatches exit 4 exists |

### mabo list

List all workspaces

Usage: `mabo list [--repo <ref>] [options]`

| Option | Meaning |
|---|---|
| `--names` | Output only workspace names (for scripts and automation) |
| `--kind <value>` | Filter by workspace or primary |
| `--paths` | Output only absolute paths, one per line |
| `--all-repos` | List repositories known to repo list; JSON adds data.repos. Cannot be combined with --repo. |

### mabo gc

Plan stale workspace cleanup; remove eligible candidates with --apply

Usage: `mabo gc [--merged] [--closed-pr] [--orphaned] [--older-than D] [--apply] [--keep-branch] [--no-hooks]`

| Option | Meaning |
|---|---|
| `--apply` | Apply the plan; otherwise return plan:true with exit 0 |
| `--merged` | Select workspaces integrated into their recorded base, including squash/rebase verified by exact tree entries and merged PR evidence |
| `--closed-pr` | Select linked PRs that are closed or merged; missing gh is reported as unavailable |
| `--orphaned` | Select workspaces whose directory is missing, whose git registration is prunable, or whose branch ref is gone. A metadata record whose directory is already gone is dropped without deleting a directory git does not list |
| `--older-than <value>` | Narrow evidence-based candidates to known createdAt at least D ago (positive integer plus m, h, d, or w); age alone never selects a workspace |
| `--keep-branch` | Always keep branches when removing checkouts |
| `--no-hooks` | Remove matching workspaces without running pre-remove hooks. This does not trust the repository. gc never asks for trust |

### mabo trust

Manage repository hook trust

Usage: `mabo trust <add|remove|list> [options]`

### mabo trust remove

Remove hook trust for a repository

Usage: `mabo trust remove [REPO] [options]`

### mabo exec

Execute a command in a workspace directory

Usage: `mabo exec [--repo <ref>] [SEL] -- COMMAND [ARG...]`

### mabo config

Read and write user configuration

Usage: `mabo config <get|set|unset|list> [options]`

### mabo config get

Show an effective config value

Usage: `mabo config get KEY [--sources] [options]`

| Option | Meaning |
|---|---|
| `--sources` | Include source (config, env, default) and detail for every effective value |

### mabo config set

Set a user config value

Usage: `mabo config set KEY VALUE [options]`

### mabo config unset

Unset a user config value

Usage: `mabo config unset KEY [options]`

### mabo clone

Clone a Git repository into the ghq-compatible layout and register it

Usage: `mabo clone <url|host/owner/repo|owner/repo> [options]`

| Option | Meaning |
|---|---|
| `--branch <value>` | Branch to check out when the repository is cloned |
| `--depth <value>` | Create a shallow clone with this many commits. Must be a positive integer |
| `--update` | Fetch origin when the repository already exists at the destination |

### mabo --version

Show the application version

Usage: `mabo --version [--json]`

### mabo repo

Register, discover, and inspect repositories

Usage: `mabo repo <add|list|show|forget> [options]`

### mabo repo add

Register a Git repository as a mabo repo

Usage: `mabo repo add [path] [options]`

### mabo repo list

List registered and discovered mabo repos

Usage: `mabo repo list [--registered|--discovered] [--names|--paths] [options]`

| Option | Meaning |
|---|---|
| `--names` | Output only repo names |
| `--paths` | Output only repo root paths |
| `--registered` | Only explicitly registered repos; do not discover |
| `--discovered` | Only discovered repos without a registration |

### mabo repo forget

Remove a Git repository from mabo's registry

Usage: `mabo repo forget <id|name|path> [options]`

### mabo sync

Fetch and sync selected workspaces; advance primary explicitly with --main

Usage: `mabo sync [SEL... | --all | --main] [--auto | --rebase | --merge] [--rewrite-published] [--keep-conflicts] [--dry-run]`

| Option | Meaning |
|---|---|
| `--all` | Sync every workspace in this repository |
| `--main` | Also fast-forward primary, only when on the default branch; may combine with SEL or --all |
| `--auto` | Rebase unpublished commits and merge published commits; overrides sync.strategy |
| `--rewrite-published` | Allow rebasing published history; permission only, does not select rebase |
| `--dry-run` | Fetch and report plan:true without changing checkouts, local branches, or workspace records |
| `--rebase` | Choose the rebase strategy |
| `--merge` | Merge the base instead of choosing automatically |
| `--keep-conflicts` | Leave conflicts in progress; exactly one workspace target required |

### mabo repo show

Inspect a repository and its primary checkout

Usage: `mabo repo show [REF] [options]`

### mabo config list

Show all effective config values

Usage: `mabo config list [--sources] [options]`

| Option | Meaning |
|---|---|
| `--sources` | Include source (config, env, default) and detail for every effective value |

### mabo trust add

Show hooks and trust a repository without prompting

Usage: `mabo trust add [REPO] [options]`

### mabo trust list

List trusted repository common directories

Usage: `mabo trust list [options]`

### mabo help

Show command help or the complete machine-readable command contract

Usage: `mabo help [COMMAND...] [--json]`

### mabo show

Inspect a workspace and its intent and observed state

Usage: `mabo show [--repo <ref>] [SEL] [options]`

### mabo path

Output only the filesystem path of a workspace

Usage: `mabo path [--repo <ref>] [SEL] [options]`

### mabo set

Update workspace purpose, base and links

Usage: `mabo set [--repo <ref>] [SEL] [options]`

| Option | Meaning |
|---|---|
| `--purpose <value>` | Replace the recorded purpose |
| `--pr <value>` | Replace the linked pull request. A number or an http(s) URL |
| `--issue <value>` | Replace the linked issue. A number or an http(s) URL |
| `--base <value>` | Set and validate the base ref used by sync; stored as a full ref name |
| `--unset <value>` | --unset FIELD clears one of purpose, base, pr or issue per occurrence. Repeat the flag to clear several fields. Cannot set and unset the same field. |

### mabo adopt

Manage an existing linked checkout without running setup

Usage: `mabo adopt PATH [--name NAME] [--base REF] [--purpose TEXT] [--pr REF] [--issue REF]`

| Option | Meaning |
|---|---|
| `--name <value>` | Workspace name; defaults to the observed checkout name |
| `--base <value>` | Optionally record the sync target for the existing checkout; unknown (null) when omitted |
| `--purpose <value>` | Free-text description of the task this workspace is for |
| `--pr <value>` | Intent to record |
| `--issue <value>` | Intent to record |

### mabo forget

Drop workspace records while preserving checkouts and branches

Usage: `mabo forget SEL...`

### mabo setup

Prepare a workspace again: copy ignored files from the primary checkout, then run trusted setup hooks

Usage: `mabo setup [SEL] [--copy-file PAT] [--no-hooks] [--source-checkout PATH]`

| Option | Meaning |
|---|---|
| `--copy-file <value>` | Extra gitignore pattern of files to copy from the primary checkout. Can be used multiple times. Only gitignored matches are copied |
| `--source-checkout <value>` | Read .mabo.toml from this checkout in the same repository, preserving the original hooks when retrying setup . from the target workspace. Copies still come from the primary checkout |
| `--no-hooks` | Copy files only; skip setup hooks without recording trust |

### mabo remove

Retire workspaces, deleting branches only when preserved

Usage: `mabo remove SEL... [--keep-branch] [--delete-unpreserved-branch] [--discard-changes] [--no-hooks] [--source-checkout PATH] [--dry-run]`

| Option | Meaning |
|---|---|
| `--source-checkout <value>` | Read pre-remove hooks from this checkout in the selected repository; preserves the original hook source when retrying from primary |
| `--discard-changes` | Allow losing modified/staged tracked files, non-ignored untracked files, and submodule contents |
| `--delete-unpreserved-branch` | Allow deleting an unpreserved branch or detached commits |
| `--dry-run` | Return a plan without running hooks or changing files, refs, or records |
| `--keep-branch` | Delete the workspace but keep its branch |
| `--no-hooks` | Delete the workspace without running pre-remove hooks. This does not trust the repository |

### mabo completions

Output a completion script for bash, zsh or fish

Usage: `mabo completions bash|zsh|fish`

### mabo shell-init

Output a shell function for mabo cd in bash, zsh or fish

Usage: `mabo shell-init bash|zsh|fish`
