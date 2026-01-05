import type { JSX } from "preact";

export type NavId = "connections" | "keychain";
export type ViewMode = "grid" | "list";

export type NavItem = {
  id: NavId;
  label: string;
  icon: JSX.Element;
};

export type DatabaseEngine =
  | "postgres"
  | "mysql"
  | "redis"
  | "mariadb"
  | "sqlserver"
  | "mongo"
  | "sqlite"
  | "oracle";

export type DatabaseType = {
  engine: DatabaseEngine;
  label: string;
  abbreviation: string;
  color: string;
  available: boolean;
};
