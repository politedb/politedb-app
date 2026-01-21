import { useMemo } from "preact/hooks";
import { Input } from "src/components/common/Input";
import { Button } from "src/components/common/Button";
import { Trash } from "src/components/icons";
import type { DatabaseEngine, TableColumn } from "src/types";
import type { TableColumn as CommonColumn } from "src/components/common/Table";
import { DATA_TYPES } from "src/constant";

interface Props {
  columns: TableColumn[];
  busy: boolean;
  engine: DatabaseEngine;
  onChange: (index: number, field: keyof TableColumn, value: string) => void;
  onRemove: (index: number) => void;
}

export function useNewTableColumns(props: Props) {
  const { columns, busy, engine, onChange, onRemove } = props;

  const dataTypes = useMemo(
    () => DATA_TYPES[engine].map((type) => ({ label: type, value: type })),
    [engine]
  );

  return useMemo<CommonColumn<TableColumn>[]>(
    () => [
      {
        key: "column_name",
        label: "column_name",
        render: (_, row, i) => (
          <Input
            value={row.column_name}
            onInput={(e) => onChange(i, "column_name", e.currentTarget.value)}
            disabled={busy}
          />
        ),
      },
      {
        key: "data_type",
        label: "data_type",
        render: (_, row, i) => (
          <Input
            showSelect
            options={dataTypes}
            value={row.data_type}
            onValueChange={(v) => onChange(i, "data_type", v)}
            disabled={busy}
          />
        ),
      },
      {
        key: "actions",
        label: "",
        render: (_, __, i) => (
          <Button
            variant="ghost"
            onClick={() => onRemove(i)}
            disabled={busy || columns.length <= 1}
          >
            <Trash className="size-4" />
          </Button>
        ),
      },
    ],
    [columns, busy, dataTypes, onChange, onRemove]
  );
}
