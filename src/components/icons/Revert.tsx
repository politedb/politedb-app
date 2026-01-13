import { SVGAttributes } from "preact";

export function RevertIcon(props: SVGAttributes<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      {...props}
    >
      <path d="M3 7v6h6" />
      <path d="M21 17a9 9 0 0 0-15-6l-3 3" />
    </svg>
  );
}
