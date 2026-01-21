import { cn } from "src/utils/cn";
import { normalizeEngineName, normalizeTags } from "src/utils/convert";
import { DbIcon } from "src/components/icons/DbIcon";

type Props = {
  label: string;
  engine?: string;
  viaSsh?: boolean;
  tags?: string[] | string | null;
  className?: string;
};

function MetaPill({
  text,
  tone = "neutral",
}: {
  text: string;
  tone?: "neutral" | "blue";
}) {
  if (!text) return null;

  const cls =
    tone === "blue"
      ? "border-blue-200/70 bg-blue-50 text-blue-700"
      : "border-neutral-200 bg-neutral-50 text-neutral-700";

  return (
    <span
      class={cn(
        "inline-flex h-6 items-center rounded-lg border px-2",
        "text-[11px] font-semibold",
        cls
      )}
    >
      {text}
    </span>
  );
}

function SpinningDbIcon({
  engine,
  size = 28,
}: {
  engine?: string;
  size?: number;
}) {
  return (
    <div
      class="relative flex items-center justify-center"
      style={{ width: size + 10, height: size + 10 }}
    >
      {/* Spinning ring */}
      <div class="absolute inset-0 rounded-full border-2 border-neutral-200" />
      <div class="absolute inset-0 animate-spin rounded-full border-2 border-transparent border-t-blue-600" />

      {/* DB Icon */}
      <DbIcon engine={engine} px={22} className="relative z-10" />
    </div>
  );
}

export function ConnectingPanel(props: Props) {
  const { label, engine, viaSsh, tags, className } = props;

  const tagList = normalizeTags(tags).slice(0, 2);

  const engineText = normalizeEngineName(engine || "postgres", { upper: true });

  return (
    <div
      class={cn(
        "flex h-full w-full items-center justify-center p-6",
        className
      )}
    >
      <div class="w-full max-w-sm rounded-xl border border-neutral-200 bg-white p-4 shadow-[0_2px_10px_rgba(0,0,0,0.06)]">
        <div class="flex items-center gap-3">
          <SpinningDbIcon engine={engine} />

          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2">
              <p class="text-sm font-semibold text-neutral-800">Connecting</p>
              <span class="text-xs font-medium text-neutral-400">•</span>
              <p class="min-w-0 truncate text-sm font-medium text-neutral-600">
                {label}
              </p>
            </div>

            <p class="mt-0.5 text-xs text-neutral-500">
              Establishing session{viaSsh ? " via SSH" : ""}…
            </p>
          </div>
        </div>

        <div class="mt-3 flex items-center gap-2 border-t border-neutral-200 pt-3">
          <MetaPill text={engineText} />
          {viaSsh ? <MetaPill text="SSH" tone="blue" /> : null}

          {tagList.map((t) => (
            <span
              key={t}
              title={t}
              class="inline-flex h-6 max-w-32 items-center truncate rounded-lg border border-neutral-200 bg-white px-2 text-[11px] font-semibold text-neutral-600"
            >
              {t}
            </span>
          ))}
        </div>

        <div class="mt-3 h-1 overflow-hidden rounded-full bg-neutral-100">
          <div class="h-full w-1/3 animate-[connecting_1.1s_ease-in-out_infinite] rounded-full bg-blue-500" />
        </div>

        <style>
          {`
            @keyframes connecting {
              0% { transform: translateX(-120%); }
              50% { transform: translateX(80%); }
              100% { transform: translateX(220%); }
            }
          `}
        </style>
      </div>
    </div>
  );
}
