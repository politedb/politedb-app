import { SVGAttributes } from "preact";

export function PlayIcon(props: SVGAttributes<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="currentColor"
      {...props}
    >
      <polygon points="6 4 20 12 6 20 6 4" />
    </svg>
  );
}
