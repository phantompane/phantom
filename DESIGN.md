# Phantom Design System

This document defines the visual and interaction principles for Phantom's user-facing interfaces, especially Phantom Serve and future developer tooling surfaces.

Phantom is a developer productivity tool for managing Git worktrees and AI-assisted parallel development. Its UI should stay quiet, dense, and practical: the worktree, chat, command output, state, and result should be more prominent than the application chrome.

## Design Philosophy

### Concept

Phantom's interface is a low-saturation, high-density workspace for developers. It is optimized for:

- Project and worktree navigation
- Agent chat and execution logs
- Status and approval flows
- Command input and output
- Git and worktree context
- Future diff or review surfaces

The interface should reduce cognitive load and keep attention on the user's current task. Avoid decorative visuals, large marketing-style sections, and brand-heavy color usage inside the product UI.

### Design Keywords

- Soft neutral workspace
- Low-contrast productivity UI
- Muted semantic highlight
- Developer workflow focus
- Quiet hierarchy
- Dense but calm
- Functional surface design
- Native-app restraint, web accessibility

### Principles

1. Make information the subject.
   Use color, emphasis, and motion only where they communicate state, selection, change, warning, or action.

2. Build hierarchy with surfaces.
   Prefer background tone, spacing, border subtlety, radius, and text weight over heavy shadows or saturated color blocks.

3. Do not turn layout regions into cards.
   Sidebar bodies, main work areas, top summaries, and page sections should be unframed bands or plain surfaces. Use cards only for repeated content items, dialogs, popovers, and genuinely bounded tools.

4. Use muted semantic colors.
   Success, warning, danger, info, added, and removed states should avoid primary red/green. Use gray-mixed colors that remain comfortable during long work sessions.

5. Keep controls compact and predictable.
   Phantom is a repeated-use developer tool. Favor compact controls, familiar icons, clear labels, and stable layouts.

6. Preserve accessibility.
   Keyboard operation, visible focus rings, accessible names for icon buttons, and non-color state indicators are required.

## Tokens

Token names should describe purpose, not incidental appearance.

```text
--category-role-state
```

Examples:

```css
--surface-panel
--text-secondary
--diff-added-bg
--button-primary-bg
--state-hover-bg
```

Recommended prefixes:

| Category                  | Prefix                              |
| ------------------------- | ----------------------------------- |
| Color primitives          | `--color-*`                         |
| Surfaces                  | `--surface-*`                       |
| Text                      | `--text-*`                          |
| Borders                   | `--border-*`                        |
| Semantic states           | `--semantic-*`                      |
| Diff states               | `--diff-*`                          |
| Interaction states        | `--state-*`                         |
| Spacing                   | `--space-*`                         |
| Radius                    | `--radius-*`                        |
| Shadow                    | `--shadow-*`                        |
| Typography                | `--font-*`                          |
| Component-specific values | `--component-*` or component prefix |

## Color System

Primitive colors should not be used directly in components. Map them through semantic tokens or Tailwind theme variables.

```css
:root {
  --color-white: #fdfdfd;

  --color-gray-50: #f7f8fa;
  --color-gray-75: #f3f4f7;
  --color-gray-100: #f0f1f5;
  --color-gray-150: #edeef0;
  --color-gray-200: #e5e7ec;
  --color-gray-250: #dadde5;
  --color-gray-300: #c9ccd6;
  --color-gray-400: #aeb1bb;
  --color-gray-500: #8d909b;
  --color-gray-600: #747783;
  --color-gray-700: #565a66;
  --color-gray-800: #343844;
  --color-gray-900: #1f2330;

  --color-green-50: #e7f0ea;
  --color-green-100: #dde7df;
  --color-green-500: #2f7a4e;

  --color-rose-50: #f0e1e7;
  --color-rose-100: #e8d7df;
  --color-rose-500: #9b3f5a;

  --color-yellow-50: #f3ead2;
  --color-yellow-100: #eadcad;
  --color-yellow-600: #8a6a1d;

  --color-blue-50: #e4e9f7;
  --color-blue-100: #d8e0f3;
  --color-blue-600: #4d5f9e;
}
```

### Surface Tokens

