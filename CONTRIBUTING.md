# 🤝 Contributing to rabi

Thank you for your interest in contributing to rabi! This guide will help you get started with development.

## 📋 Table of Contents

- [Development Setup](#development-setup)
- [Development Guidelines](#development-guidelines)
- [Testing](#testing)
- [Code Quality](#code-quality)
- [Pull Request Process](#pull-request-process)
- [Documentation](#documentation)
- [Release Process](#release-process)
- [Additional Resources](#additional-resources)

## 🛠️ Development Setup

### Prerequisites

- Rust 1.99.1 (`rust-toolchain.toml`).
- [mise](https://mise.jdx.dev/) is optional. `mise.toml` only aliases `fmt`, `clippy`, and `test`. It does not install Rust or other tools.

Development happens on `main`. Open pull requests against `main`.

Dependabot does not bump the Rust toolchain. The version is pinned in `rust-toolchain.toml`, in the `toolchain:` input of `.github/workflows/ci.yml` and `release-compile.yml`, and in `RUSTUP_TOOLCHAIN` in `release-compile.yml`. Update all of those together, then run the checks below on the new compiler. `Cargo.toml` `rust-version` is the MSRV (1.89, required by uuid 1.28) and changes only when that floor moves.

### Getting Started

```bash
git clone https://github.com/yoiailabs/rabi.git
cd rabi
cargo run --locked -- --help
```

The built binary is `rabi` (`rabi --help`, `rabi create`). The Cargo package name is `rabi`. Retired interfaces have no compatibility shims before v7 stable; unknown commands, flags, config keys, and hook fields use normal validation.

### Development Workflow

```bash
cargo test --locked
cargo fmt --all
cargo clippy --locked --all-targets -- -D warnings
```

`mise run fmt`, `mise run clippy`, and `mise run test` match the CI checks (`cargo fmt --all -- --check`, Clippy, and `cargo test --locked`).

## 📝 Development Guidelines

### Language Requirements

- **Write files, issues, and pull requests in English**, except for the Japanese README translation
- This ensures the project is accessible to the global community

### Code Style

- Follow existing code conventions and patterns
- Write new code in Rust. Non-test code returns `Result` and does not call `unwrap()`, `expect()`, or `panic!`
- Follow the Single Responsibility Principle
- Keep modules focused and testable

### Architecture Principles

- **Single Responsibility Principle**: Each module has one clear responsibility
- **Separation of Concerns**: CLI, business logic, and git operations are separated
- **Testability**: Core modules are framework-agnostic and easily testable
- **No Code Duplication**: Common operations are centralized
- **Clear Dependencies**: Dependencies flow from CLI → Core (including Git operations)

## 🧪 Testing

### Running Tests

```bash
cargo test --locked
cargo test --locked --test cli
```

### Writing Tests

- Add tests for all new features
- Follow existing test patterns
- Use descriptive test names
- Test both success and error cases

## ✨ Code Quality

### Before Committing

Always run the following command before committing:

```bash
cargo fmt --all
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked
```

### Security Best Practices

- Never introduce code that exposes or logs secrets and keys
- Never commit secrets or keys to the repository
- Be careful with user input validation

## 🚀 Pull Request Requirements

- Clear description of changes
- Tests for new functionality
- Documentation updates if applicable
- All checks passing (`cargo fmt`, `cargo clippy --locked`, and `cargo test --locked`)
- Follow existing code style

## 📚 Documentation

When contributing documentation:

- Keep language clear and concise
- Keep `README.md` concise; put detailed reference material in [`docs/`](docs/commands.md)
- Keep `README.ja.md` aligned in sections, commands, flags, and examples; fenced code blocks must be identical
- Verify CLI guidance against `help-data.json`, the implementation, and isolated example runs
- Run `cargo test --locked --test docs` for README consistency
- Check for broken links when moving reference sections

## 🚀 Release Process

To release a new version of rabi:

1. **Open a version pull request against `main`**

   Change the version by hand in a dedicated pull request. Do not bump it in a feature pull request. Edit `version` in `Cargo.toml` and the `rabi` package entry in `Cargo.lock` so they match.

   ```bash
   # After editing Cargo.toml, refresh only the rabi entry in Cargo.lock:
   cargo update -p rabi --precise <version>
   ```

   Title the pull request `chore(version): vX.Y.Z`, for example `chore(version): v7.0.0`. `.github/workflows/tag-on-merge.yml` creates that git tag when the pull request merges into `main`. `ci.yml` and `release-compile.yml` do not bump the version.

2. **Review and merge the version pull request**
   - Confirm `Cargo.toml` and `Cargo.lock` show the same version
   - Merge once checks pass
   - The merge tags `vX.Y.Z` on `main`. Publishing a GitHub release is a separate step

3. **Create a GitHub release (builds release binaries)**

   ```bash
   # Create a release with automatically generated notes
   gh release create v<version> \
     --title "rabi v<version>" \
     --generate-notes \
     --target main

   # Example for v1.3.0:
   gh release create v1.3.0 \
     --title "rabi v1.3.0" \
     --generate-notes \
     --target main
   ```

   `.github/workflows/release-compile.yml` builds linux/darwin x64/arm64 binaries and uploads `rabi-v<version>-<os>-<arch>.tar.gz` to the release. Each archive contains only the `rabi` binary. `install.sh` supports only `rabi-v<version>-<os>-<arch>.tar.gz` archives. v7.0.0-alpha.10, v7.0.0-alpha.9 and v7.0.0-alpha.8 must each be installed with that release's own `install.sh` at `https://github.com/yoiailabs/rabi/releases/download/<TAG>/install.sh` (replace `<TAG>` with the release tag); v7.0.0-alpha.7 and older have no installer and must be installed manually. npm is not published. Monitor the workflow run in GitHub Actions.

4. **Update release notes for clarity**
   - Review the auto-generated release notes using `gh release view v<version>`
   - Check PR descriptions for important details using `gh pr view <number>`
   - Update the release notes to be more user-friendly:
     - Group changes by category (Features, Bug Fixes, Improvements, Documentation)
     - Add usage examples for new features with code blocks
     - Credit external contributors inline (e.g., "Thanks @username!")
     - Include PR numbers for all changes
     - Include "New Contributors" section with PR numbers

   ````bash
   # Edit the release notes
   gh release edit v<version> --notes "$(cat <<'EOF'
   ## 🚀 What's New in v<version>

   <Brief overview of major changes>

   ### ✨ New Features

   #### Feature Name (#PR) - Thanks @contributor!
   Description and usage example:
   ```bash
   # Example command
   ````

   ### 🛠️ Improvements
   - **Improvement** (#PR) - Description
   - **Another improvement** (#PR) - Description

   ### 🐛 Bug Fixes
   - Fixed issue description (#PR) - Thanks @contributor!

   ### 📚 Documentation
   - Documentation updates (#PR)

   ### 🙏 New Contributors

   Welcome to our new contributors!
   - @username - Contribution description (#PR)

   ***

   **Full Changelog**: https://github.com/yoiailabs/rabi/compare/v<previous>...v<version>
   EOF
   )"

   ```

   ```

## 🙏 Thank You!

Your contributions make rabi better for everyone. If you have questions, feel free to:

- Open an issue for bugs or feature requests
- Start a discussion for general questions
- Ask in pull request comments
