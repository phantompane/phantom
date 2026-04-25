# `phantom serve` Product Requirements

## Status

Draft requirements for the first production-oriented release of `phantom serve`.

The command already exists as an experimental entry point that starts the bundled TanStack Start application. This document defines the intended product behavior, user experience, server architecture, and first-release scope for turning that command into Phantom's browser-based interface.

## Summary

`phantom serve` starts a local web server that hosts Phantom's web interface. Users open the interface in a browser and work across multiple Git projects, Phantom-managed worktrees, and Codex-powered coding-agent conversations from one place.

The first release targets OpenAI Codex as the agent backend through Codex App Server. Phantom remains responsible for project registration, Git repository discovery, worktree creation, worktree lifecycle state, and the browser-facing HTTP/SSE API. Codex App Server is used behind Phantom's server boundary for authentication state, thread and turn execution, streamed agent events, approvals, model listing, and related agent capabilities.

## Goals

- Provide a local browser interface for Phantom's Git worktree workflows.
- Let users register multiple Git project directories and move between them without restarting the server.
- Create a Phantom worktree whenever the user starts a new chat for a project.
- Connect each chat to an OpenAI Codex thread whose working directory is the created worktree.
- Stream agent progress, assistant messages, command output, file changes, approvals, and terminal-like events to the browser.
- Keep the UI plain, practical, and close to shadcn/ui defaults.
- Use HTTP for browser-to-server requests and Server-Sent Events for server-to-browser event delivery.

## Non-Goals

- Hosted multi-user SaaS deployment.
- Cloud workspace provisioning.
- Supporting multiple agent providers in the first release.
- Replacing the Phantom CLI commands.
- Building a full code editor in the first release.
- Using WebSocket between the browser and Phantom server for first-release realtime behavior.
- Styling the application as a marketing page or card-heavy dashboard.

## Users

The primary user is a developer who already works with multiple Git repositories and wants to manage parallel worktrees and AI coding-agent sessions through a single local interface.

## Command Behavior

### Invocation

```bash
phantom serve [options]
```

Existing options should remain supported:

- `--host <host>`: host interface to bind.
- `--port <port>`: port to bind. Default: `9640`.
- `--help`: command help.

Recommended first-release additions:

- `--open`: open the browser after the server is ready.
- `--no-open`: suppress auto-open if auto-open becomes the default later.
- `--codex-bin <path-or-command>`: Codex executable to launch. Default: `codex`.
- `--data-dir <path>`: Phantom web-interface state directory. Default: a stable user-level Phantom config/data path.

### Startup Requirements

- Start the bundled Phantom web application.
- Start a Phantom API server in the same process/runtime boundary as the web app.
- Verify that the Codex executable is available when agent features are enabled.
- Print the listening URL.
- Print a concise experimental warning until the feature is stable.
- Fail with actionable errors when the web assets, port, project state directory, or Codex executable are unavailable.

### Binding and Security Defaults

- Bind to `127.0.0.1` by default.
- Treat non-loopback binding as an explicit user choice.
- Do not expose Codex App Server directly to the browser.
- Do not expose unauthenticated Codex WebSocket transport from Phantom in the first release.
- Keep all filesystem operations scoped to user-selected project directories, Phantom-managed worktrees, and explicit user actions.

## Product Model

### Project

A project is a registered Git repository root.

Fields:

- `id`: stable Phantom-generated identifier.
- `name`: display name, defaulting to the directory basename.
- `rootPath`: absolute repository root.
- `defaultBase`: default branch or revision for new worktrees, if known.
- `createdAt`, `updatedAt`.
- `lastOpenedAt`.

Requirements:

- Users can add a project by selecting a local directory.
- The server validates that the selected directory is inside a Git repository.
- The server resolves and stores the Git top-level path, not the arbitrary selected subdirectory.
- The sidebar lists registered projects.
- Users can remove a project from the sidebar without deleting the repository or any worktrees.

### Chat

A chat is a user-facing agent conversation associated with exactly one project and one Phantom-managed worktree.

Fields:

- `id`: Phantom chat id.
- `projectId`.
- `worktreeName`.
- `worktreePath`.
- `branchName`.
- `codexThreadId`.
- `title`.
- `status`: `idle`, `running`, `waitingForApproval`, `failed`, or `archived`.
- `createdAt`, `updatedAt`.

Requirements:

- Creating a new chat creates a Phantom worktree first.
- Worktree creation should use the same core implementation path as `phantom create`.
- The Codex thread must start with `cwd` set to the worktree path.
- The chat remains visible in the project after browser reload.
- A chat can be resumed by loading its Codex thread and worktree metadata.
- A chat can be archived without deleting the worktree.
- Worktree deletion remains a separate explicit action.

### Worktree

Worktrees remain Phantom-owned Git worktrees created under the configured Phantom worktree location unless the project configuration says otherwise.

Requirements:

- New chat creation accepts an optional name.
- If omitted, Phantom generates a name with the same naming rules as `phantom create`.
- The generated branch/worktree name must be visible before or immediately after creation.
- Name validation must reuse existing Phantom validation helpers.
- Worktree list/status data should come from Phantom's core/git packages, not ad hoc Git parsing in the web layer.