```css
:root {
  --surface-window: #f0f1f5;
  --surface-sidebar: #edeef0;
  --surface-panel: #f3f4f7;
  --surface-card: #f7f8fa;
  --surface-code: #f1f2f6;
  --surface-input: #f3f4f7;
  --surface-floating: rgba(255, 255, 255, 0.72);
  --surface-overlay: rgba(31, 35, 48, 0.36);
}
```

| Token                | Use                                      |
| -------------------- | ---------------------------------------- |
| `--surface-window`   | Base app background                      |
| `--surface-sidebar`  | Sidebar and secondary navigation         |
| `--surface-panel`    | Main work area                           |
| `--surface-card`     | Repeated items, messages, bounded tools  |
| `--surface-code`     | Code, logs, diffs                        |
| `--surface-input`    | Inputs, search fields, command textareas |
| `--surface-floating` | Popovers, floating bars                  |
| `--surface-overlay`  | Dialog backdrop                          |

### Text Tokens

```css
:root {
  --text-primary: #2c303a;
  --text-secondary: #5f636f;
  --text-tertiary: #8a8e99;
  --text-muted: #a9adb6;
  --text-disabled: #c4c7cf;

  --text-link: #4d5f9e;
  --text-success: #2f7a4e;
  --text-danger: #9b3f5a;
  --text-warning: #8a6a1d;
}
```

Use `--text-primary` for project names, chat titles, command text, and key output. Use secondary and tertiary text for paths, metadata, branch names, timestamps, and supporting copy.

### Border Tokens

```css
:root {
  --border-subtle: #e0e2e8;
  --border-default: #d5d8e0;
  --border-strong: #c4c8d2;
  --border-focus: #aeb7d8;
  --border-divider: rgba(31, 35, 48, 0.08);
}
```

Border rules:

- Keep borders thin and low-saturation.
- Do not use borders where surface contrast is enough.
- Reserve stronger borders for focus, drag, resize, and selected states.

### Semantic Tokens

```css
:root {
  --semantic-success-bg: #e7f0ea;
  --semantic-success-fg: #2f7a4e;
  --semantic-success-border: #8ec7a2;

  --semantic-danger-bg: #f0e1e7;
  --semantic-danger-fg: #9b3f5a;
  --semantic-danger-border: #d18ba0;

  --semantic-warning-bg: #f3ead2;
  --semantic-warning-fg: #8a6a1d;
  --semantic-warning-border: #d7bc73;

  --semantic-info-bg: #e4e9f7;
  --semantic-info-fg: #4d5f9e;
  --semantic-info-border: #a8b7e0;
}
```

Use semantic tones for execution state, approval prompts, errors, completion, and warnings. Do not use them as general decoration.

### Diff Tokens

These are reserved for future Git diff, preview, or change summary surfaces.

```css
:root {
  --diff-added-bg: #dde7df;
  --diff-added-bg-soft: #e7f0ea;
  --diff-added-fg: #2f7a4e;
  --diff-added-border: #8ec7a2;

  --diff-removed-bg: #e8d7df;
  --diff-removed-bg-soft: #f0e1e7;
  --diff-removed-fg: #9b3f5a;
  --diff-removed-border: #d18ba0;

  --diff-hunk-bg: #e9e7f5;
  --diff-hunk-fg: #6b61a8;
  --diff-hunk-border: #c8c2ea;
}
```

Diff color rules:

| Type         | Treatment                                |
| ------------ | ---------------------------------------- |
| Added        | Muted green, also usable for completion  |
| Removed      | Rose gray, not aggressive red            |
| Context      | Lavender gray for supporting information |
| Line numbers | Tinted with the related state color      |

## Typography

```css
:root {
  --font-sans:
    -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue",
    sans-serif;
  --font-mono:
    "SF Mono", "Menlo", "Monaco", "Consolas", "Liberation Mono", monospace;

  --font-size-2xs: 10px;
  --font-size-xs: 11px;
  --font-size-sm: 12px;
  --font-size-md: 13px;
  --font-size-lg: 14px;
  --font-size-xl: 16px;
  --font-size-2xl: 20px;

  --line-height-tight: 1.25;
  --line-height-normal: 1.45;
  --line-height-relaxed: 1.6;

  --font-weight-regular: 400;
  --font-weight-medium: 500;
  --font-weight-semibold: 600;
  --font-weight-bold: 700;
}
```

