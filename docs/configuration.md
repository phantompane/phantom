# Phantom Configuration

## Table of Contents

- [Configuration File](#configuration-file)
- [Configuration Options](#configuration-options)
  - [worktreesDirectory](#worktreebasedirectory)
  - [directoryNameSeparator](#directorynameseparator)
  - [postCreate.copyFiles](#postcreatecopyfiles)
  - [postCreate.commands](#postcreatecommands)
  - [preDelete.commands](#predeletecommands)
- [Global Preferences](#global-preferences)

Phantom supports configuration through a `phantom.config.json` file in your repository root. This allows you to define project-level defaults such as where worktrees are stored, which files are copied, and which commands are executed when creating new worktrees. For personal defaults, use `phantom preferences` (stored in your global git config).

## Configuration File

Create a `phantom.config.json` file in your repository root:

```json
{
  "worktreesDirectory": "../phantom-worktrees",
  "directoryNameSeparator": "-",
  "postCreate": {
    "copyFiles": [".env", ".env.local", "config/local.json"],
    "commands": ["pnpm install", "pnpm build"]
  },
  "preDelete": {
    "commands": ["docker compose down"]
  }
}
```

## Configuration Options

### worktreesDirectory

A custom base directory where Phantom worktrees will be created. By default, Phantom creates all worktrees in `.git/phantom/worktrees/`. Set this in `phantom.config.json` for a project-wide location, or in `phantom preferences` for a personal default.

**Use Cases:**

- Store worktrees outside the main repository directory
- Use a shared location for multiple repositories
- Keep worktrees on a different filesystem or drive
- Organize worktrees in a custom directory structure

**Examples:**

**Relative path (relative to repository root):**

```json
{
  "worktreesDirectory": "../phantom-worktrees"
}
```

This creates worktrees directly in `../phantom-worktrees/` (e.g., `../phantom-worktrees/feature-1`)

**Absolute path:**

```json
{
  "worktreesDirectory": "/tmp/my-phantom-worktrees"
}
```

This creates worktrees directly in `/tmp/my-phantom-worktrees/` (e.g., `/tmp/my-phantom-worktrees/feature-1`)

**Directory Structure:**
With `worktreesDirectory` set to `../phantom-worktrees`, your directory structure will look like:

```
parent-directory/
├── your-project/           # Git repository
│   ├── .git/
│   ├── phantom.config.json
│   └── ...
└── phantom-worktrees/      # Custom worktree location
    ├── feature-1/
    ├── feature-2/
    └── bugfix-login/
```

**Notes:**

- If `worktreesDirectory` is not specified, defaults to `.git/phantom/worktrees`
- Use a path relative to the Git repository root (relative paths are resolved from the repo root; absolute paths are used as-is)
- The directory will be created automatically if it doesn't exist
- When worktreesDirectory is specified, worktrees are created directly in that directory
- `phantom.config.json` is project-level configuration, while `phantom preferences` stores per-user defaults
- If both are set, `phantom preferences` takes precedence over `phantom.config.json`

### directoryNameSeparator

Controls how `/` in worktree names is mapped to the filesystem directory name. By default, Phantom keeps `/`, which creates nested directories. Set this in `phantom.config.json` for a project-wide default, or in `phantom preferences` for a personal default.

**Use Cases:**

- Keep all worktrees at one directory level for easier browsing
- Preserve branch naming conventions like `feature/test` while storing directories as `feature-test`
- Use a separator that matches team conventions such as `-` or `_`

**Examples:**

**Flat directories with hyphens:**

```json
{
  "directoryNameSeparator": "-"
}
```

This maps `feature/test` to `feature-test` on disk while the Git branch remains `feature/test`.

**Flat directories with underscores:**

```json
{
  "directoryNameSeparator": "_"
}
```

This maps `release/2026/q1` to `release_2026_q1`.

**Notes:**

- If `directoryNameSeparator` is not specified, Phantom keeps the current behavior and uses `/`
- Only the directory name is transformed; the Git branch name is unchanged
- `phantom preferences` takes precedence over `phantom.config.json` when both are set
- This affects worktree creation paths only

### postCreate.copyFiles

An array of file paths to automatically copy from the current worktree to newly created worktrees.

**Use Cases:**

- Environment configuration files (`.env`, `.env.local`)
- Local development settings
- Secret files that are gitignored
- Database configuration files
- API keys and certificates

**Example:**

```json
{
  "postCreate": {
    "copyFiles": [".env", ".env.local", "config/database.local.yml"]
  }
}
```

**Notes:**

- Paths are relative to the repository root
- Currently, glob patterns are not supported
- Files must exist in the source worktree
- Non-existent files are silently skipped
- Can be overridden with `--copy-file` command line options

### postCreate.commands

An array of commands to execute after creating a new worktree.

**Use Cases:**

- Installing dependencies
- Building the project
- Setting up the development environment
- Running database migrations
- Generating configuration files

**Example:**

```json
{
  "postCreate": {
    "commands": ["pnpm install", "pnpm db:migrate", "pnpm db:seed"]
  }
}
```

**Notes:**

- Commands are executed in order
- Execution stops on the first failed command
- Commands run in the new worktree's directory
- Output is displayed in real-time

## Global Preferences

Use `phantom preferences` for per-user defaults stored in `git config --global` under the `phantom.*` namespace. These preferences override `phantom.config.json` when both are set for the same behavior.

### Supported Keys

- `editor`: Preferred editor command for `phantom edit`
- `ai`: Preferred assistant command for `phantom ai`
- `worktreesDirectory`: Personal default worktree directory relative to the Git repository root
- `directoryNameSeparator`: Personal default separator for flattening worktree directory names on disk
- `keepBranch`: Keep branches by default when deleting worktrees through `phantom delete` or MCP

### `keepBranch`

`keepBranch` is a user preference, not a `phantom.config.json` setting. Set it when you want `phantom delete` to remove only the worktree directory while preserving the underlying branch unless you explicitly override that behavior.

**Examples:**

```bash
# Keep branches by default when deleting worktrees
phantom preferences set keepBranch true

# Check the current value
phantom preferences get keepBranch

# Restore the default behavior and delete branches with worktrees again
phantom preferences remove keepBranch
```

**Notes:**

- Valid values are `true` and `false`
- CLI and MCP delete operations both use this preference when no explicit `keepBranch` override is provided

### preDelete.commands

An array of commands to execute in a worktree **before** it is deleted. Use this to gracefully shut down resources or clean up artifacts that were created in the worktree.

**Use Cases:**

- Stop background services started from the worktree (e.g., `docker compose down`)
- Remove generated assets or caches before deletion
- Run custom teardown scripts

**Example:**

```json
{
  "preDelete": {
    "commands": ["docker compose down"]
  }
}
```

**Notes:**

- Commands run in the worktree being deleted
- Commands are executed in order and halt on the first failure
- If a command fails, the worktree is **not** removed
- Output is displayed in real-time
