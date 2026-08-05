import { SVGProps } from "preact/compat";

export function ShieldAnalyticsIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" {...props}>
      <path
        d="M12 3L20 6V11.5C20 16.1 16.6 20.1 12 21C7.4 20.1 4 16.1 4 11.5V6L12 3Z"
        stroke-width="2"
        stroke-linejoin="round"
      />
      <path
        d="M9 15V11M12 15V8M15 15V12"
        stroke-width="2"
        stroke-linecap="round"
      />
    </svg>
  );
}
