---
name: create-pull-request
description: Create a GitHub pull request for the current repository. Use when the user asks to create, open, submit, or prepare a PR, or says the current branch is ready for review. Check git status and branch state, create a branch if needed, review diffs and commits, ensure changes are committed and pushed, draft a reviewer-friendly title/body, and create the PR with GitHub tools or gh. Unless the user explicitly asks otherwise, create draft pull requests and never add a "[codex]" prefix to the PR title.
---

# Create Pull Request

## Workflow

Follow this sequence before opening a PR:

1. Run `git status -sb` to identify the current branch and pending changes.
2. If the current branch is `main` or the repository default branch, create or ask for an appropriate feature branch before committing or pushing.
3. Inspect the change set with `git diff`, `git diff --staged`, and relevant commit history such as `git log --oneline --decorate --max-count=20`.
4. Commit all intended changes before PR creation. Do not include unrelated user changes unless the user explicitly asks.
5. Push the branch to `origin` with upstream tracking if needed.
6. Read the repository PR template before drafting the body. Check common paths such as `.github/pull_request_template.md`, `.github/PULL_REQUEST_TEMPLATE.md`, and `.github/PULL_REQUEST_TEMPLATE/*.md`.
7. Create the PR with the available GitHub tool first. If no GitHub tool can create PRs, use `gh pr create`.

## PR Title

- Write a concise title that matches the repository's convention.
- Do not prefix the title with `[codex]`, even if older PRs in the repository used that prefix.
- Use the user-requested title when provided, but strip a leading `[codex]` prefix case-insensitively before creating the PR.

## PR Body

Use the repository PR template when present and fill out every applicable section. If no template exists, use:

```markdown
## Summary

- ...

## Testing

- ...
```

Include enough context for reviewers to understand:

- what changed
- why it changed
- notable implementation decisions or tradeoffs
- validation performed, including exact commands and relevant results
- any known gaps or follow-up work

Keep the body factual and specific. Do not overstate testing that was not run.

## Creation Rules

- Prefer creating a draft PR unless the user explicitly asks for a ready-for-review PR.
- Prefer GitHub MCP/app tools when they can create the PR. Fall back to `gh pr create` when needed.
- Use non-interactive commands where possible.
- Confirm the base branch from repository context or user instruction. If uncertain, inspect the remote default branch before choosing.
- Do not open a PR from `main` directly.
- Do not create a PR with uncommitted intended changes unless the user asks only to draft PR text.
- Do not modify, discard, or revert unrelated working-tree changes while preparing the PR.

## Command Examples

```bash
git status -sb
git diff
git diff --staged
git log --oneline --decorate --max-count=20
git push -u origin <branch>
```

```bash
gh pr create --draft --base <base-branch> --head <branch> --title "<PR title>" --body-file "<body-file>"
```
