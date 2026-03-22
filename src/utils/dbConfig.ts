import { DatabaseConfig, DatabaseEngine } from "src/types";
import {
  MYSQL_DATA_TYPES,
  POSTGRES_DATA_TYPES,
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
    dataTypes: [],
    indexAlgorithms: [],
  },
  mongo: {
    dataTypes: [],
    indexAlgorithms: [],
  },
  sqlite: {
    dataTypes: SQLITE_DATA_TYPES,
    indexAlgorithms: [],
  },
  oracle: {
    dataTypes: [],
    indexAlgorithms: [],
  },
};
