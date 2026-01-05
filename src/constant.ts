import { DatabaseType } from "./types";

export const DATABASE_TYPES: DatabaseType[] = [
  {
    engine: "postgres",
    label: "PostgreSQL",
    abbreviation: "Pg",
    color: "bg-blue-600",
    available: true,
  },
  {
    engine: "mysql",
    label: "MySQL",
    abbreviation: "Ms",
    color: "bg-orange-500",
    available: true,
  },
  {
    engine: "redis",
    label: "Redis",
    abbreviation: "Re",
    color: "bg-red-700",
    available: true,
  },
  {
    engine: "mariadb",
    label: "MariaDB / SingleStore",
    abbreviation: "Mr",
    color: "bg-teal-500",
    available: false,
  },
  {
    engine: "sqlserver",
    label: "Microsoft SQL Server",
    abbreviation: "Ss",
    color: "bg-slate-600",
    available: false,
  },
  {
    engine: "mongo",
    label: "MongoDB",
    abbreviation: "Mg",
    color: "bg-green-500",
    available: false,
  },
  {
    engine: "sqlite",
    label: "SQLite",
    abbreviation: "Sl",
    color: "bg-purple-600",
    available: false,
  },
  {
    engine: "oracle",
    label: "Oracle",
    abbreviation: "Oc",
    color: "bg-red-600",
    available: false,
  },
];
