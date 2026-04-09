import { SVGAttributes } from "preact";

export function Plus(props: SVGAttributes<SVGSVGElement>) {
  return (
    <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" {...props}>
      <path
        stroke-linecap="round"
        stroke-linejoin="round"
        stroke-width="3"
        d="M12 4v16m8-8H4"
      />
    </svg>
  );
}
