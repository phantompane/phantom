# Phantom Next

Phantom Next is the major-version redesign of Phantom as an agent-native Git
workspace control plane.

AI agents create and use isolated Git worktrees. Humans supervise projects,
workspace state, and cleanup through Phantom's CLI and local web dashboard.
Phantom does not provide its own coding agent, chat interface, editor, or model
runtime.

Next is developed on the long-lived `next` branch. Breaking changes are
intentional. The redesign should prefer a small, coherent product over
compatibility layers, legacy fallbacks, or state migrations from v6.

## Current v6 Feature Inventory

The v6 baseline contains more than the worktree lifecycle itself. The inventory
below makes the disposition of each area explicit before it is changed.

### Git worktree lifecycle

- Create a worktree and branch from a chosen base revision.
- Generate a worktree name when one is not supplied.
- Attach a worktree to an existing branch.
- List worktrees and report a clean or dirty working tree.
- Resolve a worktree path by branch name.
- Delete a managed worktree and optionally delete its branch.
- Copy configured files into a new worktree.
- Run configured post-create and pre-delete commands.
- Create worktrees for GitHub issues and pull requests.

### Human-oriented CLI

- Open shells, editors, and configured AI assistants in a worktree.
- Execute commands in a selected worktree.
- Select worktrees with fzf.
- Open tmux panes and windows.
- Generate Bash, Fish, and Zsh completions.
- Store personal defaults in global Git configuration.

### Agent integration

- Run a stdio MCP server.
- Expose MCP tools to create, list, delete, and check out GitHub worktrees.
- Return a created worktree path to the calling agent.

### Local web application

- Register and select Git projects.
- List project worktrees.
- Start and resume Codex app-server chats inside worktrees.
- Store chat messages, queues, approvals, attachments, and recent skills.

## Product Decisions

### Keep

- Git worktrees as the isolation primitive for the first Next release.
- The centralized Git executor and low-level worktree operations.
- Explicit project registration. Phantom must not scan the whole computer for
  repositories.
- The repository-level concept of setup configuration, after its safety model
  is redesigned.
- A CLI as an inspection, automation, and recovery interface.
- A local web server and dashboard for human supervision.
- MCP as the first agent-facing tool protocol.
- Tests around Git operations, worktree lifecycle, and tool boundaries.

### Rebuild

- Replace the chat-centered model with Project, Workspace, Task, and Lease
  concepts.
- Derive workspace state from live Git data instead of persisted chat records.
- Replace create/delete-oriented agent tools with acquire, inspect, release,
  cleanup-plan, and guarded cleanup operations.
- Accept filesystem paths only during explicit Project registration. Agent
  lifecycle operations require a registered Project ID; the MCP server process
  working directory is never project context.
- Return structured workspace results, including an absolute path that agents
  use as the working directory for every subsequent command.
- Represent Git inspection failures as `unknown`, never as clean.
- Separate releasing ownership from deleting a worktree or branch.
- Redesign configuration around deterministic validation, trust, and explicit
  execution of repository-provided setup commands.
- Make command-line and web operations call the same application services as
  MCP tools.

### Remove

- The embedded Codex app-server bridge and chat UI.
- Chat, message, queued-message, approval, attachment, and recent-chat-skill
  state.
- The requirement for a Codex executable to start `phantom serve`.
- Phantom's configured AI launcher. Agents use their own native surfaces.
- Chat-derived fallback worktree records.
- Agent-accessible force deletion.
- Editor, shell, tmux, and fzf behavior from the product core. A small helper
  may be reconsidered later only when it supports the workspace lifecycle.
- `editor` and `ai` global preferences.
- Compatibility shims and automatic migration for experimental v6 web state.

## Product Principles

1. **Agents operate; humans supervise.** Agents acquire and release workspaces.
   Humans see the full system and decide exceptional or destructive actions.
2. **Phantom manages workspaces, not conversations.** Chat sessions belong to
   Codex, Claude, or another agent host and are not Phantom's primary records.
3. **Live Git is the source of truth.** Persist only Phantom-owned metadata,
   such as projects, tasks, leases, and lifecycle events.
4. **Paths are explicit.** A tool cannot change the calling agent's persistent
   working directory. Every result carries a canonical absolute path, and the
   agent uses it as `workdir` on later operations.
