import { cellToBinaryHexString, cellToString } from "src/utils/convert";
import { isBlobColumnType } from "src/lib/sql/sqlDialect";

export function formatTableCellValue(
  value: unknown,
  dbType?: string,
  allowNull = false
): string | null {
  return isBlobColumnType(dbType)
    ? cellToBinaryHexString(value, allowNull)
    : cellToString(value, allowNull);
}
