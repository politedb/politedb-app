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
      class={[
        "grid grid-cols-[100px_1fr] gap-3",
        alignTop ? "items-start" : "items-center",
        className || "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <div
        class={[
          "text-sm font-medium text-slate-700",
          alignTop ? "pt-2" : "",
          labelClassName || "",
        ]
          .filter(Boolean)
          .join(" ")}
      >
        {label}
      </div>
      <div class={contentClassName || ""}>{children}</div>
    </div>
  );
}
