import { SVGAttributes } from "preact/compat";

export function ShareIcon(props: SVGAttributes<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" {...props}>
      <path
        d="M12 15V4m0 0 4 4m-4-4-4 4"
        stroke="currentColor"
        stroke-width="1.9"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
      <path
        d="M6.5 10.5H6a2 2 0 0 0-2 2V18a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5.5a2 2 0 0 0-2-2h-.5"
        stroke="currentColor"
        stroke-width="1.9"
        stroke-linecap="round"
      />
    </svg>
  );
}
