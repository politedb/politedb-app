import { DatabaseConfig, DatabaseEngine } from "src/types";
import {
  MYSQL_DATA_TYPES,
  ORACLE_DATA_TYPES,
  POSTGRES_DATA_TYPES,
  SQLSERVER_DATA_TYPES,
  SNOWFLAKE_DATA_TYPES,
  SQLITE_DATA_TYPES,
} from "src/constant";

export function getDbConfig(engine: DatabaseEngine): DatabaseConfig {
  return DATABASES_CONFIG[engine];
}

const DATABASES_CONFIG: Record<DatabaseEngine, DatabaseConfig> = {
  postgres: {
    dataTypes: POSTGRES_DATA_TYPES,
    indexAlgorithms: ["BTREE", "HASH", "GIN", "GIST", "BRIN"],
    allowFk: true,
  },
  mysql: {
    dataTypes: MYSQL_DATA_TYPES,
    indexAlgorithms: ["BTREE", "HASH", "RTREE"],
    allowFk: true,
  },
  mariadb: {
    dataTypes: MYSQL_DATA_TYPES,
    indexAlgorithms: ["BTREE", "HASH", "RTREE"],
    allowFk: true,
  },
  redis: {
    dataTypes: [],
    indexAlgorithms: [],
  },
  sqlserver: {
    dataTypes: SQLSERVER_DATA_TYPES,
    indexAlgorithms: ["CLUSTERED", "NONCLUSTERED", "COLUMNSTORE", "HASH"],
    allowFk: true,
  },
  mongo: {
    dataTypes: [],
    indexAlgorithms: [],
  },
  cassandra: {
    dataTypes: [],
    indexAlgorithms: [],
  },
  sqlite: {
    dataTypes: SQLITE_DATA_TYPES,
    indexAlgorithms: [],
  },
  d1: {
    dataTypes: SQLITE_DATA_TYPES,
    indexAlgorithms: [],
    allowFk: true,
  },
  oracle: {
    dataTypes: ORACLE_DATA_TYPES,
    indexAlgorithms: [],
  },
  snowflake: {
    dataTypes: SNOWFLAKE_DATA_TYPES,
    indexAlgorithms: [],
    allowFk: true,
  },
  duckdb: {
    dataTypes: SQLITE_DATA_TYPES,
    indexAlgorithms: [],
    allowFk: true,
  },
};
