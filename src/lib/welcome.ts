export const WELCOME_SEEN_KEY = "politedb:welcome:seen";

function readStorage(key: string) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // ignore storage failures
  }
}

export function hasSeenWelcome() {
  return readStorage(WELCOME_SEEN_KEY) === "1";
}

export function markWelcomeSeen() {
  writeStorage(WELCOME_SEEN_KEY, "1");
}