## User Experience

### Layout

The first release uses a simple IDE-like layout:

- Left sidebar: project list and project actions.
- Optional second column or nested sidebar: chats/worktrees for the selected project.
- Main section: Codex chat view for the selected chat.
- Top bar: selected project, selected worktree/branch, server/auth status, and compact actions.

### Empty State

When no projects are registered:

- Show a minimal empty state in the sidebar or main section.
- Primary action: add a project directory.
- Avoid explanatory marketing copy.

### Add Project Flow

1. User clicks the add project action.
2. Browser asks the server to open/select a local directory, or the UI accepts a typed absolute path if native directory picking is unavailable.
3. Server validates the directory and resolves the Git root.
4. Server stores the project.
5. Sidebar updates through the API response and/or SSE event.

### New Chat Flow

1. User selects a project.
2. User clicks new chat.
3. UI optionally asks for a worktree/chat name and base branch.
4. Server creates a Phantom worktree.
5. Server starts or prepares a Codex thread with the worktree path as `cwd`.
6. UI navigates to the chat view.
7. User sends the first message.
8. Server starts a Codex turn and streams events to the UI over SSE.

### Chat View

The chat view must support:

- User message composer.
- Streaming assistant text.
- Running state and stop/interrupt action.
- Command execution items.
- Command output deltas.
- File-change items.
- Approval prompts for command execution and file changes.
- Error display with enough detail for recovery.
- Chat title display and rename when available.

First-release chat view may omit:

- Full diff review UI.
- Inline code editing.
- Multi-pane terminal management.
- Rich file browser.

### Visual Design

- Build the web interface with React.
- Use Tailwind CSS and shadcn/ui.
- Keep styling close to plain shadcn/ui.
- Prefer dense, utilitarian UI over marketing composition.
- Avoid card UI by default; use cards only for repeated entities, modals, or genuinely framed tools.
- Do not use large decorative gradients, hero sections, or illustrative landing-page patterns.

## Browser-to-Server API

The browser talks only to the Phantom server.

### HTTP JSON Endpoints

Initial endpoint shape:

- `GET /api/health`: server health.
- `GET /api/projects`: list projects.
- `POST /api/projects`: add a project by absolute path.
- `DELETE /api/projects/:projectId`: unregister a project.
- `GET /api/projects/:projectId/chats`: list chats for a project.
- `POST /api/projects/:projectId/chats`: create a worktree-backed chat.
- `GET /api/chats/:chatId`: read chat metadata.
- `POST /api/chats/:chatId/messages`: start a Codex turn.
- `POST /api/chats/:chatId/steer`: steer an active Codex turn.
- `POST /api/chats/:chatId/interrupt`: interrupt an active Codex turn.
- `POST /api/chats/:chatId/approvals/:requestId`: answer a pending approval.
- `POST /api/chats/:chatId/archive`: archive a chat.
- `GET /api/models`: list available Codex models.
- `GET /api/auth`: read Codex auth/account state.
- `POST /api/auth/login`: start Codex auth flow.
- `POST /api/auth/logout`: logout from Codex.

### Server-Sent Events

Initial endpoint shape:

- `GET /api/events`: global events for project/sidebar/auth state.
- `GET /api/chats/:chatId/events`: chat-scoped event stream.

Requirements:

- Use `text/event-stream`.
- Include event ids so clients can resume with `Last-Event-ID` when possible.
- Emit heartbeat comments to keep connections alive.
- Preserve Codex event ordering per chat.
- Do not require the browser to understand raw Codex JSON-RPC ids.
- Convert Codex notifications and server-initiated requests into Phantom domain events.

Example event names:

- `project.created`
- `project.removed`
- `chat.created`
- `chat.updated`
- `chat.archived`
- `agent.thread.started`
- `agent.turn.started`
- `agent.item.started`
- `agent.item.delta`
- `agent.item.completed`
- `agent.approval.requested`
- `agent.approval.resolved`
- `agent.turn.completed`
- `agent.error`
- `auth.updated`

### HTTP Streaming

SSE is the default event channel. Additional HTTP streaming may be used only when a response is naturally tied to a single request and does not need cross-request subscription semantics.

## Codex App Server Integration

### Transport

Phantom should launch Codex App Server with the default stdio transport and communicate with it using newline-delimited JSON-RPC messages.

Rationale:

- Codex App Server's default transport is `stdio`.
- The WebSocket transport is documented as experimental and unsupported.
- The browser should not connect directly to Codex App Server.
- Phantom needs a server-side bridge anyway to attach Phantom project/worktree metadata.

### Lifecycle

For each Codex App Server process or connection:

1. Start `codex app-server`.
2. Send `initialize` with Phantom client metadata.
3. Send `initialized`.
4. Use `model/list`, `account/read`, `thread/start`, `thread/resume`, `turn/start`, `turn/steer`, `turn/interrupt`, and approval responses as needed.
5. Continuously read notifications and server-initiated requests.
6. Map Codex messages to Phantom chat state and SSE events.

### Thread Mapping