| Token             | Size | Use                                  |
| ----------------- | ---: | ------------------------------------ |
| `--font-size-2xs` | 10px | Very small metadata                  |
| `--font-size-xs`  | 11px | Badges, timestamps, counts           |
| `--font-size-sm`  | 12px | Sidebar, buttons, tabs               |
| `--font-size-md`  | 13px | Body text, forms, lists              |
| `--font-size-lg`  | 14px | Section headings and emphasized body |
| `--font-size-xl`  | 16px | Page and chat titles                 |
| `--font-size-2xl` | 20px | Major headings when needed           |

Use monospace for code, command output, paths when full precision matters, and logs. Do not scale font size with viewport width.

## Spacing, Radius, and Elevation

### Spacing

```css
:root {
  --space-0: 0;
  --space-0_5: 2px;
  --space-1: 4px;
  --space-1_5: 6px;
  --space-2: 8px;
  --space-2_5: 10px;
  --space-3: 12px;
  --space-4: 16px;
  --space-5: 20px;
  --space-6: 24px;
  --space-8: 32px;
  --space-10: 40px;
  --space-12: 48px;
}
```

| Use                             | Recommended value |
| ------------------------------- | ----------------: |
| Icon and text gap               |               6px |
| Small button padding            |               8px |
| Sidebar item horizontal padding |       8px to 12px |
| Item and message padding        |      12px to 16px |
| Main panel padding              |              16px |
| Section gap                     |      24px to 32px |

### Radius

```css
:root {
  --radius-xs: 4px;
  --radius-sm: 6px;
  --radius-md: 8px;
  --radius-lg: 12px;
  --radius-xl: 16px;
  --radius-pill: 9999px;
}
```

Use 6px to 8px for compact controls and list items. Use 12px for dialogs, repeated items, and bounded tool surfaces. Avoid oversized rounding on dense tool surfaces.

Do not add radius to large app regions such as the whole sidebar, whole main area, page sections, or summary bands. Radius belongs on local controls, selected rows, messages, dialogs, and bounded tool surfaces.

### Shadow

```css
:root {
  --shadow-xs: 0 1px 2px rgba(31, 35, 48, 0.06);
  --shadow-sm: 0 2px 6px rgba(31, 35, 48, 0.08);
  --shadow-md: 0 8px 24px rgba(31, 35, 48, 0.12);
  --shadow-lg: 0 16px 48px rgba(31, 35, 48, 0.16);
}
```

Use shadows sparingly. Most app structure should come from surface contrast and dividers. Do not use shadows around the whole sidebar, main area, top summaries, or normal page sections. Reserve `--shadow-lg` for modal dialogs.

## Motion and Interaction States

```css
:root {
  --motion-duration-fast: 120ms;
  --motion-duration-normal: 180ms;
  --motion-duration-slow: 240ms;

  --motion-ease-standard: cubic-bezier(0.2, 0, 0, 1);
  --motion-ease-out: cubic-bezier(0, 0, 0.2, 1);
  --motion-ease-in: cubic-bezier(0.4, 0, 1, 1);

  --state-hover-bg: rgba(31, 35, 48, 0.05);
  --state-pressed-bg: rgba(31, 35, 48, 0.09);
  --state-selected-bg: rgba(31, 35, 48, 0.07);
  --state-focus-ring: 0 0 0 3px rgba(104, 116, 180, 0.22);

  --opacity-disabled: 0.42;
  --opacity-muted: 0.64;
}
```

Motion rules:

- Avoid large decorative animation.
- Use transitions for hover, focus, selection, and open/close states only.
- Prefer 120ms to 180ms. Dialogs and panels may use up to 240ms.
- Loading should use state text where possible; use spinners only when useful.

State rules:

| State    | Treatment                                    |
| -------- | -------------------------------------------- |
| Hover    | Add a subtle background overlay              |
| Pressed  | Slightly stronger overlay than hover         |
| Selected | Maintain a muted surface state               |
| Focus    | Always visible focus ring                    |
| Disabled | Pair opacity with disabled behavior and ARIA |

## Layout System

### Phantom Serve Shell

Phantom Serve should use an app-shell layout:

