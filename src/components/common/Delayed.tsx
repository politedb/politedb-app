import { useDelayedVisibility } from "src/hooks/useDelayedVisibility";

export function Delayed(props: {
  when: boolean;
  showDelayMs?: number;
  minShowMs?: number;
  children: any;
}) {
  const visible = useDelayedVisibility(props.when, {
    showDelayMs: props.showDelayMs,
    minShowMs: props.minShowMs,
  });

  return visible ? props.children : null;
}
