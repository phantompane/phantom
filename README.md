# 👻 Phantom

<div align="center">

**A powerful CLI tool for seamless parallel development with Git worktrees**

[![npm version](https://img.shields.io/npm/v/@phantompane/cli.svg)](https://www.npmjs.com/package/@phantompane/cli)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/node/v/@phantompane/cli.svg)](https://nodejs.org)
[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/phantompane/phantom)

[日本語](./README.ja.md) • [Installation](#-installation) • [Why Phantom?](#-why-phantom) • [Basic Usage](#-basic-usage) • [Documentation](#-documentation)

![Phantom demo](./docs/assets/phantom.gif)

</div>

## ✨ What is Phantom?

Phantom is a powerful CLI tool that dramatically boosts your development productivity by making Git worktrees simple and intuitive. Run multiple tasks in isolated environments simultaneously and achieve true multitask development. Built for the next generation of parallel development workflows, including AI-powered coding with multiple agents.

### Key Features

- 🚀 **Simple worktree management** - Create and manage Git worktrees with intuitive commands
- 🔄 **True multitasking** - Create separate working directories per branch and run multiple tasks simultaneously
- 🎯 **Execute commands from anywhere** - Run commands in any worktree with `phantom exec <worktree> <command>`
- 🪟 **Built-in tmux integration** - Open worktrees in new panes or windows
- 🔍 **Interactive selection with fzf** - Use built-in fzf option for worktree selection
- 🎮 **Shell completion** - Full autocomplete support for Fish, Zsh, and Bash
- 🧭 **Configurable defaults** - Set editor, AI commands, and worktree location once via `phantom preferences` (stored in global git config)
- 🐙 **GitHub Integration** - Create worktrees directly from GitHub PRs and issues
- 🤖 **MCP Integration** - AI autonomously manages worktrees for parallel development
- ⚡ **Fast and lightweight** - Minimal external dependencies

## 🚀 Installation

### Using Homebrew (recommended)

```bash
brew install phantom
```

> **Note:** Shell completions for Fish and Zsh are installed automatically with Homebrew. For Bash completion, see the [Shell Completion](#shell-completion) section below.

#### Using npm

```bash
npm install -g @phantompane/cli
```

## 🤔 Why Phantom?

Git worktrees are powerful but require manual management of paths and branches. Also, navigating between multiple worktrees is cumbersome. Phantom eliminates these problems:

```bash
# Without Phantom
git worktree add -b feature-awesome ../project-feature-awesome origin/main
cd ../project-feature-awesome

# With Phantom
phantom create feature-awesome --shell
```

### How Phantom Works

When you run `phantom create feature-awesome`, a new Git worktree named `feature-awesome` is created in `.git/phantom/worktrees/`.
All worktrees created with phantom are centrally managed in this location.

```
your-project/    # Git repository
├── .git/
│   └── phantom/
│       └── worktrees/        # Phantom-managed directory
│           ├── feature-awesome/  # branch name = worktree name
│           ├── bugfix-login/     # another worktree
│           └── hotfix-critical/  # yet another worktree
└── ...
```

You can also customize the worktree location with `phantom preferences set worktreesDirectory <path-from-git-root>` (default: `.git/phantom/worktrees`).
If you want flat directory names for branch names like `feature/test`, set `phantom preferences set directoryNameSeparator "-"` or add `"directoryNameSeparator": "-"` to `phantom.config.json`.

This convention means you never need to remember worktree paths - just use the branch name for easy worktree operations.

### ✈️ Features for a Comfortable Development Experience

Phantom provides perfect functionality as a command-line tool. Developers feel the trust and comfort of flying first class.

#### Shell Completion

Phantom supports full shell completion for Fish, Zsh, and Bash. Use tab key to complete commands and worktree names.

When installed via Homebrew, completions for Fish and Zsh are installed automatically. For Bash, you need to manually set up the completion:

```bash
# Prerequisites: bash-completion v2 must be installed

# For Bash (add to your .bashrc or .bash_profile)
eval "$(phantom completion bash)"
```

#### tmux Integration

When creating worktrees, you can use tmux to open them in new windows or panes. This allows you to manage multiple work environments simultaneously.

```bash
# Create and open worktree in new window
phantom create feature-x --tmux
# Create with split panes
phantom create feature-y --tmux-vertical
phantom create feature-z --tmux-horizontal

# Open existing worktrees in tmux
phantom shell feature-x --tmux
phantom shell feature-y --tmux-v

# Result: Multiple worktrees displayed simultaneously, each allowing independent work
```

![Phantom tmux integration](./docs/assets/phantom-tmux.gif)

#### Editor Integration

Phantom works seamlessly with editors like VS Code and Cursor. Configure your preferred editor once with `phantom preferences set editor <command>` (stored as `phantom.editor`), and `phantom edit` will use it before falling back to `$EDITOR`.

```bash
# Set your preferred editor once (stored in git config --global)
phantom preferences set editor "code --reuse-window"

# Open with your preferred editor (falls back to $EDITOR)
phantom edit feature

# Open a specific file
phantom edit feature README.md

# Launch VS Code right after creating
phantom create feature --exec "code ."

# Use Cursor explicitly
phantom exec feature cursor .
```

![Phantom VS Code integration](./docs/assets/phantom-vscode.gif)

#### AI Assistant Integration

Configure your preferred AI coding tool once and launch it directly in any worktree.

```bash
# Configure your assistant command (examples)
phantom preferences set ai claude
phantom preferences set ai "codex --full-auto"

# Inspect or clear the preference
phantom preferences get ai
phantom preferences remove ai

# Start the assistant in a worktree
phantom ai feature-auth
```

#### Preferences

Store your personal defaults in global git config and manage them with `phantom preferences`.

```bash
# Inspect current defaults
phantom preferences get editor
phantom preferences get ai
phantom preferences get worktreesDirectory
phantom preferences get directoryNameSeparator

# Update them
phantom preferences set editor "code --reuse-window"
phantom preferences set ai claude
phantom preferences set worktreesDirectory ../phantom-worktrees
phantom preferences set directoryNameSeparator "-"

# Remove to fall back to $EDITOR or reconfigure AI
phantom preferences remove editor
phantom preferences remove ai
phantom preferences remove worktreesDirectory
phantom preferences remove directoryNameSeparator
```

#### fzf Integration

Interactive search with fzf allows quick worktree selection.

```bash
# Open shell with fzf selection
phantom shell --fzf

# Delete with fzf selection
phantom delete --fzf
```

### MCP Integration

Phantom provides a Model Context Protocol (MCP) server. AI coding assistants can autonomously create and manage worktrees to develop multiple features in parallel.

After completing the MCP server setup, try giving your AI agent a prompt like this.
The AI agent will create two worktrees and implement Express and Hono apps in each.

> Create 2 variations of a simple hello world app using Express and Hono, each in their own worktree. Make sure each can be started with npm start and served on a different URL.

See [MCP Integration Guide](./docs/mcp.md) for detailed setup and usage.

## 🔍 Basic Usage

### Create a new worktree

```bash
phantom create feature-awesome
# Or omit the name to auto-generate one
phantom create

phantom list
```

### Start a new shell in the worktree

```bash
phantom shell feature-awesome

# Start development work

# Exit the shell when done
exit
```

### Run commands in any worktree

```bash
phantom exec feature-awesome {command to run}
# Example: phantom exec feature-awesome npm run build
```

### Open your editor in the worktree

```bash
phantom edit feature-awesome
phantom edit feature-awesome README.md
```
Uses the `phantom.editor` preference when set (falls back to `$EDITOR`).

### Launch your AI assistant in the worktree

```bash
phantom ai feature-awesome
```
Configure it first with `phantom preferences set ai <command>`.

### Clean up when done

```bash
phantom delete feature-awesome
phantom delete feature-a feature-b  # delete multiple at once
```


## 📚 Documentation

- **[Getting Started](./docs/getting-started.md)** - Common workflows and tips
- **[Commands Reference](./docs/commands.md)** - All commands and options
- **[Configuration](./docs/configuration.md)** - Set up automatic file copying and post-create commands
- **[GitHub Integration](./docs/github.md)** - Work with GitHub pull requests and issues
- **[MCP Integration](./docs/mcp.md)** - AI-powered parallel development with Model Context Protocol

### Platform support

- Officially supported: Linux and macOS
- Windows: not yet verified. It should run reliably when used from a Linux environment on WSL, but native Windows behavior is not guaranteed. The maintainers do not regularly test on Windows.
- Pull requests to improve Windows compatibility are welcome.

## 🤝 Contributing

Contributions are welcome! See our [Contributing Guide](./CONTRIBUTING.md) for:
- Development setup
- Code style guidelines  
- Testing requirements
- Pull request process

## 📄 License

MIT License - see [LICENSE](LICENSE)

## 🙏 Acknowledgments

Built with 👻 by [@aku11i](https://github.com/aku11i), [@codex](https://github.com/codex), and [Claude](https://claude.ai)
