# mabo

mabo (Maboroshi, 幻) — workspaces for parallel coding agents.

Give each task an isolated Git workspace (a linked worktree), so coding agents and humans can work in the same repository in parallel. mabo records why each checkout exists, provides machine-readable output, and checks preservation before cleanup. Unpreserved commits and dirty work require explicit permission to discard.

[日本語](README.ja.md) · [Command reference](docs/commands.md) · [JSON contract](docs/json.md)

## Install

Pin the installer and binary to the same release. This verifies SHA-256 and GitHub artifact attestations; attestation verification requires `gh`. The installer also needs `curl` and `tar`.

```sh
curl -fsSL https://github.com/phantompane/phantom/releases/download/v7.0.0-alpha.9/install.sh \
  | MABO_VERSION=v7.0.0-alpha.9 sh -s -- --prerelease --verify-attestation
```

Supports Linux and macOS on x64/arm64; use Linux binaries in WSL. Installs to `~/.local/bin` without sudo or shell-profile changes. `--prerelease` allows prereleases for unpinned installs; a version pin already permits them.

Or build from source with Rust 1.89+, replacing `<TAG>` with a release tag such as `v7.0.0-alpha.9`:

```sh
cargo install --git https://github.com/phantompane/phantom --tag <TAG> --locked mabo
```

npm `@phantompane/cli` and Homebrew `phantom` are the older TypeScript v6.

See [installation](docs/installation.md) for options, manual installs, and updates.

## Quick start

Start in an existing clone with a `main` branch (substitute your base branch). `sync` needs access to any involved remote. This walkthrough makes no code changes, so cleanup can delete the preserved task branch. Repositories with hooks need [trust or an explicit skip](docs/hooks.md).

```sh
cd your-repo
mabo create task/auth --base main --purpose 'implement authentication'
mabo exec task/auth -- git status --short
mabo list
mabo sync task/auth
mabo remove task/auth --dry-run
mabo remove task/auth
```

`exec` runs in the workspace without moving your shell. To enter it yourself, use `cd "$(mabo path task/auth)"` before removal, or load the optional [shell helper and completions](docs/shell.md) for `mabo cd task/auth`.

## Core concepts

- **Workspace:** a task checkout plus metadata such as purpose, base, and PR/issue links. Names can contain `/`. Select by name, `.`, path, `pr:N`, `issue:N`, or a recorded PR/issue URL.
- **Primary checkout:** the repository’s original checkout, which supplies copied files. mabo refuses to remove it; `sync --main` explicitly advances it on the default branch.
- **Records and management:** records live in the Git common directory. mabo also sees unrecorded checkouts; `adopt` records an existing linked checkout, while `forget` removes only records. Unrecorded checkouts outside the configured workspace directory are unmanaged and protected from removal.
- **Preservation:** removal deletes a branch only with preservation evidence, otherwise keeps it with a warning. Dirty files require `--discard-changes`; deleting unpreserved history requires `--delete-unpreserved-branch`. Ignored files are deleted with the workspace, including nested repositories in ignored directories. `gc` plans until `--apply` and skips unsafe candidates.

Read [removal safety and retries](docs/safety.md) and [sync strategies](docs/sync.md) before automating cleanup or integration. There is no ownership tracking, internal locking, or in-use detection; coordinate with other agents.

## Commands

| Command | Purpose |
|---|---|
| `mabo create` | Create from a new/existing branch, PR, issue, or detached commit |
| `mabo adopt` | Record an existing linked checkout |
| `mabo list` | List workspaces and primary checkouts |
| `mabo show` | Inspect intent and observed state |
| `mabo path` | Print an absolute workspace path |
| `mabo set` | Update purpose, base, and PR/issue links |
| `mabo setup` | Copy ignored files and rerun trusted setup hooks |
| `mabo exec` | Run a command in a workspace (requires `--`) |
| `mabo sync` | Fetch and integrate the base; `--main` advances primary |
| `mabo remove` | Retire explicit workspaces with safety checks |
| `mabo forget` | Drop records while keeping files and branches |
| `mabo gc` | Plan cleanup; `--apply` performs it |
| `mabo clone` | Clone into a ghq-compatible layout and register |
| `mabo repo` | Repository registry commands |
| `mabo repo add` | Register a repository |
| `mabo repo list` | List registered and discovered repositories |
| `mabo repo show` | Inspect a repository |
| `mabo repo forget` | Drop a registration |
| `mabo trust` | Hook trust commands |
| `mabo trust add` | Show hooks and grant trust without prompting |
| `mabo trust remove` | Revoke trust |
| `mabo trust list` | List trusted Git common directories |
| `mabo config` | User configuration commands |
| `mabo config get` | Read an effective value |
| `mabo config set` | Set a value |
| `mabo config unset` | Remove an override |
| `mabo config list` | List effective values (`--sources` shows origins) |
| `mabo help` | Text help or the complete JSON command contract |
| `mabo completions` | Generate bash/zsh/fish completions |
| `mabo shell-init` | Generate the shell helper for `mabo cd` |
| `mabo --version` | Print the application version (`-v` also works) |

Global options: `-R/--repo REF`, `--json`, `--output text|json`, `--no-input`, `-h/--help`, and `-v/--version`. For `exec`, put mabo options before the selector and the child command after `--`. See [all options and workflows](docs/commands.md).

## For agents

Use `--json` or `--output json` for one schema 2 envelope: `schema`, `command`, `ok`, `data`, `warnings`, and `error`. Parse `data` even on failure because it can contain partial results; ignore unknown fields. Use `mabo help --json` to discover commands, flags, and error/warning codes.

`--no-input` disables mabo prompts. It is also implied by JSON output, nonempty `CI`, `MABO_NO_INPUT` other than empty or `0`, or stdin/stderr without a terminal. Untrusted hooks refuse before changes; `gc` skips them. Standalone `exec` preserves child output and status; `exec`, `completions`, and `shell-init` reject explicit JSON.

| Exit | Meaning |
|---|---|
| 0 | Success |
| 1 | Operational failure |
| 2 | Usage error or ambiguous selector |
| 3 | Target or repository not found |
| 4 | Safety refusal |
| 5 | Sync conflict |
| 6 | Partial persistent changes |

See [JSON objects and per-command data](docs/json.md) and [exit codes and recovery](docs/exit-codes.md).

## Configuration

`mabo config` manages user settings: `workspace-root`, `clone-root`, `discover-ghq`, `sync.strategy`, and `sync.rewrite-published`. `-R/--repo REF` targets a repository by path or registered/discovered name. See [configuration, paths, and repository registrations](docs/configuration.md).

## Hooks and trust

Repository `.mabo.toml` defines setup and pre-remove hooks; `.worktreeinclude` selects ignored files to copy from primary. Review hooks before granting trust with `mabo trust add`. Trust applies to the Git common-directory path and survives a re-clone at that path until revoked. See [hooks, trust, and setup retries](docs/hooks.md).

## FAQ

**Why not plain `git worktree`?** Git provides the linked checkouts. mabo adds task metadata, repository discovery, preparation, base synchronization, and evidence-based cleanup. Branches and worktrees remain ordinary Git.

**Does it run agents or isolate services?** Workspaces separate files and branches. mabo does not schedule agents, manage terminal sessions, or isolate processes, ports, databases, credentials, or access between agents.

## Status

Alpha: breaking changes are possible before 7.0.0, with no backward compatibility between alphas. See [CHANGELOG](CHANGELOG.md). Rust development happens on `next`.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development and checks. Open pull requests against `next`.

## License

[MIT](LICENSE).
