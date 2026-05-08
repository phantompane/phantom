# 🚀 Getting Started with Phantom

This guide will help you get up and running with Phantom quickly.

## 📋 Table of Contents

- [Installation](#-installation)
- [Basic Concepts](#-basic-concepts)
- [Your First Phantom](#-your-first-phantom)
- [Essential Commands](#-essential-commands)
- [Common Workflows](#-common-workflows)

## 📥 Installation

```bash
# Using Homebrew (recommended)
brew install phantom

# Using npm
npm install -g @phantompane/cli

# Optional tools for better experience: fzf and tmux
```

> **Note:** When installed via Homebrew, shell completions for Fish and Zsh are set up automatically. For Bash users, you need bash-completion v2 installed first, then add this to your `.bashrc` or `.bash_profile`:
>
> ```bash
> # Prerequisites: bash-completion v2 must be installed
> eval "$(phantom completion bash)"
> ```

## 💡 Basic Concepts

### What is a Phantom?

Phantom is a tool that manages Git worktrees. When you create a worktree with Phantom, it creates a new working directory at `.git/phantom/worktrees/<branch-name>` where you can work independently from your main workspace.

### Why Use Phantom?

Git worktrees are powerful but require manual management of paths and branches. Phantom eliminates these problems:

```bash
# Without Phantom
git worktree add -b feature-awesome ../project-feature-awesome origin/main
cd ../project-feature-awesome

# With Phantom
phantom create feature-awesome --shell
```

Benefits:

- **True multitasking** - Work on multiple features in parallel without context switching
- **Clean workspace** - No need to stash or commit WIP when switching tasks
- **Centralized management** - All worktrees in one predictable location
- **Simple commands** - Intuitive interface for complex Git operations

## 👻 Your First Worktree

Let's create your first worktree:

```bash
# Create a new feature branch in its own workspace
phantom create my-first-feature

# Enter the worktree's workspace
phantom shell my-first-feature

# You're now in a separate workspace!
# Make changes, test, commit - all isolated from your main branch

# When done, exit back to where you started
exit
```

## 🎯 Essential Commands

These five commands will cover 90% of your Phantom usage:

### 1. Create a Worktree

```bash
phantom create feature-name
# Or omit the name to auto-generate one
phantom create
```

### 2. Enter a Worktree

```bash
phantom shell feature-name
```

### 3. List Your Worktrees

```bash
phantom list
```

### 4. Run Commands in a Worktree

```bash
phantom exec feature-name npm test
```

### 5. Delete Worktrees

```bash
phantom delete feature-name
phantom delete feature-name --keep-branch
phantom delete feature-a feature-b  # delete multiple at once
```

Use `--keep-branch` when you want to remove the worktree directory but continue using the branch elsewhere, such as in your main workspace.

For more commands and options, see the [Commands Reference](./commands.md).

## 🔄 Common Workflows

### Switching Between Features

You're working on a feature when you need to check something in another branch:

```bash
# Save your current location mentally
phantom list  # See: you're in feature-a

# Jump to another feature
phantom shell feature-b

# Do your work...

# Jump back
exit
phantom shell feature-a
```

### Emergency Bug Fix

A critical bug needs fixing while you're in the middle of feature development:

```bash
# Create a hotfix worktree
phantom create hotfix-critical --shell

# You're now in the hotfix workspace
# Fix the bug, test, commit, push

# Return to your feature
exit
phantom shell my-feature
```

### Reviewing a Pull Request

```bash
# Create worktree from a remote branch
phantom attach pr-branch --shell

# Or open it directly in tmux
phantom attach pr-branch --tmux

# Review code, run tests
npm test

# Done reviewing
exit
```
