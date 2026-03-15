# GitHub Integration Guide

## Overview

Phantom provides seamless integration with GitHub, allowing you to quickly create worktrees for pull requests and issues. This feature streamlines the workflow for reviewing PRs, testing changes, and developing fixes for issues.

## Requirements

> [!IMPORTANT]  
> To use Phantom's GitHub integration, you need:
>
> - GitHub CLI (gh) installed and authenticated
>
> For installation and authentication instructions, visit the [GitHub CLI documentation](https://cli.github.com/manual/)

## Commands

### `phantom github checkout`

Creates a worktree for a GitHub pull request or issue.

**Syntax:**

```bash
phantom github checkout <number> [options]
```

**Alias:**

```bash
phantom gh checkout <number> [options]
```

**Options:**

- `--base <branch>`: Base branch for new issue branches (issues only, default: repository default branch)
- `--tmux` / `-t`: Open the worktree in a new tmux window (requires tmux)
- `--tmux-vertical` / `--tmux-v`: Open the worktree in a vertical tmux split
- `--tmux-horizontal` / `--tmux-h`: Open the worktree in a horizontal tmux split

## Use Cases

### 1. Reviewing Pull Requests

When you need to review and test a pull request locally:

```bash
# Create a worktree for PR #123
phantom github checkout 123

# Open shell in the PR worktree using the PR branch name
phantom shell feature/add-logging

# Review, test, and make changes
npm test
```

**What happens:**

- Creates a worktree named after the PR branch (fork PRs use `{owner}/{branch}`)
- Checks out the PR's branch
- You can test the changes without affecting your main working directory

### 2. Working on Issues

When you want to implement a fix for an issue:

```bash
# Create a worktree for issue #456
phantom github checkout 456

# Open shell in the issue worktree
phantom shell issues/456

# Implement your fix
```

**What happens:**

- Creates a worktree named `issues/456`
- Creates a new branch `issues/456` based on the default branch
- You can start implementing the fix immediately

### 3. Issue with Custom Base Branch

When working on an issue that needs to be based on a specific branch:

```bash
# Create a worktree for issue #789 based on 'develop' branch
phantom github checkout 789 --base develop

# Open shell in the issue worktree
phantom shell issues/789
# Your worktree is now based on the 'develop' branch
```

### 4. Opening in tmux

When using tmux, you can open the worktree directly after checkout:

```bash
# Create and open PR #321 in a new tmux window
phantom github checkout 321 --tmux

# Create and open issue #654 in a vertical split
phantom github checkout 654 --tmux-v

# Create and open in a horizontal split
phantom github checkout 987 --tmux-h
```

**Note:** The `--tmux` options require you to be inside a tmux session.

## Internal Behavior

This section explains how `phantom github checkout` works internally, including the Git commands it executes and how it handles different scenarios.

### Command Flow

1. **Initial API Call**: The command always fetches the GitHub API endpoint `/repos/{owner}/{repo}/issues/{number}` first
2. **Type Detection**: Determines if the number refers to a pull request or issue based on the `pull_request` field in the response
3. **Branch Creation**: Creates appropriate worktree and branch names based on the type

### Pull Request Checkout

When checking out a pull request, Phantom performs the following steps:

#### 1. Fetch Remote Branch

```bash
# For PRs from forks:
git fetch origin pull/{number}/head:{owner}/{head-ref}

# For PRs from the same repository:
git fetch origin {head-ref}:{head-ref}
```

The command intelligently detects whether the PR comes from a fork or the same repository:

- **Fork PRs**: Uses GitHub's special `pull/{number}/head` reference and prefixes the branch with `{owner}/`
- **Same-repo PRs**: Uses the actual branch name from the PR

#### 2. Set Upstream Tracking

```bash
# For fork PRs:
git branch --set-upstream-to origin/pull/{number}/head {owner}/{head-ref}

# For same-repo PRs:
git branch --set-upstream-to origin/{head-ref} {head-ref}
```

This enables easy updates with `git pull` in the worktree.

#### 3. Create Worktree

```bash
git worktree add {worktree-path} {branch-name}
```

### Issue Checkout

For issues, the process is simpler since it creates a new local branch:

```bash
# Create worktree with new branch
git worktree add {worktree-path} -b issues/{number} {base}
```

Where `{base}` is:

- The value provided with `--base` option, or
- `HEAD` if no base is specified

### Key Implementation Details

#### Remote Branch Detection

The command determines if a PR is from a fork by checking if the PR's head repository differs from the base repository. This information comes from the GitHub API response.

#### Error Handling

- If the GitHub API call fails, the command exits with an appropriate error message
- If Git operations fail, the error is propagated to the user
- The command validates that the GitHub CLI (`gh`) is available before proceeding

#### Naming Conventions

- Pull request worktrees:
  - Same-repo PRs: `{head-ref}` (PR head ref)
  - Fork PRs: `{owner}/{head-ref}`
- Issue worktrees: `issues/{number}`
- Local branch names match the worktree names

This design ensures consistent behavior across different PR types and provides a seamless experience for working with GitHub repositories.
