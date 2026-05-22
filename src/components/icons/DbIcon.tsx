import { DatabaseIcon } from "./Database";
import { cn } from "src/utils/cn";

import postgres from "src/assets/db/postgres.svg";
import mysql from "src/assets/db/mysql.svg";
import redis from "src/assets/db/redis.svg";
import mariadb from "src/assets/db/mariadb.svg";
import mongo from "src/assets/db/mongodb.svg";
import sqlite from "src/assets/db/sqlite.svg";
import oracle from "src/assets/db/oracle.svg";
import sqlserver from "src/assets/db/sqlserver.svg";
import snowflake from "src/assets/db/snowflake.svg";
import duckdb from "src/assets/db/duckdb.svg";
import cloudflared1 from "src/assets/db/d1.svg";
import cassandra from "src/assets/db/cassandra.svg";
import clickhouse from "src/assets/db/clickhouse.svg";
import turso from "src/assets/db/turso.svg";

// Import DatabaseEngine from shared types if available; otherwise keep this local alias.
export type DatabaseEngine =
  | "postgres"
  | "mysql"
  | "redis"
  | "mariadb"
  | "sqlserver"
  | "mongo"
  | "sqlite"
  | "d1"
  | "turso"
  | "oracle"
  | "snowflake"
  | "duckdb"
  | "cassandra"
  | "clickhouse";

type DbIconSrc = string;

const DB_ICON_MAP: Partial<Record<DatabaseEngine, DbIconSrc>> = {
  postgres,
  mysql,
  redis,
  mariadb,
  sqlserver,
  mongo,
  sqlite,
  d1: cloudflared1,
  turso,
  oracle,
  snowflake,
  duckdb,
  cassandra,
  clickhouse,
};

function normalizeEngine(engine?: string): DatabaseEngine | null {
  if (!engine) return null;
  const k = engine.trim().toLowerCase();

  // alias / compat
  if (k === "postgresql") return "postgres";
  if (k === "mongodb") return "mongo";
  if (k === "scylla" || k === "scylladb") return "cassandra";
  if (k === "maria") return "mariadb";
  if (k === "mssql") return "sqlserver";
  if (k === "sf") return "snowflake";
  if (k === "dk") return "duckdb";
  if (k === "ch") return "clickhouse";
  if (k === "tu") return "turso";

  // exact
  if (k in DB_ICON_MAP) return k as DatabaseEngine;
  return null;
}

function engineFromAbbr(abbreviation?: string): DatabaseEngine | null {
  if (!abbreviation) return null;
  const k = abbreviation.trim().toLowerCase();
  if (k === "pg") return "postgres";
  if (k === "ms") return "mysql";
  if (k === "re") return "redis";
  if (k === "mr") return "mariadb";
  if (k === "ss") return "sqlserver";
  if (k === "mg") return "mongo";
  if (k === "cs") return "cassandra";
  if (k === "sl") return "sqlite";
  if (k === "d1") return "d1";
  if (k === "tu") return "turso";
  if (k === "oc") return "oracle";
  if (k === "sf") return "snowflake";
  if (k === "dk") return "duckdb";
  if (k === "ch") return "clickhouse";
  return null;
}

export function getDbIconSrc(
  engine?: DatabaseEngine | string,
  abbreviation?: string
): DbIconSrc | null {
  const normalized = normalizeEngine(engine);
  if (normalized) return DB_ICON_MAP[normalized] ?? null;

  const fromAbbr = engineFromAbbr(abbreviation);
  if (fromAbbr) return DB_ICON_MAP[fromAbbr] ?? null;

  return null;
}

type DbIconSize = "xs" | "sm" | "md" | "lg";

const SIZE_PX: Record<DbIconSize, number> = {
  xs: 20,
  sm: 24,
  md: 36,
  lg: 48,
};

export function DbIcon(props: {
  engine?: DatabaseEngine | string;
  abbreviation?: string;

  size?: DbIconSize;
  px?: number;

  className?: string;
  alt?: string;
}) {
  const { engine, abbreviation, size = "md", px, className, alt } = props;

  const src = getDbIconSrc(engine, abbreviation);
  const dim = Math.max(8, Math.round(px ?? SIZE_PX[size]));

  const boxClass = cn(
    "inline-flex shrink-0 items-center justify-center",
    className
  );

  if (!src) {
    return (
      <span class={boxClass} style={{ width: `${dim}px`, height: `${dim}px` }}>
        <DatabaseIcon className="h-full w-full" />
      </span>
    );
  }

  return (
    <span class={boxClass} style={{ width: `${dim}px`, height: `${dim}px` }}>
      <img
        src={src}
        alt={alt ?? (typeof engine === "string" ? engine : "database")}
        draggable={false}
        loading="lazy"
        class="h-full w-full object-contain select-none"
      />
    </span>
  );
}
