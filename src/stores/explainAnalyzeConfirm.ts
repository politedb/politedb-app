import { create } from "zustand";

export type ExplainAnalyzeConfirmRequest = {
  /** Profile tab the statement runs against. */
  target: string | null;
  statement: string;
};

type Pending = ExplainAnalyzeConfirmRequest & {
  resolve: (confirmed: boolean) => void;
};

type State = {
  pending: Pending | null;
  answer: (confirmed: boolean) => void;
};

/**
 * The Explain Analyze confirmation, shown by ExplainAnalyzeConfirmHost (an
 * in-app dialog, so Cancel can be the focused default on every platform).
 */
export const useExplainAnalyzeConfirmStore = create<State>((set, get) => ({
  pending: null,
  answer: (confirmed) => {
    const pending = get().pending;
    if (!pending) return;
    set({ pending: null });
    pending.resolve(confirmed);
  },
}));

/** Ask once; resolves false on Cancel, Escape, the backdrop, or when replaced. */
export function confirmExplainAnalyze(
  request: ExplainAnalyzeConfirmRequest
): Promise<boolean> {
  return new Promise((resolve) => {
    const previous = useExplainAnalyzeConfirmStore.getState().pending;
    useExplainAnalyzeConfirmStore.setState({
      pending: { ...request, resolve },
    });
    previous?.resolve(false);
  });
}
