---
name: phantom-design-system
description: Use this skill for UI or frontend development in the Phantom repository, especially packages/app changes, React components, shadcn/ui usage, sidebar/chat/worktree screens, styling, responsive behavior, or UX copy. Always read the repository DESIGN.md before making or reviewing UI/frontend changes.
metadata:
  short-description: Apply Phantom DESIGN.md to UI work
---

# Phantom Design System

Use this skill when working on UI or frontend code in the Phantom repository.

## Required Context

Before proposing, editing, or reviewing UI/frontend work:

1. Confirm the current repository root.
2. Read `DESIGN.md` from the repository root.
3. Apply its guidance to the change, especially layout, components, typography, color, motion, accessibility, and shadcn/ui usage.

If `DESIGN.md` is missing, stop and tell the user that the required design system file is unavailable.

## Workflow

- Prefer existing Phantom UI patterns and shadcn/ui-based components before adding new primitives.
- Keep UI changes consistent with the sidebar, project/worktree hierarchy, agent chat, command input, and diff/code surfaces described in `DESIGN.md`.
- Remove or revise UI text, spacing, color, and component choices that conflict with `DESIGN.md`.
- For visual changes, verify in the app when a dev server or browser context is available.
- Mention in the final response that `DESIGN.md` was consulted for UI/frontend decisions.

## Scope

This skill is for Phantom UI/frontend work only. Do not use it for backend-only changes, CLI behavior, Git orchestration, or documentation-only edits unless the documentation describes UI/frontend behavior.
