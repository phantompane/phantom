# rabi

rabi (ラビ, from "rabbit") — isolated Git workspaces for parallel coding agents.

> [!WARNING]
> rabi is under active development (v7 alpha). Commands, output, configuration and on-disk formats may change without backward compatibility until 7.0.0. It is not recommended for production use yet.

Give each task an isolated Git workspace (a linked worktree), so coding agents and humans can work in the same repository in parallel. rabi records why each checkout exists, provides machine-readable output, and checks preservation before cleanup. Unpreserved commits and dirty work require explicit permission to discard.

[日本語](README.ja.md) · [Command reference](docs/commands.md) · [JSON contract](docs/json.md)

## Install

Pin the installer and binary to the same release. Replace `<TAG>` with a tag from the first release containing rabi or later; that release has not been published yet. This verifies SHA-256 and GitHub artifact attestations; attestation verification requires `gh`. The installer also needs `curl` and `tar`.

```sh
curl -fsSL https://github.com/phantompane/phantom/releases/download/<TAG>/install.sh \
  | RABI_VERSION=<TAG> sh -s -- --prerelease --verify-attestation
```

Supports Linux and macOS on x64/arm64; use Linux binaries in WSL. Installs to `~/.local/bin` without sudo or shell-profile changes. `--prerelease` allows prereleases for unpinned installs; a version pin already permits them.

Or build from source with Rust 1.89+, replacing `<TAG>` with a tag from the first release containing rabi or later:

```sh
cargo install --git https://github.com/phantompane/phantom --tag <TAG> --locked rabi
```

npm `@phantompane/cli` and Homebrew `phantom` are the older TypeScript v6.

For v7.0.0-alpha.9 or v7.0.0-alpha.8, use that release's own installer at `https://github.com/phantompane/phantom/releases/download/<TAG>/install.sh`; v7.0.0-alpha.7 and older have no installer. See [installation](docs/installation.md) for options, manual installs, and updates.

## Quick start

Start in an existing clone with a `main` branch (substitute your base branch). `sync` needs access to any involved remote. This walkthrough makes no code changes, so cleanup can delete the preserved task branch. Repositories with hooks need [trust or an explicit skip](docs/hooks.md).

```sh
cd your-repo
rabi create task/auth --base main --purpose 'implement authentication'
rabi exec task/auth -- git status --short
rabi list
rabi sync task/auth
rabi remove task/auth --dry-run
rabi remove task/auth
```

`exec` runs in the workspace without moving your shell. To enter it yourself, use `cd "$(rabi path task/auth)"` before removal, or load the optional [shell helper and completions](docs/shell.md) for `rabi cd task/auth`.

## Core concepts

- **Workspace:** a task checkout plus metadata such as purpose, base, and PR/issue links. Names can contain `/`. Select by name, `.`, path, `pr:N`, `issue:N`, or a recorded PR/issue URL.
- **Primary checkout:** the repository’s original checkout, which supplies copied files. rabi refuses to remove it; `sync --main` explicitly advances it on the default branch.
- **Records and management:** records live in the Git common directory. rabi also sees unrecorded checkouts; `adopt` records an existing linked checkout, while `forget` removes only records. Unrecorded checkouts outside the configured workspace directory are unmanaged and protected from removal.
- **Preservation:** removal deletes a branch only with preservation evidence, otherwise keeps it with a warning. Dirty files require `--discard-changes`; deleting unpreserved history requires `--delete-unpreserved-branch`. Ignored files are deleted with the workspace, including nested repositories in ignored directories. `gc` plans until `--apply` and skips unsafe candidates.

Read [removal safety and retries](docs/safety.md) and [sync strategies](docs/sync.md) before automating cleanup or integration. There is no ownership tracking, internal locking, or in-use detection; coordinate with other agents.

## Commands

| Command | Purpose |
|---|---|
| `rabi create` | Create from a new/existing branch, PR, issue, or detached commit |
| `rabi adopt` | Record an existing linked checkout |
| `rabi list` | List workspaces and primary checkouts |
| `rabi show` | Inspect intent and observed state |
| `rabi path` | Print an absolute workspace path |
| `rabi set` | Update purpose, base, and PR/issue links |
| `rabi setup` | Copy ignored files and rerun trusted setup hooks |
| `rabi exec` | Run a command in a workspace (requires `--`) |
| `rabi sync` | Fetch and integrate the base; `--main` advances primary |
| `rabi remove` | Retire explicit workspaces with safety checks |
| `rabi forget` | Drop records while keeping files and branches |
| `rabi gc` | Plan cleanup; `--apply` performs it |
| `rabi clone` | Clone into a ghq-compatible layout and register |
| `rabi repo` | Repository registry commands |
| `rabi repo add` | Register a repository |
| `rabi repo list` | List registered and discovered repositories |
| `rabi repo show` | Inspect a repository |
| `rabi repo forget` | Drop a registration |
| `rabi trust` | Hook trust commands |
| `rabi trust add` | Show hooks and grant trust without prompting |
| `rabi trust remove` | Revoke trust |
| `rabi trust list` | List trusted Git common directories |
| `rabi config` | User configuration commands |
| `rabi config get` | Read an effective value |
| `rabi config set` | Set a value |
| `rabi config unset` | Remove an override |
| `rabi config list` | List effective values (`--sources` shows origins) |
| `rabi help` | Text help or the complete JSON command contract |
| `rabi completions` | Generate bash/zsh/fish completions |
| `rabi shell-init` | Generate the shell helper for `rabi cd` |
| `rabi --version` | Print the application version (`-v` also works) |

Global options: `-R/--repo REF`, `--json`, `--output text|json`, `--no-input`, `-h/--help`, and `-v/--version`. For `exec`, put rabi options before the selector and the child command after `--`. See [all options and workflows](docs/commands.md).

## For agents

Use `--json` or `--output json` for one schema 2 envelope: `schema`, `command`, `ok`, `data`, `warnings`, and `error`. Parse `data` even on failure because it can contain partial results; ignore unknown fields. Use `rabi help --json` to discover commands, flags, and error/warning codes.

`--no-input` disables rabi prompts. It is also implied by JSON output, nonempty `CI`, `RABI_NO_INPUT` other than empty or `0`, or stdin/stderr without a terminal. Untrusted hooks refuse before changes; `gc` skips them. Standalone `exec` preserves child output and status; `exec`, `completions`, and `shell-init` reject explicit JSON.

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

`rabi config` manages user settings: `workspace-root`, `clone-root`, `discover-ghq`, `sync.strategy`, and `sync.rewrite-published`. `-R/--repo REF` targets a repository by path or registered/discovered name. See [configuration, paths, and repository registrations](docs/configuration.md).

## Hooks and trust

Repository `.rabi.toml` defines setup and pre-remove hooks; `.worktreeinclude` selects ignored files to copy from primary. Review hooks before granting trust with `rabi trust add`. Trust applies to the Git common-directory path and survives a re-clone at that path until revoked. See [hooks, trust, and setup retries](docs/hooks.md).

## FAQ

**Why not plain `git worktree`?** Git provides the linked checkouts. rabi adds task metadata, repository discovery, preparation, base synchronization, and evidence-based cleanup. Branches and worktrees remain ordinary Git.

**Does it run agents or isolate services?** Workspaces separate files and branches. rabi does not schedule agents, manage terminal sessions, or isolate processes, ports, databases, credentials, or access between agents.

## Status

Alpha (see the warning above). Breaking changes are listed in [CHANGELOG](CHANGELOG.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development and checks. Open pull requests against `main`.

## License

[MIT](LICENSE).
