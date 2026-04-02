import { vi } from "vitest";

export class Range {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;

  constructor(sLn: number, sCol: number, eLn: number, eCol: number) {
    this.startLineNumber = sLn;
    this.startColumn = sCol;
    this.endLineNumber = eLn;
    this.endColumn = eCol;
  }
}

export class Position {
  lineNumber: number;
  column: number;

  constructor(lineNumber: number, column: number) {
    this.lineNumber = lineNumber;
    this.column = column;
  }
}

export const languages = {
  CompletionItemKind: {
    Keyword: 14,
    Function: 1,
    Field: 4,
    Struct: 6,
    Class: 7,
    Module: 8,
    Operator: 12,
  },
  CompletionItemInsertTextRule: {
    InsertAsSnippet: 4,
  },
  registerCompletionItemProvider: vi.fn((langId: string, provider: unknown) => {
    return { dispose: vi.fn(), __langId: langId, __provider: provider };
  }),
};

