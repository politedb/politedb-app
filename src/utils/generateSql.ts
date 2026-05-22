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
import {
  addColumnSql,
  addForeignKeySql,
  addPrimaryKeySql,
  alterColumnStatements,
  createIndexSql,
  dropColumnSql,
  dropForeignKeySql,
  dropIndexSql,
  dropPrimaryKeySql,
  formatSqlValue,
  isBlobColumnType,
  isJsonColumnType,
  quoteIdentifier,
  quoteTableName,
  clickhouseDeleteSql,
  clickhouseUpdateSql,
  renameColumnSql,
  renameTableSql,
  sqlStringLiteral,
} from "./sqlDialect";

// patchMap[action][dataKey][rowKey] = data
export type PatchData = Record<string, Record<string, Record<string, any>>>;

export type PatchMap = {
  [windowId: string]: {
    tableData: TableDataState;
    tableWindow: TableWindow;
    patches: PatchData;
  };
};

const qIdent = quoteIdentifier;
const qLiteral = sqlStringLiteral;
const formatValue = formatSqlValue;

function isUnsafeFallbackWhereColumn(dbType: string | undefined) {
  if (!dbType) return false;
  if (isBlobColumnType(dbType)) return true;
  return isJsonColumnType(dbType);
}

function isVirtualIdentityColumn(dbType: string | undefined) {
  return !isUnsafeFallbackWhereColumn(dbType);
}

export type VirtualKeySafetyIssue = {
  tableKey: string;
  schema: string;
  tableName: string;
  action: "update" | "delete";
  rowKey: string;
  kind: "virtual-key" | "blocked";
  columns: string[];
  message: string;
};

function virtualIdentityColumns(columns: TableDataType["columns"]): string[] {
  return columns
    .filter((col) => isVirtualIdentityColumn(col.db_type))
    .map((col) => col.name)
    .filter(Boolean);
}

function assertSafeRowIdentity(args: {
  schema: string;
  tableName: string;
  columns: TableDataType["columns"];
  constraints: TableConstraintType[] | null | undefined;
  action: "update" | "delete";
  rowKey: string;
}): string[] {
  const primaryKeyColumns = getPrimaryKeyColumns(args.constraints);
  if (primaryKeyColumns.length > 0) return primaryKeyColumns;

  const virtualColumns = virtualIdentityColumns(args.columns);
  if (virtualColumns.length === 0) {
    throw new Error(
      `TABLE_EDIT_UNSAFE_IDENTITY: Cannot ${args.action} row ${args.rowKey} in ${args.schema}.${args.tableName} because the table has no primary key and no safe non-JSON/non-BLOB virtual key columns. Choose a primary key or virtual key before saving.`
    );
  }

  return virtualColumns;
}

