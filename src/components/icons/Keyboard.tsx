import { SVGProps } from "preact/compat";

export function KeyboardIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" {...props}>
      <rect x="3" y="5" width="18" height="14" rx="2" stroke-width="2" />
      <path
        d="M7 9H7.01M10 9H10.01M13 9H13.01M16 9H16.01M7 12H7.01M10 12H10.01M13 12H13.01M16 12H16.01M8 15H16"
        stroke-width="2"
        stroke-linecap="round"
      />
    </svg>
  );
}
