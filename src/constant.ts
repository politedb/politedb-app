import { DataAction, DataKey, TableFilterState } from "./stores/connection";
import { DatabaseType } from "./types";

export const SUPPORTED_DATABASES: readonly (DatabaseType & {
  desc?: string;
  defaultLabels?: string[];
})[] = [
  {
    engine: "postgres",
    label: "PostgreSQL",
    abbreviation: "Pg",
    color: "bg-blue-600",
    available: true,
    desc: "Powerful SQL database with extensions.",
    defaultLabels: ["Athena", "Apollo", "Hephaestus"],
  },
  {
    engine: "mysql",
    label: "MySQL",
    abbreviation: "Ms",
    color: "bg-orange-500",
    available: true,
    desc: "Popular relational database for web apps.",
    defaultLabels: ["Hera", "Demeter", "Atlas"],
  },
  {
    engine: "redis",
    label: "Redis",
    abbreviation: "Re",
    color: "bg-red-700",
    available: true,
    desc: "In-memory store for cache and realtime data.",
    defaultLabels: ["Hermes", "Iris", "Zephyr"],
  },
  {
    engine: "mariadb",
    label: "MariaDB",
    abbreviation: "Mr",
    color: "bg-teal-500",
    available: true,
    desc: "Community-driven MySQL-compatible database.",
    defaultLabels: ["Artemis", "Ares", "Gaia"],
  },
  {
    engine: "mongo",
    label: "MongoDB",
    abbreviation: "Mg",
    color: "bg-green-500",
    available: true,
    desc: "Document-oriented NoSQL database.",
    defaultLabels: ["Prometheus", "Hades", "Proteus"],
  },
  {
    engine: "sqlite",
    label: "SQLite",
    abbreviation: "Sl",
    color: "bg-purple-600",
    available: true,
    desc: "Embedded database stored as a single file.",
    defaultLabels: ["Aphrodite", "Poseidon", "Hestia"],
  },
  {
    engine: "oracle",
    label: "Oracle",
    abbreviation: "Oc",
    color: "bg-red-600",
    available: true,
    desc: "Enterprise-grade relational database.",
    defaultLabels: ["Zeus", "Cronus", "Nereus"],
  },
] as const;

export const POSTGRES_DATA_TYPES = [
  "bool",
  "bytea",
  "char",
  "date",
  "float4",
  "float8",
  "int2",
  "int4",
  "int8",
  "interval",
  "json",
  "jsonb",
  "numeric",
  "text",
  "time",
  "timestamp",
  "timestamptz",
  "uuid",
  "varchar",
  "xml",
];

export const MYSQL_DATA_TYPES = [
  "tinyint",
  "smallint",
  "mediumint",
  "int",
  "integer",
  "bigint",
  "float",
  "double",
  "decimal",
  "bit",
  "char",
  "varchar",
  "tinytext",
  "text",
  "mediumtext",
  "longtext",
  "binary",
  "varbinary",
  "tinyblob",
  "blob",
  "mediumblob",
  "longblob",
  "date",
  "time",
  "datetime",
  "timestamp",
  "year",
  "boolean",
  "bool",
  "json",
  "enum",
  "set",
];

export const SQLITE_DATA_TYPES = ["INTEGER", "TEXT", "BLOB", "REAL", "NUMERIC"];

export const ORACLE_DATA_TYPES = [
  "NUMBER",
  "FLOAT",
  "BINARY_FLOAT",
  "BINARY_DOUBLE",
  "CHAR",
  "NCHAR",
  "VARCHAR2",
  "NVARCHAR2",
  "CLOB",
  "NCLOB",
  "BLOB",
  "RAW",
  "LONG",
  "LONG RAW",
  "DATE",
  "TIMESTAMP",
  "TIMESTAMP WITH TIME ZONE",
  "TIMESTAMP WITH LOCAL TIME ZONE",
  "INTERVAL YEAR TO MONTH",
  "INTERVAL DAY TO SECOND",
  "XMLTYPE",
  "JSON",
];

export const DATA_KEYS: Record<DataKey, DataKey> = {
  structure: "structure",
  constraints: "constraints",
  data: "data",
};

export const DATA_ACTIONS: Record<DataAction, DataAction> = {
  create: "create",
  update: "update",
  delete: "delete",
};

export const DEFAULT_FILTER_STATE: TableFilterState = {
  filterBarVisible: false,
  filters: [],
  filterCombine: "AND",
  appliedFilters: [],
  appliedFilterCombine: "AND",
};
