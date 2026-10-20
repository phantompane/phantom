# Repository Guidelines

## Project Structure & Module Organization

- Phantom is a Rust CLI. The crate lives at the repository root (`Cargo.toml`, `src/`, `tests/`).
- Development happens on `next`. `main` stays the previous TypeScript version.
- Modules follow the old package boundaries: `cli`, `worktree`, `git`, `config`, `preferences`, `projects`, `github`, `help`.
- Command help text is generated from `help-data.json`.
- Project hooks live in `.ptm.toml` in the source checkout, the checkout where the command runs (`[hooks] post-create` and `pre-delete`). `PTM_ROOT_PATH` is that checkout.
- Principles: single responsibility, a centralized git executor, and `Result` for every fallible path.

## Build, Test, and Development Commands

- Prerequisite: Rust 1.99.1, pinned in `rust-toolchain.toml`. The same version is pinned in `.github/workflows/ci.yml` and `release-compile.yml` (`toolchain` and `RUSTUP_TOOLCHAIN`). Dependabot reads `.github/dependabot.yml` only from the default branch, so Cargo and GitHub Actions updates start after `next` is merged into `main`. It does not bump `rust-toolchain.toml` or those workflow strings. To move the pin, change every one of those places together, then run fmt, clippy, and tests on the new compiler. Change `rust-version` in `Cargo.toml` only when the MSRV changes. It is 1.89 because uuid 1.28 declares `rust-version = "1.89.0"`.
- `mise.toml` defines optional task aliases. `mise run fmt`, `mise run clippy`, and `mise run test` run the same checks as CI. It does not install Rust or other tools.
- The installed command is `ptm` (`ptm create`, `ptm --help`). The Cargo package name stays `phantom`. There is no `phantom` binary alias.
- Run the CLI: `cargo run --locked -- --help`.
- Format: `cargo fmt --all`.
- Lint: `cargo clippy --locked --all-targets -- -D warnings`.
- Tests: `cargo test --locked`.
- Before shipping, run `cargo fmt --all`, `cargo clippy --locked --all-targets -- -D warnings`, and `cargo test --locked`.

## Coding Style & Naming Conventions

- Rust 2021. `rustfmt` is the formatter.
- Non-test code must not use `unwrap()`, `expect()`, or `panic!`. Propagate errors with `Result` and `thiserror`. The crate denies `clippy::unwrap_used`, `clippy::expect_used`, and `clippy::panic` outside tests.
- Use PascalCase for types, camelCase for functions and variables, and snake_case for modules.
- Keep CLI flags and config keys consistent with `.ptm.toml` and `ptm preferences`.
- All files, issues, and pull requests must be written in English. Follow existing patterns.

## Testing Guidelines

- Unit tests sit next to the module in `src/`. CLI coverage lives in `tests/`.
- Cover success and error paths for worktree creation, git flows, and the project registry. Use temporary directories and the git executor.

## Commit & Pull Request Guidelines

- Use conventional commits as in history: `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`.
- Do not bump `Cargo.toml` or `Cargo.lock` in a feature pull request. Change the version by hand in a dedicated pull request against `next`. See Releases.
- PRs should include a summary, verification steps, and CLI output for UX-facing changes.
- Ensure `cargo fmt`, `cargo clippy --locked`, and `cargo test --locked` pass. Note known gaps in the PR body.

## Security & Configuration Tips

- Never commit tokens or GitHub credentials. `github checkout` uses the `gh` CLI (`GH_TOKEN` / `GH_HOST`).
- Keep worktrees under `.git/ptm/worktrees/` unless overridden with the `worktreesDirectory` preference. Avoid leaking local paths in logs.
- Reuse `validate_worktree_name` rather than re-implementing name parsing.

## Releases

- The version lives in `Cargo.toml` and the `phantom` entry in `Cargo.lock`. Change it by hand in a dedicated pull request against `next`. Do not bump the version in other pull requests.
- Title that pull request `chore(version): vX.Y.Z` (a prerelease such as `v7.0.0-alpha.3` is fine). Merging it into `next` creates the git tag. `.github/workflows/tag-on-merge.yml` reads the version from the title. It does not edit `Cargo.toml`.
- Publishing a GitHub release builds linux/darwin x64/arm64 binaries and uploads `ptm-v<version>-<os>-<arch>.tar.gz`. Each archive contains the `ptm` binary. `.github/workflows/release-compile.yml` runs when that release is published and packages the version already in `Cargo.toml`. npm is not published.
