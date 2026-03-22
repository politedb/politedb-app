import type {
  TableData as TableDataType,
  TableStructure as TableStructureType,
  TableConstraint as TableConstraintType,
  ForeignKeyInfo,
  TableWindow,
  DatabaseEngine,
} from "src/types";
import { cellToString } from "./convert";
import { TableDataState } from "src/stores/connection";
import { getDbConfig } from "./dbConfig";

// patchMap[action][dataKey][rowKey] = data
export type PatchData = Record<string, Record<string, Record<string, any>>>;

export type PatchMap = {
  [windowId: string]: {
    tableData: TableDataState;
    tableWindow: TableWindow;
    patches: PatchData;
  };
};

function qIdent(ident: string, engine?: DatabaseEngine) {
  if (engine === "mysql" || engine === "mariadb") {
    return `\`${String(ident).replace(/`/g, "``")}\``;
  }
  return `"${String(ident).replace(/"/g, `""`)}"`;
}

function qLiteral(v: any): string {
  if (v === null || v === undefined) {
    return "NULL";
  }
  const str = String(v);
  // Escape single quotes
  return `'${str.replace(/'/g, "''")}'`;
}

/** PostgreSQL (and common) type names that expect numeric literals (unquoted) in SQL */
const NUMERIC_TYPE_PATTERN =
  /^(int2|int4|int8|smallint|integer|bigint|serial|bigserial|float4|float8|real|double\s*precision|numeric|decimal)(\s*\([^)]*\))?$/i;

function isNumericColumnType(dbType: string | undefined): boolean {
  if (!dbType || typeof dbType !== "string") return false;
  return NUMERIC_TYPE_PATTERN.test(dbType.trim());
}

/**
 * Format a value for use in SQL SET or WHERE. For numeric column types, outputs
 * unquoted numeric literal so PostgreSQL accepts it (e.g. SET price = 0 not SET price = '0').
 */