- New Phantom chat maps to one Codex thread.
- `thread/start` must include the worktree path as `cwd`.
- Phantom should persist the returned `thread.id` in its own chat metadata.
- Phantom should update Codex thread metadata with Git branch information when available.
- Resuming a Phantom chat should use `thread/resume` when the thread must become active again and `thread/read` or `thread/turns/list` when only history is needed.

### Turns

- Sending a user chat message calls `turn/start`.
- Sending user input while a turn is active calls `turn/steer`.
- Stopping a running agent calls `turn/interrupt`.
- The UI must render streamed notifications instead of waiting for turn completion.

### Approvals

- Command execution approvals and file-change approvals must be shown as explicit UI prompts.
- Approval state must be scoped by `threadId`, `turnId`, and Codex request id.
- Supported decisions should mirror Codex's available decisions.
- The UI should distinguish command/network approvals from file-change approvals when Codex provides that context.

### Authentication

- First release should expose Codex account state through Phantom's API.
- Support ChatGPT-managed login and API-key login if Codex App Server exposes both in the installed Codex version.
- Do not store raw API keys in Phantom project metadata.
- Prefer Codex App Server's own credential storage and auth lifecycle.

## Persistence

Phantom server must persist:

- Registered projects.
- Chat-to-project mapping.
- Chat-to-worktree mapping.
- Chat-to-Codex-thread mapping.
- User-facing chat titles if Phantom owns them.
- Last selected project and chat.

Persistence may be a local JSON file for the first release if writes are atomic and migration is planned. The storage location should be user-level, not repository-level, because the interface spans multiple projects.

The first release should avoid duplicating Codex's full conversation log. Store Phantom metadata and read conversation details from Codex where possible.

## Error Handling

The interface must handle:

- Codex executable not found.
- Codex App Server exits unexpectedly.
- Codex initialization failure.
- User not authenticated.
- Upstream Codex/API errors.
- Git repository validation failure.
- Worktree creation failure.
- Worktree name conflict.
- Missing or deleted project directories.
- Missing or deleted worktree paths.
- SSE disconnect and reconnect.

Errors should be visible in the relevant UI scope:

- Global/server/auth errors in the top bar or global status area.
- Project errors in the sidebar/project pane.
- Chat/agent errors in the chat view.

## Security Requirements

- Default to local-only binding.
- Validate all project paths on the server.
- Resolve symlinks before storing project roots.
- Never allow browser-supplied relative paths to directly drive filesystem writes.
- Require explicit user action before unregistering projects, deleting worktrees, executing user shell commands, or answering Codex approvals.
- Treat Codex command execution and file change approvals as security-sensitive UI.
- Avoid logging secrets, API keys, auth tokens, or full command environments.
- Do not expose Codex App Server raw transport to browser JavaScript.

## First-Release Scope

Required:

- `phantom serve` starts the local web interface.
- Register and persist multiple Git projects.
- Sidebar project list.
- Create a new chat from a project.
- Create a Phantom worktree during chat creation.
- Start/resume a Codex thread in the worktree.
- Send messages to Codex.
- Stream assistant responses and agent progress over SSE.
- Render command execution, command output, file changes, approvals, and errors in the chat view.
- Interrupt a running turn.
- Basic Codex auth/account state UI.
- Plain React + Tailwind CSS + shadcn/ui interface.

Deferred:

- Browser-native directory picker with desktop integration if it requires platform-specific work.
- Full diff viewer/editor.
- File tree and code editor.
- Multi-agent or non-Codex provider support.
- Remote access mode.
- Team/project sharing.
- Advanced search across all chats.
- Rich terminal multiplexing.
- Browser-to-server WebSocket transport.

## Implementation Notes

- Reuse existing Phantom packages for Git and worktree behavior:
  - `packages/core` for worktree orchestration and validation.
  - `packages/git` for Git executor/helpers.
  - `packages/process` for spawning and process control.
- Keep the app package focused on the React interface and route/server glue.
- Introduce a small server-side Codex bridge that owns:
  - process lifecycle,
  - JSON-RPC id generation,
  - request/response correlation,
  - notification fan-out,
  - approval request tracking,
  - conversion from Codex messages to Phantom API events.
- Generate Codex App Server schemas during development or CI when useful, because the schema is version-specific to the installed Codex CLI.
- Treat the first-release API as internal and version it only when external clients become a goal.

## Open Questions

- Should `phantom serve` auto-open the browser by default, or should this require `--open`?
- Should each project have one long-lived Codex App Server process, or should Phantom share one process across all projects?
- What is the exact user-level data directory on macOS, Linux, and Windows?
- Should chat creation allow selecting a base branch in the first release?
- Should deleting a chat offer to delete its worktree, archive it, or leave it untouched?
- How much Codex conversation history should Phantom cache for fast sidebar rendering?
- Which Codex auth mode should be the default UI path: ChatGPT-managed login or API key?

## References

- OpenAI Codex App Server documentation: https://developers.openai.com/codex/app-server
- Current Phantom serve handler: `packages/cli/src/handlers/serve.ts`
- Current Phantom serve help: `packages/cli/src/help/serve.ts`
- Current web app package: `packages/app`
