export function OverlayModal(props: {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const { open, onClose, children } = props;
  if (!open) return null;

  return (
    <div
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div class="flex-1 overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
  );
}