5. **Unknown is unsafe.** A failed status check must block automatic cleanup.
   Dirty or unpushed work is never discarded without explicit human approval.
6. **Identity is not a branch name.** Project IDs, workspace IDs, branch refs,
   and filesystem paths are separate values.
7. **Local first.** The initial control plane runs on the developer's computer
   and exposes only explicitly registered projects.
8. **One mutation authority.** The local Phantom daemon serializes every state
   change and Git lifecycle operation. CLI and MCP processes are clients; they
   do not mutate the registry or create worktrees independently.
9. **Small vertical slices.** Each pull request must produce one testable user
   outcome and avoid speculative infrastructure.
10. **Break cleanly.** Next does not preserve an obsolete API, configuration,
    or state shape solely for v6 compatibility.

## Domain Model

### Project

An explicitly registered Git repository. A Project has a stable Phantom ID and
a canonical root path. Registration grants Phantom permission to inspect it and
perform Phantom's defined Git/worktree lifecycle operations. It does not grant
permission to execute arbitrary repository-provided commands; those require a
separate trust decision.

### Workspace

An isolated working directory. In the first Next release every Workspace is
backed by a Git worktree, but the domain name remains Workspace so that callers
do not depend on Git's storage details.

A Workspace has its own stable ID. Its branch, path, and current commit are
attributes rather than identifiers.

### Task

The unit of intended work, such as an issue, review, experiment, or user
request. A Task may use more than one Workspace over its lifetime. Task support
is introduced only after the live Workspace inventory is stable.

### Lease

A time-bounded claim that identifies the agent or session currently using a
Workspace. A lease prevents accidental concurrent mutation, but it does not
attempt to run or schedule the agent. Heartbeats and expiration are later
capabilities.

### Lifecycle

The planned lifecycle is:

```text
provisioning -> ready -> in-use -> released -> removed
                    \                 \
                     -> blocked        -> cleanup-blocked
```

Git state such as dirty, ahead, behind, and unpushed is separate from lifecycle
state. For example, a released Workspace may still be dirty and therefore
cleanup-blocked.

## Initial Workspace Read Model

The dashboard foundation is read-only and does not persist Workspace records.
It builds a snapshot from `git worktree list --porcelain` and per-worktree Git
inspection.

```ts
type WorkspaceCleanliness = "clean" | "dirty" | "unknown";

interface WorkspaceSnapshot {
  projectId: string;
  path: string;
  relativePath: string;
  branch: string | null;
  head: string;
  cleanliness: WorkspaceCleanliness;
  statusError?: string;
  isMain: boolean;
  isManaged: boolean;
  isLocked: boolean;
  isPrunable: boolean;
}
```

The canonical `path` is the provisional snapshot key, not the long-term
Workspace ID. `relativePath` is computed relative to the Project root, never
relative to the Phantom server process. A failed Git status operation produces
`cleanliness: "unknown"` and a safe, displayable error.

The first state schema contains Projects only. UI selection belongs to the URL
or client state. Workspace, Task, Lease, and lifecycle-event persistence will
be added when a write operation requires them.

## Staged Pull Request Roadmap

### PR 0: Next development bootstrap

- Document the v6 inventory, product boundaries, safety principles, and staged
  delivery plan.
- Run CI for pushes and pull requests targeting `next` as well as `main`.
- Allow version pull requests and version tags to target `next` explicitly.

This bootstrap is intentionally separate so every implementation pull request
that follows receives normal CI coverage.

### PR 1: Workspace dashboard foundation

- Reset experimental web state to the Project-only Next schema.
- Remove the Codex bridge, chat runtime, and chat-derived worktree fallback.
- Start `phantom serve` without a Codex installation.
- Expose registered Projects and live Workspace snapshots through the local
  API.
- Replace the chat screen with a read-only Projects and Workspaces dashboard.

This PR deliberately has no Workspace create, release, or delete action.

### PR 2: Agent workspace acquisition

- Make the local daemon the only mutation authority and serialize lifecycle
  operations per Project.
- Introduce daemon services for list, acquire, inspect, and release; make CLI
  and stdio MCP thin clients of those services.
- Protect the daemon control channel before exposing mutations. Use a
  user-permissioned local socket or an authenticated loopback transport; do not
  expose unauthenticated lifecycle endpoints to other local users or browsers.
