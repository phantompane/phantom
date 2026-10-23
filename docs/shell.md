# Shell integration

[README](../README.md) · [Commands](commands.md) · [JSON](json.md)

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

The helper defines only a `mabo` function. `mabo cd [SEL] [-R REF]` resolves `command mabo path` in text mode and changes directory only on success; a lookup failure preserves the current directory, diagnostic and exit status. Repository options may also precede `cd`: `mabo -R owner/repo cd feature`. Use `mabo cd -- -leading-name` for a selector starting with a hyphen. Paths retain spaces, quotes and trailing newlines, for example `mabo cd './workspace with spaces'`. Other invocations pass every argument to `command mabo` unchanged. There are no sessions or panes, and shell-init does not load completions.

Completions derive commands, subcommands and flags from `help-data.json`. Workspace selector candidates are queried with `command mabo list --names` when completing; query failures silently produce no workspace candidates. `-R`/`--repo` selects the repository for that query. Bash quotes candidates before insertion; zsh and fish use their native completion quoting. Fish and zsh also show descriptions. These are minimal completions: they do not complete arbitrary Git refs, child commands after `exec --`, or every option value.

Both script commands require `bash`, `zsh` or `fish`; missing or unknown shells exit 2 with a usage hint. They ignore `MABO_OUTPUT` and reject explicit `--json` / `--output json` with exit 2. `mabo help completions`, `mabo help shell-init` and `mabo help --json` describe the contract.

After loading the helper, select an existing workspace:

```sh
mabo cd feature/auth
mabo -R "$primary" cd feature/auth
mabo cd -- "$primary/../workspace with spaces"
```

Here `primary` is the primary checkout’s absolute path, and `$primary/../workspace with spaces` must be an existing linked checkout. The helper is optional; [the quick start](../README.md#quick-start) uses `exec` without shell integration.
