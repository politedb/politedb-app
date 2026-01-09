export function Ssh(props: { className?: string }) {
  const { className = "" } = props;
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      class={className}
      aria-hidden="true"
    >
      {/* > */}
      <path d="M4 6l6 6-6 6" />
      {/* _ */}
      <line x1="12" y1="18" x2="20" y2="18" />
    </svg>
  );
}
