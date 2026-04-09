import { SVGProps } from "preact/compat";

export function SshIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      {...props}
    >
      {/* > */}
      <path d="M4 6l6 6-6 6" />
      {/* _ */}
      <line x1="12" y1="18" x2="20" y2="18" />
    </svg>
  );
}
