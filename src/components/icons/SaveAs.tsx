import { SVGAttributes } from "preact";

export function SaveAsIcon(props: SVGAttributes<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="currentColor"
      {...props}
    >
      {/* base floppy */}
      <rect x="3" y="3" width="18" height="18" rx="1.5" />

      {/* inner panels */}
      <rect x="7" y="3" width="10" height="5" fill="white" opacity="0.9" />
      <rect x="7" y="13" width="8" height="6" fill="white" opacity="0.9" />

      {/* plus badge – squared */}
      <rect x="16" y="16" width="5" height="5" rx="1" fill="white" />
      <rect x="18.25" y="16.75" width="0.5" height="3.5" fill="currentColor" />
      <rect x="16.75" y="18.25" width="3.5" height="0.5" fill="currentColor" />
    </svg>
  );
}
