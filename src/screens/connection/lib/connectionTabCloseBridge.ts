export type ConnectionTabCloseBridge = {
  closeTab: (tabId: string, skipCheck?: boolean) => Promise<void>;
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
