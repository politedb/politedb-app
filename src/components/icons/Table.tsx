export function Table({ className }: { className: string }) {
  return (
    <svg
      class={className}
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
    >
      <rect
        x="4"
        y="4"
        width="16"
        height="16"
        stroke-width="2"
        stroke="currentColor"
        fill="none"
        rx="1"
      />
      <path
        stroke-linecap="round"
        stroke-linejoin="round"
        stroke-width="2"
        d="M4 12h16M12 4v16"
      />
    </svg>
  );
}
