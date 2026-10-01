/**
 * Top connection status chip chrome.
 * Red / danger styles are reserved for true connection failure — not table/query load errors
 * on an otherwise live runtime connection.
 */
export function resolveMenuBarConnectionChrome(input: {
  hasRuntimeConnection: boolean;
  loadError?: string | null;
}): {
  connected: boolean;
  isConnectionError: boolean;
} {
  const connected = input.hasRuntimeConnection;
  const isConnectionError = !connected && Boolean(input.loadError);
  return { connected, isConnectionError };
}
