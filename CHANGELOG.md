# Changelog

All notable changes to PoliteDB are listed here, newest first.

## v1.7.0 - 2026-10-26

### Highlights

- **Safer saving and importing.** Row edits and deletes now always land on the row you changed, even after paging, sorting or filtering. The save dialog shows exactly what will run. CSV and SQL dump import now work from the sidebar without opening the table.
- **A smarter query analyzer and health inspector (Pro).** The analyzer can measure real PostgreSQL plans, ranks its findings by severity, and now reads plans from MySQL 9, MariaDB, DuckDB and SQL Server. The health inspector checks server health and can cancel a query or end a session.
- **A much better SQL editor and table grid.** Scripts run in order, errors are underlined where they happen, autocomplete is more reliable, and the data grid supports spreadsheet-style keyboard editing.
- **Easier navigation.** The sidebar has clearable search, section counts and full keyboard navigation. Open function, procedure and trigger editors keep their unsaved work when you close their tabs.

### New

- **Import from the sidebar.** "Import as CSV" and SQL dump import on a table no longer open the table first.
  - A table that is open or has unsaved row edits still goes through its tab, which asks about the edits first.
  - Lock mode is checked again right before anything runs.
- **Clearer CSV import.**
  - The separator (comma, semicolon, tab or pipe) is detected and can be changed. .tsv and .txt files can be chosen.
  - The preview shows what will land in the table: one column per table column, in table order.
  - Problems are grouped by column, with an example value for each. Required columns left on Skip block the import with a warning.
  - While the import runs you see a compact progress view. Failures show only the error, with Back and Close.
- **Better save review dialog.**
  - Statements that destroy data (DROP TABLE, TRUNCATE, DROP COLUMN) are shown in red, with a "Cannot be undone" summary.
  - Long statements expand with Show all / Show less, and Copy all copies every statement.
  - Row changes are grouped by table, and NULL, empty text and missing values are told apart.
  - Cmd/Ctrl+Enter saves. Focus starts on Cancel when the save cannot be undone.
- **Query analyzer (Pro).**
  - On PostgreSQL, Explain measures the real plan for SELECT-type statements, and "Run with ANALYZE" is offered on estimated plans. The statement runs in a read-only transaction that is rolled back.
  - Findings are ranked High, Medium or Low, with new checks such as heavy nested loops, JIT overhead and temporary files.
  - A selective sequential scan can offer a copy-only CREATE INDEX template.
- **Health inspector (Pro).**
  - New server health checks: transaction ID age, client connections against available slots, cache hit ratio and replication lag. A summary strip at the top shows "All clear" or the number of issues.
  - On PostgreSQL, the Sessions list has Cancel query and Terminate session, each behind a confirmation that names the session. PoliteDB's own sessions are marked "This app" and are never targeted.
- **SQL editor.**
  - Errors are underlined in the editor where the database says they occurred, and error messages have a Copy button.
  - A summary line shows the rows returned and how long the statement took. You can export the loaded rows to CSV or JSON.
  - Every statement of a run gets its own "Query n" tab in a single tab row.
  - Cmd/Ctrl+Shift+Enter runs all statements.
- **Table grid keyboard editing.**
  - Type on a selected cell to start editing. Enter or Tab saves and moves to the next cell.
  - Home, End, Cmd/Ctrl+Arrow, PageUp and PageDown move the selection.
  - Sorting by a column header cycles ascending, descending, then off.
  - First and Last page buttons were added, and the Filters button shows how many conditions apply.
- **Sidebar.**
  - Search has a clear button and Escape clears it. Section headers show counts, such as "Tables 42".
  - Up, Down, Home, End, Left and Right navigate, and Shift+F10 or the Menu key opens a row's menu.
  - The table menu adds Copy qualified name and Copy SELECT.
  - Tables load 100 at a time as you scroll.
- **Object drafts survive closing tabs.** Function, procedure and trigger editors keep unsaved work, and the sidebar lists new-object drafts.
- **Table structure editor.**
  - Readable column headers, and the Constraints tab is now called Indexes.
  - A table that cannot be edited, such as on a locked connection, shows a banner saying why.
  - The index column picker allows several columns.
  - A renamed table shows "Renamed on save" with an undo button.
  - Structure still loads when the data query fails, for example because of a bad filter.
- **Keychain page.**
  - Cards are named after what the key belongs to, with a kind badge such as PostgreSQL, SSH or AI key, an engine icon and a detail line.
  - Keys are grouped into AI providers, Database connections, SSH, Other keys and Unused. A "Delete unused" button removes unused keys after confirmation.
- **Connection tags and form.** The tag field is a dropdown with "Create Tag" and suggestions. New connections start with Database and User empty.
- **History page.**
  - Failed sessions show their error, with Retry and Copy error.
  - Open sessions have their own status.
  - Sessions are grouped by day and can be filtered by status or connection.
