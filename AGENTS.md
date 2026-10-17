# Repository Guidelines

## Project Structure & Module Organization

- Phantom is a Rust CLI. The crate lives at the repository root (`Cargo.toml`, `src/`, `tests/`).
- Modules follow the old package boundaries: `cli`, `worktree`, `git`, `config`, `preferences`, `projects`, `tmux`, `github`, `mcp`, `help`.
- Shell completion scripts are embedded from `completions/`. Command help text is generated from `help-data.json`.
- Docs and assets: `docs/`. Project config example: `phantom.config.json`.
- Principles: single responsibility, a centralized git executor, and `Result` for every fallible path.

## Build, Test, and Development Commands

- Prerequisite: stable Rust (see `rust-toolchain.toml`).
- Run the CLI: `cargo run -- --help`.
- Format: `cargo fmt --all`.
- Lint: `cargo clippy --all-targets -- -D warnings`.
- Tests: `cargo test`. Shell completion tests spawn bash, zsh, and fish (`cargo test --test completion`).
- Before shipping, run `cargo fmt --all`, `cargo clippy --all-targets -- -D warnings`, and `cargo test`.

## Coding Style & Naming Conventions

- Rust 2021. `rustfmt` is the formatter.
- Non-test code must not use `unwrap()`, `expect()`, or `panic!`. Propagate errors with `Result` and `thiserror`. The crate denies `clippy::unwrap_used`, `clippy::expect_used`, and `clippy::panic` outside tests.
- Use PascalCase for types, camelCase for functions and variables, and snake_case for modules.
- Keep CLI flags and config keys consistent with `phantom.config.json` and the docs.
- All files, issues, and pull requests must be written in English. Follow existing patterns.

## Testing Guidelines

- Unit tests sit next to the module in `src/`. CLI and shell-completion coverage lives in `tests/`.
- Cover success and error paths for worktree creation, git flows, the project registry, and shell completion. Use temporary directories and the git executor.

## Commit & Pull Request Guidelines

- Use conventional commits as in history: `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`.
- PRs should include a summary, verification steps, and CLI output for UX-facing changes.
- Ensure `cargo fmt`, clippy, and tests pass. Note known gaps in the PR body.

## Security & Configuration Tips

- Never commit tokens or GitHub credentials. `github checkout` uses the `gh` CLI (`GH_TOKEN` / `GH_HOST`).
- Keep worktrees under `.git/phantom/worktrees/` unless overridden in `phantom.config.json`. Avoid leaking local paths in logs.
- Reuse `validate_worktree_name` rather than re-implementing name parsing.

## Releases

- Version lives in `Cargo.toml`. `.github/workflows/version-bump.yml` bumps it and opens a PR.
- Merging a `chore(version): vX.Y.Z` PR tags that version.
- Publishing a GitHub release builds linux/darwin x64/arm64 binaries and uploads them. npm is not published.
