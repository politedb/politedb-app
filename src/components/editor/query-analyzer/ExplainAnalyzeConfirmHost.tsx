import { useEffect, useRef, useState } from "preact/hooks";
import { Button } from "src/components/common/Button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "src/components/common/Dialog";
import {
  EXPLAIN_ANALYZE_CONFIRMATION,
  EXPLAIN_ANALYZE_NOTES,
} from "src/lib/query-analyzer/explainAnalyzeMessages";
import { useExplainAnalyzeConfirmStore } from "src/stores/explainAnalyzeConfirm";

/**
 * Confirmation before Explain Analyze runs a statement; mounted once in the
 * main layout. Cancel has focus, so Enter, Escape and the backdrop all cancel;
 * running needs a click (or Tab then Enter) on "Run Explain Analyze". While
 * it is open, keyboard input stays in the dialog and focus returns to where
 * it was afterwards.
 */
export function ExplainAnalyzeConfirmHost() {
  // Subscribe directly, like useProGate, without zustand's React adapter.
  const [pending, setPending] = useState(
    () => useExplainAnalyzeConfirmStore.getState().pending
  );
  useEffect(
    () =>
      useExplainAnalyzeConfirmStore.subscribe((store) =>
        setPending(store.pending)
      ),
    []
  );
  const answer = useExplainAnalyzeConfirmStore.getState().answer;
  const cancel = () => answer(false);

  // Button does not forward refs; find the buttons inside the footer.
  const footerRef = useRef<HTMLDivElement>(null);
  const open = !!pending;
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const buttons = () =>
      Array.from(
        footerRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? []
      );
    const focusCancel = () =>
      footerRef.current
        ?.querySelector<HTMLButtonElement>("[data-default-action]")
        ?.focus();
    focusCancel();

    // While open, no key reaches the workspace (Save, Close, Search,
    // snippets, the editor). Window capture runs before all bubble and
    // document listeners (only window capture listeners added earlier, such
    // as a shortcut recorder, would run first); the focused button still
    // activates on Enter/Space, since that is its default action.
    const onKeyDown = (event: KeyboardEvent) => {
      event.stopImmediatePropagation();
      const list = buttons();
      const index = list.indexOf(document.activeElement as HTMLButtonElement);
      if (event.key === "Escape") {
        event.preventDefault();
        useExplainAnalyzeConfirmStore.getState().answer(false);
        return;
      }
      if (event.key === "Tab") {
        // Keep focus on the dialog's buttons.
        event.preventDefault();
        if (!list.length) return;
        const step = event.shiftKey ? -1 : 1;
        const next = index < 0 ? 0 : (index + step + list.length) % list.length;
        list[next]?.focus();
        return;
      }
      if (index < 0 && (event.key === "Enter" || event.key === " ")) {
        // Focus left the buttons (a click on the statement text): Enter
        // goes back to Cancel instead of acting on anything else.
        event.preventDefault();
        focusCancel();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      if (previous?.isConnected) previous.focus();
    };
  }, [open]);

  return (
    <Dialog open={!!pending} onClose={cancel} size="md" showCloseButton={false}>
      <DialogHeader className="pt-5 pb-0">
        <DialogTitle>Run Explain Analyze?</DialogTitle>
      </DialogHeader>
      <DialogContent className="gap-3 text-sm text-neutral-700">
        {pending?.target ? (
          <p>
            <span class="text-neutral-500">Connection: </span>
            <span class="font-medium text-neutral-900">{pending.target}</span>
          </p>
        ) : null}
        <pre class="max-h-28 overflow-auto rounded-md border border-neutral-200 bg-neutral-50 px-2.5 py-2 font-mono text-xs whitespace-pre-wrap text-neutral-800">
          {pending?.statement}
        </pre>
        <p>{EXPLAIN_ANALYZE_CONFIRMATION}</p>
        <ul class="list-disc space-y-1 pl-5 text-neutral-600">
          {EXPLAIN_ANALYZE_NOTES.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      </DialogContent>
      <div ref={footerRef}>
        <DialogFooter>
          <Button
            data-default-action
            variant="outline"
            className="py-1.5"
            onClick={cancel}
          >
            Cancel
          </Button>
          <Button
            variant="default"
            className="py-1.5"
            onClick={() => answer(true)}
          >
            Run Explain Analyze
          </Button>
        </DialogFooter>
      </div>
    </Dialog>
  );
}
