import { SVGAttributes } from "preact";

export function SaveIcon(props: SVGAttributes<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="currentColor"
      {...props}
    >
      {/* outer square */}
      <rect x="3" y="3" width="18" height="18" rx="1.5" />

      {/* top label */}
      <rect x="7" y="3" width="10" height="5" fill="white" opacity="0.9" />

      {/* bottom window */}
      <rect x="7" y="13" width="10" height="6" fill="white" opacity="0.9" />

      {/* notch */}
      <rect x="14.5" y="5" width="2" height="2" fill="currentColor" />
    </svg>
  );
}
