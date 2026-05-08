# MCP Integration Guide

## Overview

Phantom now supports the Model Context Protocol (MCP), enabling AI coding assistants to autonomously manage Git worktrees. This integration allows AI agents to work on multiple features or variations in parallel, dramatically improving development efficiency.

## What is MCP?

Model Context Protocol (MCP) is a standard protocol that allows AI assistants to interact with external tools and services. With Phantom's MCP server, AI agents can:

- Create and manage multiple worktrees programmatically
- Switch between different development contexts seamlessly
- Work on multiple features or experiments in parallel
- Keep different implementations isolated and organized

## Installation and Setup

> [!IMPORTANT]
> To use Phantom's MCP server, you need to have Phantom installed.

```bash
brew install phantom
```

### For Claude Code

```sh
claude mcp add --scope user Phantom phantom mcp serve
```

### For Visual Studio Code

```sh
code --add-mcp '{
  "name": "Phantom",
  "command": "phantom",
  "args": ["mcp", "serve"],
  "transport": "stdio"
}'
```

### For Cursor

Add this configuration to `~/.cursor/mcp.json`.

```json
{
  "mcpServers": {
    "Phantom": {
      "command": "phantom",
      "args": ["mcp", "serve"],
      "transport": "stdio"
    }
  }
}
```

### For Other AI Assistants

You can start the Phantom MCP server with stdio transport by running:

```bash
phantom mcp serve
```

## Available MCP Commands

The Phantom MCP server exposes four main tools:

### 1. `phantom_create_worktree`

Creates a new Git worktree.

**Parameters:**

- `name` (required): Name for the worktree (also used as the branch name)
- `baseBranch` (optional): Base branch to create from (defaults to current branch)

**Example:**

```typescript
{
  "tool": "phantom_create_worktree",
  "arguments": {
    "name": "feature-awesome",
    "baseBranch": "main"
  }
}
```

### 2. `phantom_list_worktrees`

Lists all Git worktrees (phantoms).

**Parameters:** None

**Example:**

```typescript
{
  "tool": "phantom_list_worktrees",
  "arguments": {}
}
```

### 3. `phantom_delete_worktree`

Deletes a Git worktree (phantom).

**Parameters:**

- `name` (required): Name of the worktree to delete
- `force` (optional): Force deletion even if there are uncommitted changes
- `keepBranch` (optional): Keep the branch after deleting the worktree

If `keepBranch` is omitted, Phantom falls back to the user's `phantom.keepBranch` preference when it is set.

**Example:**

```typescript
{
  "tool": "phantom_delete_worktree",
  "arguments": {
    "name": "feature-awesome",
    "force": false,
    "keepBranch": true
  }
}
```

### 4. `phantom_github_checkout`

Checkout a GitHub issue or pull request by number into a new worktree.

**Parameters:**

- `number` (required): Issue or pull request number to checkout
- `base` (optional): Base branch for issues (not applicable for pull requests)

**Example:**

```typescript
{
  "tool": "phantom_github_checkout",
  "arguments": {
    "number": "123",
    "base": "main"  // optional, only for issues
  }
}
```

## Use Cases

### 1. Parallel Feature Development

AI agents can work on multiple features simultaneously:

```
User: "Create a user authentication system with both JWT and OAuth2 implementations in separate worktrees"

AI Agent:
1. Creates worktree: phantom_create_worktree("auth-jwt")
2. Implements JWT authentication in auth-jwt worktree
3. Creates worktree: phantom_create_worktree("auth-oauth2")
4. Implements OAuth2 authentication in auth-oauth2 worktree
5. Compares and tests both implementations
```

### 2. A/B Testing Different Approaches

Perfect for exploring multiple solutions:

```
User: "Create 2 variations of a simple hello world app using Express and Hono,
       each in their own worktree. Make sure each can be started with npm start
       and served on a different URL."

AI Agent:
1. phantom_create_worktree("express-app")
2. Implements Express server on port 3000
3. phantom_create_worktree("hono-app")
4. Implements Hono server on port 3001
5. Tests both implementations independently
```

### 3. Incremental Feature Development

Build features step by step based on user instructions:

```
User: "Implement a basic blog system with CRUD operations"

AI Agent:
1. phantom_create_worktree("blog-basic")
2. Implements basic blog CRUD functionality
3. Tests and confirms basic features work

User: "Now add a commenting system in a new worktree"

AI Agent:
1. phantom_create_worktree("blog-comments", baseBranch: "blog-basic")
2. Switches to blog-comments worktree
3. Implements commenting system on top of basic blog
4. Tests commenting features independently
```

### 4. GitHub Issue/PR Development

Work directly on GitHub issues or pull requests:

```
User: "Check out PR #175 and add more comprehensive tests"

AI Agent:
1. phantom_github_checkout("175")
2. Switches to the PR's worktree automatically
3. Reviews existing code changes
4. Adds comprehensive test coverage
5. Commits and pushes the improvements

User: "Create a worktree for issue #180 to implement the requested feature"

AI Agent:
1. phantom_github_checkout("180", base: "main")
2. Creates worktree with a branch for issue #180
3. Implements the feature requested in the issue
4. Tests the implementation
5. Ready to create a pull request
```
