import * as monaco from "monaco-editor";
import {
  ALL_SQL_KEYWORDS,
  ALL_SQL_FUNCTIONS,
  ALL_SQL_TYPES,
  ALL_SQL_OPERATORS,
  SQL_CONSTANTS,
} from "src/sqlConstants";

let registered = false;

/**
 * Custom SQL Monarch Tokenizer
 *
 * Features:
 * - Distinguishes keywords, functions, types, operators
 * - Handles quoted identifiers ("table", `column`, [name])
 * - Proper comment handling
 * - PostgreSQL, MySQL, SQLite compatible
 * - Dollar-quoted strings (PostgreSQL)
 * - Parameter placeholders ($1, :name, @var)
 */
const sqlTokenizer: monaco.languages.IMonarchLanguage = {
  defaultToken: "identifier",
  tokenPostfix: ".sql",
  ignoreCase: true,

  brackets: [
    { open: "[", close: "]", token: "delimiter.square" },
    { open: "(", close: ")", token: "delimiter.parenthesis" },
  ],

  keywords: ALL_SQL_KEYWORDS,
  operators: ALL_SQL_OPERATORS,
  builtinFunctions: ALL_SQL_FUNCTIONS,
  builtinTypes: ALL_SQL_TYPES,
  constants: [...SQL_CONSTANTS],

  tokenizer: {
    root: [
      // Whitespace
      { include: "@whitespace" },

      // Comments
      { include: "@comments" },

      // Numbers
      [/0[xX][0-9a-fA-F]+/, "number.hex"],
      [/\d+(\.\d+)?([eE][-+]?\d+)?/, "number"],

      // Strings
      [/'/, { token: "string.quote", next: "@stringSingle" }],
      [/\$\w*\$/, { token: "string.quote", next: "@stringDollar" }],

      // Quoted identifiers
      [/"/, { token: "identifier.quote", next: "@identifierDouble" }],
      [/`/, { token: "identifier.quote", next: "@identifierBacktick" }],
      [/\[/, { token: "identifier.quote", next: "@identifierBracket" }],

      // Operators
      [/::|->|->>|#>|#>>|@>|<@|\?\||\?&|\?|@@|&&|@\?/, "operator.json"],
      [/~\*?|!\~\*?/, "operator.regex"],
      [/[<>=!]+/, "operator.comparison"],
      [/[+\-*/%^]/, "operator.arithmetic"],
      [/\|\|/, "operator.concat"],

      // Delimiters
      [/[;,.]/, "delimiter"],
      [/[()\[\]]/, "@brackets"],

      // Parameter placeholders
      [/\$\d+/, "variable.parameter"],
      [/:\w+/, "variable.parameter"],
      [/@\w+/, "variable.parameter"],

      // Identifiers and keywords
      [
        /[a-zA-Z_]\w*/,
        {
          cases: {
            "@keywords": "keyword",
            "@builtinFunctions": "function.builtin",
            "@builtinTypes": "type",
            "@constants": "constant",
            "@default": "identifier",
          },
        },
      ],
    ],

    whitespace: [[/\s+/, "white"]],

    comments: [
      [/--.*$/, "comment.line"],
      [/\/\*/, { token: "comment.block", next: "@commentBlock" }],
      [/#.*$/, "comment.line"], // MySQL style
    ],

    commentBlock: [
      [/\*\//, { token: "comment.block", next: "@pop" }],
      [/./, "comment.block"],
    ],

    stringSingle: [
      [/''/, "string.escape"],
      [/[^']+/, "string"],
      [/'/, { token: "string.quote", next: "@pop" }],
    ],

    stringDollar: [
      [/\$\w*\$/, { token: "string.quote", next: "@pop" }],
      [/./, "string"],
    ],

    identifierDouble: [
      [/""/, "identifier.escape"],
      [/[^"]+/, "identifier.quoted"],
      [/"/, { token: "identifier.quote", next: "@pop" }],
    ],

    identifierBacktick: [
      [/``/, "identifier.escape"],
      [/[^`]+/, "identifier.quoted"],
      [/`/, { token: "identifier.quote", next: "@pop" }],
    ],

    identifierBracket: [
      [/[^\]]+/, "identifier.quoted"],
      [/\]/, { token: "identifier.quote", next: "@pop" }],
    ],
  },
};

/**
 * Light Theme - "politedb-sql"
 */
const lightTheme: monaco.editor.IStandaloneThemeData = {
  base: "vs",
  inherit: false,
  rules: [
    // Base
    { token: "", foreground: "111827", background: "FFFFFF" },
    { token: "white", foreground: "111827" },

    // Keywords - Blue
    { token: "keyword", foreground: "1D4ED8" },

    // Functions - Teal
    { token: "function.builtin", foreground: "0F766E" },

    // Types - Cyan
    { token: "type", foreground: "0891B2" },

    // Constants - Purple
    { token: "constant", foreground: "7C3AED" },

    // Strings - Green
    { token: "string", foreground: "16A34A" },
    { token: "string.quote", foreground: "16A34A" },
    { token: "string.escape", foreground: "15803D" },

    // Numbers - Purple
    { token: "number", foreground: "7C3AED" },
    { token: "number.hex", foreground: "7C3AED" },

    // Identifiers
    { token: "identifier", foreground: "111827" },
    { token: "identifier.quoted", foreground: "92400E" },
    { token: "identifier.quote", foreground: "B45309" },
    { token: "identifier.escape", foreground: "B45309" },

    // Operators
    { token: "operator", foreground: "6B7280" },
    { token: "operator.comparison", foreground: "6B7280" },
    { token: "operator.arithmetic", foreground: "6B7280" },
    { token: "operator.concat", foreground: "6B7280" },
    { token: "operator.json", foreground: "0891B2" },
    { token: "operator.regex", foreground: "7C3AED" },

    // Parameters - Orange
    { token: "variable.parameter", foreground: "EA580C" },

    // Delimiters
    { token: "delimiter", foreground: "374151" },
    { token: "delimiter.parenthesis", foreground: "374151" },
    { token: "delimiter.square", foreground: "374151" },

    // Comments - Gray (WCAG AA compliant)
    { token: "comment", foreground: "6B7280", fontStyle: "italic" },
    { token: "comment.line", foreground: "6B7280", fontStyle: "italic" },
    { token: "comment.block", foreground: "6B7280", fontStyle: "italic" },
  ],
  colors: {
    // Editor base
    "editor.background": "#FFFFFF",
    "editor.foreground": "#111827",

    // Cursor
    "editorCursor.foreground": "#111827",
    "editorCursor.background": "#FFFFFF",

    // Selection
    "editor.selectionBackground": "#DBEAFE",
    "editor.selectionHighlightBackground": "#EFF6FF",
    "editor.inactiveSelectionBackground": "#E5E7EB",

    // Word highlight
    "editor.wordHighlightBackground": "#FEF3C7",
    "editor.wordHighlightStrongBackground": "#FDE68A",

    // Find
    "editor.findMatchBackground": "#FEF08A",
    "editor.findMatchHighlightBackground": "#FEF9C3",
    "editor.findMatchBorder": "#FACC15",

    // Line
    "editor.lineHighlightBackground": "#F9FAFB",
    "editor.lineHighlightBorder": "#00000000",
    "editorLineNumber.foreground": "#9CA3AF",
    "editorLineNumber.activeForeground": "#374151",

    // Indent guides
    "editorIndentGuide.background": "#E5E7EB",
    "editorIndentGuide.activeBackground": "#D1D5DB",

    // Bracket matching
    "editorBracketMatch.background": "#DBEAFE",
    "editorBracketMatch.border": "#60A5FA",

    // Bracket pair colorization
    "editorBracketHighlight.foreground1": "#1D4ED8",
    "editorBracketHighlight.foreground2": "#7C3AED",
    "editorBracketHighlight.foreground3": "#0F766E",
    "editorBracketHighlight.foreground4": "#B45309",

    // Gutter
    "editorGutter.background": "#FAFAFA",
    "editorGutter.modifiedBackground": "#3B82F6",
    "editorGutter.addedBackground": "#22C55E",
    "editorGutter.deletedBackground": "#EF4444",

    // Scrollbar
    "scrollbar.shadow": "#00000014",
    "scrollbarSlider.background": "#00000014",
    "scrollbarSlider.hoverBackground": "#00000028",
    "scrollbarSlider.activeBackground": "#00000038",

    // Suggest widget (autocomplete)
    "editorSuggestWidget.background": "#FFFFFF",
    "editorSuggestWidget.border": "#E5E7EB",
    "editorSuggestWidget.foreground": "#111827",
    "editorSuggestWidget.selectedBackground": "#EFF6FF",
    "editorSuggestWidget.selectedForeground": "#111827",
    "editorSuggestWidget.highlightForeground": "#1D4ED8",
    "editorSuggestWidget.focusHighlightForeground": "#1E40AF",

    // Hover widget
    "editorHoverWidget.background": "#FFFFFF",
    "editorHoverWidget.border": "#E5E7EB",
    "editorHoverWidget.foreground": "#111827",

    // Errors and warnings
    "editorError.foreground": "#DC2626",
    "editorWarning.foreground": "#D97706",
    "editorInfo.foreground": "#2563EB",

    // Whitespace
    "editorWhitespace.foreground": "#D1D5DB",

    // Overview ruler
    "editorOverviewRuler.border": "#E5E7EB",
    "editorOverviewRuler.findMatchForeground": "#FACC15",
    "editorOverviewRuler.errorForeground": "#DC2626",
    "editorOverviewRuler.warningForeground": "#D97706",
  },
};

/**
 * Dark Theme - "politedb-sql-dark"
 */
const darkTheme: monaco.editor.IStandaloneThemeData = {
  base: "vs-dark",
  inherit: false,
  rules: [
    // Base
    { token: "", foreground: "E5E7EB", background: "111827" },
    { token: "white", foreground: "E5E7EB" },

    // Keywords - Blue
    { token: "keyword", foreground: "60A5FA" },

    // Functions - Teal
    { token: "function.builtin", foreground: "2DD4BF" },

    // Types - Cyan
    { token: "type", foreground: "22D3EE" },

    // Constants - Purple
    { token: "constant", foreground: "A78BFA" },

    // Strings - Green
    { token: "string", foreground: "4ADE80" },
    { token: "string.quote", foreground: "4ADE80" },
    { token: "string.escape", foreground: "86EFAC" },

    // Numbers - Purple
    { token: "number", foreground: "A78BFA" },
    { token: "number.hex", foreground: "A78BFA" },

    // Identifiers
    { token: "identifier", foreground: "E5E7EB" },
    { token: "identifier.quoted", foreground: "FCD34D" },
    { token: "identifier.quote", foreground: "FBBF24" },
    { token: "identifier.escape", foreground: "FBBF24" },

    // Operators
    { token: "operator", foreground: "9CA3AF" },
    { token: "operator.comparison", foreground: "9CA3AF" },
    { token: "operator.arithmetic", foreground: "9CA3AF" },
    { token: "operator.concat", foreground: "9CA3AF" },
    { token: "operator.json", foreground: "22D3EE" },
    { token: "operator.regex", foreground: "A78BFA" },

    // Parameters - Orange
    { token: "variable.parameter", foreground: "FB923C" },

    // Delimiters
    { token: "delimiter", foreground: "9CA3AF" },
    { token: "delimiter.parenthesis", foreground: "9CA3AF" },
    { token: "delimiter.square", foreground: "9CA3AF" },

    // Comments
    { token: "comment", foreground: "6B7280", fontStyle: "italic" },
    { token: "comment.line", foreground: "6B7280", fontStyle: "italic" },
    { token: "comment.block", foreground: "6B7280", fontStyle: "italic" },
  ],
  colors: {
    // Editor base
    "editor.background": "#181818",
    "editor.foreground": "#E8E8E8",

    // Cursor
    "editorCursor.foreground": "#F9FAFB",
    "editorCursor.background": "#181818",

    // Selection
    "editor.selectionBackground": "#264F78",
    "editor.selectionHighlightBackground": "#264F7880",
    "editor.inactiveSelectionBackground": "#2E2E2E",

    // Word highlight
    "editor.wordHighlightBackground": "#78350F60",
    "editor.wordHighlightStrongBackground": "#92400E60",

    // Find
    "editor.findMatchBackground": "#854D0E",
    "editor.findMatchHighlightBackground": "#713F1280",
    "editor.findMatchBorder": "#FACC15",

    // Line
    "editor.lineHighlightBackground": "#242424",
    "editor.lineHighlightBorder": "#00000000",
    "editorLineNumber.foreground": "#737373",
    "editorLineNumber.activeForeground": "#A3A3A3",

    // Indent guides
    "editorIndentGuide.background": "#2E2E2E",
    "editorIndentGuide.activeBackground": "#525252",

    // Bracket matching
    "editorBracketMatch.background": "#264F78",
    "editorBracketMatch.border": "#3B82F6",

    // Bracket pair colorization
    "editorBracketHighlight.foreground1": "#60A5FA",
    "editorBracketHighlight.foreground2": "#A78BFA",
    "editorBracketHighlight.foreground3": "#2DD4BF",
    "editorBracketHighlight.foreground4": "#FBBF24",

    // Gutter
    "editorGutter.background": "#181818",
    "editorGutter.modifiedBackground": "#3B82F6",
    "editorGutter.addedBackground": "#22C55E",
    "editorGutter.deletedBackground": "#EF4444",

    // Scrollbar
    "scrollbar.shadow": "#00000040",
    "scrollbarSlider.background": "#FFFFFF14",
    "scrollbarSlider.hoverBackground": "#FFFFFF28",
    "scrollbarSlider.activeBackground": "#FFFFFF38",

    // Suggest widget
    "editorSuggestWidget.background": "#242424",
    "editorSuggestWidget.border": "#353535",
    "editorSuggestWidget.foreground": "#E8E8E8",
    "editorSuggestWidget.selectedBackground": "#264F78",
    "editorSuggestWidget.selectedForeground": "#F9FAFB",
    "editorSuggestWidget.highlightForeground": "#60A5FA",
    "editorSuggestWidget.focusHighlightForeground": "#93C5FD",

    // Hover widget
    "editorHoverWidget.background": "#242424",
    "editorHoverWidget.border": "#353535",
    "editorHoverWidget.foreground": "#E8E8E8",

    // Errors and warnings
    "editorError.foreground": "#F87171",
    "editorWarning.foreground": "#FBBF24",
    "editorInfo.foreground": "#60A5FA",

    // Whitespace
    "editorWhitespace.foreground": "#2E2E2E",

    // Overview ruler
    "editorOverviewRuler.border": "#2E2E2E",
    "editorOverviewRuler.findMatchForeground": "#FACC15",
    "editorOverviewRuler.errorForeground": "#F87171",
    "editorOverviewRuler.warningForeground": "#FBBF24",
  },
};

/**
 * Register custom SQL language and themes
 */
export function registerSqlLanguage() {
  if (registered) return;
  registered = true;

  // Register custom tokenizer
  monaco.languages.register({ id: "sql" });
  monaco.languages.setMonarchTokensProvider("sql", sqlTokenizer);

  // Register language configuration
  monaco.languages.setLanguageConfiguration("sql", {
    comments: {
      lineComment: "--",
      blockComment: ["/*", "*/"],
    },
    brackets: [
      ["(", ")"],
      ["[", "]"],
    ],
    autoClosingPairs: [
      { open: "(", close: ")" },
      { open: "[", close: "]" },
      { open: "'", close: "'", notIn: ["string"] },
      { open: '"', close: '"', notIn: ["string"] },
      { open: "`", close: "`", notIn: ["string"] },
    ],
    surroundingPairs: [
      { open: "(", close: ")" },
      { open: "[", close: "]" },
      { open: "'", close: "'" },
      { open: '"', close: '"' },
      { open: "`", close: "`" },
    ],
    folding: {
      markers: {
        start: /^\s*--\s*#?region\b/,
        end: /^\s*--\s*#?endregion\b/,
      },
    },
    wordPattern:
      /(-?\d*\.\d\w*)|([^\`\~\!\@\#\%\^\&\*\(\)\-\=\+\[\{\]\}\\\|\;\:\'\"\,\.\<\>\/\?\s]+)/g,
  });

  // Define themes
  monaco.editor.defineTheme("politedb-sql", lightTheme);
  monaco.editor.defineTheme("politedb-sql-dark", darkTheme);
}

/**
 * Set SQL theme based on mode
 */
export function setSqlTheme(mode: "light" | "dark" = "light") {
  registerSqlLanguage();
  const themeName = mode === "dark" ? "politedb-sql-dark" : "politedb-sql";
  monaco.editor.setTheme(themeName);
}

/**
 * Legacy API - ensures light theme is active
 */
export function ensureSqlTheme() {
  const mode =
    typeof document !== "undefined" &&
    document.documentElement.dataset.theme === "dark"
      ? "dark"
      : "light";
  setSqlTheme(mode);
}
