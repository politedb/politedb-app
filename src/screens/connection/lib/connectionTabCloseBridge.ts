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