export function analyzePatchIdentitySafety(
  patchMap: PatchMap,
  _engine: DatabaseEngine = "postgres"
): VirtualKeySafetyIssue[] {
  const issues: VirtualKeySafetyIssue[] = [];

  for (const [_windowId, patchData] of Object.entries(patchMap)) {
    const { tableData, tableWindow, patches } = patchData;
    if (!tableData || !tableWindow || !patches) continue;

    const columns = tableData.columns ?? [];
    if (!columns.length) continue;

    const primaryKeyColumns = getPrimaryKeyColumns(tableData.constraints);
    if (primaryKeyColumns.length > 0) continue;

    const { schema, name: tableName } = tableWindow.table;
    const tableKey = `${schema}.${tableName}`;
    const virtualColumns = virtualIdentityColumns(columns);
    const updateRows = Object.keys(patches.update?.data ?? {});
    const deleteRows = Object.keys(patches.delete?.data ?? {});

    for (const [action, rowKeys] of [
      ["update", updateRows],
      ["delete", deleteRows],
    ] as const) {
      for (const rowKey of rowKeys) {
        if (virtualColumns.length === 0) {
          issues.push({
            tableKey,
            schema,
            tableName,
            action,
            rowKey,
            kind: "blocked",
            columns: [],
            message: `Cannot ${action} row ${rowKey} in ${tableKey}: no primary key and no safe non-JSON/non-BLOB virtual key columns.`,
          });
          continue;
        }

        issues.push({
          tableKey,
          schema,
          tableName,
          action,
          rowKey,
          kind: "virtual-key",
          columns: virtualColumns,
          message: `${tableKey} has no primary key; ${action} row ${rowKey} will match by virtual key columns: ${virtualColumns.join(", ")}.`,
        });
      }
    }
  }

  return issues;
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
  const tableIdent = quoteTableName(schema, tableName, engine);

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

  if (!usePrimaryKey) {
    assertSafeRowIdentity({
      schema,
      tableName,
      columns,
      constraints,
      action: "update",
      rowKey: "*",
    });
  }

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
        `${qIdent(colName, engine)} = ${formatValue(newValue, col.db_type, engine)}`
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
      if (!usePrimaryKey && !isVirtualIdentityColumn(col.db_type)) {
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
          `${colName} = ${formatValue(valueToCompare, col.db_type, engine)}`
        );
      }
    }

    if (whereClauses.length === 0) {
      continue;
    }

    const sql =
      engine === "clickhouse"
        ? clickhouseUpdateSql(schema, tableName, setClauses, whereClauses)
        : `UPDATE ${tableIdent}\nSET ${setClauses.join(", ")}\nWHERE ${whereClauses.join(" AND ")};`;
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
  const tableIdent = quoteTableName(schema, tableName, engine);

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
      values.push(formatValue(value, col?.db_type, engine));
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
  engine: DatabaseEngine = "postgres",
  opts: { includeForeignKeys?: boolean } = {}
): string[] {
  const sqlStatements: string[] = [];
  const includeForeignKeys = opts.includeForeignKeys !== false;

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
          columnDef += ` DEFAULT ${qLiteral(defaultVal, engine)}`;
        }
      }

      sqlStatements.push(addColumnSql(schema, tableName, columnDef, engine));
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
          renameTableSql(schema, tableName, metadataPatch.tableName, engine)
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
              dropPrimaryKeySql(
                schema,
                tableName,
                existingPkConstraint.index_name,
                engine
              )
            );
          }

          // Add new primary key if columns are specified
          if (newPrimaryKey.length > 0) {
            sqlStatements.push(
              addPrimaryKeySql(schema, tableName, newPrimaryKey, engine)
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
          sqlStatements.push(
            renameColumnSql(schema, tableName, oldName, newName, engine)
          );
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

        let dataType: string | undefined;
        let nullable: boolean | undefined;
        let defaultExpression: string | null | undefined;

        // Handle data type change
        if (
          patchData.data_type &&
          patchData.data_type !== originalColumn.data_type
        ) {
          dataType = patchData.data_type;
        }

        // Handle nullable change
        if (
          "is_nullable" in patchData &&
          patchData.is_nullable !== originalColumn.is_nullable
        ) {
          if (patchData.is_nullable) {
            nullable = true;
          } else {
            nullable = false;
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
            defaultExpression = null;
          } else {
            const defaultVal = patchData.column_default.trim();
            if (
              defaultVal.match(/^[A-Z_][A-Z0-9_]*\(\)$/) ||
              defaultVal.match(/^[0-9]+$/) ||
              defaultVal.toUpperCase() === "NULL"
            ) {
              defaultExpression = defaultVal;
            } else {
              defaultExpression = qLiteral(defaultVal, engine);
            }
          }
        }

        if (
          dataType !== undefined ||
          nullable !== undefined ||
          defaultExpression !== undefined
        ) {
          sqlStatements.push(
            ...alterColumnStatements({
              schema,
              tableName,
              columnName,
              dataType,
              nullable,
              defaultExpression,
              engine,
            })
          );
        }

        // Handle foreign key definition changes stored on the column's `foreign_key` field.
        // For now we support simple single-column FKs in the form "ref_table(ref_column)"
        // or "ref_schema.ref_table(ref_column)" for Postgres/MySQL engines.
        const dbConfig = getDbConfig(engine);
        if (
          includeForeignKeys &&
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
            sqlStatements.push(
              dropForeignKeySql(
                schema,
                tableName,
                existingFk.constraint_name,
                engine
              )
            );
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
                sqlStatements.push(
                  dropForeignKeySql(
                    schema,
                    tableName,
                    existingFk.constraint_name,
                    engine
                  )
                );
              }

              sqlStatements.push(
                addForeignKeySql({
                  schema,
                  tableName,
                  constraintName,
                  columnName,
                  refSchema,
                  refTableName,
                  refColumnName: refColRaw,
                  engine,
                })
              );
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

      sqlStatements.push(
        dropColumnSql(schema, tableName, originalColumn.column_name, engine)
      );
    }
  }

  return sqlStatements;
}

