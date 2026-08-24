import { useEffect, useMemo } from "preact/hooks";
import { useForm } from "react-hook-form";
import type { ForeignKeyInfo } from "src/types";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "src/components/common/Dialog";
import { Button } from "src/components/common/Button";
import { Field } from "src/components/form";
import { Select } from "src/components/common/Select";
import { tableKey, useLoadTableData } from "src/hooks/useLoadTableData";
import { useConnectionStore } from "src/stores/connection";

const REFERENTIAL_ACTIONS = [
  "NO ACTION",
  "RESTRICT",
  "CASCADE",
  "SET NULL",
  "SET DEFAULT",
];

type FormValues = {
  refTable: string;
  refColumn: string;
  onUpdate: string;
  onDelete: string;
};

export function ForeignKeyDialog(props: {
  open: boolean;
  onClose: () => void;
  fk: ForeignKeyInfo | null;
  tableName: string;
  schema: string;
  tableList: { schema: string; name: string }[];
  originColumn: string;
  activeScreen: string;
  onDelete?: () => void;
  onSave?: (fk: Partial<ForeignKeyInfo>) => void;
}) {
  const {
    open,
    fk,
    tableName,
    schema,
    tableList,
    originColumn,
    activeScreen,
    onClose,
    onDelete,
    onSave,
  } = props;

  const defaultValues = useMemo(
    () => ({
      refTable: fk?.ref_table_name ?? "",
      refColumn: fk?.ref_column_names ?? "",
      onUpdate: fk?.on_update ?? "NO ACTION",
      onDelete: fk?.on_delete ?? "NO ACTION",
    }),
    [fk]
  );

  const {
    handleSubmit,
    watch,
    setValue,
    formState: { isDirty },
  } = useForm<FormValues>({
    mode: "onSubmit",
    defaultValues,
  });

  const {
    refTable,
    refColumn,
    onUpdate,
    onDelete: onDeleteAction,
  } = watch() ?? {};

  const { loadTableData } = useLoadTableData();
  const tableDataMap = useConnectionStore((s) => s.tableDataMap);

  const refKey = useMemo(
    () => (refTable ? refTable : defaultValues.refTable) ?? "",
    [refTable, defaultValues.refTable]
  );

  const tableColumns = useMemo(() => {
    if (!refKey) return [];
    const key = tableKey(activeScreen, schema, refKey);
    const data = tableDataMap[key];
    return data?.columns ?? [];
  }, [activeScreen, schema, tableDataMap, refKey]);

  useEffect(() => {
    const loadTableMetadata = async () => {
      if (!refKey) return;
      const key = tableKey(activeScreen, schema, refKey);
      const data = tableDataMap[key];
      if (!data) {
        await loadTableData(schema, refKey);
      }
    };
    loadTableMetadata();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    activeScreen,
    schema,
    refKey,
    loadTableData,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    JSON.stringify(tableDataMap),
  ]);

  const onSubmit = (values: FormValues) => {
    if (onSave) {
      onSave({
        table_name: tableName,
        table_schema: schema,
        column_names: originColumn,
        ref_table_schema: schema,
        ref_table_name: values.refTable,
        ref_column_names: values.refColumn,
        on_update: values.onUpdate || "NO ACTION",
        on_delete: values.onDelete || "NO ACTION",
      });
    }
    onClose();
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="sm"
      showCloseButton={true}
      closeOnOutsideClick={true}
    >
      <DialogHeader>
        <DialogTitle>Foreign Key</DialogTitle>
        <DialogDescription>Configure the foreign key.</DialogDescription>
      </DialogHeader>
      <DialogContent className="gap-4 pt-0">
        <Field className="grid-cols-[120px_1fr]" label="Table">
          <p class="text-sm font-medium text-neutral-600">
            {fk?.table_name ?? tableName}
          </p>
        </Field>
        <Field className="grid-cols-[120px_1fr]" label="Columns">
          <p class="text-sm font-medium text-neutral-600">{originColumn}</p>
        </Field>
        <Field className="grid-cols-[120px_1fr]" label="Referenced Table">
          <Select
            value={refTable ?? ""}
            class="text-sm! font-medium! text-neutral-600!"
            onChange={(e) => {
              const v = (e.target as HTMLSelectElement).value;
              setValue("refTable", v, { shouldDirty: true });
            }}
          >
            <option value="" disabled>
              Select a table...
            </option>
            {tableList.map((t) => (
              <option key={t.name} value={t.name}>
                {t.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field className="grid-cols-[120px_1fr]" label="Referenced Columns">
          <Select
            value={refColumn ?? ""}
            class="text-sm! font-medium! text-neutral-600!"
            onChange={(e) =>
              setValue("refColumn", (e.target as HTMLSelectElement).value, {
                shouldDirty: true,
              })
            }
          >
            <option value="" disabled>
              Select a column...
            </option>
            {tableColumns.map((c) => (
              <option key={c.name} value={c.name}>
                {c.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field className="grid-cols-[120px_1fr]" label="On Update">
          <Select
            value={onUpdate ?? "NO ACTION"}
            class="text-sm! font-medium! text-neutral-600!"
            onChange={(e) =>
              setValue("onUpdate", (e.target as HTMLSelectElement).value, {
                shouldDirty: true,
              })
            }
          >
            {REFERENTIAL_ACTIONS.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </Select>
        </Field>
        <Field className="grid-cols-[120px_1fr]" label="On Delete">
          <Select
            value={onDeleteAction ?? "NO ACTION"}
            class="text-sm! font-medium! text-neutral-600!"
            onChange={(e) =>
              setValue("onDelete", (e.target as HTMLSelectElement).value, {
                shouldDirty: true,
              })
            }
          >
            {REFERENTIAL_ACTIONS.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </Select>
        </Field>
      </DialogContent>
      <DialogFooter className="justify-end pt-1">
        {onDelete && fk && (
          <Button variant="outline" onClick={onDelete}>
            Delete
          </Button>
        )}
        <Button
          className="px-6!"
          variant="default"
          onClick={handleSubmit(onSubmit)}
          disabled={!isDirty}
        >
          OK
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
