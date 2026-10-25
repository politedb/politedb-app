/**
 * Query scopes around the cursor in a masked statement (see maskSql): the
 * tables a name can refer to are those of the cursor's own SELECT and of the
 * queries enclosing it, never those of a sibling UNION branch, a subquery or
 * a CTE body elsewhere.
 */

type Group = {
  open: number;
  close: number;
  /** A subquery: `(SELECT`, `(WITH` or `(VALUES`. */
  query: boolean;
  /** The nearest enclosing subquery; null for the statement itself. */
  parent: Group | null;
};

/** One scope: its text and keyword view (see maskSql), subqueries blanked. */
export type Scope = { text: string; keywords: string };

const QUERY_START = /(?:SELECT|WITH|VALUES)\b/iy;
const SET_OPERATOR = /\b(?:UNION|INTERSECT|EXCEPT)\b/gi;
const SPACE = /\s/;

/** Parenthesized groups in `keywords`, where quoted names hold no parens. */
function parenGroups(keywords: string): Group[] {
  const groups: Group[] = [];
  const stack: Group[] = [];
  const queries: Group[] = [];
  for (let i = 0; i < keywords.length; i++) {
    const ch = keywords[i];
    if (ch === "(") {
      let first = i + 1;
      while (first < keywords.length && SPACE.test(keywords[first]!)) first++;
      QUERY_START.lastIndex = first;
      const group: Group = {
        open: i,
        close: keywords.length,
        query: QUERY_START.test(keywords),
        parent: queries[queries.length - 1] ?? null,
      };
      groups.push(group);
      stack.push(group);
      if (group.query) queries.push(group);
    } else if (ch === ")") {
      const group = stack.pop();
      if (!group) continue;
      group.close = i;
      if (group.query) queries.pop();
    }
  }
  return groups;
}

/**
 * `src[from, to)` with the inside of each hole (in order) shrunk to one
 * space, so every scope costs only its own text, however deep the nesting;
 * and where `anchor` (an offset in `src`, outside the holes) lands.
 */
function withHoles(
  src: string,
  from: number,
  to: number,
  holes: Group[],
  anchor: number
): [string, number] {
  let out = "";
  let at = from;
  let anchorAt = -1;
  for (const hole of holes) {
    if (anchorAt < 0 && anchor <= hole.open) {
      anchorAt = out.length + (anchor - at);
    }
    out += src.slice(at, hole.open + 1) + " ";
    at = hole.close;
  }
  if (anchorAt < 0) anchorAt = out.length + (anchor - at);
  return [out + src.slice(at, to), anchorAt];
}

/** The scopes of `cursor`, outermost first. */
export function cursorScopes(
  text: string,
  keywords: string,
  cursor: number
): Scope[] {
  const groups = parenGroups(keywords);
  const children = new Map<Group | null, Group[]>();
  for (const group of groups) {
    if (!group.query) continue;
    const list = children.get(group.parent) ?? [];
    list.push(group);
    children.set(group.parent, list);
  }

  const chain: Array<Group | null> = [
    null,
    ...groups.filter(
      (group) => group.query && group.open < cursor && cursor <= group.close
    ),
  ];
  return chain.map((scope, index) => {
    const from = scope ? scope.open + 1 : 0;
    const to = scope ? scope.close : text.length;
    const holes = children.get(scope) ?? [];
    // The set-operator branch around the cursor (or the child holding it).
    const anchorAbs = chain[index + 1]?.open ?? cursor;
    const [kw, anchor] = withHoles(keywords, from, to, holes, anchorAbs);
    let start = 0;
    let end = kw.length;
    for (const match of kw.matchAll(SET_OPERATOR)) {
      if (match.index! < anchor) start = match.index! + match[0].length;
      else {
        end = match.index!;
        break;
      }
    }
    return {
      text: withHoles(text, from, to, holes, anchorAbs)[0].slice(start, end),
      keywords: kw.slice(start, end),
    };
  });
}
