# AI Agent — Live Smoke Checklist (R7 gate)

Plan: `.agent/plans/ai-agent.md` (R7.3 gate: live smoke with OpenAI, Anthropic Opus 5.5, Gemini and Ollama, plus the native approval prompt). Branch `feat/ai-agent` @ `6a1d8db` or later.

Run it on a **desktop build**, not the browser dev server:
- `npm run tauri:dev`, or
- a signed `npx tauri build --bundles app`.

Use **throwaway databases only**. Record results in the table at the end, and send it back so it can be added to the plan as gate evidence.

---

## 0. Setup (once)

### 0.1 Throwaway PostgreSQL (separate from your dev containers)

```bash
docker run -d --name politedb-smoke-pg -e POSTGRES_PASSWORD=smoke -p 55432:5432 postgres:16
```

```bash
docker exec -i politedb-smoke-pg psql -U postgres <<'SQL'
CREATE TABLE customers (id serial PRIMARY KEY, name text NOT NULL, country text, created_at timestamptz DEFAULT now());
CREATE TABLE orders (id serial PRIMARY KEY, customer_id int REFERENCES customers(id), total numeric(10,2), status text, created_at timestamptz DEFAULT now());
CREATE INDEX orders_customer_idx ON orders (customer_id);
INSERT INTO customers (name, country) SELECT 'Customer ' || g, (ARRAY['VN','US','JP'])[1 + g % 3] FROM generate_series(1, 50) g;
INSERT INTO orders (customer_id, total, status) SELECT 1 + g % 50, (g * 7.5)::numeric(10,2), (ARRAY['paid','pending','refunded'])[1 + g % 3] FROM generate_series(1, 300) g;
SQL
```

### 0.2 Throwaway SQLite file

```bash
sqlite3 /tmp/politedb-smoke.db "CREATE TABLE notes (id INTEGER PRIMARY KEY, title TEXT, body TEXT); INSERT INTO notes (title, body) VALUES ('a','first'),('b','second'),('c','third');"
```

### 0.3 In PoliteDB

1. Save two connections:
   - **Smoke PG**: host `127.0.0.1`, port `55432`, user `postgres`, password `smoke`.
   - **Smoke SQLite**: file `/tmp/politedb-smoke.db`.
2. AI settings: add the four providers. Each provider must be enabled with the model below:
   - OpenAI: a current tool-capable model, e.g. a GPT-5 family model.
   - Anthropic: **Claude Opus 5.5** (`claude-opus-5-5`).
   - Gemini: a current Gemini model.
   - Ollama: `http://127.0.0.1:11434` with a tool-capable model (e.g. `qwen3`, `llama3.1`). Pull it first with `ollama pull <model>`.
3. AI settings: turn on **AI agent (beta)**.

---

## 1. Per-provider smoke (repeat for each of the 4 providers)

Select the provider in the assistant panel. Use the **Smoke PG** tab in **Default mode** (toolbar → Safety mode).

| # | Action | Expected |
| --- | --- | --- |
| 1.1 | Ask: *"What tables are in this database and how are they related?"* | While it runs, the bubble shows activity lines ("Listing tables…", "Looking at a table's structure…"). The answer is formatted Markdown (bold, lists, `code`), not one block. It mentions `customers`, `orders`, and the `customer_id` foreign key. A "Checked the database (N steps)" summary appears. **No** consent card (metadata only). |
| 1.2 | Ask: *"How many orders are paid vs pending vs refunded?"* | First time per provider: the consent card **"Allow AI to read data from Smoke PG?"** appears with **Allow / Not now**. |
| 1.3 | Click **Not now** | No data tool runs. The answer says it could not read data, or offers SQL instead. Nothing is sent from the table. |
| 1.4 | Ask 1.2 again, click **Allow** | The card shows "Allowed.", the question re-runs, activity shows "Running a read-only query…", and the answer gives counts (100 / 100 / 100). |
| 1.5 | Follow-up: *"Which country spends the most?"* | Uses history and runs a read-only query. The answer is consistent with the data (VN/US/JP totals). |
| 1.6 | Ask: *"Delete all refunded orders."* | The agent does **not** execute anything. At most it proposes SQL in the usual preview (Run/Insert), with a write/danger label. Check: `SELECT count(*) FROM orders` is still 300. |
| 1.7 | Ask: *"Explain the query plan for orders of customer 7."* | "Checking a query plan…", and the answer mentions the index or a seq scan. No `ANALYZE` is executed. |
| 1.8 | Click **Cancel/Stop** while 1.5 is running (ask again and stop quickly) | The run stops. No answer text is overwritten later. You can ask again normally afterwards. |
| 1.9 | Repeat 1.1 and 1.4 on the **Smoke SQLite** tab | Same behavior. The SQLite file is unchanged (`sqlite3 /tmp/politedb-smoke.db "select count(*) from notes"` → 3). |

Notes per provider:
- Ollama is local: confirm it still asks for consent (the plan has no loopback default).
- If a provider answers "agent not supported" or falls back to the old assistant, record it with the exact model name.

---

## 2. Native approval (Touch ID / password), once (any provider)

| # | Action | Expected |
| --- | --- | --- |
| 2.1 | Set **Smoke PG** tab to **Safe mode**. Ask a data question (e.g. 1.2). | A macOS Touch ID / password prompt appears **before** the query runs. The reason text names the connection and shows the start of the SQL. |
| 2.2 | **Approve** | The query runs and the answer appears. |
| 2.3 | Ask again and **Cancel** the prompt | No query runs. The agent reports that approval was declined. The app stays responsive. |
| 2.4 | Ask again and **ignore** the prompt for ~30 s | The prompt closes by itself (timeout). Same as cancel. |
| 2.5 | **Production mode**: repeat 2.1–2.2 | Same as Safe mode. |
| 2.6 | **Lock mode**: ask a data question | No data tools and no prompt. Metadata answers still work. |

---

## 3. Consent management

| # | Action | Expected |
| --- | --- | --- |
| 3.1 | AI settings → **Data access** list | One grant per (connection, provider) you allowed. |
| 3.2 | **Revoke** Smoke PG for one provider | The grant disappears. A running agent on that connection is cancelled. Chats in that connection that contained data are removed. |
| 3.3 | Ask a data question again with that provider | The consent card appears again. |
| 3.4 | Edit the **Smoke PG** profile (e.g. change port and back), then ask a data question | Consent is required again (target changed), or you are asked to reconnect. |

---

## 4. Cleanup

```bash
docker rm -f politedb-smoke-pg
```

```bash
rm -f /tmp/politedb-smoke.db
```

In PoliteDB: delete the two smoke connections, and revoke their remaining grants in **Data access**.

---

## Results

| Step | OpenAI | Anthropic Opus 5.5 | Gemini | Ollama | Notes |
| --- | --- | --- | --- | --- | --- |
| Model used | | | | | |
| 1.1 metadata | | | | | |
| 1.2–1.4 consent + data | | | | | |
| 1.5 follow-up | | | | | |
| 1.6 no write | | | | | |
| 1.7 explain | | | | | |
| 1.8 cancel | | | | | |
| 1.9 SQLite | | | | | |

| Step | Result | Notes |
| --- | --- | --- |
| 2.1–2.2 Safe approve | | |
| 2.3 cancel | | |
| 2.4 timeout | | |
| 2.5 Production | | |
| 2.6 Lock | | |
| 3.1–3.4 consent mgmt | | |

Mark each cell ✅ / ❌ / ⚠️. For any ❌ or ⚠️, note the exact message shown. Do **not** paste API keys, connection passwords or query results containing real data.
