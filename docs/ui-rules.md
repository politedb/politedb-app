# UI Rules

PoliteDB is a work-focused desktop database client. The UI should feel dense, predictable, and fast for repeated daily use.

## Product Feel

- Prefer quiet, utilitarian interfaces over marketing-style layouts.
- Optimize for scanning, comparison, keyboard use, and repeated actions.
- Keep primary database work visible: connection navigation, SQL editor, results, table data, schema metadata, and pending changes.
- Avoid decorative UI that competes with data tables, editors, and status feedback.

## Layout

- Use stable dimensions for panels, toolbars, table rows, tabs, icon buttons, counters, and fixed-format controls.
- Do not let hover states, loading labels, badges, or dynamic text resize the surrounding layout.
- Avoid nesting cards inside cards. Use cards only for repeated items, dialogs, and genuinely framed tools.
- Prefer split panes, sidebars, tabs, toolbars, drawers, and dialogs for app workflows.
- Make empty, loading, error, and permission states compact but actionable.

## Components

- Reuse components from `src/components/common/` before creating new primitives.
- Use icons for clear tool actions such as refresh, save, search, close, edit, delete, import, export, and navigation.
- Use text buttons for commands that need explicit wording or carry risk.
- Use menus for option sets, tabs for peer views, toggles or checkboxes for binary settings, and inputs/sliders/steppers for numeric values.
- Use tooltips for icon-only actions whose meaning may not be obvious.

## Tables And Editors

- Keep table controls close to the table they affect.
- Preserve row identity and pending-change visibility in editing flows.
- Destructive table actions must remain clearly labeled and require the existing confirmation flow.
- SQL editor controls should not obscure the editor, results, or execution status.
- Loading large datasets should show progress or a clear busy state without blocking unrelated navigation where possible.

## Copy

- Use short, specific labels.
- Error messages should state what failed and what the user can do next.
- Avoid visible instructional text that explains obvious UI mechanics.
- Avoid exposing internal implementation details unless they help diagnose a developer-facing database issue.
- Never display secrets, tokens, passwords, or full connection strings.

## Visual Style

- Keep type sizes appropriate to dense desktop UI. Reserve large headings for top-level screens or empty states.
- Avoid one-note color palettes and decorative gradients.
- Use color to communicate state: success, warning, danger, selection, focus, and disabled.
- Keep contrast high enough for long SQL and data-table sessions.
- Do not rely on color alone to communicate destructive or disabled states.

## Accessibility And Interaction

- Preserve keyboard navigation for editor, dialogs, menus, tabs, and common actions.
- Maintain visible focus states.
- Keep click targets large enough for toolbar and table actions.
- Dialogs should trap focus, close predictably, and avoid losing unsaved user input.
- Do not introduce pointer-only workflows for critical actions.

## Review Checklist

- The affected screen works at common desktop sizes.
- Text does not overflow buttons, tabs, table cells, or dialog footers.
- Loading, empty, error, disabled, and destructive states are handled.
- Icon-only controls have accessible names or tooltips.
- No sensitive database or profile data is shown unnecessarily.