function formatValue(value: any, dbType: string | undefined): string {
  if (value === null || value === undefined) {
    return "NULL";
  }
  if (typeof value === "boolean") {
    return value ? "TRUE" : "FALSE";
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (isNumericColumnType(dbType)) {
    const s = String(value).trim();
    if (s === "" || s.toLowerCase() === "null") return "NULL";
    const n = Number(s);
    if (Number.isFinite(n)) return String(n);
  }
  return qLiteral(value);
}

/**
 * Extract primary key column names from constraints
 */
function getPrimaryKeyColumns(
  constraints: TableConstraintType[] | null | undefined
): string[] {
  if (!constraints || constraints.length === 0) {
    return [];
  }

  const isTruthy = (v: unknown) =>
    v === true || String(v ?? "").toLowerCase() === "true";

  const pkConstraint = constraints.find(
    (c) =>
      isTruthy(c.is_primary) ||
      c.index_name.toLowerCase() === "primary" ||
      c.index_name.toLowerCase().includes("pkey") ||
      (c.is_unique && c.index_name.toLowerCase().includes("primary"))
  );

  if (!pkConstraint?.column_name) {
    return [];
  }

  return pkConstraint.column_name
    .split(",")
    .map((col) => col.trim())
    .filter(Boolean);
}

/**
 * Generate SQL UPDATE statements from patchMap for data changes
 */
export function generateUpdateSqlFromPatches(
  patchMap: PatchData,
  schema: string,
  tableName: string,
  tableData: TableDataType | null,
  constraints: TableConstraintType[] | null = null,
  engine: DatabaseEngine = "postgres"
): string[] {
  const sqlStatements: string[] = [];
  const tableIdent = `${qIdent(schema, engine)}.${qIdent(tableName, engine)}`;

  // Get update patches for data
  const updatePatches = patchMap["update"]?.["data"];
  if (!updatePatches || !tableData) {
    return sqlStatements;
  }

  const columns = tableData.columns;
  const rows = tableData.rows;

  // Get primary key columns if available
  const primaryKeyColumns = getPrimaryKeyColumns(constraints);
  const usePrimaryKey = primaryKeyColumns.length > 0;

  // Process each row that has updates
  for (const [rowKey, patchData] of Object.entries(updatePatches)) {
    const rowIndex = parseInt(rowKey, 10);
    if (isNaN(rowIndex) || rowIndex < 0 || rowIndex >= rows.length) {
      continue;
    }

    const originalRow = rows[rowIndex];
    if (!originalRow || !Array.isArray(originalRow)) {
      continue;
    }

    // Build SET clause from patch data
    const setClauses: string[] = [];
    for (const [colName, newValue] of Object.entries(patchData)) {
      const col = columns.find((c) => c.name === colName);
      if (!col) continue;

      setClauses.push(
        `${qIdent(colName, engine)} = ${formatValue(newValue, col.db_type)}`
      );
    }

    if (setClauses.length === 0) {
      continue;
    }

    // Build WHERE clause using primary key columns if available, otherwise all columns
    const whereClauses: string[] = [];
    for (let i = 0; i < columns.length; i++) {
      const col = columns[i];
      if (!col) continue;

      // Skip if using primary key and this column is not a primary key
      if (usePrimaryKey && !primaryKeyColumns.includes(col.name)) {
        continue;
      }

      const cellValue = originalRow[i];
      const originalValue = cellToString(cellValue);
      const colName = qIdent(col.name, engine);

      // Handle null/empty values
      if (
        cellValue === null ||
        cellValue === undefined ||
        originalValue === ""
      ) {
        whereClauses.push(`${colName} IS NULL`);
      } else {
        // Extract actual value from cell object if needed
        let valueToCompare: any = originalValue;
        if (typeof cellValue === "object" && cellValue !== null) {
          if ("v" in cellValue) {
            valueToCompare = (cellValue as any).v;
          } else if ((cellValue as any).t === "Null") {
            whereClauses.push(`${colName} IS NULL`);
            continue;
          }
        }
        whereClauses.push(
          `${colName} = ${formatValue(valueToCompare, col.db_type)}`
        );
      }
    }

    if (whereClauses.length === 0) {
      continue;
    }

    const sql = `UPDATE ${tableIdent}\nSET ${setClauses.join(", ")}\nWHERE ${whereClauses.join(" AND ")};`;
    sqlStatements.push(sql);
  }

  return sqlStatements;
}

/**
 * Generate SQL INSERT statements from patchMap for data changes
 */
export function generateInsertSqlFromPatches(
  patchMap: PatchData,
  schema: string,
  tableName: string,
  engine: DatabaseEngine = "postgres",
  columns?: Array<{ name: string; db_type?: string }>
): string[] {
  const sqlStatements: string[] = [];
  const tableIdent = `${qIdent(schema, engine)}.${qIdent(tableName, engine)}`;

  // Get create patches for data only (not structure or constraints)
  const createPatches = patchMap["create"]?.["data"];
  if (!createPatches) {
    return sqlStatements;
  }

  // Process each new row
  for (const [_rowKey, patchData] of Object.entries(createPatches)) {
    const colNames: string[] = [];
    const values: string[] = [];

    for (const [colName, value] of Object.entries(patchData)) {
      if (colName === "__rowKey") continue; // Skip internal row key
      const col = columns?.find((c) => c.name === colName);
      colNames.push(qIdent(colName, engine));
      values.push(formatValue(value, col?.db_type));
    }

    if (colNames.length === 0) {
      continue;
    }

    const sql = `INSERT INTO ${tableIdent} (${colNames.join(", ")})\nVALUES (${values.join(", ")});`;
    sqlStatements.push(sql);
  }

  return sqlStatements;
}

/**
 * Generate SQL ALTER TABLE statements from patchMap for structure changes
 */
export function generateStructureSqlFromPatches(
  patchMap: PatchData,
  schema: string,
  tableName: string,
  initStructure: TableStructureType[] | null,
  initConstraints: TableConstraintType[] | null = null,
  initForeignKeys: ForeignKeyInfo[] | null = null,
  engine: DatabaseEngine = "postgres"
): string[] {
  const sqlStatements: string[] = [];
  const tableIdent = `${qIdent(schema, engine)}.${qIdent(tableName, engine)}`;

  // Handle CREATE (new columns)
  const createPatches = patchMap["create"]?.["structure"];

  if (createPatches) {
    for (const [_rowKey, patchData] of Object.entries(createPatches)) {
      const columnName = patchData.column_name?.trim();
      const dataType = patchData.data_type?.trim();
      const isNullable = patchData.is_nullable;
      const columnDefault = patchData.column_default;

      let columnDef = `${qIdent(columnName, engine)} ${dataType || "UNKNOWN"}`;
      if (!isNullable) {
        columnDef += " NOT NULL";
      }
      if (columnDefault && columnDefault.trim() !== "") {
        const defaultVal = columnDefault.trim();
        if (
          defaultVal.match(/^[A-Z_][A-Z0-9_]*\(\)$/) ||
          defaultVal.match(/^[0-9]+$/) ||
          defaultVal.toUpperCase() === "NULL"
        ) {
          columnDef += ` DEFAULT ${defaultVal}`;
        } else {
          columnDef += ` DEFAULT ${qLiteral(defaultVal)}`;
        }
      }

      const sql = `ALTER TABLE ${tableIdent} ADD COLUMN ${columnDef};`;
      sqlStatements.push(sql);
    }
  }

  // Handle UPDATE (modify existing columns)
  const updatePatches = patchMap["update"]?.["structure"];
  if (updatePatches) {
    // Handle table metadata changes (rowIndex: -1) - table name and primary key
    const metadataPatch = updatePatches["-1"];
    if (metadataPatch) {
      // Handle table name change
      if (metadataPatch.tableName && metadataPatch.tableName !== tableName) {
        sqlStatements.push(
          `ALTER TABLE ${tableIdent} RENAME TO ${qIdent(metadataPatch.tableName, engine)};`
        );
      }

      // Handle primary key change
      if (metadataPatch.primaryKey && Array.isArray(metadataPatch.primaryKey)) {
        const newPrimaryKey = metadataPatch.primaryKey.filter(Boolean).sort();

        // Find existing primary key constraint
        const existingPkConstraint = initConstraints?.find((c) =>
          c.index_name.toLowerCase().includes("pkey")
        );

        // Get existing primary key columns
        const existingPkColumns = existingPkConstraint
          ? existingPkConstraint.column_name
              .split(",")
              .map((col) => col.trim())
              .filter(Boolean)
              .sort()
          : [];

        // Only change primary key if it's actually different
        const pkChanged =
          newPrimaryKey.length !== existingPkColumns.length ||
          newPrimaryKey.some(
            (col: string, idx: number) => col !== existingPkColumns[idx]
          );

        if (pkChanged) {
          // Drop existing primary key if it exists
          if (existingPkConstraint) {
            sqlStatements.push(
              `ALTER TABLE ${tableIdent} DROP CONSTRAINT IF EXISTS ${qIdent(existingPkConstraint.index_name, engine)};`
            );
          }

          // Add new primary key if columns are specified
          if (newPrimaryKey.length > 0) {
            const pkColumns = newPrimaryKey
              .map((col: string) => qIdent(col, engine))
              .join(", ");
            sqlStatements.push(
              `ALTER TABLE ${tableIdent} ADD PRIMARY KEY (${pkColumns});`
            );
          }
        }
      }
    }

    // Handle column structure changes
    if (initStructure) {
      // First pass: Handle column renames (must be done before other ALTER COLUMN statements)
      for (const [rowKey, patchData] of Object.entries(updatePatches)) {
        const rowIndex = parseInt(rowKey, 10);
        // Skip metadata changes (handled above) and invalid indices
        if (
          isNaN(rowIndex) ||
          rowIndex < 0 ||
          rowIndex >= initStructure.length
        ) {
          continue;
        }

        const originalColumn = initStructure[rowIndex];
        if (!originalColumn) continue;

        // Handle column name change (RENAME COLUMN must be done separately)
        if (
          patchData.column_name &&
          patchData.column_name !== originalColumn.column_name
        ) {
          const oldName = originalColumn.column_name;
          const newName = patchData.column_name.trim();
          const sql = `ALTER TABLE ${tableIdent} RENAME COLUMN ${qIdent(oldName, engine)} TO ${qIdent(newName, engine)};`;
          sqlStatements.push(sql);
        }
      }

      // Second pass: Handle other column changes (use new column name if renamed)
      for (const [rowKey, patchData] of Object.entries(updatePatches)) {
        const rowIndex = parseInt(rowKey, 10);
        // Skip metadata changes (handled above) and invalid indices
        if (
          isNaN(rowIndex) ||
          rowIndex < 0 ||
          rowIndex >= initStructure.length
        ) {
          continue;
        }

        const originalColumn = initStructure[rowIndex];
        if (!originalColumn) continue;

        // Use new column name if it was changed, otherwise use original
        const columnName =
          patchData.column_name &&
          patchData.column_name !== originalColumn.column_name &&
          patchData.column_name.trim() !== ""
            ? patchData.column_name.trim()
            : originalColumn.column_name;

        const changes: string[] = [];

        // Handle data type change
        if (
          patchData.data_type &&
          patchData.data_type !== originalColumn.data_type
        ) {
          changes.push(`TYPE ${patchData.data_type}`);
        }

        // Handle nullable change
        if (
          "is_nullable" in patchData &&
          patchData.is_nullable !== originalColumn.is_nullable
        ) {
          if (patchData.is_nullable) {
            changes.push("DROP NOT NULL");
          } else {
            changes.push("SET NOT NULL");
          }
        }

        // Handle default change
        if (
          "column_default" in patchData &&
          patchData.column_default !== originalColumn.column_default
        ) {
          if (
            !patchData.column_default ||
            patchData.column_default.trim() === ""
          ) {
            changes.push("DROP DEFAULT");
          } else {
            const defaultVal = patchData.column_default.trim();
            if (
              defaultVal.match(/^[A-Z_][A-Z0-9_]*\(\)$/) ||
              defaultVal.match(/^[0-9]+$/) ||
              defaultVal.toUpperCase() === "NULL"
            ) {
              changes.push(`SET DEFAULT ${defaultVal}`);
            } else {
              changes.push(`SET DEFAULT ${qLiteral(defaultVal)}`);
            }
          }
        }

        // Only generate ALTER COLUMN if there are changes (excluding column_name which is handled above)
        if (changes.length > 0) {
          const sql = `ALTER TABLE ${tableIdent} ALTER COLUMN ${qIdent(columnName, engine)} ${changes.join(", ")};`;
          sqlStatements.push(sql);
        }

        // Handle foreign key definition changes stored on the column's `foreign_key` field.
        // For now we support simple single-column FKs in the form "ref_table(ref_column)"
        // or "ref_schema.ref_table(ref_column)" for Postgres/MySQL engines.
        const dbConfig = getDbConfig(engine);
        if (
          dbConfig.allowFk &&
          "foreign_key" in patchData &&
          patchData.foreign_key !== undefined &&
          patchData.foreign_key !== originalColumn.foreign_key &&
          typeof patchData.foreign_key === "string"
        ) {
          const fkDef = patchData.foreign_key.trim();
          const existingFk =
            initForeignKeys?.find((fk) =>
              fk.column_names
                .split(",")
                .map((s) => s.trim())
                .includes(originalColumn.column_name)
            ) ?? null;

          if (fkDef === "" && existingFk?.constraint_name) {
            if (engine === "mysql" || engine === "mariadb") {
              sqlStatements.push(
                `ALTER TABLE ${tableIdent} DROP FOREIGN KEY ${qIdent(existingFk.constraint_name, engine)};`
              );
            } else {
              sqlStatements.push(
                `ALTER TABLE ${tableIdent} DROP CONSTRAINT IF EXISTS ${qIdent(existingFk.constraint_name, engine)};`
              );
            }
            continue;
          }

          // Try to parse "schema.table(col)" or "table(col)"
          const fkMatch = fkDef.match(/^([\w.]+)\s*\(([^)]+)\)/);
          if (fkMatch) {
            const refTableFull = fkMatch[1]; // schema.table or table
            const refColRaw = fkMatch[2].split(",")[0]?.trim();
            if (refColRaw) {
              let refSchema = schema;
              let refTableName = refTableFull;
              const parts = refTableFull.split(".");
              if (parts.length === 2) {
                [refSchema, refTableName] = parts;
              }

              const constraintName =
                existingFk?.constraint_name ||
                `${tableName}_${columnName}_fkey`;

              if (existingFk?.constraint_name) {
                if (engine === "mysql" || engine === "mariadb") {
                  sqlStatements.push(
                    `ALTER TABLE ${tableIdent} DROP FOREIGN KEY ${qIdent(existingFk.constraint_name, engine)};`
                  );
                } else {
                  sqlStatements.push(
                    `ALTER TABLE ${tableIdent} DROP CONSTRAINT IF EXISTS ${qIdent(existingFk.constraint_name, engine)};`
                  );
                }
              }

              const fkSql = `ALTER TABLE ${tableIdent} ADD CONSTRAINT ${qIdent(
                constraintName,
                engine
              )} FOREIGN KEY (${qIdent(
                columnName,
                engine
              )}) REFERENCES ${qIdent(refSchema, engine)}.${qIdent(
                refTableName,
                engine
              )} (${qIdent(refColRaw, engine)});`;

              sqlStatements.push(fkSql);
            }
          }
        }
      }
    }
  }

  // Handle DELETE (drop columns)
  const deletePatches = patchMap["delete"]?.["structure"];
  if (deletePatches && initStructure) {
    for (const [rowKey] of Object.entries(deletePatches)) {
      const rowIndex = parseInt(rowKey, 10);
      if (isNaN(rowIndex) || rowIndex < 0 || rowIndex >= initStructure.length) {
        continue;
      }

      const originalColumn = initStructure[rowIndex];
      if (!originalColumn) continue;

      const sql = `ALTER TABLE ${tableIdent} DROP COLUMN ${qIdent(originalColumn.column_name, engine)};`;
      sqlStatements.push(sql);
    }
  }

  return sqlStatements;
}

