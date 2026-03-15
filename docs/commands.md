# Phantom Commands Reference

This document provides a comprehensive reference for all Phantom commands and their options.

## Table of Contents

- [Worktree Management](#worktree-management)
  - [create](#create)
  - [attach](#attach)
  - [list](#list)
  - [where](#where)
  - [delete](#delete)
- [Working with Worktrees](#working-with-worktrees)
  - [shell](#shell)
  - [exec](#exec)
  - [edit](#edit)
  - [ai](#ai)
- [Preferences](#preferences)
  - [preferences get](#preferences-get)
  - [preferences set](#preferences-set)
  - [preferences remove](#preferences-remove)
- [GitHub Integration](#github-integration)
  - [github checkout](#github-checkout)
- [Other Commands](#other-commands)
  - [mcp](#mcp)
  - [version](#version)
  - [completion](#completion)

## Worktree Management

### create

Create a new worktree with a matching branch.

```bash
phantom create [name] [options]
```

If `name` is omitted, a random human-readable name is generated automatically.

**Options:**

- `--shell` - Create and enter interactive shell
- `--exec <command>` - Create and execute command
- `--tmux` / `-t` - Create and open in new tmux window
- `--tmux-vertical` / `--tmux-v` - Create and split tmux pane vertically
- `--tmux-horizontal` / `--tmux-h` - Create and split tmux pane horizontally
- `--copy-file <file>` - Copy specific files from current worktree (can be used multiple times)
- `--base <branch/commit>` - Branch or commit to create the new worktree from (defaults to HEAD)

**Examples:**

```bash
# Auto-generate a random name
phantom create

# Specify a name
phantom create feature-auth

# Create and immediately open shell
phantom create feature-auth --shell

# Create in new tmux window
phantom create feature-auth --tmux

# Create and copy environment files
phantom create feature-auth --copy-file .env --copy-file .env.local

# Create from main branch
phantom create feature-auth --base main

# Create from remote branch
phantom create hotfix --base origin/production
```

### attach

Attach to an existing branch as a worktree.

```bash
phantom attach <branch-name> [options]
```

**Options:**

- `--shell` - Attach and enter interactive shell
- `--exec <command>` - Attach and execute command
- `--tmux` / `-t` - Attach and open in new tmux window
- `--tmux-vertical` / `--tmux-v` - Attach and split tmux pane vertically
- `--tmux-horizontal` / `--tmux-h` - Attach and split tmux pane horizontally

**Examples:**

```bash
# Basic usage
phantom attach feature/existing-branch

# Attach and open shell
phantom attach feature/existing-branch --shell

# Attach and run command
phantom attach feature/existing-branch --exec "npm install"

# Attach and open in tmux window
phantom attach feature/existing-branch --tmux
```

### list

List all worktrees with their current status.

```bash
phantom list [options]
```

**Options:**

- `--fzf` - Interactive selection with fzf (outputs selected name)
- `--names` - Machine-readable output (for scripting)

**Examples:**

```bash
# Basic list
phantom list

# Interactive selection
phantom list --fzf

# For scripting
for worktree in $(phantom list --names); do
  echo "Processing $worktree"
done
```

### where

Get the absolute path to a worktree.

```bash
phantom where <name> [options]
```

**Options:**

- `--fzf` - Select worktree with fzf and get its path

**Examples:**

```bash
# Get path
phantom where feature-auth

# Interactive selection
cd $(phantom where --fzf)

# Open in editor
code $(phantom where feature-auth)
```

### delete

Delete one or more worktrees and their branches.

```bash
phantom delete <name...> [options]
```

**Options:**

- `--force` / `-f` - Force delete with uncommitted changes
- `--current` - Delete the current worktree (when inside one)
- `--fzf` - Select worktree to delete with fzf

**Examples:**

```bash
# Basic delete
phantom delete feature-auth

# Delete multiple worktrees
phantom delete feature-auth docs-cleanup spike-login

# Force delete
phantom delete feature-auth --force

# Delete current worktree
phantom delete --current

# Interactive selection
phantom delete --fzf
```

## Working with Worktrees

### shell

Open an interactive shell session in a worktree.

```bash
phantom shell <name> [options]
```

**Options:**

- `--fzf` - Select worktree with fzf and open shell
- `--tmux`, `-t` - Open shell in new tmux window
- `--tmux-vertical`, `--tmux-v` - Open shell in vertical split pane
- `--tmux-horizontal`, `--tmux-h` - Open shell in horizontal split pane

**Environment Variables:**
When in a phantom shell, these environment variables are set:

- `PHANTOM` - Set to "1"
- `PHANTOM_NAME` - Name of the current worktree
- `PHANTOM_PATH` - Absolute path to the worktree directory

**Examples:**

```bash
# Open shell
phantom shell feature-auth

# Interactive selection
phantom shell --fzf

# Open in new tmux window
phantom shell feature-auth --tmux

# Open in vertical split pane
phantom shell feature-auth --tmux-v

# Open in horizontal split pane
phantom shell feature-auth --tmux-h

# Interactive selection with tmux
phantom shell --fzf --tmux
```

**Notes:**

- tmux options require being inside a tmux session

### exec

Execute any command in a worktree's context.

```bash
phantom exec [options] <name> <command> [args...]
```

**Options:**

- `--fzf` - Select worktree with fzf and execute command
- `--tmux`, `-t` - Execute command in new tmux window
- `--tmux-vertical`, `--tmux-v` - Execute command in vertical split pane
- `--tmux-horizontal`, `--tmux-h` - Execute command in horizontal split pane

**Examples:**

```bash
# Install dependencies
phantom exec feature-auth npm install

# Run tests
phantom exec feature-auth npm test

# Check git status
phantom exec feature-auth git status

# Run complex commands
phantom exec feature-auth bash -c "npm install && npm test"

# Interactive selection
phantom exec --fzf npm run dev

# Execute in new tmux window
phantom exec --tmux feature-auth npm run dev

# Execute in vertical split pane
phantom exec --tmux-v feature-auth npm test

# Execute in horizontal split pane
phantom exec --tmux-h feature-auth npm run watch

# Interactive selection with tmux
phantom exec --fzf --tmux npm run dev
```

**Notes:**

- tmux options require being inside a tmux session

### edit

Open your configured editor inside a worktree.

```bash
phantom edit <name> [path]
```

**Examples:**

```bash
# Open the worktree root with your configured editor
phantom edit feature-auth

# Open a specific file
phantom edit feature-auth README.md
```

**Notes:**

- Set a default editor with `phantom preferences set editor <command>`; phantom.editor takes priority over `$EDITOR`
- The editor starts in the worktree directory so relative paths resolve there

### ai

Launch your configured AI coding assistant inside a worktree.

```bash
phantom ai <name>
```

**Examples:**

```bash
# Launch the configured AI assistant in a worktree
phantom ai feature-auth
```

**Notes:**

- Configure the assistant with `phantom preferences set ai <command>` (e.g., `claude` or `codex --full-auto`) stored as `phantom.ai` in global git config

## Preferences

Configure defaults for Phantom commands using global git config. Preferences are stored under the `phantom.<key>` namespace and currently support:

- `editor` - preferred editor command for `phantom edit`
- `ai` - assistant command for `phantom ai`
- `worktreesDirectory` - where to store worktrees (relative to the Git repository root; defaults to `.git/phantom/worktrees`)
- `directoryNameSeparator` - replaces `/` in worktree directory names only (defaults to `/`, which keeps nested directories)

Set them once to avoid exporting environment variables each time.

### preferences get

Show a preference value.

```bash
phantom preferences get editor
phantom preferences get ai
phantom preferences get worktreesDirectory
phantom preferences get directoryNameSeparator
```

### preferences set

Set or change a preference value.

```bash
# Use VS Code (reuse the current window)
phantom preferences set editor "code --reuse-window"

# Configure your AI assistant command
phantom preferences set ai "codex --full-auto"

# Store worktrees outside the repo (path relative to the Git root)
phantom preferences set worktreesDirectory ../phantom-worktrees

# Flatten feature/test to feature-test on disk while keeping the branch name
phantom preferences set directoryNameSeparator "-"
```

### preferences remove

Remove a preference value.

```bash
phantom preferences remove editor
phantom preferences remove ai
phantom preferences remove worktreesDirectory
phantom preferences remove directoryNameSeparator
```

**Notes:**

- `phantom edit` prefers `phantom.editor` and falls back to `$EDITOR` if unset
- `phantom ai` requires `phantom.ai` to be configured
- `worktreesDirectory` should be set relative to the Git repository root (default: `.git/phantom/worktrees`)
- `directoryNameSeparator` only changes the directory path; the worktree/branch name remains unchanged

## GitHub Integration

### github checkout

Create a worktree for a GitHub pull request or issue.

```bash
phantom github checkout <number> [options]
phantom gh checkout <number> [options]  # alias
```

**Options:**

- `--base <branch>` - Base branch for new issue branches (issues only, default: repository default branch)
- `--tmux` / `-t` - Open the worktree in a new tmux window after checkout
- `--tmux-vertical` / `--tmux-v` - Open the worktree in a vertical tmux split
- `--tmux-horizontal` / `--tmux-h` - Open the worktree in a horizontal tmux split

**Examples:**

```bash
# Create worktree for PR #123
phantom github checkout 123

# Create worktree for issue #456
phantom github checkout 456

# Create worktree for issue #789 based on develop branch
phantom github checkout 789 --base develop

# Create and open PR #321 in a new tmux window
phantom github checkout 321 --tmux

# Create and open issue #654 in a vertical split
phantom github checkout 654 --tmux-v

# Using the alias
phantom gh checkout 123
```

**Requirements:**

- GitHub CLI (gh) must be installed
- Must be authenticated with `gh auth login`
- tmux options require being inside a tmux session

**Behavior:**

- For same-repo PRs: Worktree name matches the PR branch (e.g., `feature/add-logging`)
- For fork PRs: Worktree name is `{owner}/{branch}` (e.g., `aku11i/feature/add-logging`)
- For Issues: Creates worktree named `issues/{number}` with a new branch

For detailed information, see the [GitHub Integration Guide](./github.md).

## Other Commands

### mcp

Start and manage the Phantom MCP server for AI assistant integrations. See the [MCP Integration Guide](./mcp.md) for full setup instructions.

```bash
phantom mcp <subcommand> [options]
```

**Subcommands:**

- `serve` - Start the MCP server (stdio transport)

**Examples:**

```bash
# Start the MCP server with stdio transport
phantom mcp serve

# Show MCP help
phantom mcp --help
```

### version

Display the version of Phantom.

```bash
phantom version
```

### completion

Generate shell completion scripts.

```bash
phantom completion <shell>
```

**Supported Shells:**

- `fish` - Fish shell
- `zsh` - Z shell
- `bash` - Bash shell

**Installation:**

When installed via Homebrew, completions for Fish and Zsh are installed automatically. For Bash, manual setup is required:

```bash
# For Fish (add to ~/.config/fish/config.fish for persistence)
phantom completion fish | source

# For Zsh (add to .zshrc)
eval "$(phantom completion zsh)"

# For Bash (add to .bashrc or .bash_profile)
# Prerequisites: bash-completion v2 must be installed
eval "$(phantom completion bash)"
```

## Exit Codes

Phantom uses the following exit codes:

- `0` - Success
- `1` - General error
- `2` - Invalid arguments
- `3` - Git operation failed
- `4` - Worktree operation failed
- `127` - Command not found

## Related Documentation

- [Getting Started](./getting-started.md) - Get started with Phantom quickly
- [Configuration](./configuration.md) - Configure Phantom for your workflow
- [Integrations](./integrations.md) - Integrate Phantom with other tools