- **Settings shortcut and layout.** Cmd+, (Ctrl+, on Windows and Linux) opens Settings from any screen. Appearance, License and Keyboard shortcuts pages are clearer. Theme is picked from System, Light and Dark preview tiles.
- **Drag the AI assistant button anywhere.** You can also move it with Alt+arrow keys. The position is remembered on each device.

### Changed

- **AI chat.**
  - The chat list groups chats under Today, Yesterday or the date.
  - The prompt grows with its text and stays editable while an answer runs.
  - The @ context menu works with the keyboard.
  - "Share" is now "Copy chat". Deleting a chat asks for confirmation.
- **AI provider settings.**
  - The list shows each provider as On, Off or Not set up, with a Default chip.
  - A saved key shows as "Saved in the OS keychain" with Replace.
  - Closing or switching provider with unsaved edits asks "Discard changes?".
  - Gemini and Anthropic model lists are loaded from the provider.
  - The default Gemini model is now gemini-flash-latest. Providers you already saved keep their models.
- **License page.** It names your plan and shows a shortened key. Deactivate now asks first.
- **Home screen.** It keeps your search, sort, grid or list view, selected group, History filters and scroll position after you visit a connection.
- **Table paging.** Next stays available while a page is full, even past an estimated row total. Exact counts are offered only for estimated totals, with a note that counting reads the whole table.
- **Health inspector speed.** Sections load progressively, and inspector queries run read-only with short lock and time limits.
- **Query analyzer.** Copy buttons have clearer labels and announce "Copied".
- **PostgreSQL connections are named.** Connections from PoliteDB now show the application name "PoliteDB/…" in `pg_stat_activity` and server logs.

### Fixed

- **Edits saved to the wrong row.** Unsaved row edits and deletes were tracked by their position on the page. Paging, sorting, filtering or reloading before saving could update or delete a different row. Saves now target the row you edited, and a change is refused if another row has taken its place.
- **CSV export rows running together.** In large exports, the last row of one batch ran into the first row of the next, for example rows 50 and 99, so the file could not be imported back. Every batch now starts on a new line. Re-export large CSV files made with earlier versions.
- **CSV import problems.**
  - Semicolon-separated files previewed correctly but were imported split on commas.
  - Database-style dates and times, such as long fractions of a second or "+07" zones, were wrongly rejected on macOS.
  - Header names now match columns ignoring case and surrounding spaces.
- **Import and save errors on PostgreSQL.** Failed statements in CSV import and in saves showed only "db error". They now show the database's own message, with its Detail and Hint lines.
- **Structure changes generating wrong SQL.**
  - Choosing NOT NULL generated DROP NOT NULL, new columns and new tables ignored NOT NULL, and Unique "false" still created a unique index.
  - Changing a primary key on MySQL and MariaDB did not drop the old key. The key is now replaced in one statement. ClickHouse refuses primary key changes.
  - An index with no columns now fails with a clear message instead of being skipped.
- **Save dialog.**
  - A retry can no longer overlap a save still running.
  - A save that wrote everything but failed on a later step now says "Your changes were saved, but a later step failed."
- **SQL editor.**
  - Scripts whose statements depend on each other now run in order.
  - Long queries are no longer cut off after 65 seconds of status tracking, and a run can no longer get stuck.
  - Autocomplete inserted "public.public.addresses" after "public.". Schemas, aliases, multi-table FROM and MySQL/SQLite columns now complete correctly.
- **Empty pages.** A page with no rows, past a low estimated total, showed blank rows and no empty message.
- **Query analyzer plans.**
  - SQL Server Explain always failed.
  - MySQL 9, MariaDB and DuckDB plans were misread.
- **AI.**
  - Gemini errors showed only "404 Not Found".
  - Numbered lists with ten or more items lost the first digit, so "10." showed as "0.".
  - Pressing Enter to confirm text in an input method (Vietnamese, Japanese and others) sent a half-typed question.
  - Several SQL blocks in one answer now keep their own Run and Insert state.
- **Sidebar and tabs.** In MongoDB and Redis, clicking the Collections or Keys title did nothing. The MongoDB database selector showed the first database instead of the tab's own.

### Security and credentials

- **Less error detail in analytics.** If you have detailed analytics on, connection and query errors used to send the first 160 characters of the error text, which could include host names, user names, table names or row values. Only a fixed category such as "timeout" or "auth_failed" is sent now. Statement types report only a known keyword, never leading comments.
- **Clearer privacy page.** Privacy & Analytics lists what is always sent (a random install ID, never email or license key) and what is never included.

## v1.6.0 - 2026-10-20

### Highlights

- **AI agent.** The AI assistant can now look up your schema and run read-only queries before it answers, instead of relying only on what you paste in. Agent mode is a PoliteDB Pro feature. Basic AI chat stays free.
- **PoliteDB Pro.** Pro unlocks the AI agent, the visual query analyzer, the database health inspector, ER diagram export to SVG, and column masking on export. Everything else stays free, including database backup and restore. Pro is available with a license key or a free trial.
- **Cleaner ER diagrams.** Relation lines now route around tables instead of running across them, on the canvas and in exports.

