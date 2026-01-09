export function Kebab({ className }: { className?: string }) {
  return (
    <svg
      class={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path d="M12 5.5h.01" />
      <path d="M12 12h.01" />
      <path d="M12 18.5h.01" />
    </svg>
  );
}
