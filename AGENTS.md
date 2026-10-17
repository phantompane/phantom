# Repository Guidelines

## Project Structure & Module Organization

- Phantom is a Rust CLI. The crate lives at the repository root (`Cargo.toml`, `src/`, `tests/`).
- Development happens on `next`. `main` stays the previous TypeScript version.
- Modules follow the old package boundaries: `cli`, `worktree`, `git`, `config`, `preferences`, `projects`, `tmux`, `github`, `mcp`, `help`.
- Shell completion scripts are embedded from `completions/`. Command help text is generated from `help-data.json`.
- Project config example: `phantom.config.json`.
- Principles: single responsibility, a centralized git executor, and `Result` for every fallible path.

## Build, Test, and Development Commands

- Prerequisite: Rust 1.99.1, pinned in `rust-toolchain.toml`. The same version is pinned in `.github/workflows/ci.yml`, `release-compile.yml` (`toolchain` and `RUSTUP_TOOLCHAIN`), `version-bump.yml`, and `devenv.nix`. Dependabot reads `.github/dependabot.yml` only from the default branch, so Cargo and GitHub Actions updates start after `next` is merged into `main`. It does not bump `rust-toolchain.toml` or those workflow strings. To move the pin, change every one of those places together, then run fmt, clippy, and tests on the new compiler. Change `rust-version` in `Cargo.toml` only when the MSRV changes. It is 1.89 because uuid 1.28 declares `rust-version = "1.89.0"`.
- Run the CLI: `cargo run --locked -- --help`.
- Format: `cargo fmt --all`.
- Lint: `cargo clippy --locked --all-targets -- -D warnings`.
- Tests: `cargo test --locked`. Shell completion tests spawn bash, zsh, and fish (`cargo test --locked --test completion`).
- Before shipping, run `cargo fmt --all`, `cargo clippy --locked --all-targets -- -D warnings`, and `cargo test --locked`.

## Coding Style & Naming Conventions

- Rust 2021. `rustfmt` is the formatter.
- Non-test code must not use `unwrap()`, `expect()`, or `panic!`. Propagate errors with `Result` and `thiserror`. The crate denies `clippy::unwrap_used`, `clippy::expect_used`, and `clippy::panic` outside tests.
- Use PascalCase for types, camelCase for functions and variables, and snake_case for modules.
- Keep CLI flags and config keys consistent with `phantom.config.json`.
- All files, issues, and pull requests must be written in English. Follow existing patterns.

## Testing Guidelines

- Unit tests sit next to the module in `src/`. CLI and shell-completion coverage lives in `tests/`.
- Cover success and error paths for worktree creation, git flows, the project registry, and shell completion. Use temporary directories and the git executor.

## Commit & Pull Request Guidelines

- Use conventional commits as in history: `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`.
- PRs should include a summary, verification steps, and CLI output for UX-facing changes.
- Ensure `cargo fmt`, `cargo clippy --locked`, and `cargo test --locked` pass. Note known gaps in the PR body.

## Security & Configuration Tips

- Never commit tokens or GitHub credentials. `github checkout` uses the `gh` CLI (`GH_TOKEN` / `GH_HOST`).
- Keep worktrees under `.git/phantom/worktrees/` unless overridden in `phantom.config.json`. Avoid leaking local paths in logs.
- Reuse `validate_worktree_name` rather than re-implementing name parsing.

## Releases

- Version lives in `Cargo.toml`. Dispatch `.github/workflows/version-bump.yml` from `next` (`gh workflow run version-bump.yml --ref next`). It checks out `next`, refreshes `Cargo.lock` with `cargo update -p phantom --precise <version>`, and opens a PR against `next`.
- Merging a `chore(version): vX.Y.Z` PR into `next` tags that version.
- Publishing a GitHub release builds linux/darwin x64/arm64 binaries and uploads them. npm is not published.
