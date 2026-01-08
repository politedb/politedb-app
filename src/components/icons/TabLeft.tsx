export function TabLeft({ className }: { className: string }) {
  return (
    <svg
      class={className}
      width="28"
      height="28"
      viewBox="0 0 28 28"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M8 4V24H24V4H8ZM4 0H24C25.0609 0 26.0783 0.421427 26.8284 1.17157C27.5786 1.92172 28 2.93913 28 4V24C28 25.0609 27.5786 26.0783 26.8284 26.8284C26.0783 27.5786 25.0609 28 24 28H4C2.93913 28 1.92172 27.5786 1.17157 26.8284C0.421427 26.0783 0 25.0609 0 24V4C0 2.93913 0.421427 1.92172 1.17157 1.17157C1.92172 0.421427 2.93913 0 4 0Z"
        fill="currentColor"
      />
    </svg>
  );
}
