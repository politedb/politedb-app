import { SVGProps } from "preact/compat";

export function SquareFunctionIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <path
        d="M8 15.889C8.15 16.42 8.455 17 9.25 17C10.625 17 10.969 15.889 12 12C13.031 8.111 13.375 7 14.75 7C15.545 7 15.85 7.58 16 8.111M10.333 10.611H14.75"
        stroke="currentColor"
        stroke-width="1.5"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
      <path
        d="M2.5 12C2.5 7.522 2.5 5.282 3.891 3.891C5.282 2.5 7.521 2.5 12 2.5C16.478 2.5 18.718 2.5 20.109 3.891C21.5 5.282 21.5 7.521 21.5 12C21.5 16.478 21.5 18.718 20.109 20.109C18.718 21.5 16.479 21.5 12 21.5C7.522 21.5 5.282 21.5 3.891 20.109C2.5 18.718 2.5 16.479 2.5 12Z"
        stroke="currentColor"
        stroke-width="1.5"
        stroke-linejoin="round"
      />
    </svg>
  );
}
