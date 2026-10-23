import { SVGProps } from "preact/compat";

export function ChevronsRightIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" {...props}>
      <path
        stroke-linecap="round"
        stroke-linejoin="round"
        stroke-width="3"
        d="M6 5l7 7-7 7M13 5l7 7-7 7"
      />
    </svg>
  );
}
