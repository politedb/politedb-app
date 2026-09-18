import { afterEach, describe, expect, it } from "vitest";
import { WELCOME_SEEN_KEY, hasSeenWelcome, markWelcomeSeen } from "./welcome";

afterEach(() => {
  window.localStorage.clear();
});

describe("welcome first-launch flag", () => {
  it("defaults to unseen", () => {
    expect(hasSeenWelcome()).toBe(false);
  });

  it("marks welcome as seen", () => {
    markWelcomeSeen();

    expect(window.localStorage.getItem(WELCOME_SEEN_KEY)).toBe("1");
    expect(hasSeenWelcome()).toBe(true);
  });
});