```text
+-------------------------------------------------------------+
| Sidebar: projects and worktrees | Main: chat, status, logs  |
|                                |                            |
|                                |                            |
|                                |                            |
+-------------------------------------------------------------+
| Optional command composer within the main panel             |
+-------------------------------------------------------------+
```

Recommended layout tokens:

```css
:root {
  --layout-sidebar-width: 320px;
  --layout-topbar-height: 56px;
  --layout-panel-min-width: 320px;
  --layout-max-content-width: 1200px;
}
```

Responsive rules:

| Breakpoint          | Rule                                                              |
| ------------------- | ----------------------------------------------------------------- |
| `< 640px`           | One column; sidebar becomes a drawer                              |
| `640px-1023px`      | Sidebar plus main content where space allows                      |
| `1024px+`           | Sidebar plus main content                                         |
| Future wide screens | Add optional detail or diff panel only when the workflow needs it |

## Component Guidelines

### Surface and Card Usage

Cards are not the default layout primitive in Phantom.

Rules:

- Do not wrap major regions in cards: sidebar content, main content, top summaries, page sections, and composer areas should not have enclosing border + radius + shadow treatments.
- Prefer unframed surfaces, horizontal dividers, selected row backgrounds, and subtle density changes for hierarchy.
- Use cards only for repeated content items, message bubbles, dialogs, popovers, and explicitly bounded tool surfaces.
- Avoid card grids and persistent bands for summary information. Keep current context in the top bar unless an action-specific state requires a temporary banner.
- Do not nest cards inside cards.

### Button

Use buttons for primary actions, secondary actions, destructive actions, and icon-only controls.

Rules:

- Use a single primary action per local context.
- Use ghost buttons in sidebars and toolbars.
- Icon buttons must use `aria-label` and `title` when helpful.
- Prefer lucide-react icons for actions.

### Input and Textarea

Use inputs for paths, settings, and short names. Use textarea for chat or command composition.

Rules:

- Placeholder text should be useful but not required for understanding.
- Preserve visible labels in dialogs and settings forms.
- Keep command/chat input stable in height; dynamic content should not shift the layout unexpectedly.

### Sidebar

The sidebar is for project and worktree navigation.

Rules:

- Project items should be simple and scan-friendly.
- Sidebar items should be single-line by default.
- Show project and worktree names as primary text; avoid counts, status descriptions, branch names, or full paths unless the user needs disambiguation.
- Nest worktree/chat items under their project.
- Project creation belongs in the Projects group action.
- Worktree/chat creation belongs near the related project item.
- Collapsing the sidebar should fully hide it instead of leaving an icon rail, so the main panel can use the recovered space.
- Keep the top-bar sidebar trigger accessible for reopening the sidebar.

### Agent Chat Panel

The main panel is for user instructions, assistant responses, approvals, and errors. Internal execution events may exist in the data model, but they are not primary user-facing chat content.

Rules:

- User messages may use the strongest surface.
- Assistant output should be calmer and easy to scan.
- Message bubbles should contain only the message body. Do not show speaker labels, avatars, timestamps, message IDs, item IDs, or raw transport identifiers in the primary chat timeline.
- Do not show internal lifecycle or debug records such as `item/started`, `item/completed`, and `turn/completed` in the main chat timeline by default.
- Put raw logs and event streams in a dedicated diagnostics surface only when the workflow explicitly needs them.
- Error and approval states should use semantic tones and clear labels.
- Do not rely on color alone to communicate status.

### Dialog

Use dialogs for project creation, settings, approvals requiring structured input, and destructive confirmations.

Rules:

- Dialogs must have a title.
- Keep body text brief and task-specific.
- Primary action goes on the right.
- Destructive actions require clear labeling and semantic danger styling.

### Badge and Status

Use badges for concise state: ready, running, waiting for approval, failed, archived, count, or branch metadata.

Rules:

- Keep badge text short.
- Use semantic tones only when the state needs attention.
- Do not use badges as decoration.

### Diff and Code Surfaces

Future diff or preview views should use the diff tokens above.

Rules:

- Use monospace text.
- Use symbols, labels, or line prefixes in addition to color.
- Allow horizontal scrolling for code.
- Keep line height compact but readable.

## Iconography

