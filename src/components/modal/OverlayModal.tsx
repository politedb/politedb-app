export function OverlayModal(props: {
  open: boolean;
  onClose: () => void;
  children: preact.ComponentChildren;
}) {
  if (!props.open) return null;

  return (
    <div
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={props.onClose}
    >
      <div
        class="max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {props.children}
      </div>
    </div>
  );
}
