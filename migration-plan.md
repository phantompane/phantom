# Test Migration Plan

## Goal

Convert all test files from JavaScript to TypeScript and keep the suite green.

## Scope

- Convert all `packages/**/*.test.js` files to `*.test.ts`
- Convert all `packages/**/*.test.shell.js` files to `*.test.shell.ts`
- Update test discovery so Vitest continues to find the migrated files
- Fix or remove invalid test cases discovered during the migration

## Inventory

- `packages/cli`: 17 standard tests, 3 shell tests
- `packages/core`: 19 tests
- `packages/git`: 4 tests
- `packages/github`: 8 tests
- `packages/mcp`: 4 tests
- `packages/process`: 4 tests
- `packages/shared`: 2 tests
- Total: 61 files

## Migration Rules

- Rename each test file from `.js` to `.ts`
- Keep runtime behavior unchanged unless the migration exposes a broken test
- Add explicit types only where TypeScript requires them
- Preserve existing `.ts` import specifiers
- Record any deleted or behavior-changing test updates in the findings log below

## Progress

- [x] Audit current test inventory and Vitest configuration
- [x] Update Vitest/package configuration for TypeScript test files
- [x] Migrate `packages/shared`
- [x] Migrate `packages/process`
- [x] Migrate `packages/git`
- [x] Migrate `packages/github`
- [x] Migrate `packages/mcp`
- [x] Migrate `packages/core`
- [x] Migrate `packages/cli`
- [x] Run `pnpm ready`

## Findings

- `packages/core/src/paths.test.ts`: the tests were using an outdated `getWorktreesDirectory(gitRoot)` call shape. Updated them to pass the current second argument explicitly with `undefined` when exercising the default path.
- `packages/core/src/worktree/where.test.ts`: the tests were using the stale 2-argument `whereWorktree` call and mock expectation. Updated them to include the current `worktreeDirectory` argument.
- `packages/mcp/src/tools/create-worktree.test.ts`, `packages/mcp/src/tools/delete-worktree.test.ts`, `packages/mcp/src/tools/list-worktrees.test.ts`: the tests were calling MCP tool handlers with the old single-argument shape. Updated them to pass the current second callback argument placeholder.
- Several migrated tests accessed `Result` unions through `.value` or `.error` without narrowing. The runtime behavior was valid, but the assertions were updated to use `isOk` / `isErr` so the tests match the actual TypeScript contract.