/**
 * Generate SQL ALTER TABLE statements from patchMap for constraint changes
 */
export function generateConstraintSqlFromPatches(
  patchMap: PatchData,
  schema: string,
  tableName: string,
  initConstraints: TableConstraintType[] | null,
  engine: DatabaseEngine = "postgres"
): string[] {
  const sqlStatements: string[] = [];
  const tableIdent = `${qIdent(schema, engine)}.${qIdent(tableName, engine)}`;

  // Handle CREATE (new indexes/constraints)
  const createPatches = patchMap["create"]?.["constraints"];
  if (createPatches && initConstraints) {
    for (const [_rowKey, patchData] of Object.entries(createPatches)) {
      const indexName = patchData.index_name;
      const columnName = patchData.column_name;
      const isUnique = patchData.is_unique;
      const algorithm = patchData.index_algorithm;

      const uniqueClause = isUnique ? "UNIQUE " : "";
      const algorithmClause = ` USING ${algorithm || "BTREE"}`;
      const columnClause = columnName ? ` (${qIdent(columnName)})` : "";
      const sql = `CREATE ${uniqueClause}INDEX ${qIdent(indexName, engine)} ON ${tableIdent}${algorithmClause}${columnClause};`;
      sqlStatements.push(sql);
    }
  }

  // Handle UPDATE (modify existing constraints) - typically requires DROP and CREATE
  const updatePatches = patchMap["update"]?.["constraints"];
  if (updatePatches && initConstraints) {
    for (const [rowKey, patchData] of Object.entries(updatePatches)) {
      const rowIndex = parseInt(rowKey, 10);
      if (
        isNaN(rowIndex) ||
        rowIndex < 0 ||
        rowIndex >= initConstraints.length
      ) {
        continue;
      }

      const originalConstraint = initConstraints[rowIndex];
      if (!originalConstraint) continue;

      const indexName = originalConstraint.index_name;

      // For updates, we typically need to drop and recreate
      // Drop the old index
      sqlStatements.push(
        `DROP INDEX IF EXISTS ${qIdent(schema, engine)}.${qIdent(indexName, engine)};`
      );

      // Create the new index with updated properties
      const newIndexName = patchData.index_name || indexName;
      const columnName =
        patchData.column_name || originalConstraint.column_name;
      const isUnique =
        "is_unique" in patchData
          ? patchData.is_unique
          : originalConstraint.is_unique;
      const algorithm =
        patchData.index_algorithm || originalConstraint.index_algorithm;

      const uniqueClause = isUnique ? "UNIQUE " : "";
      const algorithmClause = algorithm ? `USING ${algorithm} ` : "";
      const sql = `CREATE ${uniqueClause}INDEX ${qIdent(newIndexName, engine)} ${algorithmClause}ON ${tableIdent} (${qIdent(columnName, engine)});`;
      sqlStatements.push(sql);
    }
  }

  // Handle DELETE (drop indexes/constraints)
  const deletePatches = patchMap["delete"]?.["constraints"];
  if (deletePatches && initConstraints) {
    for (const [rowKey] of Object.entries(deletePatches)) {
      const rowIndex = parseInt(rowKey, 10);
      if (
        isNaN(rowIndex) ||
        rowIndex < 0 ||
        rowIndex >= initConstraints.length
      ) {
        continue;
      }

      const originalConstraint = initConstraints[rowIndex];
      if (!originalConstraint) continue;

      const sql = `DROP INDEX IF EXISTS ${qIdent(schema, engine)}.${qIdent(originalConstraint.index_name, engine)};`;
      sqlStatements.push(sql);
    }
  }

  return sqlStatements;
}

