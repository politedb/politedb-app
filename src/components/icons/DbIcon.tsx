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

// Import DatabaseEngine from shared types if available; otherwise keep this local alias.
export type DatabaseEngine =
  | "postgres"
  | "mysql"
  | "redis"
  | "mariadb"
  | "sqlserver"
  | "mongo"
  | "sqlite"
  | "oracle";

type DbIconSrc = string;

const DB_ICON_MAP: Record<DatabaseEngine, DbIconSrc> = {
  postgres,
  mysql,
  redis,
  mariadb,
  sqlserver,
  mongo,
  sqlite,
  oracle,
};

function normalizeEngine(engine?: string): DatabaseEngine | null {
  if (!engine) return null;
  const k = engine.trim().toLowerCase();

  // alias / compat
  if (k === "postgresql") return "postgres";
  if (k === "mongodb") return "mongo";
  if (k === "maria") return "mariadb";
  if (k === "mssql") return "sqlserver";

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
  if (k === "sl") return "sqlite";
  if (k === "oc") return "oracle";
  return null;
}

export function getDbIconSrc(
  engine?: DatabaseEngine | string,
  abbreviation?: string
): DbIconSrc | null {
  const normalized = normalizeEngine(engine);
  if (normalized) return DB_ICON_MAP[normalized];

  const fromAbbr = engineFromAbbr(abbreviation);
  if (fromAbbr) return DB_ICON_MAP[fromAbbr];

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
