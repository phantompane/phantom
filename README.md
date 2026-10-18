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
```

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