/**
 * Generate SQL DELETE statements from patchMap for data changes
 */
export function generateDeleteSqlFromPatches(
  patchMap: PatchData,
  schema: string,
  tableName: string,
  tableData: TableDataType | null,
  constraints: TableConstraintType[] | null = null,
  engine: DatabaseEngine = "postgres"
): string[] {
  const sqlStatements: string[] = [];
  const tableIdent = `${qIdent(schema, engine)}.${qIdent(tableName, engine)}`;

  // Get delete patches for data
  const deletePatches = patchMap["delete"]?.["data"];
  if (!deletePatches || !tableData) {
    return sqlStatements;
  }

  const columns = tableData.columns;
  const rows = tableData.rows;

  // Get primary key columns if available
  const primaryKeyColumns = getPrimaryKeyColumns(constraints);
  const usePrimaryKey = primaryKeyColumns.length > 0;

  // Process each row to delete
  for (const [rowKey] of Object.entries(deletePatches)) {
    const rowIndex = parseInt(rowKey, 10);
    if (isNaN(rowIndex) || rowIndex < 0 || rowIndex >= rows.length) {
      continue;
    }

    const originalRow = rows[rowIndex];
    if (!originalRow || !Array.isArray(originalRow)) {
      continue;
    }

    // Build WHERE clause using primary key columns if available, otherwise all columns
    const whereClauses: string[] = [];
    for (let i = 0; i < columns.length; i++) {
      const col = columns[i];
      if (!col) continue;

      // Skip if using primary key and this column is not a primary key
      if (usePrimaryKey && !primaryKeyColumns.includes(col.name)) {
        continue;
      }

      const cellValue = originalRow[i];
      const originalValue = cellToString(cellValue);
      const colName = qIdent(col.name, engine);

      // Handle null/empty values
      if (
        cellValue === null ||
        cellValue === undefined ||
        originalValue === ""
      ) {
        whereClauses.push(`${colName} IS NULL`);
      } else {
        // Extract actual value from cell object if needed
        let valueToCompare: any = originalValue;
        if (typeof cellValue === "object" && cellValue !== null) {
          if ("v" in cellValue) {
            valueToCompare = (cellValue as any).v;
          } else if ((cellValue as any).t === "Null") {
            whereClauses.push(`${colName} IS NULL`);
            continue;
          }
        }
        whereClauses.push(
          `${colName} = ${formatValue(valueToCompare, col.db_type)}`
        );
      }
    }

    if (whereClauses.length === 0) {
      continue;
    }

    const sql = `DELETE FROM ${tableIdent}\nWHERE ${whereClauses.join(" AND ")};`;
    sqlStatements.push(sql);
  }

  return sqlStatements;
}

