# Vitest Migration Plan

## Goal

Migrate the entire monorepo test runner from `node --test` to `vitest` while preserving current test coverage, package boundaries, and existing test semantics as much as possible.

## Current State

- Every package runs tests with `node --test --experimental-strip-types --experimental-test-module-mocks`.
- Test files are mainly `src/**/*.test.js`, plus CLI shell completion tests under `src/completions/*.test.shell.js`.
- Most tests import from `node:test`.
- A large portion of tests rely on `mock.fn()`, `mock.module()`, and `mock.method()`.
- Existing assertions mostly use `node:assert`, which can remain in place during the runner migration.

## Constraints And Risks

- Rewriting every test directly to `vi.mock()` / `vi.fn()` would create a large diff and unnecessary migration risk.
- Node test mocks expose APIs such as `mock.calls[n].arguments` and `mock.resetCalls()` that do not match Vitest one-to-one.
- Some suites use `describe(..., { skip: ... })` or `describe(..., { concurrency: false })`, which also differ from Vitest semantics.
- CLI and integration-style tests must continue to run in a Node environment.

## Migration Strategy

1. Add Vitest as the monorepo test runner and create a shared root configuration.
2. Introduce a small compatibility layer for `node:test` usage on top of Vitest.
3. Route `node:test` imports used by test files to that compatibility layer.
4. Keep `node:assert` assertions intact unless a specific test requires change.
5. Update all package-level `test` scripts and CLI shell test scripts to use Vitest.
6. Fix only the test files that still fail after the compatibility layer is in place.
7. Run the full repository verification flow (`pnpm ready`) and resolve remaining regressions.

## Implementation Plan

### Phase 1: Runner And Config

- Add `vitest` as a root `devDependency`.
- Add a root `vitest.config.ts`.
- Configure Vitest to:
  - run in a Node environment
  - discover all package tests
  - include shell completion tests
  - avoid watch mode in package scripts
  - resolve workspace source files correctly

### Phase 2: Compatibility Layer

- Create a compatibility module that provides:
  - `describe`, `it`, `test`
  - `beforeEach`, `afterEach`, `before`, `after`
  - `mock.fn()`
  - `mock.method()`
  - `mock.module()`
- Make the compatibility layer preserve the node-style mock ergonomics currently used in the repo:
  - `mock.resetCalls()`
  - `mock.mockImplementation(...)`
  - `mock.mockImplementationOnce(...)`
  - `mock.restore()`
  - `mock.calls[n].arguments`
- Support node-style suite/test options where currently used:
  - `skip`
  - `concurrency: false`

### Phase 3: Script Migration

- Replace package `test` scripts from `node --test ...` to `vitest run ...`.
- Replace CLI shell test scripts similarly.
- Keep root `pnpm test`, `pnpm test:shell`, and `pnpm ready` flows intact.

### Phase 4: Targeted Test Fixes

- Run package tests incrementally.
- Fix remaining incompatibilities such as:
  - module mock timing
  - spy restore behavior
  - suite option mismatches
  - any path resolution differences in shell tests

### Phase 5: Full Verification

- Run:
  - `pnpm test`
  - `pnpm test:shell`
  - `pnpm typecheck`
  - `pnpm ready`
- Address all regressions until the repository passes on the new runner.

## Expected Outcome

- `node --test` is removed from package test scripts.
- The whole monorepo test suite runs through Vitest.
- Existing tests stay largely intact, with compatibility handling the bulk of API differences.
- Repository quality gates continue to pass through `pnpm ready`.
