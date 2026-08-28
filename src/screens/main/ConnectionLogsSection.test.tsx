import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const src = readFileSync(
  resolve(process.cwd(), "src/screens/main/ConnectionLogsSection.tsx"),
  "utf8"
);

describe("ConnectionLogsSection", () => {
  it("keeps the session date range on one line", () => {
    expect(src).toContain("whitespace-nowrap");
    expect(src).toMatch(
      /td class="[^"]*whitespace-nowrap[\s\S]*formatConnectionLogDateRange/
    );
  });
});
