# Changelog

All notable changes to PoliteDB are listed here, newest first.

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
