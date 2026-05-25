# Performance

PoliteDB needs to stay responsive while users browse large schemas, edit tables, run SQL, import/export data, and manage local desktop resources.

## Frontend Principles

- Keep render work proportional to what is visible.
- Avoid storing large result sets in multiple duplicated frontend structures.
- Memoize expensive derived data only when it prevents real repeated work.
- Keep global state narrow. Do not put high-churn editor, hover, selection, or progress details into broad stores unless multiple distant consumers need them.
- Avoid synchronous work on the main thread for parsing, formatting, filtering, or transforming large datasets.

## Tables And Results

- Paginate, window, or otherwise constrain large table/result rendering.
- Keep row identity stable across paging, sorting, filtering, and editing.
- Avoid rebuilding every row object when only one row or cell changes.
- Keep pending edits separate from original row data so save/review flows can diff efficiently.
- Show progress for long-running reads, imports, exports, and backups.

## SQL Editor

- Avoid reinitializing Monaco unless the editor mode, theme, or model genuinely changes.
- Keep SQL formatting, metadata extraction, and completion work scoped to the active editor/model.
- Debounce expensive completion, metadata, or validation work.
- Do not block typing on backend calls.

## Tauri Boundary

- Send compact payloads across the frontend/Rust boundary.
- Prefer streaming, paging, or operation IDs for large or long-running work.
- Do not repeatedly call Tauri commands from render paths.
- Keep command payloads free of redundant large data when an identifier or cursor is enough.
- Use emitted events intentionally; unsubscribe listeners when components unmount.

## Rust Backend

- Keep blocking database and filesystem work off UI-sensitive paths.
- Preserve cancellation support for long-running database operations.
- Use pooled or reused resources where the existing engine/tunnel/profile architecture supports it.
- Avoid cloning large result buffers or profile structures unnecessarily.
- Keep SSH tunnels, connections, and operation handles scoped and cleaned up.

## Startup And App Responsiveness

- Defer non-critical work until after the initial screen is usable.
- Avoid loading optional AI runtime resources during normal startup unless explicitly needed.
- Keep profile migration, updater checks, analytics setup, and license checks from blocking first paint where possible.
- Cache stable metadata carefully and invalidate it when connections, schema, or table structure changes.

## Logging And Telemetry Cost

- Keep logs useful but bounded in hot paths.
- Never log raw SQL, secrets, connection strings, or sensitive identifiers.
- Avoid high-frequency telemetry events for editor keystrokes, table cell focus, hover state, or result rendering.
- Batch or summarize events when tracking repeated actions.

## Verification Checklist

- Run `npm run build` after frontend changes.
- Run relevant Vitest tests with `npm run test:run` or a narrower test target.
- For Rust changes, run the relevant checks/tests from `src-tauri/`.
- Manually inspect flows that touch large tables, SQL results, import/export, SSH tunnels, updater, or AI runtime.
- Compare before/after behavior when a change touches rendering loops, table diffing, command payloads, or backend operation dispatch.

## Common Performance Smells

- A component rerenders the whole screen for one cell edit.
- Large query results are copied into several state containers.
- A Tauri command runs from a render path or unguarded effect.
- Monaco is recreated when only content changes.
- Long-running backend work has no cancellation or progress path.
- Logging or telemetry runs for every row, cell, or keystroke.