export function generateForeignKeySqlFromPatches(
  patchMap: PatchData,
  schema: string,
  tableName: string,
  initStructure: TableStructureType[] | null,
  initForeignKeys: ForeignKeyInfo[] | null = null,
  engine: DatabaseEngine = "postgres"
): string[] {
  if (!initStructure) return [];

  const sqlStatements: string[] = [];
  const updatePatches = patchMap["update"]?.["structure"];
  const dbConfig = getDbConfig(engine);

  if (!updatePatches || !dbConfig.allowFk) {
    return sqlStatements;
  }

  for (const [rowKey, patchData] of Object.entries(updatePatches)) {
    const rowIndex = parseInt(rowKey, 10);
    if (isNaN(rowIndex) || rowIndex < 0 || rowIndex >= initStructure.length) {
      continue;
    }

    const originalColumn = initStructure[rowIndex];
    if (!originalColumn) continue;

    if (
      !("foreign_key" in patchData) ||
      patchData.foreign_key === undefined ||
      patchData.foreign_key === originalColumn.foreign_key ||
      typeof patchData.foreign_key !== "string"
    ) {
      continue;
    }

    const columnName =
      patchData.column_name &&
      patchData.column_name !== originalColumn.column_name &&
      patchData.column_name.trim() !== ""
        ? patchData.column_name.trim()
        : originalColumn.column_name;
    const fkDef = patchData.foreign_key.trim();
    const existingFk =
      initForeignKeys?.find((fk) =>
        fk.column_names
          .split(",")
          .map((s) => s.trim())
          .includes(originalColumn.column_name)
      ) ?? null;

    if (fkDef === "" && existingFk?.constraint_name) {
      sqlStatements.push(
        dropForeignKeySql(schema, tableName, existingFk.constraint_name, engine)
      );
      continue;
    }

    const fkMatch = fkDef.match(/^([\w.]+)\s*\(([^)]+)\)/);
    if (!fkMatch) continue;

    const refTableFull = fkMatch[1];
    const refColRaw = fkMatch[2].split(",")[0]?.trim();
    if (!refColRaw) continue;

    let refSchema = schema;
    let refTableName = refTableFull;
    const parts = refTableFull.split(".");
    if (parts.length === 2) {
      [refSchema, refTableName] = parts;
    }

    const constraintName =
      existingFk?.constraint_name || `${tableName}_${columnName}_fkey`;

    if (existingFk?.constraint_name) {
      sqlStatements.push(
        dropForeignKeySql(schema, tableName, existingFk.constraint_name, engine)
      );
    }

    sqlStatements.push(
      addForeignKeySql({
        schema,
        tableName,
        constraintName,
        columnName,
        refSchema,
        refTableName,
        refColumnName: refColRaw,
        engine,
      })
    );
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

  // Handle CREATE (new indexes/constraints)
  const createPatches = patchMap["create"]?.["constraints"];
  if (createPatches && initConstraints) {
    for (const [_rowKey, patchData] of Object.entries(createPatches)) {
      const indexName = patchData.index_name;
      const columnName = patchData.column_name;
      const isUnique = patchData.is_unique;
      const algorithm = patchData.index_algorithm;

      if (!columnName) continue;
      sqlStatements.push(
        createIndexSql({
          schema,
          tableName,
          indexName,
          columnName,
          unique: isUnique,
          algorithm: algorithm || "BTREE",
          engine,
        })
      );
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
      sqlStatements.push(dropIndexSql(schema, tableName, indexName, engine));

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

      sqlStatements.push(
        createIndexSql({
          schema,
          tableName,
          indexName: newIndexName,
          columnName,
          unique: isUnique,
          algorithm,
          engine,
        })
      );
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

      sqlStatements.push(
        dropIndexSql(schema, tableName, originalConstraint.index_name, engine)
      );
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
  const tableIdent = quoteTableName(schema, tableName, engine);

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

  if (!usePrimaryKey) {
    assertSafeRowIdentity({
      schema,
      tableName,
      columns,
      constraints,
      action: "delete",
      rowKey: "*",
    });
  }

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
      if (!usePrimaryKey && !isVirtualIdentityColumn(col.db_type)) {
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
          `${colName} = ${formatValue(valueToCompare, col.db_type, engine)}`
        );
      }
    }

    if (whereClauses.length === 0) {
      continue;
    }

    const sql =
      engine === "clickhouse"
        ? clickhouseDeleteSql(schema, tableName, whereClauses)
        : `DELETE FROM ${tableIdent}\nWHERE ${whereClauses.join(" AND ")};`;
    sqlStatements.push(sql);
  }

  return sqlStatements;
}

export type PatchSqlPlan = {
  preData: string[];
  data: string[];
  postData: string[];
};

export type PatchSqlPlanOptions = {
  activeScreen?: string;
  getRowAt?: (key: string, rowIndex: number) => unknown[] | undefined;
  /** Prefer cached DB rows over optimistic in-grid edits when building WHERE clauses. */
  getOriginalRowAt?: (key: string, rowIndex: number) => unknown[] | undefined;
  offset?: number;
};

