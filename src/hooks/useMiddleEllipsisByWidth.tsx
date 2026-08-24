import { useEffect, useMemo, useRef, useState } from "preact/hooks";

type UseMiddleEllipsisOpts = {
  text: string;
  /** Optional: provide a font string to match actual rendered text (recommended) */
  font?: string;
};

function measureTextPx(text: string, font: string) {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) return text.length * 8; // fallback rough
  ctx.font = font;
  return ctx.measureText(text).width;
}

function middleEllipsisToFit(text: string, maxPx: number, font: string) {
  if (!text) return "";
  const ell = "…";

  // Fast path: fits already
  if (measureTextPx(text, font) <= maxPx) return text;

  // If even ellipsis doesn't fit, return empty/ellipsis
  if (measureTextPx(ell, font) > maxPx) return "";

  // Binary search number of chars kept on each side (symmetric)
  let lo = 0;
  let hi = Math.floor(text.length / 2);

  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const candidate = text.slice(0, mid) + ell + text.slice(text.length - mid);
    if (measureTextPx(candidate, font) <= maxPx) lo = mid;
    else hi = mid - 1;
  }

  return text.slice(0, lo) + ell + text.slice(text.length - lo);
}

export function useMiddleEllipsisByWidth(opts: UseMiddleEllipsisOpts): {
  ref: (el: HTMLElement | null) => void;
  value: string;
} {
  const { text, font } = opts;

  const elRef = useRef<HTMLElement | null>(null);
  const [width, setWidth] = useState(0);

  const setRef = (el: HTMLElement | null) => {
    elRef.current = el;
    if (el) setWidth(el.clientWidth || 0);
  };

  useEffect(() => {
    const el = elRef.current;
    if (!el) return;

    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect?.width ?? el.clientWidth ?? 0;
      setWidth(Math.floor(w));
    });

    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const computedFont = useMemo(() => {
    if (font) return font;
    const el = elRef.current;
    if (!el) return "12px system-ui";
    const cs = getComputedStyle(el);
    // Match how browser measures: "font" includes weight/size/family etc.
    return cs.font || `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [font, width]); // width change ensures ref computed style ready

  const value = useMemo(() => {
    // Small padding so we don't touch the edge
    const maxPx = Math.max(0, width - 6);
    return middleEllipsisToFit(text, maxPx, computedFont);
  }, [text, width, computedFont]);

  return { ref: setRef, value };
}
