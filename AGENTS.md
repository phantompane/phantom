# Repository Guidelines

## Project Structure & Module Organization

- Maboroshi is a Rust CLI that manages local Git workspaces so many coding agents and humans can work independently in the same repository. The crate lives at the repository root (`Cargo.toml`, `src/`, `tests/`).
- Development happens on `next`. `main` stays the previous TypeScript version.
- Modules follow the old package boundaries: `cli`, `worktree`, `git`, `config`, `preferences`, `projects`, `github`, `help`.
- Command help text is generated from `help-data.json`.
- Project hooks live in `.mabo.toml` in the source checkout, the checkout where the command runs (`[hooks] post-create` and `pre-delete`). `MABO_REPO_PATH` always points to the primary checkout. Hooks and exec also receive `MABO=1`, `MABO_WORKSPACE`, `MABO_WORKSPACE_ID` (empty when unrecorded), and `MABO_WORKSPACE_PATH`. Hooks run only after that git common directory is trusted (`mabo trust add` or `MABO_TRUST_ALL=1`). mabo does not ask with nonempty `CI`, JSON output, `--no-input`, `MABO_NO_INPUT` other than empty or `0`, or when stdin or stderr is not a terminal. `--no-hooks` skips them. `mabo gc` skips an untrusted repository that has pre-delete hooks and does not ask. Trust is the common-dir path, so a re-clone at the same path stays trusted until `mabo trust remove`.
- Outer commands are `repo add/list/show/forget`, `config get/set/unset/list` (`--sources` for reads), `trust add/remove/list`, `help [COMMAND...] [--json]`, and `--version`/`-v`. `trust add` shows hooks and records trust without prompting. Global `-R/--repo REF` selects a repository; exec requires it before the workspace name. Removed commands and flags return usage exit 2 with migration hints.
- User config keys are `workspace-root`, `clone-root`, `discover-ghq`, and `keep-branch` (until P7). Old worktrees-directory/root/ghq-discovery keys warn, take effect under the new names, and are rewritten on the next config write. New keys take precedence when both exist. directory-name-separator warns and is ignored. Clone-root keeps ghq.root -> GHQ_ROOT -> ~/ghq defaults. `help --json` includes help-data.json and its schemaVersion/exitCodes/errorCodes contract; `--version --json` keeps the application version in data.version.
- Principles: single responsibility, a centralized git executor, and `Result` for every fallible path.

## Build, Test, and Development Commands

- Prerequisite: Rust 1.99.1, pinned in `rust-toolchain.toml`. The same version is pinned in `.github/workflows/ci.yml` and `release-compile.yml` (`toolchain` and `RUSTUP_TOOLCHAIN`). Dependabot reads `.github/dependabot.yml` only from the default branch, so Cargo and GitHub Actions updates start after `next` is merged into `main`. It does not bump `rust-toolchain.toml` or those workflow strings. To move the pin, change every one of those places together, then run fmt, clippy, and tests on the new compiler. Change `rust-version` in `Cargo.toml` only when the MSRV changes. It is 1.89 because uuid 1.28 declares `rust-version = "1.89.0"`.
- `mise.toml` defines optional task aliases. `mise run fmt`, `mise run clippy`, and `mise run test` run the same checks as CI. It does not install Rust or other tools.
- The installed command is `mabo` (`mabo create`, `mabo --help`). The Cargo package name is `maboroshi`. There is no `ptm` or `phantom` binary.
- Run the CLI: `cargo run --locked -- --help`.
- Format: `cargo fmt --all`.
- Lint: `cargo clippy --locked --all-targets -- -D warnings`.
- Tests: `cargo test --locked`.
- Before shipping, run `cargo fmt --all`, `cargo clippy --locked --all-targets -- -D warnings`, and `cargo test --locked`.

## Coding Style & Naming Conventions

- Rust 2021. `rustfmt` is the formatter.
- Non-test code must not use `unwrap()`, `expect()`, or `panic!`. Propagate errors with `Result` and `thiserror`. The crate denies `clippy::unwrap_used`, `clippy::expect_used`, and `clippy::panic` outside tests.
- Use PascalCase for types, camelCase for functions and variables, and snake_case for modules.
- Keep CLI flags and config keys consistent with `.mabo.toml` and `mabo config`.
- All files, issues, and pull requests must be written in English. Follow existing patterns.

## Testing Guidelines

- Unit tests sit next to the module in `src/`. CLI coverage lives in `tests/`.
- Cover success and error paths for workspace creation, git flows, and the project registry. Use temporary directories and the git executor.

## Commit & Pull Request Guidelines

- Use conventional commits as in history: `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`.
- Do not bump `Cargo.toml` or `Cargo.lock` in a feature pull request. Change the version by hand in a dedicated pull request against `next`. See Releases.
- PRs should include a summary, verification steps, and CLI output for UX-facing changes.
- Ensure `cargo fmt`, `cargo clippy --locked`, and `cargo test --locked` pass. Note known gaps in the PR body.

## Security & Configuration Tips

- Never commit tokens or GitHub credentials. `github checkout` uses the `gh` CLI (`GH_TOKEN` / `GH_HOST`).
- New workspaces go under `$XDG_DATA_HOME/maboroshi/workspaces/<checkout>-<hash>/` (`~/.local/share/maboroshi/workspaces/...` when `XDG_DATA_HOME` is unset, empty, or relative) unless overridden with the `workspace-root` config key, which accepts absolute paths, ~/, or paths relative to the repository root. `delete` and `gc` may also remove a workspace recorded in `maboroshi/workspaces/<id>.json` when it sits outside that directory. Existing workspaces under `maboroshi/worktrees/` are not moved. An unrecorded workspace outside the resolved directory is left alone. Avoid leaking local paths in logs.
- Workspace metadata uses `<git-common-dir>/maboroshi/workspaces/ws_<uuid v4>.json` (schema 2); project registrations use `$XDG_STATE_HOME/maboroshi/repos/proj_<uuid>.json`. Legacy `worktrees.json` and `projects.json` stay readable until the first write imports all records and renames the source to `*.json.imported`. Use the shared atomic writer for state files; mabo has no internal file locks. Different-record additions preserve both records; same-record concurrent updates use the last write. Project readers deduplicate roots by oldest `createdAt`.
- Workspace records store purpose, links, base, and creation details. `where` and `exec` read metadata without rewriting records or importing legacy files. `gc --older-than` uses `createdAt`; `sync --all` selects every workspace in the selected repository.
- Reuse `validate_worktree_name` rather than re-implementing name parsing.

## Releases

- The version lives in `Cargo.toml` and the `maboroshi` entry in `Cargo.lock`. Change it by hand in a dedicated pull request against `next`. Do not bump the version in other pull requests.
- Title that pull request `chore(version): vX.Y.Z` (a prerelease such as `v7.0.0-alpha.6` is fine). Merging it into `next` creates the git tag. `.github/workflows/tag-on-merge.yml` reads the version from the title. It does not edit `Cargo.toml`.
- Publishing a GitHub release builds linux/darwin x64/arm64 binaries and uploads `maboroshi-v<version>-<os>-<arch>.tar.gz`. Each archive contains the `mabo` binary. `.github/workflows/release-compile.yml` runs when that release is published and packages the version already in `Cargo.toml`. npm is not published.
