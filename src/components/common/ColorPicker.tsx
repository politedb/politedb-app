import { cn } from "src/utils/cn";

const PRESET_COLORS = [
  "",
  "#CBD5E1", // gray
  "#93C5FD", // blue
  "#FDE68A", // yellow
  "#BBF7D0", // green
  "#FBCFE8", // pink
] as const;

export function ColorPicker(props: {
  value: string;
  onChange: (color: string) => void;
}) {
  const { value, onChange } = props;

  const isCustom =
    value && !PRESET_COLORS.includes(value as (typeof PRESET_COLORS)[number]);

  return (
    <div class="flex items-center gap-2">
      {/* Preset colors */}
      {PRESET_COLORS.map((c) => {
        const selected = value.toUpperCase() === c.toUpperCase();
        return (
          <button
            key={c || "none"}
            type="button"
            onClick={() => onChange(c)}
            title={c || "None"}
            class={cn(
              "h-9 w-9 rounded-xl border transition-all duration-150",
              "hover:scale-[1.05] active:scale-100",
              selected
                ? "border-blue-400 ring-2 ring-blue-200"
                : "border-slate-200 hover:bg-slate-50"
            )}
            style={{ background: c || "transparent" }}
          />
        );
      })}

      {/* Custom color */}
      <label
        title="Pick custom color"
        class={cn(
          "group relative h-9 w-9 rounded-xl border",
          "transition-all duration-150",
          "hover:scale-[1.05] hover:ring-2 hover:ring-blue-200",
          isCustom
            ? "border-blue-400 ring-2 ring-blue-200"
            : "border-slate-200 bg-white"
        )}
      >
        <input
          type="color"
          value={isCustom ? value : "#000000"}
          onInput={(e) => onChange((e.currentTarget as HTMLInputElement).value)}
          class="absolute inset-0 opacity-0"
        />

        {/* Visual layer */}
        <div
          class="flex h-full w-full items-center justify-center rounded-xl"
          style={{
            background: isCustom
              ? value
              : "conic-gradient(red, yellow, lime, cyan, blue, magenta, red)",
          }}
        >
          {!isCustom && (
            <span class="text-xs opacity-70 transition group-hover:opacity-100">
              🎨
            </span>
          )}
        </div>
      </label>
    </div>
  );
}