/**
 * Generate all SQL statements from patchMap
 */
export function generateSqlFromPatches(
  patchMap: PatchMap,
  engine: DatabaseEngine = "postgres",
  options?: {
    activeScreen?: string;
    getRowAt?: (key: string, rowIndex: number) => unknown[] | undefined;
  }
): string[] {
  // engine parameter is passed to individual functions for future use
  const allStatements: string[] = [];
  const { activeScreen, getRowAt } = options || {};

  for (const [_windowId, patchData] of Object.entries(patchMap)) {
    const { tableData, tableWindow, patches } = patchData;
    if (!tableData || !tableWindow || !patches) {
      continue;
    }

    const { schema, name: tableName } = tableWindow.table;
    const { structure, constraints, columns, foreignKeys } = tableData;

    // Construct TableDataType for UPDATE and DELETE operations
    // These need row data to build WHERE clauses
    let tableDataForSql: TableDataType | null = null;
    if (columns && getRowAt && activeScreen) {
      // Build rows array from getRowAt function
      // We need to get rows for all row indices that appear in patches
      const rowIndices = new Set<number>();

      // Collect all row indices from update and delete patches
      const updatePatches = patches["update"]?.["data"];
      const deletePatches = patches["delete"]?.["data"];

      if (updatePatches) {
        for (const rowKey of Object.keys(updatePatches)) {
          const rowIndex = parseInt(rowKey, 10);
          if (!isNaN(rowIndex) && rowIndex >= 0) {
            rowIndices.add(rowIndex);
          }
        }
      }

      if (deletePatches) {
        for (const rowKey of Object.keys(deletePatches)) {
          const rowIndex = parseInt(rowKey, 10);
          if (!isNaN(rowIndex) && rowIndex >= 0) {
            rowIndices.add(rowIndex);
          }
        }
      }

      if (rowIndices.size > 0) {
        // Construct table key: activeScreen.schema.tableName
        const tableKey = `${activeScreen}.${schema}.${tableName}`;
        const rows: unknown[][] = [];
        const maxIndex = Math.max(...Array.from(rowIndices), -1);

        // Build rows array - only include rows that exist
        // Use empty arrays for missing rows (functions will handle this)
        for (let i = 0; i <= maxIndex; i++) {
          const row = getRowAt(tableKey, i);
          // Push the row if it exists, otherwise push empty array
          // Functions check for array validity and will skip invalid rows
          rows.push(row ? (row as unknown[]) : []);
        }

        tableDataForSql = {
          columns,
          rows,
          rowCount: rows.length,
        };
      }
    }

    // Generate INSERT statements
    const insertStatements = generateInsertSqlFromPatches(
      patches,
      schema,
      tableName,
      engine,
      columns ?? undefined
    );
    allStatements.push(...insertStatements);

    // Generate UPDATE statements
    const updateStatements = generateUpdateSqlFromPatches(
      patches,
      schema,
      tableName,
      tableDataForSql,
      constraints,
      engine
    );
    allStatements.push(...updateStatements);

    // Generate DELETE statements
    const deleteStatements = generateDeleteSqlFromPatches(
      patches,
      schema,
      tableName,
      tableDataForSql,
      constraints,
      engine
    );
    allStatements.push(...deleteStatements);

    // Generate structure ALTER TABLE statements (should come before data changes)
    const structureStatements = generateStructureSqlFromPatches(
      patches,
      schema,
      tableName,
      structure,
      constraints,
      foreignKeys,
      engine
    );
    allStatements.push(...structureStatements);

    // Generate constraint ALTER TABLE statements
    const constraintStatements = generateConstraintSqlFromPatches(
      patches,
      schema,
      tableName,
      constraints,
      engine
    );
    allStatements.push(...constraintStatements);
  }

  return allStatements;
}

