export function OverlayModal(props: {
  open: boolean;
  onClose: () => void;
  children: preact.ComponentChildren;
}) {
  if (!props.open) return null;

  return (
    <div
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={props.onClose}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      <div
        class="flex h-full w-full items-center justify-center overflow-hidden p-4"
        onClick={(e) => e.stopPropagation()}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
      >
        {props.children}
      </div>
    </div>
  );
}
