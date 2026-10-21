import { cn } from "src/utils/cn";

export function Field(props: {
  label: string;
  children: any;
  alignTop?: boolean;
  className?: string;
  labelClassName?: string;
  contentClassName?: string;
}) {
  const {
    label,
    children,
    alignTop,
    className,
    labelClassName,
    contentClassName,
  } = props;

  return (
    <div
      class={cn(
        "grid grid-cols-[100px_1fr] gap-3",
        alignTop ? "items-start" : "items-center",
        className || ""
      )}
    >
      <div
        class={cn(
          "text-sm font-medium text-slate-700",
          alignTop ? "pt-2" : "",
          labelClassName || ""
        )}
      >
        {label}
      </div>
      <div class={cn(contentClassName || "")}>{children}</div>
    </div>
  );
}
