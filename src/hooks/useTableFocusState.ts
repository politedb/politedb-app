import { useCallback, useEffect, useRef, useState } from "preact/hooks";

/** Track whether the table area is the active interaction target (click/focus inside). */
export function useTableFocusState() {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const [isFocused, setIsFocused] = useState(false);

  const ref = useCallback((node: HTMLDivElement | null) => {
    rootRef.current = node;
    setRoot(node);
  }, []);

  useEffect(() => {
    if (!root) return;

    const handlePointerDown = (e: MouseEvent) => {
      setIsFocused(root.contains(e.target as Node));
    };

    const handleFocusIn = () => {
      if (root.contains(document.activeElement)) {
        setIsFocused(true);
      }
    };

    document.addEventListener("mousedown", handlePointerDown, true);
    document.addEventListener("focusin", handleFocusIn);

    return () => {
      document.removeEventListener("mousedown", handlePointerDown, true);
      document.removeEventListener("focusin", handleFocusIn);
    };
  }, [root]);

  return { ref, rootRef, isFocused };
}
