import { SVGProps } from "preact/compat";

export function TabRightIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      width="28"
      height="28"
      viewBox="0 0 28 28"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <path
        d="M20 4H4V24H20V4ZM24 0C25.0609 0 26.0783 0.421427 26.8284 1.17157C27.5786 1.92172 28 2.93913 28 4V24C28 25.0609 27.5786 26.0783 26.8284 26.8284C26.0783 27.5786 25.0609 28 24 28H4C2.93913 28 1.92172 27.5786 1.17157 26.8284C0.421427 26.0783 0 25.0609 0 24V4C0 2.93913 0.421427 1.92172 1.17157 1.17157C1.92172 0.421427 2.93913 0 4 0L24 0Z"
        fill="currentColor"
      />
    </svg>
  );
}