### New

- **AI agent mode (Pro).**
  - The agent looks up schemas, tables and columns on PostgreSQL, MySQL, MariaDB and SQLite.
  - It can read data on PostgreSQL and SQLite through read-only queries, but only after you allow it for that saved connection. In safe and production modes you approve the exact SQL before it runs.
  - It never writes data.
  - While it works, the chat shows what it is doing, for example "Listing tables..." or "Running a read-only query...".
  - It works with OpenAI, Anthropic, Gemini, Groq and Ollama.
- **Agent / Manual mode picker.** A picker at the bottom left of the AI composer switches between Agent (looks up your schema and runs read-only queries) and Manual (answers from the chat and the context you attach). Manual is free. Your choice is remembered on each device.
- **AI answers render as formatted text.** Headings, lists, quotes, code blocks, bold and italic now display properly. Links show their text and domain only, and are not clickable.
- **Native Ollama support for the agent.** The agent uses Ollama's native API with a real context size. AI settings has a new per-provider context size setting (2048 to 262144, default 16384) and an Ollama status line. This needs Ollama 0.12.6 or newer; older versions show a prompt to update.
- **ER diagram export to SVG (Pro).** PNG and Mermaid export remain free. PNG and SVG now share one "Export as..." menu.
- **Drop and truncate from the object tree.** Drop... and Truncate... no longer open the table first.
  - Drop asks with a native confirmation, then closes every open view of that table.
  - Truncate opens its dialog right away, with the Cascade and Restart identity options.
  - Lock mode still blocks both. Drop database keeps its typed-name confirmation.
- **Keychain card menu on right-click.** Right-click anywhere on a keychain card to open its menu (Edit, Copy name, Delete), like connection cards. Shift+F10 and the ContextMenu key also work.
- **Subscription dates in the license panel.** Settings > License key and the License dialog now show your subscription status and date, such as Renews on, Ends on, Pauses on, Past due or Ended. When this information isn't available, you see "Renews with your subscription".
- **Easier lost-key recovery.** "Lost license key?" now opens the Polar customer portal, where you sign in with your purchase email to see your keys. The Mac App Store build keeps the email-support instructions.
- **Native Pro upgrade prompt.** Using a Pro feature without Pro now shows a short native dialog with Enter license key, See Pro pricing (where purchase links are allowed) and Cancel.

### Changed

- **ER diagram layout.** Lines run only through the space between tables and cross a column through the gap between two tables. Relations from the same key share one line and then branch off to each table. The SVG and PNG exports use the same layout as the canvas.
- **The free trial is now recorded by the license server.** Deleting local files no longer restarts it. New installs are on the Free plan until the server confirms the trial. A trial already running in an older build keeps its remaining days, and a used-up trial stays used up. The License screens show days left, an ended trial, or an offline note. The account menu shows "Pro trial" while a trial runs.
- **Pro gating.** The visual query analyzer and the health inspector need Pro or a trial. Raw EXPLAIN, database backup and restore, and table-level SQL dump import stay free.
- **Column masking is now opt-in on export.** The export dialog is a plain column picker by default. Turn on "Mask sensitive columns" (Pro) to see the treatment and preview columns. Turning it off resets every column to Keep.
- **Mac App Store build:** Pro features are not locked there.
- **Interface polish.**
  - Dialogs have a consistent header with an icon.
  - Settings is now "General settings", and the license key field shows the whole key format.
  - Chat history scrolls under a fixed header.
  - The Agent / Manual picker is a rounded pill.
  - License Refresh buttons show a spinner.
  - Reloading the model list in AI settings is a small refresh icon.

### Fixed

- **ER diagram lines over tables.** Relation lines could cross table cards, especially in exported SVGs of large schemas. In the macOS app, lines could also be cut off partway down the canvas, and the diagram could stutter while you hovered a table.
- **Settings lost after upgrading from 1.4.** The 1.5 identifier change left your settings, connection groups, pinned connections, shortcuts, AI chats and analytics choice behind. They are now restored once, on first launch, and values you set since 1.5 are kept. This applies to macOS, Windows and Linux.
- **Pro licenses were treated as the free AI tier.** After the plan was renamed from Ultimate to Pro, Pro licenses were not recognised as the paid AI tier. This is fixed.
- **Ollama "thinking" models** such as qwen3 could fail on short prompts such as a greeting, because the reasoning used up the whole answer budget. They now get enough room.
- **AI answers.** Very long or oddly formatted answers could freeze the app while rendering, and a late progress update could overwrite a finished answer. Both are fixed.
- **Dark mode:** the Pro banners, the agent upgrade hint and the trial note no longer stay light in the dark theme.
- **Mode picker and checkboxes.** The mode picker now works with the keyboard and screen readers. Checkboxes no longer stay ticked when a change is refused, for example by a Pro gate.

### Security and credentials

- Saved connection credentials are now stored in the system keychain under the "PoliteDB" service. Existing credentials are moved automatically the first time they are read, and nothing needs re-entering.
