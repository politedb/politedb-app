export type DiagramColumn = {
  name: string;
  type: string;
  isPrimaryKey?: boolean;
};

export type DiagramTable = {
  schema: string;
  name: string;
  columns: DiagramColumn[];
};

export type DiagramRelation = {
  fromTable: string;
  toTable: string;
  label: string;
  fromColumn?: string;
  toColumn?: string;
  cardinality: "one-to-one" | "one-to-many";
};

export type DiagramState = {
  mermaid: string;
  tableCount: number;
  relationshipCount: number;
  tables: DiagramTable[];
  relations: DiagramRelation[];
};
