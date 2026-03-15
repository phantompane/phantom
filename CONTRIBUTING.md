# 🤝 Contributing to Phantom

Thank you for your interest in contributing to Phantom! This guide will help you get started with development.

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

- Node.js 22+ and pnpm 10+

### Getting Started

```bash
# Clone and setup
git clone https://github.com/phantompane/phantom.git
cd phantom
pnpm install

# run phantom in development mode
pnpm phantom
```

### Development Workflow

```bash
# Run tests
pnpm test

# Type checking
pnpm typecheck

# Linting
pnpm lint
# or
pnpm fix

# Run all checks before committing
pnpm ready
```

## 📝 Development Guidelines

### Language Requirements

- **All files, issues, and pull requests must be written in English**
- This ensures the project is accessible to the global community

### Code Style

- Follow existing code conventions and patterns
- Use TypeScript for all new code
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
# Run all tests
pnpm test

# Run specific test file
pnpm test:file src/core/worktree/create.test.js
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
pnpm ready
```

This command runs:

- Formatting auto-fixes (`pnpm fix`)
- Type checking (`pnpm typecheck`)
- All tests (`pnpm test`)

To run the non-mutating variant, use `pnpm ready:check`, which runs `turbo run lint typecheck test`.

### Security Best Practices

- Never introduce code that exposes or logs secrets and keys
- Never commit secrets or keys to the repository
- Be careful with user input validation

## 🚀 Pull Request Requirements

- Clear description of changes
- Tests for new functionality
- Documentation updates if applicable
- All checks passing (`pnpm ready`)
- Follow existing code style

## 📚 Documentation

When contributing documentation:

- Keep language clear and concise
- Update the table of contents if adding sections
- Check for broken links

## 🚀 Release Process

To release a new version of Phantom:

1. **Bump version**

   ```bash
   # Trigger the automated version bump workflow via GitHub CLI
   # release_type: patch | minor | major | prepatch | preminor | premajor | prerelease
   gh workflow run version-bump.yml -f release_type=patch

   # Example: start a prerelease minor bump
   gh workflow run version-bump.yml -f release_type=preminor

   # Wait for the workflow to finish and create the PR for you
   gh run watch --exit-status --workflow=version-bump.yml
   ```

2. **Review the version bump PR created by the workflow**
   - Confirm version numbers and changelog/doc updates if any
   - Merge the PR once checks pass

3. **Create GitHub release (publishes to npm)**

   ```bash
   # Create a release with automatically generated notes
   gh release create v<version> \
     --title "Phantom v<version>" \
     --generate-notes \
     --target main

   # Example for v1.3.0:
   gh release create v1.3.0 \
     --title "Phantom v1.3.0" \
     --generate-notes \
     --target main
   ```

   Publishing to npm is handled by `.github/workflows/npm-publish.yml` when the release is published. Releases from `pre*` bumps are published with the `next` dist-tag; all other releases use `latest`. Monitor the workflow run in GitHub Actions to ensure it completes successfully.

4. **Update release notes for clarity**
   - Review the auto-generated release notes using `gh release view v<version>`
   - Check PR descriptions for important details using `gh pr view <number>`
   - Update the release notes to be more user-friendly:
     - Group changes by category (Features, Bug Fixes, Improvements, Documentation)
     - Add usage examples for new features with code blocks
     - Credit external contributors inline (e.g., "Thanks @username!")
     - Include PR numbers for all changes
     - Add installation/upgrade instructions
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

   **Installation/Upgrade:**

   ```bash
   npm install -g @phantompane/cli@latest
   # or
   brew upgrade phantom
   ```

   **Full Changelog**: https://github.com/phantompane/phantom/compare/v<previous>...v<version>
   EOF
   )"

   ```

   ```

## 🙏 Thank You!

Your contributions make Phantom better for everyone. If you have questions, feel free to:

- Open an issue for bugs or feature requests
- Start a discussion for general questions
- Ask in pull request comments