```css
:root {
  --icon-size-xs: 12px;
  --icon-size-sm: 14px;
  --icon-size-md: 16px;
  --icon-size-lg: 20px;

  --icon-color-default: #747783;
  --icon-color-muted: #a9adb6;
  --icon-color-active: #343844;
}
```

Icon rules:

- Use lucide-react where possible.
- Keep stroke icons small and light.
- Do not depend on icons alone when the action is unfamiliar.
- Icon buttons require accessible names.
- Avoid custom SVG icons unless the icon library lacks the concept.

## Accessibility

Requirements:

- Every interactive element must be reachable by keyboard.
- Focus rings must be visible.
- Icon buttons require accessible names.
- Do not communicate status with color alone.
- Use `aria-live` or `role="status"` for important asynchronous state changes.
- Dialogs must expose title and close behavior.
- Disabled controls must use native `disabled` where possible.

ARIA examples:

```html
<button aria-label="Create worktree">
  <svg aria-hidden="true"></svg>
</button>

<nav aria-label="Projects and worktrees">
  <button aria-current="page">feature-auth</button>
</nav>

<div role="status" aria-live="polite">Running command</div>
```

## Theming

Light theme is the default. It should use neutral gray surfaces and muted text hierarchy.

Dark theme, when implemented, should not be a pure inversion. Preserve the same low-saturation hierarchy and avoid high-contrast neon accents.

## Implementation Notes

Phantom's app package currently uses Tailwind CSS and local shadcn-style components under `packages/app/src/components/ui`.

Implementation rules:

- Prefer existing local UI components before adding new ones.
- Map design tokens into `packages/app/src/styles.css` and Tailwind theme variables.
- Keep tokens centralized; do not hard-code one-off colors across components.
- Use lucide-react icons for buttons and sidebar actions.
- Keep UI text in English.
- Keep file paths visible only when they are needed for task context or disambiguation.

## Usage Guidelines

### Do

- Use pale gray backgrounds instead of pure white.
- Use unframed bands and dividers for app layout.
- Keep secondary actions low contrast.
- Use semantic color only for meaningful states.
- Keep dense layouts readable with consistent line height and spacing.
- Always show focus states.
- Use monospace for code, command output, and path-heavy details.
- Pair color with symbols or labels for diff and status views.

### Do Not

- Spread brand color across the product UI.
- Use card shells around major app regions.
- Use card grids for routine summaries.
- Add persistent summary bands above the chat when the top bar already carries the active context.
- Expose debug lifecycle events in the primary chat timeline.
- Use heavy shadows for normal panels.
- Use primary red or green over large areas.
- Over-emphasize every button.
- Remove focus styles.
- Add decorative gradients or abstract background elements.
- Show long filesystem paths in navigation unless they are necessary.

## Governance

Before adding a token, check whether an existing token expresses the same purpose.

Add a token only when:

- The value is reused across multiple components.
- The purpose is independently meaningful.
- The value needs theme-specific replacement.
- The token names a stable component dimension or state.

Do not add a token when:

- It is used once.
- It renames an existing token without adding meaning.
- It only supports a one-off visual tweak.
- Its name does not explain usage.

When adding a component, document:

- Purpose
- Anatomy
- Variants
- States
- Accessibility
- Tokens
- Examples
- Do and do not rules

## Review Checklist

- [ ] Semantic color is limited to meaningful states.
- [ ] Major app regions are not enclosed in card shells.
- [ ] Cards are limited to repeated items, dialogs, popovers, or bounded tools.
- [ ] Text hierarchy uses primary, secondary, tertiary, and muted levels.
- [ ] Spacing follows the spacing scale.
- [ ] Radius follows the radius scale.
- [ ] Focus states are visible.
- [ ] Keyboard interaction works.
- [ ] Status is not communicated by color alone.
- [ ] Sidebar navigation remains scannable.
- [ ] Mobile and narrow layouts do not overlap.
- [ ] Dark theme, if touched, preserves the same hierarchy.

## Summary

Phantom's design system is a quiet, dense, developer-focused UI foundation.

The central rule is:

> Use a pale neutral workspace, and reserve muted semantic color for state, change, and execution results.

This keeps Phantom useful for long-running worktree management, AI agent workflows, command execution, and future Git review surfaces without making the interface itself compete for attention.
