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
    available: false,
    desc: "Community-driven MySQL-compatible database.",
    defaultLabels: ["Gaia"],
  },
  {
    engine: "mongo",
    label: "MongoDB",
    abbreviation: "Mg",
    color: "bg-green-500",
    available: false,
    desc: "Document-oriented NoSQL database.",
    defaultLabels: ["Proteus"],
  },
  {
    engine: "sqlite",
    label: "SQLite",
    abbreviation: "Sl",
    color: "bg-purple-600",
    available: false,
    desc: "Embedded database stored as a single file.",
    defaultLabels: ["Hestia"],
  },
  {
    engine: "oracle",
    label: "Oracle",
    abbreviation: "Oc",
    color: "bg-red-600",
    available: false,
    desc: "Enterprise-grade relational database.",
    defaultLabels: ["Zeus"],
  },
] as const;
