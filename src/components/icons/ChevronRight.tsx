import { SVGProps } from "preact/compat";

export function ChevronRightIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" {...props}>
      <path
        stroke-linecap="round"
        stroke-linejoin="round"
        stroke-width="3"
        d="M9 5l7 7-7 7"
      />
    </svg>
  );
}
