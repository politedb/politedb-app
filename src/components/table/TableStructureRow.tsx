import { cn } from "../../utils/cn";
import type { TableStructure } from "../../types";

interface Props {
  structure: TableStructure;
  index: number;
}

export function TableStructureRow({ structure, index }: Props) {
  const formatValue = (value: any): string => {
    if (value === null || value === undefined || value === "") return "-";
    if (typeof value === "boolean") return value ? "Yes" : "No";
    const str = String(value);
    return str.trim() || "-";
  };

  return (
    <tr
      class={cn(
        "border-b border-neutral-200 transition-colors",
        index % 2 === 0 ? "bg-white" : "bg-neutral-50",
        "hover:bg-blue-50"
      )}
    >
      <td class="px-4 py-3 text-sm font-medium text-neutral-900">
        {structure.column_name || "-"}
      </td>
      <td class="px-4 py-3 text-sm text-neutral-700">
        {structure.data_type || "-"}
      </td>
      <td class="px-4 py-3 text-sm text-neutral-700">
        {structure.is_nullable ? "Yes" : "No"}
      </td>
      <td class="px-4 py-3 text-sm text-neutral-700">
        {formatValue(structure.column_default)}
      </td>
      <td class="px-4 py-3 text-sm text-neutral-700">
        {formatValue(structure.foreign_key)}
      </td>
      <td class="px-4 py-3 text-sm text-neutral-700">
        {formatValue(structure.comment)}
      </td>
    </tr>
  );
}
