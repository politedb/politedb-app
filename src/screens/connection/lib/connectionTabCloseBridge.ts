export type ConnectionTabCloseBridge = {
  /** `intent`: the outer close's admission (see withCloseAdmission). */
  closeTab: (
    tabId: string,
    skipCheck?: boolean,
    intent?: symbol
  ) => Promise<void>;
  discardChanges: () => Promise<void>;
  discardAndQuitApp?: () => Promise<void>;
};

let bridge: ConnectionTabCloseBridge | null = null;

export function registerConnectionTabCloseBridge(
  next: ConnectionTabCloseBridge | null
) {
  bridge = next;
}

export function getConnectionTabCloseBridge() {
  return bridge;
}

/**
 * The bridge over the connection screen's actions (read through a ref, so
 * the latest ones run). The close's intent is passed on, so the screen's
 * close borrows the outer close's lease instead of taking its own.
 */
export function connectionTabCloseBridgeFor(
  actions: () => {
    closeTab: (
      tabId: string,
      skipCheck?: boolean,
      intent?: symbol
    ) => Promise<void>;
    discardChanges: () => Promise<void>;
  },
  discardAndQuitApp: () => Promise<void>
): ConnectionTabCloseBridge {
  return {
    closeTab: (tabId, skipCheck, intent) =>
      actions().closeTab(tabId, skipCheck, intent),
    discardChanges: () => actions().discardChanges(),
    discardAndQuitApp,
  };
}
