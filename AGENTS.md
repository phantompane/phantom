# Repository Guidelines

## Project Structure & Module Organization

- Monorepo managed by pnpm; source lives in `packages/`.
- Key packages: `cli` (user-facing CLI), `core` (worktree orchestration/validation), `git` (executor/helpers), `github` (API + checkout flows), `mcp` (MCP tools), `process` (spawn/tmux utilities), `shared` (types/guards).
- Docs and assets: `docs/`; shared configs: `.oxfmtrc.json`, `.oxlintrc.json`, `tsconfig*.json`, `phantom.config.json`; builds land in package-level `dist/`.
- Principles: single responsibility, separation of concerns, centralized git executor, dependency flow CLI → core → git/process/shared.

## Build, Test, and Development Commands

- Prereqs: Node 22+ and pnpm 10+; install deps via `pnpm install`.
- Run CLI locally: `pnpm phantom`.
- Build: `pnpm build`; type check: `pnpm typecheck`.
- Lint/format: `pnpm lint` (check with `oxfmt` + `oxlint`) or `pnpm fix` (apply formatter and auto-fixes).
- Tests: `pnpm test` (native `node --test` across packages).
- Pre-flight: `pnpm ready` (`turbo run fix typecheck test`) or `pnpm ready:check` (`turbo run lint typecheck test`).
- After finishing an implementation, run `pnpm ready` to execute fix, typecheck, and tests before shipping changes.
- Scope work: `pnpm --filter <pkg> <cmd>` (e.g., `pnpm --filter @phantompane/github test`).

## Coding Style & Naming Conventions

- ESM with TypeScript sources; tests are `.test.js` files using stripped types.
- `oxfmt` enforces 2-space indentation and double quotes; `oxlint` enforces correctness rules including no unused variables.
- Use PascalCase for types/interfaces, camelCase for functions/variables, and kebab-case for package or file names where applicable.
- Keep CLI flags and config keys consistent with `phantom.config.json` and README examples.
- All files/issues/PRs must be written in English; follow existing patterns over inventing new ones.

## Testing Guidelines

- Tests run with `node --test --experimental-strip-types --experimental-test-module-mocks`.
- Place tests beside source under `src/**/*/*.test.js`, mirroring module names.
- Cover success/error paths for worktree creation, git/github flows, and MCP tools; use temporary directories and the centralized git executor. Prefer tests over ad-hoc manual commands.

## Commit & Pull Request Guidelines

- Use conventional commits as in history: `feat:`, `fix:`, `chore:`, `docs:`, `refactor:` (often suffixed with `(#123)`).
- PRs should include a clear summary, linked issue/PR context, verification steps, and CLI output or screenshots for UX-facing changes.
- Ensure checks pass (`pnpm ready` or at least lint + typecheck + test); note any known gaps in the PR body.

## Security & Configuration Tips

- Never commit tokens or GitHub credentials; use env vars such as `GH_TOKEN`/`GH_HOST` locally.
- Keep worktrees under `.git/phantom/worktrees/` unless overridden in `phantom.config.json`; avoid leaking local paths in logs.
- Reuse existing validation helpers (e.g., `worktree/validate-name`) rather than re-implementing parsing of user input.
