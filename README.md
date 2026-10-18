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