export function formatMongoScalar(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return JSON.stringify(String(v));
  }
}

export function formatMongoObject(v: Record<string, unknown>): string {
  const entries = Object.entries(v).filter(([k]) => k !== "__rowKey");
  if (entries.length === 0) return "{}";
  const parts = entries.map(([k, val]) => `${k}: ${formatMongoScalar(val)}`);
  return `{ ${parts.join(", ")} }`;
}

export function buildMongoOperations(
  patchMap: PatchMap,
  options?: {
    activeScreen?: string;
    getRowAt?: (key: string, rowIndex: number) => unknown[] | undefined;
    offset?: number;
  }
): string[] {
  const out: string[] = [];
  const { activeScreen, getRowAt, offset = 0 } = options || {};

  for (const { tableWindow, tableData, patches } of Object.values(patchMap)) {
    const db = tableWindow.table.schema;
    const coll = tableWindow.table.name;
    const ref = `db.${coll}`;
    const tableKey = activeScreen ? `${activeScreen}.${db}.${coll}` : "";

    const columns = tableData?.columns ?? [];
    const idColIdx = columns.findIndex((c) => c.name === "_id");

    const inserts = Object.values(
      (patches.create?.data ?? {}) as Record<string, Record<string, unknown>>
    );
    const updates = Object.entries(
      (patches.update?.data ?? {}) as Record<string, Record<string, unknown>>
    );
    const deletes = Object.keys(
      (patches.delete?.data ?? {}) as Record<string, Record<string, unknown>>
    );

    if (inserts.length > 0) {
      for (const doc of inserts) {
        out.push(`${ref}.insertOne(${formatMongoObject(doc)})`);
      }
    }

    if (updates.length > 0) {
      for (const [rowKey, patch] of updates) {
        const setData: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(patch)) {
          if (k === "__rowKey") continue;
          setData[k] = v;
        }

        let idExpr = "/* _id unresolved */";
        if (idColIdx >= 0 && getRowAt && tableKey) {
          const localIdx = Number(rowKey);
          const candidates = [localIdx, localIdx + offset];
          for (const idx of candidates) {
            if (!Number.isFinite(idx) || idx < 0) continue;
            const row = getRowAt(tableKey, idx);
            const idCell = row?.[idColIdx];
            const idText = cellToString(idCell);
            if (idText && idText.trim()) {
              idExpr = JSON.stringify(idText);
              break;
            }
          }
        }

        out.push(
          `${ref}.updateOne({ _id: ${idExpr} }, { $set: ${formatMongoObject(setData)} })`
        );
      }
    }

    if (deletes.length > 0) {
      const ids: string[] = [];
      if (idColIdx >= 0 && getRowAt && tableKey) {
        for (const rowKey of deletes) {
          const localIdx = Number(rowKey);
          const candidates = [localIdx, localIdx + offset];
          let found: string | null = null;
          for (const idx of candidates) {
            if (!Number.isFinite(idx) || idx < 0) continue;
            const row = getRowAt(tableKey, idx);
            const idCell = row?.[idColIdx];
            const idText = cellToString(idCell);
            if (idText && idText.trim()) {
              found = JSON.stringify(idText);
              break;
            }
          }
          if (found) ids.push(found);
        }
      }

      if (ids.length > 0) {
        out.push(`${ref}.deleteMany({ _id: { $in: [${ids.join(", ")}] } })`);
      } else {
        out.push(`${ref}.deleteMany({ _id: { $in: [/* unresolved */] } })`);
      }
    }
  }

  return out;
}
