// TODO: DEPRECATED - using native window controls for now
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

const win = getCurrentWebviewWindow();

/**
 * macOS-like custom traffic lights (no shadow)
 * - size: 12px
 * - glyph: small, centered, slightly rounded caps
 * - glyph only visible on hover of the whole group (like macOS)
 */
export function WindowControls() {
  async function onClose() {
    await win.close();
  }

  async function onMinimize() {
    await win.minimize();
  }

  async function onToggleMaximize() {
    const isMax = await win.isMaximized();
    if (isMax) await win.unmaximize();
    else await win.maximize();
  }

  return (
    <div
      class="group mr-2 flex items-center gap-2"
      data-tauri-drag-region="false"
    >
      <TrafficLight
        title="Close"
        color="bg-red-500"
        glyph="close"
        onClick={onClose}
      />
      <TrafficLight
        title="Minimize"
        color="bg-yellow-500"
        glyph="minimize"
        onClick={onMinimize}
      />
      <TrafficLight
        title="Zoom"
        color="bg-green-500"
        glyph="zoom"
        onClick={onToggleMaximize}
      />
    </div>
  );
}

function TrafficLight(props: {
  title: string;
  color: string;
  glyph: "close" | "minimize" | "zoom";
  onClick: () => void;
  disabled?: boolean;
}) {
  const { title, color, glyph, onClick, disabled } = props;

  return (
    <button
      type="button"
      aria-label={title}
      title={title}
      disabled={disabled}
      data-tauri-drag-region="false"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!disabled) onClick();
      }}
      class={[
        "relative grid place-items-center",
        "h-3.5 w-3.5 rounded-full",
        color,
        // no shadow — but keep subtle border like native button edge
        // interaction
        disabled ? "opacity-50" : "active:brightness-[0.94]",
        "transition",
      ].join(" ")}
    >
      {/* Glyph only on hover of the whole controls cluster (macOS behavior) */}
      <span class="pointer-events-none absolute inset-0 hidden place-items-center group-hover:grid">
        <MacTrafficGlyph kind={glyph} />
      </span>
    </button>
  );
}

/**
 * Glyphs tuned to look closer to macOS traffic light icons:
 * - smaller than 12px circle
 * - strokes have rounded caps/joins
 * - slightly translucent dark color
 * - positioned dead-center
 */
function MacTrafficGlyph(props: { kind: "close" | "minimize" | "zoom" }) {
  const { kind } = props;

  const stroke = 1.65;
  const color = "rgba(0,0,0,0.6)";

  if (kind === "close") {
    return (
      <svg width="8" height="8" viewBox="0 0 12 12" class="block">
        <path
          d="M3.2 3.2 L8.8 8.8"
          stroke={color}
          stroke-width={stroke}
          stroke-linecap="round"
        />
        <path
          d="M8.8 3.2 L3.2 8.8"
          stroke={color}
          stroke-width={stroke}
          stroke-linecap="round"
        />
      </svg>
    );
  }

  if (kind === "minimize") {
    return (
      <svg width="8" height="8" viewBox="0 0 12 12" class="block">
        <path
          d="M3.0 6.0 L9.0 6.0"
          stroke={color}
          stroke-width={stroke}
          stroke-linecap="round"
        />
      </svg>
    );
  }

  // zoom / expand (macOS-like)
  return (
    <svg width="8" height="8" viewBox="0 0 12 12" class="block">
      {/* top-left corner */}
      <path
        d="M5.0 3.0 H3.5 C3.22 3.0 3.0 3.22 3.0 3.5 V5.0"
        fill="none"
        stroke={color}
        stroke-width={stroke}
        stroke-linecap="round"
        stroke-linejoin="round"
      />
      {/* bottom-right corner */}
      <path
        d="M7.0 9.0 H8.5 C8.78 9.0 9.0 8.78 9.0 8.5 V7.0"
        fill="none"
        stroke={color}
        stroke-width={stroke}
        stroke-linecap="round"
        stroke-linejoin="round"
      />
      {/* diagonal hint */}
      <path
        d="M4.2 7.8 L7.8 4.2"
        fill="none"
        stroke={color}
        stroke-width={stroke}
        stroke-linecap="round"
      />
    </svg>
  );
}