function tableDataForPatchSql(args: {
  activeScreen?: string;
  getRowAt?: (key: string, rowIndex: number) => unknown[] | undefined;
  getOriginalRowAt?: (key: string, rowIndex: number) => unknown[] | undefined;
  offset?: number;
  schema: string;
  tableName: string;
  columns: TableDataState["columns"];
  patches: PatchData;
}): TableDataType | null {
  const {
    activeScreen,
    getRowAt,
    getOriginalRowAt,
    offset = 0,
    schema,
    tableName,
    columns,
    patches,
  } = args;
  const resolveRow = getOriginalRowAt ?? getRowAt;
  if (!columns || !resolveRow || !activeScreen) return null;

  const rowIndices = new Set<number>();
  const updatePatches = patches["update"]?.["data"];
  const deletePatches = patches["delete"]?.["data"];

  if (updatePatches) {
    for (const rowKey of Object.keys(updatePatches)) {
      const rowIndex = parseInt(rowKey, 10);
      if (!isNaN(rowIndex) && rowIndex >= 0) rowIndices.add(rowIndex);
    }
  }

  if (deletePatches) {
    for (const rowKey of Object.keys(deletePatches)) {
      const rowIndex = parseInt(rowKey, 10);
      if (!isNaN(rowIndex) && rowIndex >= 0) rowIndices.add(rowIndex);
    }
  }

  if (rowIndices.size === 0) return null;

  const tableKey = `${activeScreen}.${schema}.${tableName}`;
  const rows: unknown[][] = [];
  const maxIndex = Math.max(...Array.from(rowIndices), -1);

  for (let i = 0; i <= maxIndex; i++) {
    const row =
      resolveRow(tableKey, i + offset) ??
      (offset === 0 ? undefined : resolveRow(tableKey, i));
    rows.push(row ? (row as unknown[]) : []);
  }

  return {
    columns,
    rows,
    rowCount: rows.length,
  };
}

export function flattenPatchSqlPlan(plan: PatchSqlPlan): string[] {
  return [...plan.preData, ...plan.data, ...plan.postData];
}

export function generateSqlPlanFromPatches(
  patchMap: PatchMap,
  engine: DatabaseEngine = "postgres",
  options?: PatchSqlPlanOptions
): PatchSqlPlan {
  const plan: PatchSqlPlan = { preData: [], data: [], postData: [] };
  const { activeScreen, getRowAt, getOriginalRowAt, offset } = options || {};

  for (const [_windowId, patchData] of Object.entries(patchMap)) {
    const { tableData, tableWindow, patches } = patchData;
    if (!tableData || !tableWindow || !patches) {
      continue;
    }

    const { schema, name: tableName } = tableWindow.table;
    const { structure, constraints, columns, foreignKeys } = tableData;

    const tableDataForSql = tableDataForPatchSql({
      activeScreen,
      getRowAt,
      getOriginalRowAt,
      offset,
      schema,
      tableName,
      columns,
      patches,
    });

    plan.preData.push(
      ...generateStructureSqlFromPatches(
        patches,
        schema,
        tableName,
        structure,
        constraints,
        foreignKeys,
        engine,
        { includeForeignKeys: false }
      )
    );

    plan.data.push(
      ...generateInsertSqlFromPatches(
        patches,
        schema,
        tableName,
        engine,
        columns ?? undefined
      ),
      ...generateUpdateSqlFromPatches(
        patches,
        schema,
        tableName,
        tableDataForSql,
        constraints,
        engine
      ),
      ...generateDeleteSqlFromPatches(
        patches,
        schema,
        tableName,
        tableDataForSql,
        constraints,
        engine
      )
    );

    plan.postData.push(
      ...generateForeignKeySqlFromPatches(
        patches,
        schema,
        tableName,
        structure,
        foreignKeys,
        engine
      ),
      ...generateConstraintSqlFromPatches(
        patches,
        schema,
        tableName,
        constraints,
        engine
      )
    );
  }

  return plan;
}

/**
 * Generate all SQL statements from patchMap.
 * Kept for existing callers; returns pre-data DDL, data DML, then post-data
 * constraints/index/FK SQL in execution order.
 */
export function generateSqlFromPatches(
  patchMap: PatchMap,
  engine: DatabaseEngine = "postgres",
  options?: PatchSqlPlanOptions
): string[] {
  return flattenPatchSqlPlan(
    generateSqlPlanFromPatches(patchMap, engine, options)
  );
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
