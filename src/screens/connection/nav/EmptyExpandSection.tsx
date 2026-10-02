export function EmptyExpandSection({
  Icon,
  description,
}: {
  Icon: React.FunctionComponent<
    React.SVGProps<SVGSVGElement> & { className?: string }
  >;
  description: string;
}) {
  return (
    <div class="rounded-xl border border-dashed border-neutral-200 bg-white/80 px-3 py-4 text-center shadow-sm">
      <div class="mx-auto mb-2 flex size-8 items-center justify-center rounded-full bg-neutral-100">
        <Icon className="size-4 text-blue-500" />
      </div>
      <div class="text-sm font-medium text-neutral-700">{description}</div>
    </div>
  );
}
