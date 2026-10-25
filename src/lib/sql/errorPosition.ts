/**
 * Where a query error points inside its statement, read from the
 * `LINE n: <text>` + caret lines the backend appends (Postgres style; the
 * caret's indent counts characters of that line). The column is in UTF-16
 * code units, like string indexes. Null when absent.
 */
export function parseSqlErrorPosition(
  error: string | undefined
): { line: number; column: number } | null {
  if (!error) return null;
  const lines = error.split("\n");
  for (let i = 0; i < lines.length - 1; i++) {
    const head = /^LINE (\d+): (.*)$/.exec(lines[i]!);
    const caret = /^( *)\^\s*$/.exec(lines[i + 1]!);
    if (!head || !caret) continue;
    const line = Number(head[1]);
    const text = head[2] ?? "";
    const caretChars = caret[1]!.length;
    // Characters (code points) before the caret -> string column (1-based).
    let chars = 0;
    let column = 1;
    for (const ch of text) {
      if (chars >= caretChars) break;
      chars += 1;
      column += ch.length;
    }
    if (!Number.isFinite(line) || line < 1) return null;
    return { line, column };
  }
  return null;
}

/**
 * The [start, end) character range in `statement` an error at `line`/`column`
 * points at: the word there (identifier or quoted name), else one character.
 */
export function errorRangeInStatement(
  statement: string,
  position: { line: number; column: number }
): { start: number; end: number } | null {
  const lines = statement.split("\n");
  if (position.line > lines.length) return null;
  let start = 0;
  for (let i = 0; i < position.line - 1; i++) start += lines[i]!.length + 1;
  start += position.column - 1;
  if (start < 0 || start >= statement.length) return null;
  const rest = statement.slice(start);
  const word = /^("[^"]*"|`[^`]*`|[\p{L}\p{N}_$.]+)/u.exec(rest);
  return { start, end: start + Math.max(1, word?.[0].length ?? 1) };
}

/**
 * The statements a run executes from its SQL, with where each one's text
 * starts in it: the same split the runner uses (trimmed, empty ones dropped).
 */
export function runStatementStarts(
  runSql: string,
  split: (sql: string) => { text: string; start: number; end: number }[]
): { text: string; start: number }[] {
  const trimmed = runSql.trim();
  const lead = runSql.length - runSql.trimStart().length;
  const parts = split(trimmed)
    .map((part) => {
      const raw = trimmed.slice(part.start, part.end);
      const text = raw.trim();
      return {
        text,
        start: lead + part.start + (raw.length - raw.trimStart().length),
      };
    })
    .filter((part) => part.text);
  return parts.length ? parts : [{ text: trimmed, start: lead }];
}