- Accept only a registered `projectId` at mutation boundaries. Resolve its
  canonical root inside the daemon instead of accepting an arbitrary path.
- Introduce the minimal Task and Lease records required for ownership,
  idempotency, and safe release.
- Make acquisition idempotent for an agent-provided task key.
- Return structured output with the canonical Workspace path.
- Validate refs, names, and canonical path containment before creating a
  Workspace.
- Do not execute repository-provided setup commands until the Project has an
  explicit trust decision and the command policy is implemented.
- Add MCP server instructions and a distributable agent skill that require the
  returned path to be used as `workdir` on every later command.
- Prove acquire, explicit-workdir editing, tests, commit, and release in the
  same Codex Local session before treating the agent workflow as viable.

### PR 3: Release and cleanup safety

- Add lease renewal, heartbeat, and expiration behavior.
- Report dirty, ahead, behind, and unpushed state.
- Add cleanup planning and guarded cleanup.
- Require human approval for dirty, unpushed, ambiguous, or forced cleanup.
- Harden Git exit-code handling, ref validation, and filesystem containment.

### PR 4: Workspace supervision

- Show ownership, task, lease age, last activity, and attention reasons.
- Add human create, adopt, release, and cleanup approval actions.
- Before exposing browser write actions, require exact-origin/CSRF protection
  and a human-only approval boundary on top of the authenticated daemon
  channel. Binding a write-capable API to a non-loopback interface is out of
  scope until an explicit remote-access security model exists.
- Reconcile Phantom metadata with live Git worktrees.
- Add orphaned and expired-workspace views.

### PR 5: Integration and release readiness

- Add GitHub pull request and check status where it improves supervision.
- Finalize the Next configuration surface and installation experience.
- Expand the already-proven Codex Local workflow to other supported local agent
  hosts.
- Publish prereleases from `next`, then prepare the stable major release.

## Acceptance Metrics

### Dashboard foundation

- `phantom serve` starts and lists Projects without Codex being installed.
- Fixtures containing a main worktree, Phantom-managed worktree, external
  worktree, dirty worktree, locked worktree, and prunable worktree produce the
  expected snapshot fields.
- Every status-inspection failure is visible as `unknown`; no fallback reports
  it as clean.
- The runtime, API, state, and UI contain no chat or Codex app-server concepts.
- A fresh state directory works without reading or migrating v6 chat state.
- CI runs for pushes and pull requests targeting both `main` and `next`.

### Agent workflow validation

- A local agent can acquire a Workspace, edit files, run tests, and commit from
  the returned path without starting a new chat.
- Twenty consecutive acquire/use/release trials complete without operating in
  the wrong repository or worktree.
- Retrying the same acquisition does not create a duplicate Workspace.
- Concurrent acquisition attempts for the same Project and task key converge
  on one Workspace and one active lease.
- Automatic cleanup causes zero losses of dirty or unpushed work.
- The dashboard identifies every Workspace that requires human attention.
- Phantom's maintainer can complete normal development using an external agent
  surface and the dashboard, without Phantom providing an embedded chat.

## `next` Branch Workflow

`main` remains the stable v6 branch while the major redesign is developed.
`next` is the long-lived integration branch for the next major version.

1. Create every feature or fix branch from the latest `next`.
2. Create a dedicated Git worktree for that branch.
3. Keep the pull request focused on one roadmap outcome and target `next`.
4. Open it as a draft, run `pnpm ready`, and record verification in the pull
   request body.
5. Have an independent agent review the implementation. Resolve all actionable
   Must and Should findings and rerun the relevant checks.
6. Mark the pull request ready and ask the maintainer for review in the active
   development conversation.
7. Merge only after the maintainer approves it. Do not push feature commits
   directly to `next`.

Current v6 fixes continue to target `main`. Bring relevant `main` changes into
`next` with a normal pull request; do not force-push or rewrite the shared
integration branch.

Start the v7 prerelease line against `next` explicitly:

```sh
gh workflow run version-bump.yml \
  --ref next \
  -f target_branch=next \
  -f release_type=premajor
```

After `7.0.0-0`, advance prereleases with:

```sh
gh workflow run version-bump.yml \
  --ref next \
  -f target_branch=next \
  -f release_type=prerelease
```

When the Next acceptance metrics are satisfied, merge `next` into `main`
through a reviewed pull request and prepare the stable major version from
`main`.
